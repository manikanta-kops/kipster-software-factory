import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises'
import { basename, extname, join, relative, sep } from 'node:path'
import type { Database } from '../store/database.ts'
import type { ArtifactInput, StepResult } from '../domain/lifecycle.ts'
import type { AttemptContext, TicketDetail } from '../store/tickets.ts'
import {
  addAttemptArtifacts,
  completeAttempt,
  recordAttemptHeadCommit,
} from '../store/tickets.ts'
import { run } from '../executors/process.ts'
import { loadKit } from '../kit/kit.ts'
import {
  startVerification,
  VerificationError,
  verificationFinding,
  type VerificationInstance,
} from '../verification/harness.ts'
import { artifactPath, buildPrompt, readResult } from './prompt.ts'
import type { RunnerOptions } from './runner.ts'

type Instance = VerificationInstance & {
  surface: 'base' | 'head'
  commit: string
}

export async function runProofAttempt(
  options: RunnerOptions,
  context: AttemptContext,
  detail: TicketDetail,
  repositoryPath: string,
  diff: string,
  signal: AbortSignal,
): Promise<void> {
  const { database, home, config, execute } = options
  const { ticket, attempt, step, repository } = context
  if (
    step.kind !== 'agent' ||
    (step.role !== 'tester' && step.role !== 'reproducer')
  )
    throw new Error('Proof requires a tester or reproducer')
  const git = (args: string[]) =>
    run('git', args, { cwd: repositoryPath, signal })
  const head = await git(['rev-parse', 'HEAD'])
  const base = await git(['rev-parse', `origin/${repository.defaultBranch}`])
  const headCommit = step.role === 'reproducer' ? base : head
  // Pin the observation before any agent can edit its disposable checkout.
  await recordAttemptHeadCommit(database, attempt.id, headCommit)
  const loaded = await loadKit(repositoryPath, base, signal)
  if (!loaded.kit?.verify)
    throw new Error(loaded.state.error ?? 'Missing trusted verify kit')
  const kit = loaded.kit
  const paths = (
    await git(['ls-tree', '-r', '--name-only', base, '--', '.kipster'])
  ).split('\n')
  const documents = await Promise.all(
    paths
      .filter(
        (path) =>
          path === '.kipster/verify/README.md' ||
          /^\.kipster\/verify\/features\/[^/]+\.md$/.test(path),
      )
      .map(async (path) => ({
        path,
        content: await git(['show', `${base}:${path}`]),
      })),
  )
  const rolePath = `.kipster/roles/${step.role}.md`
  const roleInstructions = paths.includes(rolePath)
    ? await git(['show', `${base}:${rolePath}`])
    : ''
  const reproducerSteps = new Set(
    detail.workflow.steps
      .filter((s) => s.kind === 'agent' && s.role === 'reproducer')
      .map((s) => s.id),
  )
  const bug = step.role === 'tester' && reproducerSteps.size > 0
  const reproduction = detail.attempts.findLast(
    (a) => reproducerSteps.has(a.stepId) && a.waitingFor === null,
  )
  if (
    bug &&
    (reproduction?.status !== 'finished' ||
      reproduction.outcome !== 'reproduced' ||
      !detail.artifacts.some(
        (a) =>
          a.attemptId === reproduction.id &&
          a.kind === 'note' &&
          a.title === 'Reproduction steps',
      ))
  )
    throw new Error(
      'Bug verification requires a successful reproduction and its Reproduction steps artifact',
    )
  const targets: { surface: 'base' | 'head'; commit: string }[] =
    step.role === 'reproducer'
      ? [{ surface: 'base', commit: base }]
      : [
          ...(bug ? [{ surface: 'base' as const, commit: base }] : []),
          { surface: 'head', commit: head },
        ]

  for (let retry = 1; retry <= 2; retry++) {
    signal.throwIfAborted()
    const directory = join(
      home,
      'steps',
      String(ticket.id),
      String(attempt.id),
      String(retry),
    )
    await mkdir(directory, { recursive: true })
    const instances: Instance[] = []
    const lifetime = new AbortController()
    const executionSignal = AbortSignal.any([signal, lifetime.signal])
    let execution: Promise<void> | undefined
    let result: StepResult | undefined
    try {
      for (const target of targets) {
        const instance = await startVerification({
          home,
          repository: repositoryPath,
          commit: target.commit,
          kit,
          database,
          signal: executionSignal,
        })
        instances.push({ ...instance, ...target })
        await addAttemptArtifacts(
          database,
          attempt.id,
          instance.logs.map((log) => ({
            ...log,
            title: `${target.surface} ${target.commit}: ${log.title}`,
          })),
        )
      }
      const proof = {
        trustedKitCommit: base,
        documents,
        instances: instances.map((i) => ({
          surface: i.surface,
          commit: i.commit,
          url: new URL(i.url).origin,
          databaseUrl: i.databaseUrl,
          evidenceDir: i.evidenceDir,
          checkout: i.checkout,
        })),
        requirement: bug
          ? 'Run the exact Reproduction steps on BOTH instances: the reported failure must still occur on base and must be absent on head. Attach file evidence from each. Otherwise changes-needed, never passed.'
          : step.role === 'tester'
            ? 'Prove every approved acceptance scenario on head.'
            : 'Prove the reported failure on base; record exact Reproduction steps for the builder and tester.',
      }
      const cwd = instances.at(-1)!.checkout
      const prompt = await buildPrompt({
        step,
        detail,
        cwd,
        directory,
        diff,
        home,
        proof: { context: proof, roleInstructions },
      })
      await writeFile(join(directory, 'prompt.md'), prompt)
      const log = join(directory, 'agent.log')
      await writeFile(log, '')
      await addAttemptArtifacts(database, attempt.id, [
        { kind: 'log', title: `${step.role} run ${retry}`, path: log },
      ])
      execution = execute({
        config: config.agents.roles[step.role] ?? config.agents.default,
        cwd,
        prompt,
        directory,
        log,
        signal: executionSignal,
      })
      await Promise.race([
        execution,
        ...instances.map((i) =>
          i.exited.then(() => {
            throw new Error(`${i.surface} instance stopped during proof`)
          }),
        ),
      ])
      signal.throwIfAborted()
      try {
        result = await readResult(directory, step.role, home)
        await validateProof(result, step.role, instances, home)
      } catch (error) {
        await writeFile(join(directory, 'result-error.txt'), String(error))
        if (retry === 1) continue
        throw new Error(
          `Invalid or missing proof result after two runs: ${String(error)}`,
          { cause: error },
        )
      }
      const artifacts = await Promise.all(
        result.artifacts.map(async (artifact, index) => {
          if (!artifact.path) return artifact
          const path = join(
            directory,
            `artifact-${index}${extname(artifact.path) || '.txt'}`,
          )
          await copyFile(await artifactPath(home, artifact.path), path)
          return { ...artifact, path }
        }),
      )
      result = { ...result, artifacts }
      // Check exits that occurred while ingesting evidence, before deliberate shutdown.
      await Promise.race([
        Promise.all(instances.map((i) => i.exited)),
        new Promise<void>((resolve) => setImmediate(resolve)),
      ])
    } catch (error) {
      if (error instanceof VerificationError)
        await addAttemptArtifacts(database, attempt.id, [
          ...error.logs,
          await verificationFinding(error),
        ])
      signal.throwIfAborted()
      throw error
    } finally {
      lifetime.abort(new Error('Proof session finished'))
      await execution?.catch(() => {})
      await retainAndStop(instances, database, attempt.id)
    }
    signal.throwIfAborted()
    if ((await git(['rev-parse', 'HEAD'])) !== head)
      throw new Error('Ticket branch moved during proof; verdict is stale')
    if (result) {
      const summary =
        step.role === 'tester' && result.outcome === 'passed'
          ? `${result.summary}\n\nVerified at ${headCommit}${bug ? `\nReproduction failed on base ${base} and passed on head ${head}.` : ''}`
          : result.summary
      await completeAttempt(
        database,
        attempt.id,
        { ...result, summary },
        { headCommit },
      )
      return
    }
  }
}

