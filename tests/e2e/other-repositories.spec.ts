import type { TicketResponse } from '../../src/api/contract.ts'
import { test, expect } from './fixtures.ts'

test('New ticket selects optional registered dependencies and shows them on the ticket', async ({
  page,
  factory,
  request,
}) => {
  await page.goto(`${factory.url}/#/tickets/new`)
  await page
    .getByLabel('Repository', { exact: true })
    .selectOption('kipster/demo-shop')
  await expect(
    page.getByRole('radio', { name: /large-feature|^phase / }),
  ).toHaveCount(0)
  await page.getByRole('radio', { name: /^quick-change / }).check()
  await page
    .getByRole('group', { name: 'Read-only dependencies' })
    .getByRole('checkbox', { name: 'kipster/legacy-api' })
    .check()
  await page
    .getByLabel('Title', { exact: true })
    .fill('Use registered reference repositories')
  await page.getByRole('button', { name: 'Create ticket', exact: true }).click()
  await expect(
    page.getByRole('heading', {
      name: 'Use registered reference repositories',
    }),
  ).toBeVisible()
  const context = page.getByRole('region', { name: 'Repository context' })
  await expect(
    context.getByRole('heading', { name: 'Read-only dependencies' }),
  ).toBeVisible()
  await expect(context).toContainText('kipster/legacy-api')
  const number = page.url().split('/').at(-1)!
  const response = await request.get(`${factory.url}/api/tickets/${number}`)
  const detail = (await response.json()) as TicketResponse
  expect(detail.dependencies?.map((repository) => repository.slug)).toEqual([
    'kipster/legacy-api',
  ])
})

test.describe('linked tickets', () => {
  test.use({ withLinks: true })
  test('both tickets show their link and dependencies; cancelling the original keeps the linked ticket', async ({
    page,
    factory,
    request,
  }) => {
    const { original, linked } = factory.linkedTickets!
    await page.goto(`${factory.url}/#/tickets/${original}`)
    await expect(page.locator('.ticket-meta')).toContainText(
      `Waiting for linked ticket #${linked}`,
    )
    await expect(page.locator('.ticket-meta')).toContainText('queued')
    await expect(page.locator('.ticket-meta .badge.running')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Retry step' })).toHaveCount(
      0,
    )
    await expect(
      page.getByText(
        'Cancelling this ticket does not cancel its linked tickets.',
      ),
    ).toBeVisible()
    await page
      .getByRole('link', { name: `#${linked} Expose the library API` })
      .click()
    await expect(
      page.getByRole('link', { name: `#${original} Use the library API` }),
    ).toBeVisible()
    const context = page.getByRole('region', { name: 'Repository context' })
    await expect(
      context.getByRole('heading', { name: 'Read-only dependencies' }),
    ).toBeVisible()
    await expect(context).toContainText('kipster/demo-shop')
    await page
      .getByRole('link', { name: `#${original} Use the library API` })
      .click()
    await page
      .getByRole('button', { name: 'Cancel ticket', exact: true })
      .click()
    await expect(
      page.locator('.ticket-meta').getByText('cancelled', { exact: true }),
    ).toContainText('cancelled')
    const detail = (await (
      await request.get(`${factory.url}/api/tickets/${linked}`)
    ).json()) as TicketResponse
    expect(detail.ticket.status).toBe('queued')
  })
  test('the waiting header updates with the linked ticket status', async ({
    page,
    factory,
    request,
  }) => {
    const { original, linked } = factory.linkedTickets!
    await page.goto(`${factory.url}/#/tickets/${original}`)
    const header = page.locator('.ticket-meta')
    await expect(header).toContainText(`Waiting for linked ticket #${linked}`)
    await expect(header).toContainText('queued')
    const cancelled = await request.post(
      `${factory.url}/api/tickets/${linked}/cancel`,
      { data: {} },
    )
    expect(cancelled.ok()).toBeTruthy()
    await expect(header).toContainText('cancelled')
    await expect(header.locator('.badge.running')).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: 'Cancel ticket', exact: true }),
    ).toBeVisible()
  })
})
