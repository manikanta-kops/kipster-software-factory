import type { TicketResponse, TicketsResponse } from '../../src/api/contract.ts'
import { test, expect } from './fixtures.ts'

test.use({ withTasks: true })

test('a lead ticket lists its tasks and each child links back to its lead', async ({
  page,
  factory,
  request,
}) => {
  const { lead, child } = factory.taskTickets!
  await page.goto(`${factory.url}/#/tickets/${lead}`)
  await expect(page.getByRole('region', { name: 'Now' })).toContainText(
    'Waiting for tasks',
  )
  await expect(page.getByRole('button', { name: 'Retry step' })).toHaveCount(0)
  const tasks = page.getByRole('region', { name: 'Tasks' })
  await expect(tasks.getByRole('heading', { name: 'Tasks' })).toBeVisible()
  const api = tasks.getByRole('listitem').filter({ hasText: 'api-export' })
  await expect(api).toContainText('Add the export endpoint')
  await expect(api.locator('.badge.running')).toBeVisible()
  await expect(api).toContainText('Lead branch · claude · opus · high')
  const docs = tasks.getByRole('listitem').filter({ hasText: 'docs' })
  await expect(docs.locator('.badge.pr-ready')).toHaveText('PR ready')
  await expect(docs).toContainText('Own pull request')
  await expect(docs).toContainText('Pull request ready for a decision.')
  await expect(
    tasks.getByText('Cancelling this ticket cancels its unfinished tasks.'),
  ).toBeVisible()
  await expect(tasks.getByRole('heading', { name: 'Tasks' })).toContainText(
    '2 of 4 finished',
  )

  const inProgress = tasks.getByRole('list', { name: 'Tasks in progress' })
  await expect(inProgress.getByRole('listitem')).toHaveCount(2)
  const finishedToggle = tasks.getByRole('button', { name: /Finished/ })
  await expect(finishedToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(finishedToggle).toContainText('1 merged')
  await expect(finishedToggle).toContainText('1 failed')
  const finished = tasks.getByRole('list', { name: 'Finished tasks' })
  await expect(finished).toHaveCount(0)
  await finishedToggle.click()
  await expect(finished.getByRole('listitem')).toHaveCount(2)
  const fixtures = finished
    .getByRole('listitem')
    .filter({ hasText: 'fixtures' })
  await expect(fixtures.locator('.badge.failed')).toHaveText('Failed')
  await expect(fixtures).not.toContainText('No work was produced.')
  await fixtures.getByRole('button', { name: /Seed export fixtures/ }).click()
  await expect(fixtures).toContainText('No work was produced.')
  await expect(fixtures).toContainText('Lead branch')

  await api.getByRole('link', { name: `#${child}` }).click()
  await expect(page.locator('.ticket-meta')).toContainText(
    'Untested: no verify capability (skipped test)',
  )
  await page.reload()
  await expect(page.locator('.ticket-meta')).toContainText(
    'Untested: no verify capability (skipped test)',
  )
  const parent = page.getByRole('region', { name: 'Tasks' })
  await expect(
    parent.getByRole('heading', { name: 'Lead ticket' }),
  ).toBeVisible()
  await expect(parent).toContainText('Task api-export of')
  await parent
    .getByRole('link', { name: `#${lead} Build the export feature` })
    .click()
  await expect(
    page.getByRole('heading', { name: 'Build the export feature' }),
  ).toBeVisible()

  const leadDetail = (await (
    await request.get(`${factory.url}/api/tickets/${lead}`)
  ).json()) as TicketResponse
  expect(leadDetail.tasks?.map((task) => [task.key, task.status])).toEqual([
    ['api-export', 'running'],
    ['docs', 'pr-ready'],
    ['schema', 'merged'],
    ['fixtures', 'failed'],
  ])
  const childDetail = (await (
    await request.get(`${factory.url}/api/tickets/${child}`)
  ).json()) as TicketResponse
  expect(childDetail.parentTask).toMatchObject({
    key: 'api-export',
    land: 'branch',
    parent: { number: lead },
  })
})

test('Today folds the child tickets of a lead under it until expanded', async ({
  page,
  factory,
  request,
}) => {
  const { lead, child } = factory.taskTickets!
  const { tickets } = (await (
    await request.get(`${factory.url}/api/tickets`)
  ).json()) as TicketsResponse
  expect(tickets.find((item) => item.number === child)?.task).toEqual({
    key: 'api-export',
    leadNumber: lead,
  })
  expect(tickets.find((item) => item.number === lead)?.task).toBeNull()

  await page.goto(factory.url)
  const moving = page.getByRole('region', { name: 'Moving', exact: true })
  await expect(
    moving.getByRole('link', { name: /Build the export feature/ }),
  ).toBeVisible()
  const childRow = moving.getByRole('link', { name: /Add the export endpoint/ })
  await expect(childRow).toHaveCount(0)
  const toggle = moving.getByRole('button', { name: /\d+ tasks?/ })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(childRow).toBeVisible()
  await expect(childRow).toContainText('api-export')
  await childRow.click()
  await expect(
    page.getByRole('heading', { name: 'Add the export endpoint' }),
  ).toBeVisible()
})
