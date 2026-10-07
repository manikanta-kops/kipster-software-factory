import { DependencyChangedError } from '../workspace/dependencies.ts'
import { dependencySession } from './dependencies.ts'
import { cleanVerificationEvidence } from '../artifacts/storage.ts'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import type { Database } from '../store/database.ts'
import type { ArtifactInput, StepResult } from '../domain/lifecycle.ts'
import type { AttemptContext, TicketDetail } from '../store/tickets.ts'
import {
  addAttemptArtifacts,
  completeAttempt,
  recordAttemptHeadCommit,
} from '../store/tickets.ts'
import { run } from '../executors/process.ts'
import { loadKit, loadTrustedInstructions } from '../kit/kit.ts'
import {
  startVerification,
  VerificationError,
  verificationFinding,
  type VerificationInstance,
} from '../verification/harness.ts'
import { artifactPath, buildPrompt, openSession, readResult } from './prompt.ts'
import type { RunnerOptions } from './runner.ts'
import { agentFor } from './tasks.ts'

type Instance = VerificationInstance & {
  surface: 'base' | 'head'
  commit: string
}
type RetainedArtifact = {
  source: string
  commit: string | null
  artifact: ArtifactInput & { path: string }
}

export async function runProofAttempt(
  options: RunnerOptions,
  context: AttemptContext,
  detail: TicketDetail,
  repositoryPath: string,
  diff: string,
  signal: AbortSignal,
): Promise<void> {
  const { database, home } = options
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
  const kit = loaded.kit?.verify ? loaded.kit : null
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
  const trusted = await loadTrustedInstructions(
    repositoryPath,
    base,
    step.role,
    signal,
  )
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
  // Reproductions and base/head comparisons only mean something in the running app.
  if (!kit && (step.role === 'reproducer' || bug))
    throw new Error(loaded.state.error ?? 'Missing trusted verify kit')
  const targets: { surface: 'base' | 'head'; commit: string }[] =
    step.role === 'reproducer'
      ? [{ surface: 'base', commit: base }]
      : [
          ...(bug ? [{ surface: 'base' as const, commit: base }] : []),
          { surface: 'head', commit: head },
        ]

  let resultValidationError: string | undefined
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
    let retained: RetainedArtifact[] = []
    let appUnavailable = kit
      ? null
      : `The repository's kit has no verify instructions${loaded.state.error ? ` (${loaded.state.error})` : ''}.`
    try {
      for (const target of targets) {
        const start = (withKit: typeof kit) =>
          startVerification({
            home,
            ticketId: ticket.id,
            repository: repositoryPath,
            commit: target.commit,
            kit: withKit,
            database,
            signal: executionSignal,
          })
        let instance: VerificationInstance
        try {
          instance = await start(appUnavailable ? null : kit)
        } catch (error) {
          // A checker whose app will not start still checks the change itself.
          if (
            !(error instanceof VerificationError) ||
            appUnavailable ||
            bug ||
            step.role !== 'tester' ||
            executionSignal.aborted
          )
            throw error
          await addAttemptArtifacts(database, attempt.id, [
            ...error.logs,
            {
              ...(await verificationFinding(error)),
              kind: 'note',
              title: 'The app did not start for the checker',
            },
          ])
          if (error.evidenceDir)
            await cleanVerificationEvidence(home, error.evidenceDir)
          appUnavailable = `The kit's app did not start: ${error.message}`
          instance = await start(null)
        }
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
          url: i.url ? new URL(i.url).origin : null,
          databaseUrl: i.databaseUrl,
          evidenceDir: i.evidenceDir,
          checkout: i.checkout,
        })),
        ...(appUnavailable
          ? {
              app: {
                started: false,
                reason: appUnavailable,
                suggestedCommands: {
                  setup: loaded.kit?.setup ?? null,
                  check: loaded.kit?.check ?? null,
                },
              },
            }
          : {}),
        requirement: bug
          ? 'Run the exact Reproduction steps on BOTH instances: the reported failure must still occur on base and must be absent on head. Attach file evidence from each. Otherwise changes-needed, never passed.'
          : step.role === 'tester'
            ? appUnavailable
              ? 'No app was started for you. Work out how to check the change yourself in this disposable checkout: read the diff, install dependencies, run the tests and start the app on a free loopback port if the change needs it. Save the output that proves each approved acceptance scenario in evidenceDir. Report each scenario you cannot prove with scenarioResult unverified; that alone is not changes-needed.'
              : 'Prove every approved acceptance scenario on head. Report each scenario you cannot prove with scenarioResult unverified; that alone is not changes-needed.'
            : 'Prove the reported failure on base; record exact Reproduction steps for the builder and tester.',
      }
      const cwd = instances.at(-1)!.checkout
      const session = await dependencySession(options, detail, signal)
      const prompt = await buildPrompt({
        database: options.database,
        dependencies: session.dependencies,
        step,
        detail,
        directory,
        diff,
        home,
        trusted,
        proof: { context: proof },
        resultValidationError,
      })
      const log = await openSession({
        database,
        home,
        ticketId: ticket.id,
        attemptId: attempt.id,
        directory,
        prompt,
        title: `${step.role} run ${retry}`,
      })
      execution = session.execute({
        config: await agentFor(options, context, step.role),
        cwd,
        prompt,
        directory,
        log,
        signal: executionSignal,
      })
      await Promise.race([
        execution,
        ...instances
          .filter((i) => i.url)
          .map((i) =>
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
        resultValidationError = String(error)
        await writeFile(
          join(directory, 'result-error.txt'),
          resultValidationError,
        )
        if (retry === 1) continue
        throw new Error(
          `Invalid or missing proof result after two runs: ${String(error)}`,
          { cause: error },
        )
      }
      const artifacts = await Promise.all(
        result.artifacts.map(async (artifact) => {
          if (!artifact.path) return { artifact, source: null }
          const source = await artifactPath(home, artifact.path)
          const instance =
            instances.find((i) => source.startsWith(`${i.evidenceDir}/`)) ??
            (
              await Promise.all(
                instances.map(async (i) => ({
                  instance: i,
                  root: await realpath(i.evidenceDir),
                })),
              )
            ).find((i) => source.startsWith(`${i.root}/`))?.instance
          return { artifact, source, commit: instance?.commit ?? null }
        }),
      )
      retained = artifacts.filter(
        (item): item is RetainedArtifact => item.source !== null,
      )
      result = {
        ...result,
        artifacts: artifacts
          .filter((item) => item.source === null)
          .map((item) => item.artifact),
      }
      // Check exits that occurred while ingesting evidence, before deliberate shutdown.
      await Promise.race([
        Promise.all(instances.map((i) => i.exited)),
        new Promise<void>((resolve) => setImmediate(resolve)),
      ])
    } catch (error) {
      lifetime.abort(error)
      const dependencyError = await execution?.catch(
        (executionError: unknown) =>
          executionError instanceof DependencyChangedError
            ? executionError
            : undefined,
      )
      const failure =
        dependencyError instanceof DependencyChangedError
          ? dependencyError
          : error
      if (failure instanceof VerificationError)
        await addAttemptArtifacts(database, attempt.id, [
          ...failure.logs,
          await verificationFinding(failure),
        ])
      if (
        failure instanceof VerificationError &&
        failure.evidenceDir &&
        !instances.some((i) => i.evidenceDir === failure.evidenceDir)
      )
        await cleanVerificationEvidence(home, failure.evidenceDir)
      if (failure instanceof DependencyChangedError) throw failure
      signal.throwIfAborted()
      throw failure
    } finally {
      lifetime.abort(new Error('Proof session finished'))
      await execution?.catch(() => {})
      await retainAndStop(instances, database, attempt.id, retained, home)
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
        {
          headCommit,
          ...(bug && reproduction
            ? { reproductionAttemptId: reproduction.id }
            : {}),
        },
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
  // A checker reports what it could not prove; the merge gate shows it to the owner.
  if (
    ['passed', 'reproduced'].includes(result.outcome) &&
    result.artifacts.some(
      (a) =>
        a.scenarioResult === 'failed' ||
        (role === 'reproducer' && a.scenarioResult === 'unverified'),
    )
  )
    throw new Error(
      role === 'tester'
        ? 'A passing proof cannot contain failed scenario results'
        : 'A reproduction cannot contain failed or unverified scenario results',
    )
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

async function capturedEvidence(
  instance: Instance,
  declared: ReadonlySet<string>,
): Promise<ArtifactInput[]> {
  const artifacts: ArtifactInput[] = []
  for (const entry of await readdir(instance.evidenceDir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    if (
      declared.has(await realpath(path)) ||
      instance.logs.some((log) => log.path === path)
    )
      continue
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
  retained: RetainedArtifact[],
  home: string,
) {
  // Always try every cleanup even if another stop fails; retain evidence on failures too.
  const cleanup = await Promise.allSettled(instances.map((i) => i.stop()))
  // Attach declared files here too, so cleanup or stale-head failures retain them once.
  for (const item of retained)
    await addAttemptArtifacts(
      database,
      attemptId,
      [item.artifact],
      item.commit ? { commit: item.commit } : {},
    )
  const declared = new Set(retained.map((item) => item.source))
  for (const instance of instances) {
    await addAttemptArtifacts(
      database,
      attemptId,
      await capturedEvidence(instance, declared),
      { commit: instance.commit },
    )
    await cleanVerificationEvidence(home, instance.evidenceDir)
  }
  const failures = cleanup.filter((r) => r.status === 'rejected')
  if (failures.length)
    throw new AggregateError(
      failures.map((r) => r.reason),
      'Proof instance cleanup failed',
    )
}
