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
  await expect(page.locator('a[href$="/pull/42"]')).toHaveAttribute(
    'href',
    /pull\/42$/,
  )
  await expect(page.getByText('Add a dark mode toggle')).toBeHidden()
  await page.getByText('Show finished (2)').click()
  await expect(page.getByText('Add a dark mode toggle')).toBeVisible()
})

test('approve a plan', async ({ page, factory, request }) => {
  await page.goto(`${factory.url}/#/tickets/${factory.tickets.approvePlan}`)
  const panel = page.getByRole('region', {
    name: 'Review and approve the plan',
  })
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
    const decision = page
      .getByRole('region', { name: 'Timeline' })
      .locator('.attempt-entry')
      .first()
    await expect(decision).toContainText('human decision')
    await expect(decision).toContainText(
      action === 'retry'
        ? 'Retry requested'
        : action === 'move'
          ? 'Moved to build'
          : 'Cancelled',
    )
    if (action !== 'cancel')
      await expect(
        decision.getByText('Use the existing validation helper.', {
          exact: true,
        }),
      ).toBeVisible()
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
  await expect(page.getByRole('radio', { name: /^feature / })).toBeEnabled()
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
      data: {
        attemptId: detail.ticket.waiting!.attemptId,
        choice: 'approved',
        comment: 'Approved from another client.',
      },
    },
  )
  await expect(page.locator('.ticket-meta .badge')).toHaveText('queued')
  await expect(
    page.getByRole('button', { name: 'Approve', exact: true }),
  ).toHaveCount(0)
  const timeline = page.getByRole('region', { name: 'Timeline' })
  await expect(timeline.locator('.attempt-entry').first()).toContainText(
    'approved',
  )
  await expect(
    timeline.getByText('Approved from another client.', { exact: true }),
  ).toBeVisible()
  await expect(timeline.locator('.event-entry')).toHaveCount(0)
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
    await expect.poll(() => fetched.length).toBe(1)
    await expect(page.getByRole('heading', { name: 'Safe plan' })).toBeVisible()
    await expect(page.locator('.markdown script')).toHaveCount(0)
    await expect(
      page.getByRole('link', { name: 'Bad link' }),
    ).not.toHaveAttribute('href', /^javascript:/)
    await page.getByText('Planner log log').click()
    await expect(
      page.locator('pre').filter({ hasText: 'Planner started' }),
    ).toBeVisible()
    expect(fetched).toHaveLength(2)
    const log = page.getByLabel('Planner log', { exact: true })
    await log.focus()
    await page.keyboard.press('ArrowDown')
    await expect
      .poll(() => log.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0)
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

test('keyboard users can skip navigation, collapse and reopen the plan', async ({
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
  const content = page.locator('.action-panel').getByRole('heading', {
    name: 'Acceptance scenarios',
  })
  await expect(content).toBeVisible()
  await plan.focus()
  await page.keyboard.press('Enter')
  await expect(content).toBeHidden()
  await page.keyboard.press('Space')
  await expect(
    page
      .locator('.action-panel')
      .getByRole('heading', { name: 'Acceptance scenarios' }),
  ).toBeVisible()
})

test('timeline groups step runs and human decisions, with internal events behind a keyboard toggle', async ({
  page,
  factory,
}) => {
  await page.goto(`${factory.url}/#/tickets/${factory.tickets.askAfterLimit}`)
  const timeline = page.getByRole('region', { name: 'Timeline' })
  const runs = timeline.locator('.attempt-entry')
  await expect(runs).toHaveCount(8)
  await expect(runs.first()).toContainText('review')
  await expect(runs.first().locator('.badge')).toHaveText('changes needed')
  await expect(runs.first()).toContainText('The validation still accepts')
  await expect(runs.first().locator('.attempt-meta')).toContainText(/\d+s/)
  await expect(runs.first().getByText('Review round 2 finding')).toBeVisible()
  await expect(
    timeline.getByText('Also cover addresses with a plus sign, like', {
      exact: false,
    }),
  ).toBeVisible()
  await expect(timeline.locator('.event-entry')).toHaveCount(0)
  const times = await runs
    .locator('time')
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('datetime')!),
    )
  expect(times).toEqual([...times].sort().reverse())
  const toggle = timeline.getByRole('button', { name: 'Show all events' })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.focus()
  await page.keyboard.press('Space')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  for (const kind of [
    'attempt · claimed',
    'ticket · status',
    'attempt · queued',
    'artifact · added',
    'decision · made',
  ]) {
    await expect(
      timeline.getByText(kind, { exact: false }).first(),
    ).toBeVisible()
  }
  const allTimes = await timeline
    .locator('time')
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('datetime')!),
    )
  expect(allTimes).toEqual([...allTimes].sort().reverse())
  await page.keyboard.press('Enter')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(timeline.locator('.event-entry')).toHaveCount(0)
})

