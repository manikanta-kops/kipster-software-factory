import { test, expect } from './fixtures.ts'
import type { TicketResponse, TicketsResponse } from '../../src/api/contract.ts'

test('home separates attention, progress and finished tickets', async ({
  page,
  factory,
}) => {
  await page.goto(factory.url)
  await expect(
    page.getByRole('heading', { name: 'Needs you', exact: true }),
  ).toBeVisible()
  await expect(page.locator('output.status')).toHaveText('Live')
  await expect(page.getByText('A loop reached its limit.')).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Open pull request' }),
  ).toHaveAttribute('href', /pull\/42$/)
  await expect(page.getByText('Add a dark mode toggle')).toBeHidden()
  await page.getByText('Show finished (2)').click()
  await expect(page.getByText('Add a dark mode toggle')).toBeVisible()
})

test('approve a plan', async ({ page, factory, request }) => {
  await page.goto(`${factory.url}/#/tickets/${factory.tickets.approvePlan}`)
  const panel = page.getByRole('region', {
    name: 'Review and approve the plan',
  })
  await panel.getByText('Plan', { exact: true }).click()
  await expect(
    panel.getByRole('heading', { name: 'Acceptance scenarios' }),
  ).toBeVisible()
  await panel.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(page.locator('.ticket-meta .badge')).toHaveText('queued')
  const detail = (await (
    await request.get(
      `${factory.url}/api/tickets/${factory.tickets.approvePlan}`,
    )
  ).json()) as TicketResponse
  expect(detail.ticket.currentStep).toBe('build')
  expect(
    detail.attempts.some((attempt) => attempt.outcome === 'approved'),
  ).toBeTruthy()
})

test('request changes requires and saves a comment', async ({
  page,
  factory,
  request,
}) => {
  await page.goto(`${factory.url}/#/tickets/${factory.tickets.approvePlan}`)
  await page.getByRole('button', { name: 'Request changes' }).click()
  await expect(page.getByRole('alert')).toHaveText(
    'Add a comment to explain the changes needed.',
  )
  await page
    .getByLabel('Comment')
    .fill('Cover empty reports and **Unicode** filenames.')
  await page.getByRole('button', { name: 'Request changes' }).click()
  await expect(page.locator('.ticket-meta .badge')).toHaveText('queued')
  const detail = (await (
    await request.get(
      `${factory.url}/api/tickets/${factory.tickets.approvePlan}`,
    )
  ).json()) as TicketResponse
  expect(detail.ticket.currentStep).toBe('plan')
  expect(
    detail.artifacts.some(
      (item) => item.kind === 'comment' && item.content?.includes('Unicode'),
    ),
  ).toBeTruthy()
})

for (const action of ['retry', 'move', 'cancel'] as const)
  test(`resolve an ask: ${action}`, async ({ page, factory, request }) => {
    const number = factory.tickets.askAfterLimit
    await page.goto(`${factory.url}/#/tickets/${number}`)
    await expect(
      page.getByRole('heading', { name: 'A loop reached its limit.' }),
    ).toBeVisible()
    if (action !== 'cancel') {
      await page.getByRole('button', { name: 'Retry step' }).click()
      await expect(page.getByRole('alert')).toHaveText(
        'Add a note for the next attempt.',
      )
      await page
        .getByLabel('Note', { exact: false })
        .fill('Use the existing validation helper.')
    }
    if (action === 'move')
      await page.getByLabel('Move to step').selectOption('build')
    await page
      .getByRole('button', {
        name:
          action === 'retry'
            ? 'Retry step'
            : action === 'move'
              ? 'Move ticket'
              : 'Cancel ticket',
      })
      .click()
    await expect(page.locator('.ticket-meta .badge')).toHaveText(
      action === 'cancel' ? 'cancelled' : 'queued',
    )
    const detail = (await (
      await request.get(`${factory.url}/api/tickets/${number}`)
    ).json()) as TicketResponse
    expect(detail.ticket.currentStep).toBe(
      action === 'move' ? 'build' : 'review',
    )
    if (action !== 'cancel')
      expect(
        detail.artifacts.some(
          (item) =>
            item.kind === 'note' && item.content?.includes('validation helper'),
        ),
      ).toBeTruthy()
  })

test('reject a plan', async ({ page, factory }) => {
  await page.goto(`${factory.url}/#/tickets/${factory.tickets.approvePlan}`)
  await page.getByRole('button', { name: 'Reject', exact: true }).click()
  await expect(page.locator('.ticket-meta .badge')).toHaveText('cancelled')
})