async function validateProof(
  result: StepResult,
  role: 'tester' | 'reproducer',
  instances: Instance[],
  home: string,
) {
  if (result.outcome === 'needs-decision') return
  const evidence = await Promise.all(
    result.artifacts
      .filter((a) => a.kind === 'evidence' && a.path)
      .map(async (a) => artifactPath(home, a.path!)),
  )
  for (const instance of instances) {
    const root = await realpath(instance.evidenceDir)
    const logs = await Promise.all(
      instance.logs.map((log) => realpath(log.path!)),
    )
    const files = evidence.filter(
      (path) => path.startsWith(`${root}${sep}`) && !logs.includes(path),
    )
    if (
      !files.length ||
      !(await Promise.all(files.map((path) => lstat(path)))).some(
        (s) => s.size > 0,
      )
    )
      throw new Error(
        `Proof requires nonempty file evidence in ${instance.surface} evidenceDir; readiness logs and prose are not proof`,
      )
  }
  if (role === 'reproducer') {
    const steps = result.artifacts.find(
      (a) => a.kind === 'note' && a.title === 'Reproduction steps',
    )
    const content =
      steps &&
      (steps.content ??
        (await readFile(await artifactPath(home, steps.path!), 'utf8')))
    if (!content?.trim())
      throw new Error(
        'Reproducer must include a Reproduction steps note with exact steps and what it tried',
      )
  }
  const findings = result.artifacts.filter((a) => a.kind === 'finding')
  if (result.outcome === 'passed' && findings.length)
    throw new Error('A passing proof cannot contain failed scenarios')
  if (result.outcome === 'changes-needed' && !findings.length)
    throw new Error('changes-needed requires one finding per failed scenario')
  for (const finding of findings) {
    const content =
      finding.content ??
      (await readFile(await artifactPath(home, finding.path!), 'utf8'))
    if (
      !['Scenario:', 'Observed:', 'Expected:', 'Evidence:'].every((label) =>
        content.includes(label),
      ) ||
      !evidence.some((path) => content.includes(basename(path)))
    )
      throw new Error(
        'Each finding requires Scenario:, Observed:, Expected:, Evidence: naming an attached evidence file',
      )
  }
}

async function capturedEvidence(instance: Instance): Promise<ArtifactInput[]> {
  const artifacts: ArtifactInput[] = []
  for (const entry of await readdir(instance.evidenceDir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    if (instance.logs.some((log) => log.path === path)) continue
    artifacts.push({
      kind: 'evidence',
      title: `${instance.surface} ${instance.commit}: ${relative(instance.evidenceDir, path)}`,
      path,
    })
  }
  return artifacts
}

async function retainAndStop(
  instances: Instance[],
  database: Database,
  attemptId: number,
) {
  // Always try every cleanup even if another stop fails; retain evidence on failures too.
  const cleanup = await Promise.allSettled(instances.map((i) => i.stop()))
  for (const instance of instances)
    await addAttemptArtifacts(
      database,
      attemptId,
      await capturedEvidence(instance),
    )
  const failures = cleanup.filter((r) => r.status === 'rejected')
  if (failures.length)
    throw new AggregateError(
      failures.map((r) => r.reason),
      'Proof instance cleanup failed',
    )
}
