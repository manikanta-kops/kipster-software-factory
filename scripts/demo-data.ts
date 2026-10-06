import { evaluateMergeGate, type MergeFacts } from '../src/domain/merge-gate.ts'
import { saveMergeGate } from '../src/store/merge-gates.ts'
import { getTicketDetail } from '../src/store/tickets.ts'
import { setArtifactHome } from '../src/store/database.ts'
import { defaultHome } from '../src/config.ts'
import { writeDemoEvidence } from './demo-evidence.ts'
import { resolve } from 'node:path'
// Fills a database with repositories and lead tickets in every state, using the
// same store functions the engine and API use. The web app can be built against it
// before the engine exists.
import type { ArtifactInput } from '../src/domain/lifecycle.ts'
import type { TaskRequest } from '../src/domain/catalog.ts'
import {
  parseUpload,
  type Library,
  type LibraryEntry,
} from '../src/library/library.ts'
import type { Database } from '../src/store/database.ts'
import { acquireSchedulerLock } from '../src/store/scheduler.ts'
import {
  listTasks,
  parkForTasks,
  startTask,
  updateTask,
} from '../src/store/tasks.ts'
import { migrate } from '../src/store/migrate.ts'
import {
  createRepository,
  getRepository,
  markRepositoryFailed,
  markRepositoryReady,
} from '../src/store/repositories.ts'
import {
  claimAttempts,
  completeAttempt,
  createTicket,
  decide,
  getTicket,
  markRunning,
  setPullRequestUrl,
  waitForPullRequestMerge,
} from '../src/store/tickets.ts'

export const DEMO_REPOSITORY = 'kipster/demo-shop'

/** Ticket numbers of the demo tickets, by the state each one is left in. */
export interface DemoTickets {
  readonly proofPassed: number
  readonly proofStale: number
  readonly done: number
  readonly waitingForMerge: number
  readonly askAfterLimit: number
  readonly approvePlan: number
  readonly cancelled: number
  readonly running: number
  readonly queued: number
  readonly lightsOutLead: number
  readonly lightsOutChild: number
  readonly lightsOutUntestedChild: number
}

export async function seedDemo(
  database: Database,
  library: Library,
  home: string = defaultHome(),
): Promise<DemoTickets> {
  const directory = resolve(home)
  setArtifactHome(database, directory)
  await migrate(database)
  const lock = await acquireSchedulerLock(database, () => {}, 'demo')
  try {
    return await seedLocked(database, library, directory)
  } finally {
    await lock.close()
  }
}

