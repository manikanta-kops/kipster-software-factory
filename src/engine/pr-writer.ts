import { newEvidenceFile } from '../artifacts/storage.ts'
import { scenarioIndex } from '../domain/evidence.ts'
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
  const detail = (await getTicketDetail(database, ticket.number))!
  const evidence = detail.artifacts.filter(
    (a) =>
      a.kind === 'evidence' &&
      (a.observedCommit ??
        detail.attempts.find((at) => at.id === a.attemptId)?.headCommit) ===
        head,
  )
  const scenarios = scenarioIndex(
    evidence,
    detail.attempts,
    new Map(
      detail.workflow.steps
        .filter((s) => s.kind === 'agent')
        .map((s) => [s.id, s.role]),
    ),
    head,
  )
  const cached = await getPullRequestDescription(database, ticket.id, head)
  if (cached && validDescription(cached, head, ticket.number, scenarios))
    return cached
  const instructions = `Head commit: ${head}
Ticket number: ${ticket.number}
Independent proof scenarios: ${JSON.stringify(scenarios)}
Workflow has tester: ${detail.workflow.steps.some((s) => s.kind === 'agent' && s.role === 'tester')}
Current evidence: ${JSON.stringify(evidence.map((a) => ({ title: a.title, scenario: a.scenario, result: a.scenarioResult, content: a.content })))}
Only evidence at this exact commit counts. If the workflow has no tester, state that it is an untested workflow; builder evidence is not independent proof. Describe what each labelled scenario proved; unlabelled evidence has no scenario index. Distinguish independent tester/reproducer proof from repository checks. Do not claim any scenario was approved without proof. CI is pending at publication; the live ticket panel and GitHub checks report current status. Include exactly "Evidence on ticket #${ticket.number} in the factory". Do not include local URLs, file paths or factory links. No hosted attachments are configured.`
  let rejection = ''
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
        instructions: rejection
          ? `${instructions}\n\nYour previous description was rejected: ${rejection}`
          : instructions,
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
    const log = await newEvidenceFile(home, ticket.id)
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
      if (!validDescription(body, head, ticket.number, scenarios))
        throw new Error(
          'Writer description requires <= 4,000 characters, a factory ticket reference without local links, Verified at current SHA and Merge danger with door classification',
        )
      await addAttemptArtifacts(database, attempt.id, notes)
      await savePullRequestDescription(database, ticket.id, head, body)
      return body
    } catch (error) {
      await writeFile(join(directory, 'result-error.txt'), String(error))
      rejection = error instanceof Error ? error.message : String(error)
      if (retry === 2) throw error
    }
  }
  throw new Error('Writer did not produce a description')
}

export function validDescription(
  body: string,
  head: string,
  ticketNumber: number,
  scenarios: readonly { scenario: string }[],
): boolean {
  return (
    body.length <= 4000 &&
    body.includes(`Verified at ${head}`) &&
    scenarios.every((s) => body.includes(s.scenario)) &&
    body.includes(`Evidence on ticket #${ticketNumber} in the factory`) &&
    !/\]\((?:\/|#|\.)/.test(body) &&
    !/(?:https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|[^/\s]*\.ts\.net)|file:\/\/|https?:\/\/\S*\/(?:#\/tickets|api\/artifacts)\/)/i.test(
      body,
    ) &&
    !/(?:^|[\s(`'"])(?:~|\/(?:Users|home|private|var\/folders|tmp))\//.test(
      body,
    ) &&
    /Merge danger:.*(?:one-way door|two-way door)/i.test(body)
  )
}
