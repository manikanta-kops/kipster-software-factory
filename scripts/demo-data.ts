// Fills a database with repositories and quick-change tickets in every state, using the
// same store functions the engine and API use. The web app can be built against it
// before the engine exists.
import type { ArtifactInput } from '../src/domain/lifecycle.ts'
import type { Library } from '../src/library/library.ts'
import type { Database } from '../src/store/database.ts'
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
  readonly done: number
  readonly waitingForMerge: number
  readonly askAfterLimit: number
  readonly approvePlan: number
  readonly cancelled: number
  readonly running: number
  readonly queued: number
}

export async function seedDemo(
  database: Database,
  library: Library,
): Promise<DemoTickets> {
  await migrate(database)
  if (await getRepository(database, DEMO_REPOSITORY)) {
    throw new Error(`The database already has demo data (${DEMO_REPOSITORY})`)
  }
  const workflow = library.get('quick-change')
  if (!workflow) throw new Error('The library has no quick-change workflow')

  const shop = await createRepository(database, { slug: DEMO_REPOSITORY })
  await markRepositoryReady(database, shop.id)
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

  const create = async (title: string, body: string) =>
    (
      await createTicket(database, {
        repository: DEMO_REPOSITORY,
        workflow,
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
    },
    executor = 'claude-code',
  ) => {
    const [claimed] = await claimAttempts(database, 1)
    if (claimed?.ticket.number !== number) {
      throw new Error(`Expected to claim ticket #${number}'s attempt`)
    }
    await markRunning(database, claimed.attempt.id, executor)
    if (result) {
      await completeAttempt(database, claimed.attempt.id, {
        artifacts: [],
        ...result,
      })
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
      outcome: 'done',
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
      summary: 'Implemented the plan and added tests.',
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

  // Asking you: the reviewer sent the change back until its limit of two.
  const askAfterLimit = await create(
    'Validate email addresses on sign-up',
    'Reject malformed email addresses on the sign-up form with a clear message.',
  )
  await run(askAfterLimit, {
    outcome: 'done',
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
      summary: `Implemented validation (round ${round}).`,
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
    outcome: 'done',
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
    outcome: 'done',
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

  // Running: the planner is working on it.
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
    done,
    waitingForMerge,
    askAfterLimit,
    approvePlan,
    cancelled,
    running,
    queued,
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
