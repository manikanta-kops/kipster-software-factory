import { openReviewFindings } from '../domain/review.ts'
import { untestedReasons } from '../domain/task-testing.ts'
import { dependencySession } from './dependencies.ts'
import { newEvidenceFile } from '../artifacts/storage.ts'
import { scenarioIndex } from '../domain/evidence.ts'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunnerOptions } from './runner.ts'
import { agentFor } from './tasks.ts'
import { buildPrompt, readResult } from './prompt.ts'
import { run } from '../executors/process.ts'
import { loadTrustedInstructions } from '../kit/kit.ts'
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
  const { database, home } = options
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
  const reasons = untestedReasons(detail)
  const findings = openReviewFindings(detail)
  const findingNotice = openFindingsNotice(findings)
  const annotate = (body: string) => {
    const withoutOldFindings = body.split('\n\n## Open review findings\n\n')[0]!
    return withUntestedNotice(withoutOldFindings, reasons) + findingNotice
  }
  const cached = await getPullRequestDescription(database, ticket.id, head)
  if (cached) {
    const body = annotate(cached)
    if (validDescription(body, head, ticket.number, scenarios)) {
      if (body !== cached)
        await savePullRequestDescription(database, ticket.id, head, body)
      return body
    }
  }
  const instructions = `Head commit: ${head}
Ticket number: ${ticket.number}
Maximum description length before the factory adds open findings: ${4000 - findingNotice.length}
Open review findings: ${JSON.stringify(findings.map((finding) => ({ title: finding.title, file: finding.file, content: finding.content })))}
Untested warnings: ${JSON.stringify(reasons)}
Independent proof scenarios: ${JSON.stringify(scenarios)}
Workflow has tester: ${detail.workflow.steps.some((s) => s.kind === 'agent' && s.role === 'tester')}
Current evidence: ${JSON.stringify(evidence.map((a) => ({ title: a.title, scenario: a.scenario, result: a.scenarioResult, content: a.content })))}
Only evidence at this exact commit counts. If the workflow has no tester, state that it is an untested workflow; builder evidence is not independent proof. Describe what each labelled scenario proved; unlabelled evidence has no scenario index. Distinguish independent tester/reproducer proof from repository checks. Do not claim any scenario was approved without proof. CI is pending at publication; the live ticket panel and GitHub checks report current status. Include exactly "Evidence on ticket #${ticket.number} in the factory". Do not include local URLs, file paths or factory links. No hosted attachments are configured.`
  let rejection = ''
  const git = (args: string[]) => run('git', args, { cwd, signal })
  const trusted = await loadTrustedInstructions(
    cwd,
    `origin/${repository.defaultBranch}`,
    'writer',
    signal,
  )
  for (let retry = 1; retry <= 2; retry++) {
    const directory = join(
      home,
      'steps',
      String(ticket.id),
      String(attempt.id),
      `writer-${retry}`,
    )
    await mkdir(directory, { recursive: true })
    const session = await dependencySession(options, detail, signal)
    const prompt = await buildPrompt({
      dependencies: session.dependencies,
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
      directory,
      home,
      trusted,
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
    await session.execute({
      config: await agentFor(options, context, 'writer'),
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
      const body = annotate(notes[0]!.content!.trim())
      if (!validDescription(body, head, ticket.number, scenarios))
        throw new Error(
          'Writer description requires <= 4,000 characters, a factory ticket reference without local links, Verified at current SHA and Merge danger with door classification',
        )
      await addAttemptArtifacts(database, attempt.id, [
        { ...notes[0]!, content: body },
      ])
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

export function withUntestedNotice(
  body: string,
  reasons: readonly string[],
): string {
  const missing = reasons.filter((reason) => !body.includes(reason))
  return missing.length ? `${body}\n\n${missing.join('\n\n')}` : body
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

export function openFindingsNotice(
  findings: readonly { title: string; file?: string | null }[],
): string {
  if (!findings.length) return ''
  const lines: string[] = []
  for (const finding of findings) {
    const line = `- ${finding.title}${finding.file ? ` (${finding.file})` : ''}`
      .replace(/\s+/g, ' ')
      .slice(0, 400)
    if (lines.join('\n').length + line.length > 1800) break
    lines.push(line)
  }
  if (lines.length < findings.length)
    lines.push(
      `- ${findings.length - lines.length} further findings; see the factory ticket.`,
    )
  return `\n\n## Open review findings\n\n${lines.join('\n')}\n\nFull findings and corrections are recorded on the factory ticket.`
}
