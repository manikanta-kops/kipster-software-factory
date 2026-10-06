import type { TicketResponse } from '../../src/api/contract.ts'
import { test, expect } from './fixtures.ts'

test.use({ withTasks: true })

test('a lead ticket lists its tasks and each child links back to its lead', async ({
  page,
  factory,
  request,
}) => {
  const { lead, child } = factory.taskTickets!
  await page.goto(`${factory.url}/#/tickets/${lead}`)
  await expect(page.locator('.ticket-meta')).toContainText('Waiting for tasks')
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

  await api.getByRole('link', { name: `#${child}` }).click()
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