test('create a ticket and explain unavailable workflows', async ({
  page,
  factory,
}) => {
  await page.goto(factory.url)
  await page.getByRole('link', { name: 'New ticket' }).click()
  await page
    .getByLabel('Repository', { exact: true })
    .selectOption('kipster/demo-shop')
  await expect(page.getByRole('radio', { name: /^feature / })).toBeDisabled()
  await expect(page.getByText(/Missing capabilities:/).first()).toBeVisible()
  await page.getByRole('radio', { name: /^quick-change / }).check()
  await page
    .getByLabel('Title', { exact: true })
    .fill('Export reports with Unicode filenames')
  await page
    .getByLabel('Description')
    .fill('## Goal\n\nPreserve **all** characters.')
  await page.getByText('Preview description').click()
  await expect(page.getByRole('heading', { name: 'Goal' })).toBeVisible()
  await page.getByRole('button', { name: 'Create ticket' }).click()
  await expect(
    page.getByRole('heading', {
      name: 'Export reports with Unicode filenames',
    }),
  ).toBeVisible()
  await expect(page).toHaveURL(/#\/tickets\/\d+$/)
  await expect(page.locator('.ticket-meta .badge')).toHaveText('queued')
})

test('pending repositories disable every workflow', async ({
  page,
  factory,
}) => {
  await page.goto(`${factory.url}/#/tickets/new`)
  await page
    .getByLabel('Repository', { exact: true })
    .selectOption('kipster/website')
  for (const radio of await page.getByRole('radio').all())
    await expect(radio).toBeDisabled()
  await expect(
    page
      .getByText('Repository is pending. It must be ready to start a ticket.')
      .first(),
  ).toBeVisible()
})

for (const input of [
  'acme/shop',
  'https://github.com/acme/tools.git',
  'git@github.com:acme/ssh-tools.git',
])
  test(`add repository: ${input}`, async ({ page, factory }) => {
    await page.goto(`${factory.url}/#/repositories`)
    await expect(
      page.getByText('git clone failed: Repository not found.'),
    ).toBeVisible()
    await page.getByLabel('Add a repository').fill(input)
    await page
      .getByRole('button', { name: 'Add repository', exact: true })
      .click()
    await expect(
      page.getByRole('status').filter({ hasText: 'Repository added' }),
    ).toBeVisible()
    await expect(
      page.getByRole('heading', {
        name: input.replace(/^.*[:/]acme\//, 'acme/').replace(/\.git$/, ''),
      }),
    ).toBeVisible()
  })

test('live updates reconcile another client, reconnect, and keep one stream across navigation', async ({
  page,
  factory,
  request,
  context,
}) => {
  let streams = 0
  page.on('request', (req) => {
    if (new URL(req.url()).pathname === '/api/events') streams++
  })
  await page.goto(`${factory.url}/#/tickets/${factory.tickets.approvePlan}`)
  await expect(page.locator('output.status')).toHaveText('Live')
  const detail = (await (
    await request.get(
      `${factory.url}/api/tickets/${factory.tickets.approvePlan}`,
    )
  ).json()) as TicketResponse
  await request.post(
    `${factory.url}/api/tickets/${detail.ticket.number}/decision`,
    {
      data: { attemptId: detail.ticket.waiting!.attemptId, choice: 'approved' },
    },
  )
  await expect(page.locator('.ticket-meta .badge')).toHaveText('queued')
  await expect(
    page.getByRole('button', { name: 'Approve', exact: true }),
  ).toHaveCount(0)
  await page.getByRole('link', { name: 'Repositories', exact: true }).click()
  await page.getByRole('link', { name: 'Needs you', exact: true }).click()
  expect(streams).toBe(1)
  await context.setOffline(true)
  await request.post('/__test/disconnect', { data: { url: factory.url } })
  await expect(page.locator('output.status')).toHaveText('Reconnecting')
  await request.post(`${factory.url}/api/tickets`, {
    data: {
      repository: 'kipster/demo-shop',
      workflow: 'quick-change',
      title: 'Arrived while disconnected',
    },
  })
  await context.setOffline(false)
  await expect(page.locator('output.status')).toHaveText('Live', {
    timeout: 15_000,
  })
  await expect(page.getByText('Arrived while disconnected')).toBeVisible()
})

test.describe('artifact files', () => {
  test.use({ withArtifacts: true })
  test('artifacts render safe markdown and fetch logs only when expanded', async ({
    page,
    factory,
  }) => {
    const fetched: string[] = []
    page.on('request', (req) => {
      if (req.url().includes('/api/artifacts/')) fetched.push(req.url())
    })
    await page.goto(`${factory.url}/#/tickets/${factory.artifactTicket}`)
    await expect(
      page.getByRole('heading', { name: 'Inspect artifacts safely' }),
    ).toBeVisible()
    expect(fetched).toHaveLength(0)
    await page.locator('.action-panel').getByText('Safety plan plan').click()
    await expect(page.getByRole('heading', { name: 'Safe plan' })).toBeVisible()
    await expect(page.locator('.markdown script')).toHaveCount(0)
    await expect(
      page.getByRole('link', { name: 'Bad link' }),
    ).not.toHaveAttribute('href', /^javascript:/)
    await page.getByText('Planner log log').click()
    await expect(
      page.locator('pre').filter({ hasText: 'Planner started' }),
    ).toBeVisible()
    expect(fetched).toHaveLength(1)
  })
})

test('workflows render steps and loops, with direct hash links and back navigation', async ({
  page,
  factory,
}) => {
  await page.goto(`${factory.url}/#/workflows/large-feature`)
  await expect(
    page.getByRole('heading', { name: 'large-feature' }),
  ).toBeVisible()
  await expect(page.getByText('after 2 rounds → maintain-pr')).toBeVisible()
  await page.getByRole('link', { name: /^bug / }).click()
  await expect(page).toHaveURL(/#\/workflows\/bug$/)
  const diagram = page.getByRole('figure', { name: 'bug workflow' })
  await expect(diagram.getByText('reproduce', { exact: true })).toBeVisible()
  await expect(diagram.getByText('changes-needed → fix').first()).toBeVisible()
  await expect(diagram.locator('path.edge.back')).not.toHaveCount(0)
  await page.goBack()
  await expect(
    page.getByRole('heading', { name: 'large-feature' }),
  ).toBeVisible()
})

test('empty attention keeps the quiet home message', async ({
  page,
  factory,
  request,
}) => {
  const { tickets } = (await (
    await request.get(`${factory.url}/api/tickets`)
  ).json()) as TicketsResponse
  for (const ticket of tickets.filter((item) => item.status === 'needs-you'))
    await request.post(`${factory.url}/api/tickets/${ticket.number}/cancel`, {
      data: {},
    })
  await page.goto(factory.url)
  await expect(
    page.getByRole('heading', { name: 'Nothing needs you.' }),
  ).toBeVisible()
  await expect(page.getByRole('heading', { name: 'In progress' })).toBeVisible()
})

test('runtime API base directs fetch and live events to a separate factory', async ({
  page,
  factory,
}) => {
  await page.addInitScript((base) => {
    Object.assign(globalThis, { KIPSTER_API_BASE_URL: base })
  }, factory.url)
  const requests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/api/')) requests.push(request.url())
  })
  await page.goto('/#/tickets/new')
  await expect(page.locator('output.status')).toHaveText('Live')
  await page
    .getByLabel('Repository', { exact: true })
    .selectOption('kipster/demo-shop')
  await page.getByRole('radio', { name: /^quick-change / }).check()
  await page
    .getByLabel('Title', { exact: true })
    .fill('Created through configured API')
  await page.getByRole('button', { name: 'Create ticket' }).click()
  await expect(
    page.getByRole('heading', { name: 'Created through configured API' }),
  ).toBeVisible()
  expect(requests.length).toBeGreaterThan(3)
  expect(
    requests.every((url) => url.startsWith(`${factory.url}/api/`)),
  ).toBeTruthy()
  expect(requests.filter((url) => url.endsWith('/api/events'))).toHaveLength(1)
})

test('keyboard users can skip navigation and expand the plan', async ({
  page,
  factory,
}) => {
  await page.goto(`${factory.url}/#/tickets/${factory.tickets.approvePlan}`)
  await expect(
    page.getByRole('heading', { name: 'Add CSV export to reports' }),
  ).toBeVisible()
  const skip = page.getByRole('link', { name: 'Skip to content' })
  await skip.focus()
  await expect(skip).toBeInViewport()
  await page.keyboard.press('Enter')
  await expect(page.locator('main')).toBeFocused()
  const plan = page.locator('.action-panel summary')
  await plan.focus()
  await page.keyboard.press('Enter')
  await expect(
    page
      .locator('.action-panel')
      .getByRole('heading', { name: 'Acceptance scenarios' }),
  ).toBeVisible()
})
