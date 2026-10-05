import { newEvidenceFile } from '../artifacts/storage.ts'
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { join, resolve as resolvePath } from 'node:path'
import { createServer, type Server } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import type { ArtifactInput } from '../domain/lifecycle.ts'
import type { Database } from '../store/database.ts'
import { createVerificationDatabase } from '../store/verification.ts'
import { run } from '../executors/process.ts'
import { kitSchema, type Kit } from '../kit/kit.ts'

export type VerificationStage =
  | 'kit'
  | 'checkout'
  | 'setup'
  | 'check'
  | 'ports'
  | 'database'
  | 'start'
  | 'ready'
  | 'stop'
export class VerificationError extends Error {
  readonly stage: VerificationStage
  readonly logs: readonly ArtifactInput[]
  readonly evidenceDir: string
  constructor(
    stage: VerificationStage,
    cause: unknown,
    logs: readonly ArtifactInput[],
    evidenceDir: string,
  ) {
    super(
      `Verification ${stage} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
    this.stage = stage
    this.logs = logs
    this.evidenceDir = evidenceDir
  }
}
export interface VerificationInstance {
  readonly url: string
  readonly ports: readonly number[]
  readonly databaseUrl: string | null
  readonly checkout: string
  readonly evidenceDir: string
  readonly logs: readonly ArtifactInput[]
  /** Resolves when the supervised process ends. Unexpected exit rejects. */
  readonly exited: Promise<void>
  stop(): Promise<void>
}
export interface VerificationOptions {
  readonly home: string
  readonly ticketId?: number
  /** Local repository cache containing the exact commit, including ticket commits. */
  readonly repository: string
  readonly commit: string
  readonly kit: Kit
  readonly database: Database
  readonly signal?: AbortSignal
  /** verify-kit runs the deterministic gate after setup, before provisioning/start. */
  readonly check?: boolean
  /** Run setup and check without starting an app. */
  readonly checkOnly?: boolean
}
const leased = new Set<number>()
async function reservePort(): Promise<{ port: number; server: Server }> {
  while (true) {
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('No allocated port')
    if (leased.has(address.port)) {
      await closePort(server)
      continue
    }
    leased.add(address.port)
    return { port: address.port, server }
  }
}
async function closePort(server: Server) {
  if (server.listening)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
}
function expand(
  template: string,
  ports: readonly number[],
  databaseUrl: string | null,
  shell: boolean,
) {
  const quote = (value: string) =>
    shell ? `'${value.replaceAll("'", "'\\''")}'` : value
  return template.replace(/\{(port\d*|databaseUrl)\}/g, (_, key: string) =>
    quote(
      key === 'databaseUrl'
        ? (databaseUrl ?? '')
        : String(ports[key === 'port' ? 0 : Number(key.slice(4)) - 1]),
    ),
  )
}
/** The caller owns the lifetime and must await stop() in finally. Evidence is never removed. */
export async function startVerification(
  options: VerificationOptions,
): Promise<VerificationInstance> {
  let stage: VerificationStage = 'kit'
  const logs: ArtifactInput[] = []
  let evidenceDir = ''
  let root = ''
  let checkout = ''
  let db: Awaited<ReturnType<typeof createVerificationDatabase>> | undefined
  const reservations: Awaited<ReturnType<typeof reservePort>>[] = []
  const lifetime = new AbortController()
  const signal = options.signal
    ? AbortSignal.any([options.signal, lifetime.signal])
    : lifetime.signal
  let processDone: Promise<void> | undefined
  let stopping: Promise<void> | undefined
  let processEnded = false
  let processError: unknown
  let shutdownError: unknown
  const stop = (): Promise<void> => {
    if (stopping) return stopping
    stopping = (async () => {
      lifetime.abort(new Error('Verification stopped'))
      const failures: unknown[] = []
      try {
        await processDone
      } catch (error) {
        failures.push(error)
      }
      if (shutdownError) failures.push(shutdownError)
      // A failed supervisor/log shutdown retains storage for inspection.
      if (!failures.length) {
        for (const item of reservations) {
          try {
            await closePort(item.server)
            leased.delete(item.port)
          } catch (error) {
            failures.push(error)
          }
        }
        try {
          await db?.drop()
        } catch (error) {
          failures.push(error)
        }
        try {
          if (root) await rm(root, { recursive: true, force: true })
        } catch (error) {
          failures.push(error)
        }
      }
      options.signal?.removeEventListener('abort', aborted)
      if (failures.length)
        throw new VerificationError(
          'stop',
          new AggregateError(failures, failures.map(String).join('; ')),
          logs,
          evidenceDir,
        )
    })()
    return stopping
  }
  const aborted = () => {
    void stop().catch(() => {})
  }
  const command = async (
    name: 'setup' | 'check',
    value: string | undefined,
  ) => {
    stage = name
    const path = options.ticketId
      ? await newEvidenceFile(options.home, options.ticketId)
      : join(evidenceDir, `${name}.log`)
    await writeFile(path, value ? '' : 'No setup command declared.\n')
    logs.push({ kind: 'log', title: `Verification ${name}`, path })
    if (value)
      await run('/bin/sh', ['-c', value], { cwd: checkout, log: path, signal })
  }
  try {
    const kit = kitSchema.parse(options.kit)
    if (!kit.verify && !options.checkOnly)
      throw new Error('Kit has no verify block')
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(options.commit))
      throw new Error('commit must be a full object ID')
    stage = 'checkout'
    const directory = join(resolvePath(options.home), 'verification')
    await mkdir(directory, { recursive: true })
    evidenceDir = await mkdtemp(join(directory, 'evidence-'))
    root = await mkdtemp(join(directory, 'checkout-'))
    checkout = join(root, 'repo')
    await run(
      'git',
      [
        'clone',
        '--shared',
        '--no-checkout',
        '--',
        options.repository,
        checkout,
      ],
      { signal },
    )
    await run('git', ['checkout', '--detach', options.commit], {
      cwd: checkout,
      signal,
    })
    await run('git', ['remote', 'remove', 'origin'], { cwd: checkout, signal })
    await command('setup', kit.setup)
    if (options.check) await command('check', kit.check)
    if (options.checkOnly)
      return {
        url: '',
        ports: [],
        databaseUrl: null,
        checkout,
        evidenceDir,
        logs,
        exited: Promise.resolve(),
        stop,
      }
    if (!kit.verify) throw new Error('Kit has no verify block')
    stage = 'ports'
    for (let i = 0; i < kit.verify.ports; i++)
      reservations.push(await reservePort())
    const ports = reservations.map((item) => item.port)
    stage = 'database'
    if (kit.verify.database === 'postgres')
      db = await createVerificationDatabase(options.database)
    const databaseUrl = db?.url ?? null
    const url = expand(kit.verify.ready, ports, databaseUrl, false)
    stage = 'start'
    const path = options.ticketId
      ? await newEvidenceFile(options.home, options.ticketId)
      : join(evidenceDir, 'start.log')
    await writeFile(path, '')
    logs.push({ kind: 'log', title: 'Verification start', path })
    for (const item of reservations) await closePort(item.server)
    const processSignal = signal
    processDone = run(
      '/bin/sh',
      ['-c', expand(kit.verify.start, ports, databaseUrl, true)],
      { cwd: checkout, log: path, signal: processSignal },
    ).then(
      () => {
        processEnded = true
        processError = new Error('Start command exited before stop()')
      },
      (error: unknown) => {
        processEnded = true
        if (!processSignal.aborted) processError = error
        else if (error !== processSignal.reason) shutdownError = error
      },
    )
    const deadline = AbortSignal.timeout(
      Math.ceil(kit.verify.timeoutSeconds * 1000),
    )
    const readySignal = AbortSignal.any([signal, deadline])
    stage = 'ready'
    while (true) {
      signal.throwIfAborted()
      if (processEnded)
        throw new VerificationError('start', processError, logs, evidenceDir)
      if (deadline.aborted)
        throw new Error(
          `No 2xx from ${url} within ${kit.verify.timeoutSeconds}s`,
        )
      try {
        const response = await fetch(url, {
          redirect: 'manual',
          signal: AbortSignal.any([readySignal, AbortSignal.timeout(500)]),
        })
        await response.body?.cancel()
        if (response.ok) break
      } catch {
        signal.throwIfAborted()
      }
      await delay(30, undefined, { signal })
    }
    if (processEnded)
      throw new VerificationError('start', processError, logs, evidenceDir)
    const exited = processDone.then(() => {
      if (processError)
        throw new VerificationError('start', processError, logs, evidenceDir)
    })
    void exited.catch(() => {})
    options.signal?.addEventListener('abort', aborted, { once: true })
    signal.throwIfAborted()
    return {
      url,
      ports,
      databaseUrl,
      checkout,
      evidenceDir,
      logs,
      exited,
      stop,
    }
  } catch (error) {
    const failure =
      error instanceof VerificationError
        ? error
        : new VerificationError(stage, error, logs, evidenceDir)
    try {
      await stop()
    } catch (cleanupError) {
      throw new VerificationError(
        failure.stage,
        new Error(`${failure.message}; ${String(cleanupError)}`, {
          cause: cleanupError,
        }),
        logs,
        evidenceDir,
      )
    }
    throw failure
  }
}
export async function verificationFinding(
  error: VerificationError,
): Promise<ArtifactInput> {
  const excerpts = await Promise.all(
    error.logs.map(async (log) => {
      try {
        const file = await open(log.path!, 'r')
        try {
          const { size } = await file.stat()
          const bytes = Buffer.alloc(Math.min(size, 4000))
          await file.read(
            bytes,
            0,
            bytes.length,
            Math.max(0, size - bytes.length),
          )
          return `${log.title}:\n${bytes.toString('utf8')}`
        } finally {
          await file.close()
        }
      } catch {
        return `${log.title}: unavailable`
      }
    }),
  )
  return {
    kind: 'finding',
    title: `Verification failed: ${error.stage}`,
    content: `${error.message}\n\n${excerpts.join('\n\n') || 'No command log was produced at this stage.'}`,
  }
}
