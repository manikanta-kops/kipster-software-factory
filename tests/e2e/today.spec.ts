import { test, expect } from './fixtures.ts'
import type { TicketResponse, TicketsResponse } from '../../src/api/contract.ts'

test('Today gives a lead with a replaced task one row that never reads Blocked', async ({
  page,
  factory,
  request,
}) => {
  const { replacedLead, replacedChild, replacementChild } = factory.tickets
  const { tickets } = (await (
    await request.get(`${factory.url}/api/tickets`)
  ).json()) as TicketsResponse
  expect(tickets.find((item) => item.number === replacedChild)?.task).toEqual({
    key: 'export-fix',
    leadNumber: replacedLead,
    replacedBy: replacementChild,
  })

  await page.goto(factory.url)
  await expect(page.locator('output.status')).toHaveText('Live')
  await expect(page.getByText('Ticket summaries')).toHaveCount(0)
  const lead = page.getByRole('link', {
    name: 'Export order history (synthetic demo)',
    exact: true,
  })
  await expect(lead).toHaveCount(1)
  const needs = page.getByRole('region', { name: 'Needs you', exact: true })
  const row = needs.locator('.decision').filter({ has: lead })
  await expect(row.locator('.summary-status')).toHaveText('Needs you · 1')
  await expect(row.locator('.decision-happened')).toHaveText(
    /^1 task merged · 1 replaced · /,
  )
  // Sub-tasks have no rows of their own.
  for (const title of [
    'Fix the order history export (synthetic demo)',
    'Fix the order history export on the new query (synthetic demo)',
  ])
    await expect(page.getByRole('link', { name: title })).toHaveCount(0)
  const toggle = row.getByRole('button', { name: /2 tasks/ })
  await expect(toggle).toContainText('1 Done · 1 Replaced')
  await toggle.click()
  const replaced = row.getByRole('link', {
    name: /Fix the order history export \(synthetic demo\)/,
  })
  await expect(replaced).toContainText(`Replaced by #${replacementChild}`)
  await expect(row).not.toContainText('Blocked')
  await expect(row).not.toContainText('Cancelled')

  // A lead whose task waits for the owner needs the owner, with the count on its pill.
  const parked = needs.locator('.decision').filter({
    has: page.getByRole('link', {
      name: 'Overnight report export (synthetic demo)',
      exact: true,
    }),
  })
  await expect(parked.locator('.summary-status')).toHaveText('Needs you · 1')
  await expect(parked.locator('.decision-question')).toContainText(
    'Task export-endpoint:',
  )
  await expect(parked.locator('.decision-happened')).toHaveCount(0)
  await expect(
    parked.getByRole('link', { name: 'Decide', exact: true }),
  ).toHaveAttribute('href', `#/tickets/${factory.tickets.lightsOutChild}`)

  await replaced.click()
  const card = page.getByRole('region', { name: 'Ticket summary', exact: true })
  await expect(card).toBeVisible()
  await expect(card.locator('.summary-status')).toHaveText(
    `Replaced by #${replacementChild}`,
  )
  await expect(card).not.toContainText('Blocked')
  await card
    .getByRole('link', { name: `Replaced by #${replacementChild}` })
    .click()
  await expect(page).toHaveURL(`${factory.url}/#/tickets/${replacementChild}`)

  await page.goto(`${factory.url}/#/tickets/${replacedLead}`)
  const summary = page.getByRole('region', {
    name: 'Ticket summary',
    exact: true,
  })
  await expect(summary.locator('.summary-status')).toHaveText('Needs you · 1')
  await expect(summary.locator('.summary-happened')).toContainText('1 replaced')
  await expect(summary.getByRole('list', { name: 'Issues' })).toHaveCount(0)
  const tasks = page.getByRole('region', { name: 'Tasks' })
  const finished = tasks.getByRole('button', { name: /Finished/ })
  await expect(finished).toContainText('1 merged')
  await expect(finished).toContainText('1 replaced')
  await expect(finished).not.toContainText('failed')
  await finished.click()
  await expect(
    tasks.getByRole('list', { name: 'Finished tasks' }),
  ).toContainText(`Replaced by #${replacementChild}`)
  const detail = (await (
    await request.get(`${factory.url}/api/tickets/${replacedChild}`)
  ).json()) as TicketResponse
  expect(detail.parentTask?.replacedBy).toBe(replacementChild)
})
