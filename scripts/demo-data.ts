import { evaluateMergeGate, type MergeFacts } from '../src/domain/merge-gate.ts'
import { checksResult } from '../src/engine/pull-requests.ts'
import { mergedTaskResult } from '../src/engine/tasks.ts'
import { checkerVerdict, untestedReasons } from '../src/domain/task-testing.ts'
import type { run as runCommand } from '../src/executors/process.ts'
import { inspectChecks } from '../src/github/checks.ts'
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
  reportTasks,
  startTask,
  updateTask,
} from '../src/store/tasks.ts'
import { migrate } from '../src/store/migrate.ts'
import { saveUploadedWorkflow } from '../src/store/workflows.ts'
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

// Preserve the retired workflow source without making it available for new tickets.
const RETIRED_QUICK_CHANGE = `name: quick-change
description: Agree a plan with you, build it, have it reviewed and land it. Needs nothing from the repository's kit.
steps:
  - id: plan
    kind: agent
    role: planner

  - id: approve-plan
    kind: human
    routes:
      changes-needed: plan

  - id: build
    kind: agent
    role: builder

  - id: review
    kind: agent
    role: reviewer
    limit: 2
    routes:
      changes-needed: build

  - id: maintain-pr
    kind: system
    action: maintain-pr
    routes:
      conflict: build
      ci-failed: build
      base-moved: review

  - id: merge
    kind: system
    action: merge
`

// An uploaded workflow that unfinished tickets use, so removing it is refused.
const SYNTHETIC_UPLOAD = `name: synthetic-review
description: Synthetic uploaded demo workflow. Build it and have it reviewed.
steps:
  - id: build
    kind: agent
    role: builder

  - id: review
    kind: agent
    role: reviewer
    limit: 2
    routes:
      changes-needed: build
`

/** Ticket numbers of the demo tickets, by the state each one is left in. */
export interface DemoTickets {
  readonly proofPassed: number
  readonly proofStale: number
  readonly done: number
  readonly waitingForMerge: number
  readonly askAfterLimit: number
  readonly approvePlan: number
  readonly planToApprove: number
  readonly planToChange: number
  readonly planToReject: number
  readonly askToRetry: number
  readonly askToMove: number
  readonly askToCancel: number
  readonly cancelled: number
  readonly running: number
  readonly queued: number
  readonly retiredWorkflow: number
  readonly lightsOutLead: number
  readonly lightsOutChild: number
  readonly lightsOutUntestedChild: number
  readonly uploadRunning: number
  readonly uploadLead: number
  readonly uploadChild: number
  readonly bundleFailed: number
  readonly bundlePending: number
  readonly checkedWithoutVerifyLead: number
  readonly checkedWithoutVerifyChild: number
  readonly checkedWithVerifyLead: number
  readonly checkedWithVerifyChild: number
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
  const docs = await createRepository(database, { slug: 'kipster/docs-site' })
  await markRepositoryReady(database, docs.id, {
    kit: { status: 'valid', error: null, capabilities: ['setup'] },
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
  /** Reviews two rounds until the review limit asks the owner. */
  const reachReviewLimit = async (
    number: number,
    accepted: string,
    finding: string,
  ) => {
    for (const round of [1, 2]) {
      await run(number, {
        outcome: 'done',
        summary: `Coordinated validation (round ${round}).`,
      })
      await run(number, {
        outcome: 'passed',
        summary: 'Tested validation.',
      })
      await run(number, {
        outcome: 'changes-needed',
        summary: `The validation still accepts ${accepted}.`,
        artifacts: [
          {
            kind: 'finding',
            title: `Review round ${round}`,
            content: `- **Blocking:** ${accepted} passes validation; ${finding}\n- Minor: the error message is not announced to screen readers.`,
          },
        ],
      })
    }
  }
  await reachReviewLimit(askAfterLimit, '`a@b`', 'require a dot in the domain.')

  /** Leaves a plan waiting for your approval. */
  const waitForPlanApproval = async (
    title: string,
    body: string,
    subject: string,
  ) => {
    const number = await create(title, body)
    await run(number, {
      outcome: 'plan-ready',
      summary: 'Wrote the plan with three acceptance scenarios.',
      artifacts: [{ kind: 'plan', title: 'Plan', content: planFor(subject) }],
    })
    return number
  }

  // Waiting for you to approve the plan.
  const approvePlan = await waitForPlanApproval(
    'Add CSV export to reports',
    'Let shop owners download any report as CSV from the report page.',
    'CSV export of reports',
  )

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
        title: 'Document report exports (synthetic unverified demo)',
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
      body: 'Synthetic task with an unverified item: no agents, code changes or verification ran.',
    },
    null,
  )
  const lightsOutUntestedChild = notesChild!.number
  await run(lightsOutUntestedChild, {
    outcome: 'done',
    summary:
      'Synthetic documentation task finished without a verify capability.',
  })
  await run(lightsOutUntestedChild, {
    outcome: 'passed',
    summary:
      'Synthetic checker: read the change without an app; one item stays unverified.',
    artifacts: [
      {
        kind: 'evidence',
        title: 'Export docs not viewed in a browser (synthetic demo)',
        content: 'Synthetic: no app was started and nothing ran.',
        scenario: 'Read the export docs',
        scenarioResult: 'unverified',
      },
    ],
  })
  await updateTask(
    database,
    notesTask!.id,
    'merged',
    mergedTaskResult(
      'f'.repeat(40),
      checkerVerdict(
        (await getTicketDetail(database, lightsOutUntestedChild))!,
      ),
    ),
  )

