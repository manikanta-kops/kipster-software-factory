import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunnerOptions } from './runner.ts'
import { buildPrompt, readResult } from './prompt.ts'
import { run } from '../executors/process.ts'
import {
  addAttemptArtifacts,
  getTicketDetail,
  type AttemptContext,
} from '../store/tickets.ts'
import {
  getPullRequestDescription,
  savePullRequestDescription,
} from '../store/pull-requests.ts'

export async function writePullRequest(
  options: RunnerOptions,
  context: AttemptContext,
  cwd: string,
  head: string,
  signal: AbortSignal,
): Promise<string> {
  const { database, home, config, execute } = options
  const { ticket, attempt, repository, step } = context
  const cached = await getPullRequestDescription(database, ticket.id, head)
  if (cached) return cached
  const detail = (await getTicketDetail(database, ticket.number))!
  const factoryUrl =
    step.kind === 'system' ? step.with['factoryUrl'] : undefined
  const root =
    typeof factoryUrl === 'string'
      ? factoryUrl.replace(/\/$/, '')
      : 'http://localhost:4600'
  const evidence = detail.artifacts
    .filter(
      (a) =>
        a.kind === 'evidence' &&
        detail.attempts.find((at) => at.id === a.attemptId)?.headCommit ===
          head,
    )
    .map((a) => ({
      title: a.title,
      commit: detail.attempts.find((at) => at.id === a.attemptId)?.headCommit,
      url: `${root}/api/artifacts/${a.id}`,
    }))
  const instructions = `Only evidence for this exact commit is listed; if none, say that verification evidence is unavailable and link the timeline. CI is not yet checked: describe it as pending.\nHead commit: ${head}\nEvidence links: ${JSON.stringify(evidence)}\nTicket timeline: ${root}/tickets/${ticket.number}`
  const git = (args: string[]) => run('git', args, { cwd, signal })
  for (let retry = 1; retry <= 2; retry++) {
    const directory = join(
      home,
      'steps',
      String(ticket.id),
      String(attempt.id),
      `writer-${retry}`,
    )
    await mkdir(directory, { recursive: true })
    const prompt = await buildPrompt({
      step: {
        id: step.id,
        kind: 'agent',
        role: 'writer',
        needs: [],
        routes: {},
        instructions,
      },
      detail,
      cwd,
      directory,
      home,
      diff: await git([
        'diff',
        '--stat',
        `origin/${repository.defaultBranch}...HEAD`,
      ]),
    })
    await writeFile(join(directory, 'prompt.md'), prompt)
    const log = join(directory, 'agent.log')
    await writeFile(log, '')
    await addAttemptArtifacts(database, attempt.id, [
      { kind: 'log', title: `writer run ${retry}`, path: log },
    ])
    await execute({
      config: config.agents.roles.writer ?? config.agents.default,
      cwd,
      directory,
      prompt,
      log,
      signal,
    })
    if (
      (await git(['rev-parse', 'HEAD'])) !== head ||
      (await git(['status', '--porcelain']))
    )
      throw new Error(
        'writer changed the worktree; preserved for human inspection',
      )
    try {
      const result = await readResult(directory, 'writer', home)
      if (result.outcome !== 'done')
        throw new Error(`Writer needs a decision: ${result.summary}`)
      const notes = result.artifacts.filter(
        (a) => a.kind === 'note' && a.content,
      )
      if (notes.length !== 1)
        throw new Error('Writer must provide one inline description note')
      const body = notes[0]!.content!.trim()
      if (
        body.length > 4000 ||
        !body.includes(`Verified at ${head}`) ||
        !(evidence.length
          ? evidence.some((e) => body.includes(e.url))
          : body.includes(`${root}/tickets/${ticket.number}`)) ||
        !/Merge danger:.*(?:one-way door|two-way door)/i.test(body)
      )
        throw new Error(
          'Writer description requires <= 4,000 characters, a factory evidence link, Verified at current SHA and Merge danger with door classification',
        )
      await addAttemptArtifacts(database, attempt.id, notes)
      await savePullRequestDescription(database, ticket.id, head, body)
      return body
    } catch (error) {
      await writeFile(join(directory, 'result-error.txt'), String(error))
      if (retry === 2) throw error
    }
  }
  throw new Error('Writer did not produce a description')
}
