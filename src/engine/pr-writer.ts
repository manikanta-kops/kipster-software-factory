import { openReviewFindings } from '../domain/review.ts'
import { untestedReasons } from '../domain/task-testing.ts'
import { dependencySession } from './dependencies.ts'
import { newEvidenceFile } from '../artifacts/storage.ts'
import { scenarioIndex } from '../domain/evidence.ts'
import { FACTORY_MARKER } from '../github/feedback.ts'
import type { ArtifactInput } from '../domain/lifecycle.ts'
import { DependencyChangedError } from '../workspace/dependencies.ts'
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
  type TicketDetail,
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
  signal.throwIfAborted()
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
  if (cached?.trim()) {
    const body = annotate(cached)
    if (body !== cached)
      await savePullRequestDescription(database, ticket.id, head, body)
    return fitGitHubLimit(body, ticket.number)
  }
  const instructions = `Head commit: ${head}
Ticket number: ${ticket.number}
Maximum description length before the factory adds open findings: ${4000 - findingNotice.length}
Open review findings: ${JSON.stringify(findings.map((finding) => ({ title: finding.title, file: finding.file, content: finding.content })))}
Untested warnings: ${JSON.stringify(reasons)}
Independent proof scenarios: ${JSON.stringify(scenarios)}
Workflow has tester: ${detail.workflow.steps.some((s) => s.kind === 'agent' && s.role === 'tester')}
Current evidence: ${JSON.stringify(evidence.map((a) => ({ title: a.title, scenario: a.scenario, result: a.scenarioResult, content: a.content })))}
Only evidence at this exact commit counts. If the workflow has no tester, state that it is an untested workflow; builder evidence is not independent proof. Describe what each labelled scenario proved; unlabelled evidence has no scenario index. Distinguish independent tester/reproducer proof from repository checks. Do not claim any scenario was approved without proof. CI is pending at publication; the live ticket panel and GitHub checks report current status. Aim for 150–250 words and keep it under 4,000 characters. Include exactly "Evidence on ticket #${ticket.number} in the factory" and "Verified at ${head}". Include a "Merge danger:" line with one-way door or two-way door, how to undo the change and its blast radius. Do not include local URLs, internal links, local file paths or factory links. No hosted attachments are configured. The factory publishes your note as written.`
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
      database: options.database,
      dependencies: session.dependencies,
      step: {
        id: step.id,
        kind: 'agent',
        role: 'writer',
        needs: [],
        routes: {},
        instructions,
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
    const config = await agentFor(options, context, 'writer')
    let failure: string | undefined
    let note: ArtifactInput | undefined
    try {
      await session.execute({ config, cwd, directory, prompt, log, signal })
      signal.throwIfAborted()
      const result = await readResult(directory, 'writer', home)
      if (result.outcome !== 'done')
        throw new Error(`Writer outcome ${result.outcome}: ${result.summary}`)
      note = result.artifacts.find(
        (a) => a.kind === 'note' && a.content?.trim(),
      )
      if (!note) throw new Error('Writer provided no non-empty inline note')
    } catch (error) {
      if (signal.aborted || error instanceof DependencyChangedError) throw error
      failure = String(error)
    }
    signal.throwIfAborted()
    if (
      (await git(['rev-parse', 'HEAD'])) !== head ||
      (await git(['status', '--porcelain']))
    )
      throw new Error(
        'writer changed the worktree; preserved for human inspection',
      )
    if (failure) {
      await writeFile(join(directory, 'result-error.txt'), failure)
      continue
    }
    const description = annotate(note!.content!)
    const body = fitGitHubLimit(description, ticket.number)
    await addAttemptArtifacts(database, attempt.id, [
      { ...note!, content: description },
    ])
    await savePullRequestDescription(database, ticket.id, head, body)
    return body
  }
  const range = `origin/${repository.defaultBranch}..HEAD`
  const commits = detail.tasks.length
    ? []
    : (await git(['log', '--oneline', '-50', range]))
        .split('\n')
        .filter(Boolean)
  const more = detail.tasks.length
    ? 0
    : Number(await git(['rev-list', '--count', range])) - commits.length
  const description = annotate(factoryDescription(detail, head, commits, more))
  const body = fitGitHubLimit(description, ticket.number)
  await addAttemptArtifacts(database, attempt.id, [
    { kind: 'note', title: 'factory PR description', content: description },
  ])
  await savePullRequestDescription(database, ticket.id, head, body)
  return body
}

export function withUntestedNotice(
  body: string,
  reasons: readonly string[],
): string {
  const missing = reasons.filter((reason) => !body.includes(reason))
  return missing.length ? `${body}\n\n${missing.join('\n\n')}` : body
}

export function fitGitHubLimit(
  body: string,
  ticketNumber: number,
  reserved = `\n\n${FACTORY_MARKER}`.length,
): string {
  const limit = 65_536 - reserved
  if (body.length <= limit) return body
  const ending = `\n\nFull description on ticket #${ticketNumber} in the factory`
  let end = limit - ending.length
  // JavaScript counts UTF-16 units; preserve an astral character at the cut.
  if (
    /[\uD800-\uDBFF]/.test(body[end - 1]!) &&
    /[\uDC00-\uDFFF]/.test(body[end]!)
  )
    end--
  return body.slice(0, end) + ending
}

export function factoryDescription(
  detail: TicketDetail,
  head: string,
  commits: readonly string[],
  more = 0,
): string {
  const plainFact = (value: string) =>
    value
      // A bounded scheme keeps this linear on long unbroken words.
      .replace(/(?:[a-z][a-z\d+.-]{0,31}:\/\/|www\.)\S+/gi, '[URL omitted]')
      .replace(/(?:[A-Za-z]:\\|~?\/)\S+/g, '[path omitted]')
      .replace(/\s+/g, ' ')
      .trim()
  const verdict = (role: 'tester' | 'reviewer') => {
    const steps = detail.workflow.steps.filter(
      (s) => s.kind === 'agent' && s.role === role,
    )
    const latest = detail.attempts.findLast(
      (a) => a.status === 'finished' && steps.some((s) => s.id === a.stepId),
    )
    return latest
      ? `${role === 'tester' ? 'Tester' : 'Reviewer'} verdict: ${latest.outcome} — ${plainFact(latest.summary ?? '')}`
      : `no ${role} ran`
  }
  const changes = detail.tasks.length
    ? [
        'Tasks:',
        ...detail.tasks.map((t) => `- ${plainFact(t.title)} (${t.status})`),
      ]
    : [
        'Commits:',
        ...commits.map((c) => `- ${plainFact(c)}`),
        ...(more > 0 ? [`and ${more} more`] : []),
      ]
  return [
    plainFact(detail.ticket.title),
    'The writer did not produce a description, so the factory wrote this one from facts.',
    changes.join('\n'),
    verdict('tester'),
    verdict('reviewer'),
    `Verified at ${head}`,
    `Evidence on ticket #${detail.ticket.number} in the factory`,
  ].join('\n\n')
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