  // Every task and the final change are checked, with or without the kit's app.
  // Routing, task results and gates come from the real lifecycle and engine code.
  const checkedLead = async (input: {
    repository: string
    title: string
    task: { key: string; title: string }
    commits: { task: string; lead: string }
    pull: number
    checks: { summary: string; artifacts: ArtifactInput[] }
  }) => {
    const lead = (
      await createTicket(database, {
        repository: input.repository,
        workflow: leadWorkflow,
        lightsOut: true,
        title: input.title,
        body: 'Synthetic lights-out demo of the checker on every task and the final change. No real agents, code or verification ran.',
      })
    ).number
    await run(lead, {
      outcome: 'plan-ready',
      summary: 'Prepared the synthetic plan for automatic approval.',
      artifacts: [
        { kind: 'plan', title: 'Plan', content: planFor(input.task.title) },
      ],
    })
    await run(lead, {
      outcome: 'delegate',
      summary: 'Delegated one synthetic task.',
      tasks: [
        {
          key: input.task.key,
          title: input.task.title,
          instructions: `Synthetic demo task: ${input.task.title}.`,
          land: 'branch',
        },
      ],
    })
    const tasks = await run(lead, undefined, 'system')
    await parkForTasks(database, tasks.attempt.id)
    const [task] = await listTasks(database, tasks.ticket.id)
    const checked = (await startTask(
      database,
      task!.id,
      {
        repository: input.repository,
        workflow: taskWorkflow,
        title: task!.title,
        body: 'Synthetic child task: no agents, code changes or verification ran.',
      },
      null,
    ))!.number
    await run(
      checked,
      { outcome: 'done', summary: 'Synthetic builder committed the change.' },
      'claude-code',
      input.commits.task,
    )
    const test = await run(
      checked,
      { outcome: 'passed', ...input.checks },
      'codex',
      input.commits.task,
    )
    if (test.attempt.stepId !== 'test')
      throw new Error(
        `Expected #${checked} to be checked, not ${test.attempt.stepId}`,
      )
    await updateTask(
      database,
      task!.id,
      'merged',
      mergedTaskResult(
        input.commits.lead,
        checkerVerdict((await getTicketDetail(database, checked))!),
      ),
    )
    await reportTasks(database, tasks.attempt.id)
    await run(
      lead,
      { outcome: 'done', summary: 'The task landed on the lead branch.' },
      'claude-code',
      input.commits.lead,
    )
    const final = await run(
      lead,
      {
        outcome: 'passed',
        ...input.checks,
        summary: `Final check of the whole change. ${input.checks.summary}`,
      },
      'codex',
      input.commits.lead,
    )
    if (final.attempt.stepId !== 'final-test')
      throw new Error(
        `Expected #${lead}'s final check, not ${final.attempt.stepId}`,
      )
    await run(
      lead,
      { outcome: 'passed', summary: 'Reviewed the checked commit.' },
      'codex',
      input.commits.lead,
    )
    await run(
      lead,
      { outcome: 'ready', summary: 'Opened the pull request; CI is green.' },
      'system',
      input.commits.lead,
    )
    await openPullRequestAndWait(lead, input.pull)
    // Identical gate facts; only what the latest checker reported differs.
    const detail = (await getTicketDetail(database, lead))!
    const head = input.commits.lead
    const checker = { status: 'finished', outcome: 'passed', commit: head }
    await saveMergeGate(
      database,
      detail.ticket.id,
      evaluateMergeGate(
        {
          untestedReasons: untestedReasons(detail),
          head,
          localHead: head,
          base: 'c'.repeat(40),
          behind: 0,
          tester: checker,
          hasTester: true,
          hasReviewer: true,
          reviewer: checker,
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
          paths: [],
          migrationGlobs: [],
          trustedKitError: null,
          approvedUnverified: null,
        },
        new Date().toISOString(),
      ),
    )
    return { lead, child: checked }
  }
  const withoutVerify = await checkedLead({
    repository: 'kipster/docs-site',
    title: 'Document the API rate limits (checked without verify)',
    task: {
      key: 'rate-limit-page',
      title: 'Write the rate limit page (checked without verify)',
    },
    commits: { task: '1'.repeat(40), lead: '2'.repeat(40) },
    pull: 46,
    checks: {
      summary:
        'Synthetic checker: the kit has no verify block, so it read the diff and ran the tests in a disposable checkout. One item stays unverified.',
      artifacts: [
        {
          kind: 'evidence',
          title: 'Rate limit page not opened (synthetic demo)',
          content:
            'Synthetic: no app was started and nothing ran. The checker could not open the page in a browser.',
          scenario: 'Open the rate limit page in a browser',
          scenarioResult: 'unverified',
        },
      ],
    },
  })
  const withVerify = await checkedLead({
    repository: DEMO_REPOSITORY,
    title: 'Show stock levels on product pages (checked with verify)',
    task: {
      key: 'stock-badge',
      title: 'Add the stock badge (checked with verify)',
    },
    commits: { task: '3'.repeat(40), lead: '4'.repeat(40) },
    pull: 47,
    checks: {
      summary:
        "Synthetic checker: drove the kit's running app; every scenario passed.",
      artifacts: [
        {
          kind: 'evidence',
          title: 'Stock badge on a product page (synthetic demo)',
          content: 'Synthetic: observed In stock: 12 on the product page.',
          scenario: 'A product page shows its stock level',
          scenarioResult: 'passed',
        },
      ],
    },
  })

