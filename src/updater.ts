import type { UpdateResponse } from './api/contract.ts'
import { FactoryError } from './domain/errors.ts'
import type { Scheduler } from './engine/scheduler.ts'
import { type FailedUpdate, isNewer, RELEASES } from './updates.ts'

export interface Updater {
  status(): Promise<UpdateResponse>
  /** Holds new steps and installs the newer release once running steps finish. */
  request(): Promise<UpdateResponse>
  /** Releases a waiting update; an install already started cannot be cancelled. */
  cancel(): Promise<UpdateResponse>
  close(): void
}

export interface UpdaterOptions {
  readonly current: string
  /** Why this factory cannot update itself, or null when it can. */
  readonly blocked: () => string | null
  readonly latest: (signal: AbortSignal) => Promise<string>
  readonly scheduler?: Pick<Scheduler, 'hold' | 'busy'> | undefined
  readonly automatic: () => Promise<boolean>
  /** Starts the installer outside this process. */
  readonly install: (version: string) => Promise<void>
  readonly failed: () => Promise<FailedUpdate | null>
  readonly clearFailed: () => Promise<void>
  readonly now?: () => Date
  readonly checkEveryMs?: number
  readonly tickMs?: number
  readonly pollMs?: number
  readonly report?: (error: unknown) => void
}

/** Local hours in which an automatic update may start. */
const NIGHT = { from: 2, to: 5 }
const INSTALL_LIMIT_MS = 30 * 60_000

export function startUpdater(options: UpdaterOptions): Updater {
  const now = options.now ?? (() => new Date())
  const checkEveryMs = options.checkEveryMs ?? 6 * 60 * 60_000
  const report =
    options.report ?? ((error: unknown) => console.error('Updates:', error))
  let latest: string | null = null
  let checkedAt: Date | null = null
  let checking: Promise<void> | undefined
  let phase: 'idle' | 'waiting' | 'installing' = 'idle'
  let installingSince = 0
  let error: string | null = null
  let lastNight: string | null = null
  let closed = false
  let poll: ReturnType<typeof setInterval> | undefined

  function check(): Promise<void> {
    return (checking ??= options
      .latest(AbortSignal.timeout(15_000))
      .then((version) => {
        latest = version
        checkedAt = now()
      })
      .catch((failure: unknown) => {
        report(
          `Could not check for a newer release: ${failure instanceof Error ? failure.message : String(failure)}`,
        )
      })
      .finally(() => {
        checking = undefined
      }))
  }

  const available = () => latest !== null && isNewer(latest, options.current)

  async function status(): Promise<UpdateResponse> {
    const failed = await options.failed()
    const failedHere = failed !== null && failed.version === latest
    return {
      current: options.current,
      latest,
      checkedAt: checkedAt?.toISOString() ?? null,
      state:
        phase !== 'idle'
          ? phase
          : error || failedHere
            ? 'failed'
            : available()
              ? 'available'
              : 'none',
      running: options.scheduler?.busy() ?? 0,
      blocked: options.blocked(),
      error:
        phase === 'idle'
          ? (error ?? (failedHere ? failed.message : null))
          : null,
      automatic: await options.automatic(),
      notes: latest && available() ? `${RELEASES}/tag/v${latest}` : null,
    }
  }

  function release(message: string | null) {
    phase = 'idle'
    error = message
    if (poll) clearInterval(poll)
    poll = undefined
    options.scheduler?.hold(false)
  }

  async function advance() {
    if (phase === 'waiting' && (options.scheduler?.busy() ?? 0) === 0) {
      phase = 'installing'
      installingSince = Date.now()
      try {
        await options.install(latest!)
      } catch (failure) {
        release(failure instanceof Error ? failure.message : String(failure))
      }
    } else if (
      phase === 'installing' &&
      Date.now() - installingSince > INSTALL_LIMIT_MS
    )
      release(
        'The update did not finish. See logs/update.log in the factory home.',
      )
  }

  async function request(): Promise<UpdateResponse> {
    if (phase !== 'idle') return status()
    const age = checkedAt ? now().getTime() - checkedAt.getTime() : Infinity
    if (age > 10 * 60_000) await check()
    if (!available()) return status()
    const blocked = options.blocked()
    if (blocked) throw new FactoryError('conflict', blocked)
    await options.clearFailed()
    error = null
    phase = 'waiting'
    options.scheduler?.hold(true)
    poll = setInterval(
      () => void advance().catch(report),
      options.pollMs ?? 5_000,
    )
    poll.unref()
    await advance()
    return status()
  }

  async function cancel(): Promise<UpdateResponse> {
    if (phase === 'installing')
      throw new FactoryError('conflict', 'The update is already installing.')
    if (phase === 'waiting') release(null)
    return status()
  }

  async function tick() {
    if (closed) return
    const time = now()
    const night = time.getHours() >= NIGHT.from && time.getHours() < NIGHT.to
    const age = checkedAt ? time.getTime() - checkedAt.getTime() : Infinity
    if (age >= (night ? 60 * 60_000 : checkEveryMs)) await check()
    const today = time.toDateString()
    if (
      !night ||
      lastNight === today ||
      phase !== 'idle' ||
      !available() ||
      options.blocked() ||
      !(await options.automatic())
    )
      return
    if ((await options.failed())?.version === latest) return
    lastNight = today
    await request()
  }

  const timer = setInterval(
    () => void tick().catch(report),
    options.tickMs ?? 10 * 60_000,
  )
  timer.unref()
  void tick().catch(report)

  return {
    status,
    request,
    cancel,
    close() {
      closed = true
      clearInterval(timer)
      if (poll) clearInterval(poll)
    },
  }
}

/** For a factory that cannot update itself: reports the version and the reason. */
export function fixedVersion(current: string, blocked: string): Updater {
  const status = async (): Promise<UpdateResponse> => ({
    current,
    latest: null,
    checkedAt: null,
    state: 'none',
    running: 0,
    blocked,
    error: null,
    automatic: false,
    notes: null,
  })
  return {
    status,
    request: async () => {
      throw new FactoryError('conflict', blocked)
    },
    cancel: status,
    close() {},
  }
}