test('all-events preference survives live decisions and returns to a quiet timeline', async ({
  page,
  factory,
  request,
}) => {
  const number = factory.tickets.approvePlan
  await page.goto(`${factory.url}/#/tickets/${number}`)
  await expect(page.locator('output.status')).toHaveText('Live')
  const timeline = page.getByRole('region', { name: 'Timeline' })
  const toggle = timeline.getByRole('button', { name: 'Show all events' })
  await toggle.click()
  const detail = (await (
    await request.get(`${factory.url}/api/tickets/${number}`)
  ).json()) as TicketResponse
  await request.post(`${factory.url}/api/tickets/${number}/decision`, {
    data: {
      attemptId: detail.ticket.waiting!.attemptId,
      choice: 'changes-needed',
      comment: 'Include empty reports.',
    },
  })
  await expect(
    timeline.getByText('Include empty reports.', { exact: true }),
  ).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(
    timeline.getByText('decision · made · approve-plan', { exact: true }),
  ).toBeVisible()
  await toggle.click()
  await expect(timeline.locator('.attempt-entry')).toHaveCount(2)
  await expect(
    timeline.locator('.attempt-entry').first().locator('.badge'),
  ).toHaveText('changes needed')
  await expect(timeline.locator('.event-entry')).toHaveCount(0)
})

test('queued tickets keep internal events out of the default timeline', async ({
  page,
  factory,
}) => {
  await page.goto(`${factory.url}/#/tickets/${factory.tickets.queued}`)
  const timeline = page.getByRole('region', { name: 'Timeline' })
  await expect(
    timeline.getByText('No step runs or decisions yet.'),
  ).toBeVisible()
  await timeline.getByRole('button', { name: 'Show all events' }).click()
  await expect(
    timeline.getByText('attempt · queued · plan', { exact: true }),
  ).toBeVisible()
})

test('repositories show valid and invalid kits and gate workflows on capabilities', async ({
  page,
  factory,
}) => {
  await page.goto(`${factory.url}/#/repositories`)
  const valid = page
    .locator('.repository-list li')
    .filter({ hasText: 'kipster/demo-shop' })
  await expect(valid).toContainText('Kit: valid')
  await expect(valid.locator('.chip')).toHaveText(['setup', 'verify'])
  const invalid = page
    .locator('.repository-list li')
    .filter({ hasText: 'kipster/invalid-kit' })
  await expect(invalid).toContainText('Kit: invalid')
  await expect(invalid).toContainText('verify.ready:')
  await page.goto(`${factory.url}/#/tickets/new`)
  await page
    .getByLabel('Repository', { exact: true })
    .selectOption('kipster/invalid-kit')
  await expect(page.getByRole('radio', { name: /^feature / })).toBeDisabled()
  await expect(page.getByText(/needs a verified kit/).first()).toBeVisible()
})

test('demo evidence endpoints provide decodable image and video with recorded verdict commits', async ({
  page,
  factory,
  request,
}) => {
  const proof = (await (
    await request.get(
      `${factory.url}/api/tickets/${factory.tickets.proofPassed}`,
    )
  ).json()) as TicketResponse
  const image = proof.artifacts.find((a) => a.mediaType === 'image/png')!
  const video = proof.artifacts.find((a) => a.mediaType === 'video/webm')!
  expect(proof.attempts.find((a) => a.stepId === 'test')!.headCommit).toMatch(
    /^[a-f0-9]{40}$/,
  )
  await page.goto(factory.url)
  await page.setContent(
    `<img src="${factory.url}/api/artifacts/${image.id}"><video src="${factory.url}/api/artifacts/${video.id}" preload="auto"></video>`,
  )
  await expect
    .poll(() =>
      page
        .locator('img')
        .evaluate(
          (element) =>
            (element as unknown as { naturalWidth: number }).naturalWidth,
        ),
    )
    .toBe(320)
  await expect
    .poll(() =>
      page
        .locator('video')
        .evaluate(
          (element) =>
            (element as unknown as { readyState: number }).readyState,
        ),
    )
    .toBeGreaterThanOrEqual(2)
  expect(
    await page
      .locator('video')
      .evaluate(
        (element) => (element as unknown as { videoWidth: number }).videoWidth,
      ),
  ).toBe(32)
  type SeekingVideo = {
    duration: number
    currentTime: number
    seekable: { length: number; end(index: number): number }
  }
  const duration = await page
    .locator('video')
    .evaluate((element) => (element as unknown as SeekingVideo).duration)
  await expect
    .poll(() =>
      page.locator('video').evaluate((element) => {
        const player = element as unknown as SeekingVideo
        return player.seekable.length ? player.seekable.end(0) : 0
      }),
    )
    .toBeGreaterThan(0)
  await page.locator('video').evaluate((element) => {
    const player = element as unknown as SeekingVideo
    player.currentTime = player.duration / 2
  })
  await expect
    .poll(() =>
      page
        .locator('video')
        .evaluate(
          (element) => (element as unknown as SeekingVideo).currentTime,
        ),
    )
    .toBeCloseTo(duration / 2, 2)
})