  const retired = parseUpload(RETIRED_QUICK_CHANGE)
  if (!retired.ok) {
    throw new Error(
      `Cannot parse the historical quick-change demo workflow: ${retired.errors.join('; ')}`,
    )
  }
  const retiredWorkflow = await create(
    'Historical quick-change ticket',
    'This ticket ran a retired quick-change workflow.',
    retired.entry,
  )
  await run(retiredWorkflow, {
    outcome: 'done',
    summary: 'Historical plan ready.',
    artifacts: [
      {
        kind: 'plan',
        title: 'Historical plan',
        content:
          'Retain the old workflow history. Keep its completed plan readable after quick-change is retired from the library.',
      },
    ],
  })

  // Running on an uploaded workflow, and a lead whose running child task uses it.
  const upload = parseUpload(SYNTHETIC_UPLOAD)
  if (!upload.ok) {
    throw new Error(
      `Cannot parse the synthetic uploaded workflow: ${upload.errors.join('; ')}`,
    )
  }
  await saveUploadedWorkflow(database, upload.entry)
  const uploadRunning = await create(
    'Shorten the checkout labels (synthetic upload)',
    'Synthetic ticket running an uploaded workflow; no real agent is running.',
    upload.entry,
  )
  await run(uploadRunning)
  const uploadLead = (
    await createTicket(database, {
      repository: DEMO_REPOSITORY,
      workflow: leadWorkflow,
      title: 'Tidy the cart copy (synthetic upload lead)',
      body: 'Synthetic lead with a task that runs the uploaded synthetic-review workflow. No real agents ran.',
    })
  ).number
  await run(uploadLead, {
    outcome: 'plan-ready',
    summary: 'Prepared the synthetic cart copy plan for automatic approval.',
    artifacts: [{ kind: 'plan', title: 'Plan', content: planFor('cart copy') }],
  })
  await run(uploadLead, {
    outcome: 'delegate',
    summary: 'Delegated the synthetic cart copy task.',
    tasks: [
      {
        key: 'cart-copy',
        title: 'Tidy the cart copy (synthetic upload task)',
        instructions: 'Tidy the wording on the cart page.',
        land: 'branch',
        workflow: upload.entry.workflow.name,
      },
    ],
  })
  const uploadTasks = await run(uploadLead, undefined, 'system')
  await parkForTasks(database, uploadTasks.attempt.id)
  const [cartTask] = await listTasks(database, uploadTasks.ticket.id)
  const uploadChildTicket = await startTask(
    database,
    cartTask!.id,
    {
      repository: DEMO_REPOSITORY,
      workflow: upload.entry,
      title: cartTask!.title,
      body: 'Synthetic child task running the uploaded workflow; no real agent is running.',
    },
    null,
  )
  const uploadChild = uploadChildTicket!.number
  await run(uploadChild)

