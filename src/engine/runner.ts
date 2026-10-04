import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { EngineConfig } from '../config.ts'
import { markRepositoryReady } from '../store/repositories.ts'
import type { Database } from '../store/database.ts'
import {
  addAttemptArtifacts,
  completeAttempt,
  getTicketDetail,
  setPullRequestUrl,
  waitForPullRequestMerge,
  type AttemptContext,
} from '../store/tickets.ts'
import type { AgentExecutor } from '../executors/cli.ts'
import { run } from '../executors/process.ts'
import type { Workspaces } from '../workspace/workspaces.ts'
import type { GitHub } from '../github/github.ts'
import { artifactPath, buildPrompt, readResult } from './prompt.ts'

export interface RunnerOptions {
  database: Database
  home: string
  config: EngineConfig
  workspaces: Workspaces
  github: GitHub
  execute: AgentExecutor
}
export async function runAttempt(
  options: RunnerOptions,
  context: AttemptContext,
  signal: AbortSignal,
): Promise<void> {
  const { database, home, config, workspaces, github, execute } = options
  const { ticket, step, attempt } = context
  let { repository } = context
  const detail = await getTicketDetail(database, ticket.number)
  if (!detail) throw new Error(`Missing ticket #${ticket.number}`)
  signal.throwIfAborted()
  if (step.kind === 'system' && step.action === 'merge') {
    if (!detail.ticket.pullRequestUrl)
      throw new Error('Cannot wait for merge without a pull request')
    await waitForPullRequestMerge(database, attempt.id)
    return
  }
  const defaultBranch = await workspaces.prepareRepository(repository, signal)
  if (defaultBranch !== repository.defaultBranch)
    repository = await markRepositoryReady(database, repository.id, {
      defaultBranch,
    })
  const cwd = await workspaces.prepare(ticket, repository, signal)
  const git = (args: string[]) => run('git', args, { cwd, signal })
  const base = `origin/${repository.defaultBranch}`
  const diff = await git(['diff', '--stat', `${base}...HEAD`])
  if (step.kind === 'agent') {
    const selected = config.agents.roles[step.role] ?? config.agents.default
    const before = await git(['rev-parse', 'HEAD'])
    for (let retry = 0; retry < 2; retry++) {
      signal.throwIfAborted()
      const directory = join(
        home,
        'steps',
        String(ticket.id),
        String(attempt.id),
        String(retry + 1),
      )
      await mkdir(directory, { recursive: true })
      const prompt = await buildPrompt({
        step,
        detail,
        cwd,
        directory,
        diff,
        home,
      })
      await writeFile(join(directory, 'prompt.md'), prompt)
      const log = join(directory, 'agent.log')
      await writeFile(log, '')
      await addAttemptArtifacts(database, attempt.id, [
        { kind: 'log', title: `${step.role} run ${retry + 1}`, path: log },
      ])
      let executionError: unknown
      try {
        await execute({ config: selected, cwd, prompt, directory, log, signal })
      } catch (error) {
        executionError = error
      }
      signal.throwIfAborted()
      let result
      try {
        result = await readResult(directory, step.role, home)
      } catch (error) {
        await writeFile(join(directory, 'result-error.txt'), String(error))
        if (retry === 0) continue
        throw new Error(
          `Invalid or missing result.json after two runs: ${String(error)}`,
          { cause: error },
        )
      }
      if (executionError) throw executionError
      if (
        ['planner', 'reviewer', 'writer', 'tester', 'reproducer'].includes(
          step.role,
        )
      ) {
        if (
          (await git(['rev-parse', 'HEAD'])) !== before ||
          (await git(['status', '--porcelain']))
        )
          throw new Error(
            `${step.role} changed the worktree; preserved for human inspection`,
          )
      }
      if (
        step.role === 'builder' &&
        result.outcome === 'done' &&
        (await git(['status', '--porcelain']))
      )
        throw new Error('Builder left uncommitted changes')
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
      await completeAttempt(database, attempt.id, { ...result, artifacts })
      return
    }
  } else if (step.kind === 'system' && step.action === 'maintain-pr') {
    if (Number(await git(['rev-list', '--count', `${base}..HEAD`])) === 0) {
      await completeAttempt(database, attempt.id, {
        outcome: 'needs-decision',
        summary: 'The ticket branch has no commits to publish.',
        artifacts: [],
      })
      return
    }
    await git(['push', '--set-upstream', 'origin', ticket.branch])
    const approval = detail.attempts.findLast(
      (a) => a.waitingFor === 'human' && a.outcome === 'approved',
    )
    const plan = approval
      ? detail.artifacts.findLast(
          (a) => a.kind === 'plan' && a.attemptId < approval.id,
        )
      : undefined
    const latest = [
      ...new Map(
        detail.attempts
          .filter(
            (a) =>
              a.status === 'finished' && a.summary && a.waitingFor === null,
          )
          .map((a) => [a.stepId, a]),
      ).values(),
    ]
    const successful = new Set(
      latest
        .filter((a) => a.outcome === 'done' || a.outcome === 'passed')
        .map((a) => a.id),
    )
    const writers = new Set(
      detail.workflow.steps
        .filter(
          (candidate) =>
            candidate.kind === 'agent' && candidate.role === 'writer',
        )
        .map((candidate) => candidate.id),
    )
    const writerAttempts = new Set(
      latest
        .filter((candidate) => writers.has(candidate.stepId))
        .map((candidate) => candidate.id),
    )
    const descriptions = await Promise.all(
      detail.artifacts
        .filter(
          (a) =>
            a.id === plan?.id ||
            (successful.has(a.attemptId) &&
              a.kind === 'evidence' &&
              a.content !== null) ||
            (a.kind === 'note' && writerAttempts.has(a.attemptId)),
        )
        .map(
          async (a) =>
            `## ${a.title}\n\n${a.content ?? (await readFile(await artifactPath(home, a.path!), 'utf8'))}`,
        ),
    )
    const body = [
      ticket.body,
      ...latest
        .filter((a) => a.stepId !== 'plan')
        .map((a) => `## ${a.stepId}\n\n${a.summary}`),
      ...descriptions,
    ].join('\n\n')
    const pr = await github.maintain({
      repository: repository.slug,
      branch: ticket.branch,
      base: repository.defaultBranch,
      title: ticket.title,
      body,
      cwd,
      signal,
    })
    signal.throwIfAborted()
    await setPullRequestUrl(database, ticket.id, pr.url)
    await completeAttempt(database, attempt.id, {
      outcome: 'ready',
      summary: `Pull request: ${pr.url}`,
      artifacts: [],
    })
  } else throw new Error(`Step ${step.id} is not supported in this slice`)
}