async function seedLocked(
  database: Database,
  library: Library,
  home: string,
): Promise<DemoTickets> {
  if (await getRepository(database, DEMO_REPOSITORY)) {
    throw new Error(`The database already has demo data (${DEMO_REPOSITORY})`)
  }
  const workflow = library.get('lead')
  if (!workflow) throw new Error('The library has no lead workflow')

  const shop = await createRepository(database, { slug: DEMO_REPOSITORY })
  await markRepositoryReady(database, shop.id, {
    kit: { status: 'valid', error: null, capabilities: ['setup', 'verify'] },
  })
  const invalid = await createRepository(database, {
    slug: 'kipster/invalid-kit',
  })
  await markRepositoryReady(database, invalid.id, {
    kit: {
      status: 'invalid',
      error: 'verify.ready: must be a local http URL with {port}',
      capabilities: [],
    },
  })
  await createRepository(database, { slug: 'kipster/website' })
  const legacy = await createRepository(database, {
    slug: 'kipster/legacy-api',
    defaultBranch: 'master',
  })
  await markRepositoryFailed(
    database,
    legacy.id,
    'git clone failed: Repository not found.',
  )

  const create = async (
    title: string,
    body: string,
    version: LibraryEntry = workflow,
  ) =>
    (
      await createTicket(database, {
        repository: DEMO_REPOSITORY,
        workflow: version,
        lightsOut: false,
        title,
        body,
      })
    ).number

  /** Claims the ticket's pending attempt, starts it and optionally completes it. */
  const run = async (
    number: number,
    result?: {
      outcome: string
      summary: string
      artifacts?: ArtifactInput[]
      tasks?: TaskRequest[]
    },
    executor = 'claude-code',
    headCommit?: string,
  ) => {
    const [claimed] = await claimAttempts(database, 1)
    if (claimed?.ticket.number !== number) {
      throw new Error(`Expected to claim ticket #${number}'s attempt`)
    }
    await markRunning(database, claimed.attempt.id, executor)
    if (result) {
      await completeAttempt(
        database,
        claimed.attempt.id,
        {
          artifacts: [],
          ...result,
        },
        headCommit ? { headCommit } : {},
      )
    }
    return claimed
  }

  const waitingAttempt = async (number: number) => {
    const ticket = await getTicket(database, number)
    if (!ticket?.waiting) throw new Error(`Ticket #${number} is not waiting`)
    return ticket.waiting.attemptId
  }

  /** Runs the merge step until it waits for the pull request to be merged. */
  const openPullRequestAndWait = async (number: number, pull: number) => {
    const merge = await run(number, undefined, 'system')
    await setPullRequestUrl(
      database,
      merge.ticket.id,
      `https://github.com/${DEMO_REPOSITORY}/pull/${pull}`,
    )
    await waitForPullRequestMerge(database, merge.attempt.id)
    return merge.attempt.id
  }

  const planAndApprove = async (number: number, plan: string) => {
    await run(number, {
      outcome: 'plan-ready',
      summary: 'Wrote the plan with acceptance scenarios.',
      artifacts: [{ kind: 'plan', title: 'Plan', content: plan }],
    })
    await decide(database, {
      ticketNumber: number,
      attemptId: await waitingAttempt(number),
      choice: 'approved',
    })
  }

  const buildAndReview = async (number: number) => {
    await run(number, {
      outcome: 'done',
      summary: 'The lead finished coordinating the change.',
    })
    await run(number, {
      outcome: 'passed',
      summary: 'Tested the whole change.',
    })
    await run(number, {
      outcome: 'passed',
      summary: 'The diff matches the plan; nothing unsafe.',
    })
    await run(
      number,
      { outcome: 'ready', summary: 'Opened the pull request; CI is green.' },
      'system',
    )
  }

  // Done: every step ran and the pull request merged.
  // Lifecycle writes seed Ready, Needs you and Blocked reports from synthetic facts.
  const done = await create(
    'Add a dark mode toggle',
    'Add a toggle in **Settings** that switches the shop to a dark theme and remembers the choice.',
  )
  await planAndApprove(done, planFor('dark mode toggle'))
  await buildAndReview(done)
  await completeAttempt(database, await openPullRequestAndWait(done, 41), {
    outcome: 'merged',
    summary: 'Merged after the owner approved.',
    artifacts: [],
  })

  // Waiting for the owner to merge the pull request.
  const waitingForMerge = await create(
    'Show order totals in the header',
    'The header should show the running cart total next to the cart icon.',
  )
  await planAndApprove(waitingForMerge, planFor('order totals in the header'))
  await buildAndReview(waitingForMerge)
  await openPullRequestAndWait(waitingForMerge, 42)

  // This synthetic historical workflow demonstrates a review limit that asks the owner.
  const historical = parseUpload(
    workflow.source
      .replace('role: reviewer\n    limit: 5', 'role: reviewer\n    limit: 2')
      .replace('limit: maintain-pr', 'limit: ask'),
  )
  if (!historical.ok) throw new Error(historical.errors.join('; '))
  const askAfterLimit = await create(
    'Validate email addresses on sign-up',
    'Reject malformed email addresses on the sign-up form with a clear message.',
    historical.entry,
  )
  await run(askAfterLimit, {
    outcome: 'plan-ready',
    summary: 'Wrote the plan.',
    artifacts: [
      {
        kind: 'plan',
        title: 'Plan',
        content: planFor('email validation on sign-up'),
      },
    ],
  })
  await decide(database, {
    ticketNumber: askAfterLimit,
    attemptId: await waitingAttempt(askAfterLimit),
    choice: 'changes-needed',
    comment:
      'Also cover addresses with a plus sign, like `ann+shop@example.com`.',
  })
  await planAndApprove(
    askAfterLimit,
    planFor('email validation on sign-up, including plus addresses'),
  )
  for (const round of [1, 2]) {
    await run(askAfterLimit, {
      outcome: 'done',
      summary: `Coordinated validation (round ${round}).`,
    })
    await run(askAfterLimit, {
      outcome: 'passed',
      summary: 'Tested validation.',
    })
    await run(askAfterLimit, {
      outcome: 'changes-needed',
      summary: 'The validation still accepts `a@b`.',
      artifacts: [
        {
          kind: 'finding',
          title: `Review round ${round}`,
          content:
            '- **Blocking:** `a@b` passes validation; require a dot in the domain.\n- Minor: the error message is not announced to screen readers.',
        },
      ],
    })
  }

  // Waiting for you to approve the plan.
  const approvePlan = await create(
    'Add CSV export to reports',
    'Let shop owners download any report as CSV from the report page.',
  )
  await run(approvePlan, {
    outcome: 'plan-ready',
    summary: 'Wrote the plan with three acceptance scenarios.',
    artifacts: [
      {
        kind: 'plan',
        title: 'Plan',
        content: planFor('CSV export of reports'),
      },
    ],
  })

  // Cancelled: you rejected the plan.
  const cancelled = await create(
    'Rewrite the checkout in a new framework',
    'Move the checkout pages to a new UI framework.',
  )
  await run(cancelled, {
    outcome: 'plan-ready',
    summary: 'Wrote a migration plan.',
    artifacts: [
      {
        kind: 'plan',
        title: 'Plan',
        content: planFor('the checkout rewrite'),
      },
    ],
  })
  await decide(database, {
    ticketNumber: cancelled,
    attemptId: await waitingAttempt(cancelled),
    choice: 'rejected',
    comment: 'Not worth the risk this quarter.',
  })

  const evidence = await writeDemoEvidence(home)
  const proof = async (stale: boolean) => {
    const number = (
      await createTicket(database, {
        repository: DEMO_REPOSITORY,
        workflow,
        lightsOut: false,
        title: stale
          ? 'Cart proof needs another run'
          : 'Cart quantity changes are proven',
        body: 'Demo feature: changing quantity updates the total. Media is synthetic UI fixture data.',
      })
    ).number
    await planAndApprove(number, planFor('cart quantity changes'))
    const commit = 'a'.repeat(40)
    await run(
      number,
      { outcome: 'done', summary: 'Coordinated cart quantity updates.' },
      'codex',
      commit,
    )
    await run(
      number,
      {
        outcome: 'passed',
        summary: 'Cart quantity and total passed at the recorded demo commit.',
        artifacts: [
          {
            kind: 'evidence',
            scenario: 'Cart quantity updates the total',
            scenarioResult: 'passed',
            title: 'Cart image (synthetic demo)',
            path: evidence.image,
          },
          {
            kind: 'evidence',
            scenario: 'Cart quantity updates the total',
            scenarioResult: 'passed',
            title: 'Cart recording (synthetic demo)',
            path: evidence.video,
          },
          {
            kind: 'log',
            title: 'Cart driving log (synthetic demo)',
            path: evidence.log,
          },
        ],
      },
      'codex',
      commit,
    )
    if (stale) {
      await run(
        number,
        {
          outcome: 'changes-needed',
          summary: 'Review requested a later cart change.',
        },
        'codex',
        commit,
      )
      await run(
        number,
        {
          outcome: 'done',
          summary: 'Later task changed the cart; previous verdict is stale.',
        },
        'codex',
        'b'.repeat(40),
      )
      await run(number, undefined, 'codex')
    } else {
      await run(
        number,
        { outcome: 'passed', summary: 'Reviewed the tested commit.' },
        'codex',
        commit,
      )
      await run(
        number,
        { outcome: 'ready', summary: 'Demo PR is ready for the owner.' },
        'system',
        commit,
      )
      await openPullRequestAndWait(number, 43)
    }
    return number
  }
  const proofPassed = await proof(false)
  const proofStale = await proof(true)
  for (const number of [proofPassed, proofStale, waitingForMerge]) {
    const detail = (await getTicketDetail(database, number))!
    const hasTester = number !== waitingForMerge
    const head = 'a'.repeat(40)
    const facts: MergeFacts = {
      head,
      localHead: head,
      base: 'c'.repeat(40),
      behind: 0,
      tester: hasTester
        ? { status: 'finished', outcome: 'passed', commit: head }
        : null,
      hasTester,
      hasReviewer: true,
      reviewer: { status: 'finished', outcome: 'passed', commit: head },
      reproducer: null,
      hasReproducer: false,
      ci: 'passed',
      checks: [
        {
          name: 'Demo repository checks',
          state: 'passed',
          required: true,
          url: '',
        },
      ],
      feedback: [],
      buildWork: false,
      state: 'OPEN',
      draft: false,
      mergeable: 'MERGEABLE',
      paths: hasTester ? [] : ['.github/workflows/check.yml'],
      migrationGlobs: [],
      trustedKitError: null,
      approvedUnverified: null,
    }
    await saveMergeGate(
      database,
      detail.ticket.id,
      evaluateMergeGate(facts, new Date().toISOString()),
    )
    if (number === proofStale)
      await saveMergeGate(
        database,
        detail.ticket.id,
        evaluateMergeGate(
          { ...facts, localHead: 'b'.repeat(40), buildWork: true },
          new Date().toISOString(),
        ),
      )
  }

  // Synthetic lights-out choices and a child task, available without an agent session.
  const leadWorkflow = library.get('lead')
  const taskWorkflow = library.get('task')
  if (!leadWorkflow || !taskWorkflow)
    throw new Error('The library has no lead or task workflow')
  const lightsOutLead = (
    await createTicket(database, {
      repository: DEMO_REPOSITORY,
      workflow: leadWorkflow,
      title: 'Overnight report export (synthetic demo)',
      body: 'Synthetic lights-out demo: inspect the Decision log and follow the child task link. No real agents ran.',
    })
  ).number
  await run(lightsOutLead, {
    outcome: 'plan-ready',
    summary: 'Prepared the synthetic export plan for automatic approval.',
    artifacts: [
      { kind: 'plan', title: 'Plan', content: planFor('report export') },
      {
        kind: 'decision',
        title: 'Export format (synthetic demo)',
        chose: 'CSV',
        alternative: 'An Excel workbook',
        reason:
          'CSV works with the existing report data and common spreadsheet tools.',
      },
    ],
  })
  await run(lightsOutLead, {
    outcome: 'delegate',
    summary: 'Delegated the synthetic export endpoint task.',
    tasks: [
      {
        key: 'export-endpoint',
        title: 'Add the report export endpoint (synthetic demo)',
        instructions: 'Add a CSV export for the existing report data.',
        land: 'branch',
      },
      {
        key: 'export-notes',
        title: 'Document report exports (synthetic untested demo)',
        instructions:
          'Document CSV exports in the repository without a verify capability.',
        land: 'branch',
      },
    ],
  })
  const taskRun = await run(lightsOutLead, undefined, 'system')
  await parkForTasks(database, taskRun.attempt.id)
  const [exportTask, notesTask] = await listTasks(database, taskRun.ticket.id)
  const child = await startTask(
    database,
    exportTask!.id,
    {
      repository: DEMO_REPOSITORY,
      workflow: taskWorkflow,
      title: exportTask!.title,
      body: 'Synthetic child task with a recorded decision; no real code or verification was executed.',
    },
    null,
  )
  const lightsOutChild = child!.number
  await run(lightsOutChild, {
    outcome: 'needs-decision',
    summary:
      'Synthetic question: may the export include private customer data?',
    artifacts: [
      {
        kind: 'decision',
        title: 'CSV column order (synthetic demo)',
        chose: 'Use the displayed report column order',
        alternative: 'Sort columns alphabetically',
        reason: 'Matching the report makes the export familiar to shop owners.',
      },
    ],
  })
  await updateTask(
    database,
    exportTask!.id,
    'parked',
    'Synthetic question: may the export include private customer data?',
  )
  const notesChild = await startTask(
    database,
    notesTask!.id,
    {
      repository: 'kipster/invalid-kit',
      workflow: taskWorkflow,
      title: notesTask!.title,
      body: 'Synthetic untested task: no agents, code changes or verification ran.',
    },
    null,
  )
  const lightsOutUntestedChild = notesChild!.number
  await run(lightsOutUntestedChild, {
    outcome: 'done',
    summary:
      'Synthetic documentation task finished without a verify capability.',
  })
  await updateTask(
    database,
    notesTask!.id,
    'merged',
    'Synthetic merged task. Untested: no verify capability (skipped test). No real merge ran.',
  )

  // Running: the lead is working on it.
  const running = await create(
    'Fix the typo on the pricing page',
    'The pricing page says "anually"; it should say "annually".',
  )
  await run(running)

  // Queued: nothing has picked it up yet.
  const queued = await create(
    'Update the README badges',
    'Replace the old CI badge with the GitHub Actions one.',
  )

  return {
    proofPassed,
    proofStale,
    done,
    waitingForMerge,
    askAfterLimit,
    approvePlan,
    cancelled,
    running,
    queued,
    lightsOutLead,
    lightsOutChild,
    lightsOutUntestedChild,
  }
}

function planFor(subject: string): string {
  return `## Goal

Deliver ${subject} without changing anything else.

## Acceptance scenarios

1. **Given** a signed-in shop owner, **when** they use ${subject}, **then** it works on desktop and mobile.
2. **Given** the feature is unused, **when** a page loads, **then** nothing looks or behaves differently.
3. **Given** a slow network, **when** the page loads, **then** no layout shift is visible.

## Approach

- Keep the change inside the existing components.
- Add unit tests for the new logic and one browser test for the main scenario.

## Out of scope

- Redesigning related pages.
`
}