  // Running: the lead is working on it.
  const running = await create(
    'Fix the typo on the pricing page',
    'The pricing page says "anually"; it should say "annually".',
  )
  await run(running)

  // One plan and one ask for each owner action, so every verification scenario
  // can run on one instance without consuming another scenario's ticket. They
  // come before the CI tickets, whose pending build attempt run() would claim.
  const planToApprove = await waitForPlanApproval(
    'Add gift notes to orders (plan to approve)',
    'Let shoppers add a short gift note at checkout.',
    'gift notes on orders',
  )
  const planToChange = await waitForPlanApproval(
    'Add a size guide to product pages (plan to change)',
    'Show a size guide next to the size picker on clothing pages.',
    'a size guide on product pages',
  )
  const planToReject = await waitForPlanApproval(
    'Add a loyalty points page (plan to reject)',
    'Show shoppers the loyalty points they have earned.',
    'a loyalty points page',
  )
  const ask = async (title: string, subject: string, accepted: string) => {
    const number = await create(
      title,
      `Reject malformed ${subject} with a clear message.`,
      historical.entry,
    )
    await planAndApprove(number, planFor(`${subject} validation`))
    await reachReviewLimit(number, accepted, 'reject it with a clear message.')
    return number
  }
  const askToRetry = await ask(
    'Validate postcodes at checkout (ask to retry)',
    'postcodes at checkout',
    '`ABC`',
  )
  const askToMove = await ask(
    'Validate phone numbers on the account page (ask to move)',
    'phone numbers on the account page',
    '`12`',
  )
  const askToCancel = await ask(
    'Validate coupon codes in the cart (ask to cancel)',
    'coupon codes in the cart',
    '`!!!`',
  )

