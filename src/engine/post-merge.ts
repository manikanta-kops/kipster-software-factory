import { loadKit } from '../kit/kit.ts'
import { cleanVerificationEvidence } from '../artifacts/storage.ts'
import {
  BUILT_IN_WORKFLOWS,
  loadLibrary,
  type LibraryEntry,
} from '../library/library.ts'
import { getRepositoryById } from '../store/repositories.ts'
import { addAttemptArtifacts } from '../store/tickets.ts'
import {
  finishPostMergeCheck,
  type PostMergeCheck,
} from '../store/post-merge.ts'
import {
  startVerification,
  VerificationError,
  verificationFinding,
} from '../verification/harness.ts'
import type { RunnerOptions } from './runner.ts'

export async function checkAfterMerge(
  options: RunnerOptions,
  check: PostMergeCheck,
  signal: AbortSignal,
  bugWorkflow?: LibraryEntry,
) {
  const repository = await getRepositoryById(
    options.database,
    check.repositoryId,
  )
  if (!repository) throw new Error('Missing post-merge repository')
  const checks = await options.github.commitChecks(
    repository.slug,
    repository.defaultBranch,
    check.mergeCommit,
    signal,
  )
  const elapsed = Date.now() - Date.parse(check.createdAt)
  if (
    checks.state === 'pending' ||
    checks.state === 'head-changed' ||
    (checks.state === 'none' && elapsed < 3 * 60_000)
  )
    return
  if (checks.state === 'passed' || checks.state === 'failed') {
    await finish(checks.state, checks)
    return
  }
  // A PR-only workflow may have no default-branch run. Wait for registration before using the kit.
  if (check.hadCI && elapsed < 60 * 60_000) return
  await options.workspaces.prepareRepository(repository, signal)
  const cache = options.workspaces.cache(repository)
  const loaded = await loadKit(cache, check.mergeCommit, signal)
  if (!loaded.kit) {
    await finishPostMergeCheck(options.database, check, 'unavailable', {
      state: 'none',
      failures: [
        {
          name: 'Kit check unavailable',
          url: '',
          excerpt: loaded.state.error ?? 'Repository has no kit check.',
        },
      ],
    })
    return
  }
  let instance: Awaited<ReturnType<typeof startVerification>> | undefined
  let evidenceDir = ''
  try {
    instance = await startVerification({
      home: options.home,
      ticketId: check.ticketId,
      repository: cache,
      commit: check.mergeCommit,
      kit: loaded.kit,
      database: options.database,
      signal,
      check: true,
      checkOnly: true,
    })
    evidenceDir = instance.evidenceDir
    await instance.stop()
    await addAttemptArtifacts(
      options.database,
      check.attemptId,
      instance.logs,
      { commit: check.mergeCommit },
    )
    await finish('passed', {
      state: 'passed',
      failures: [],
      checks: [
        { name: 'Kit check', state: 'passed', required: false, url: '' },
      ],
    })
  } catch (error) {
    signal.throwIfAborted()
    if (
      !(error instanceof VerificationError) ||
      !['check', 'setup'].includes(error.stage)
    )
      throw error
    evidenceDir = error.evidenceDir
    const finding = await verificationFinding(error)
    await addAttemptArtifacts(
      options.database,
      check.attemptId,
      [...error.logs, finding],
      { commit: check.mergeCommit },
    )
    await finish('failed', {
      state: 'failed',
      failures: [
        {
          name: `Kit ${error.stage}`,
          url: '',
          excerpt: finding.content!.slice(-2000),
        },
      ],
    })
  } finally {
    await instance?.stop()
    if (evidenceDir) await cleanVerificationEvidence(options.home, evidenceDir)
  }
  async function finish(
    status: 'passed' | 'failed',
    result: import('../github/checks.ts').Checks,
  ) {
    if (status === 'failed' && !bugWorkflow) {
      const library = await loadLibrary(BUILT_IN_WORKFLOWS)
      if (!library.ok) throw new Error(library.errors.join('\n'))
      bugWorkflow = library.library.get('bug')
    }
    await finishPostMergeCheck(
      options.database,
      check,
      status,
      result,
      bugWorkflow,
    )
  }
}