  // CI outcomes come from the real check inspection and maintain-pr result, fed fixture gh output.
  const taskPr = library.get('task-pr')
  if (!taskPr) throw new Error('The library has no task-pr workflow')
  const ciTicket = async (
    title: string,
    body: string,
    head: string,
    pull: number,
    bundle: object,
    logs: Record<string, string>,
  ) => {
    const number = await create(title, body, taskPr)
    await run(
      number,
      { outcome: 'done', summary: 'Built the change and committed it.' },
      'claude-code',
      head,
    )
    await run(
      number,
      { outcome: 'passed', summary: 'Tested the change at its head.' },
      'codex',
      head,
    )
    await run(
      number,
      { outcome: 'passed', summary: 'Reviewed the tested commit.' },
      'codex',
      head,
    )
    const maintain = await run(number, undefined, 'system')
    const url = `https://github.com/${DEMO_REPOSITORY}/pull/${pull}`
    await setPullRequestUrl(database, maintain.ticket.id, url)
    await waitForPullRequestMerge(
      database,
      maintain.attempt.id,
      'pull-request-checks',
      head,
    )
    const checks = await inspectChecks(
      fixtureGh(
        head,
        [
          {
            kind: 'CheckRun',
            name: 'Demo repository checks',
            isRequired: true,
            status: 'COMPLETED',
            conclusion: 'SUCCESS',
            detailsUrl: `https://github.com/${DEMO_REPOSITORY}/actions/runs/${pull}0/job/${pull}1`,
            databaseId: Number(`${pull}1`),
          },
          bundle,
        ],
        logs,
      ),
      DEMO_REPOSITORY,
      url,
      head,
      AbortSignal.timeout(10_000),
    )
    await saveMergeGate(
      database,
      maintain.ticket.id,
      evaluateMergeGate(
        {
          head,
          localHead: head,
          base: 'c'.repeat(40),
          behind: 0,
          tester: { status: 'finished', outcome: 'passed', commit: head },
          hasTester: true,
          hasReviewer: true,
          reviewer: { status: 'finished', outcome: 'passed', commit: head },
          reproducer: null,
          hasReproducer: false,
          ci: checks.state,
          checks: checks.checks ?? [],
          feedback: [],
          buildWork: false,
          state: 'OPEN',
          draft: false,
          mergeable: 'MERGEABLE',
          paths: [],
          migrationGlobs: [],
          trustedKitError: null,
          approvedUnverified: [],
        },
        new Date().toISOString(),
      ),
    )
    const result = checksResult(checks, url)
    if (!result) throw new Error(`Demo CI for #${number} is still awaited`)
    await completeAttempt(database, maintain.attempt.id, result, {
      headCommit: head,
    })
    return number
  }
  const bundlePending = await ciTicket(
    'Optional check still running',
    'Synthetic demo: the required check passed while the optional **Bundle** check is still running. maintain-pr does not wait for it. No real GitHub or agents ran.',
    'e'.repeat(40),
    45,
    {
      kind: 'CheckRun',
      name: 'Bundle',
      isRequired: false,
      status: 'IN_PROGRESS',
      conclusion: null,
      detailsUrl: `https://github.com/${DEMO_REPOSITORY}/actions/runs/450/job/452`,
      databaseId: 452,
    },
    {},
  )
  await openPullRequestAndWait(bundlePending, 45)
  // Left queued at build: the scheduler is off, so the builder never picks it up.
  const bundleFailed = await ciTicket(
    'Bundle check failed on the pull request',
    'Synthetic demo: the required check passed but the optional **Bundle** check failed, so maintain-pr sent the ticket back to the builder. No real GitHub or agents ran.',
    'd'.repeat(40),
    44,
    {
      kind: 'CheckRun',
      name: 'Bundle',
      isRequired: false,
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      detailsUrl: `https://github.com/${DEMO_REPOSITORY}/actions/runs/440/job/442`,
      databaseId: 442,
    },
    {
      '442':
        'Bundle\tSize\tdist/assets/index.js is 312.4 kB, over the 250 kB budget (synthetic demo)\nBundle\tSize\tError: Process completed with exit code 1.',
    },
  )

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
    planToApprove,
    planToChange,
    planToReject,
    askToRetry,
    askToMove,
    askToCancel,
    cancelled,
    running,
    queued,
    lightsOutLead,
    lightsOutChild,
    lightsOutUntestedChild,
    retiredWorkflow,
    uploadRunning,
    uploadLead,
    uploadChild,
    bundleFailed,
    bundlePending,
    checkedWithoutVerifyLead: withoutVerify.lead,
    checkedWithoutVerifyChild: withoutVerify.child,
    checkedWithVerifyLead: withVerify.lead,
    checkedWithVerifyChild: withVerify.child,
  }
}

/** Answers the gh calls check inspection makes with fixed pull request checks. */
function fixtureGh(
  head: string,
  nodes: readonly object[],
  logs: Readonly<Record<string, string>>,
): typeof runCommand {
  return async (command, args) => {
    const call = `${command} ${args.join(' ')}`
    if (command === 'gh' && args[0] === 'api' && args[1] === 'graphql')
      return JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              headRefOid: head,
              baseRefName: 'main',
              baseRef: { branchProtectionRule: null },
            },
            object: {
              statusCheckRollup: {
                contexts: {
                  nodes,
                  pageInfo: { hasNextPage: false, endCursor: '' },
                },
              },
            },
          },
        },
      })
    if (command === 'gh' && args[0] === 'api' && args.includes('--slurp'))
      return '[[]]'
    const job = args[args.indexOf('--job') + 1] ?? ''
    if (command === 'gh' && args[0] === 'run' && logs[job] !== undefined)
      return logs[job]
    throw new Error(`Unexpected demo GitHub call: ${call}`)
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
