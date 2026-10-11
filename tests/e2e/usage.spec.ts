import { test, expect } from './fixtures.ts'

test('a ticket shows what each step run cost in a collapsed usage table', async ({
  page,
  factory,
}) => {
  await page.goto(`${factory.url}/#/tickets/${factory.tickets.done}`)
  const usage = page.getByRole('region', { name: 'Usage' })
  const summary = usage.locator('summary')
  await expect(summary).toHaveText('Usage · ↑5.1M ↓65.3k · 3h 18m')
  await expect(usage.locator('details')).not.toHaveAttribute('open')
  await expect(usage.getByRole('table')).toBeHidden()

  await summary.click()
  const rows = usage.getByRole('table').locator('tbody tr')
  await expect(rows).toHaveCount(7)
  const cells = (index: number) => rows.nth(index).locator('td')
  await expect(cells(0)).toHaveText([
    'Lead round 1',
    'claude-code',
    'plan-ready',
    '412k',
    '9.8k',
    '4m 12s',
  ])
  await expect(cells(1)).toHaveText([
    'Approve plan',
    'human',
    'approved',
    '—',
    '—',
    '18m 0s',
  ])
  await expect(cells(2)).toHaveText([
    'Lead round 2',
    'claude-code',
    'done',
    '2.9M',
    '35.7k',
    '41m 5s',
  ])
  await expect(cells(3)).toHaveText([
    'Final test',
    'claude-code',
    'passed',
    '1.2M',
    '12.4k',
    '7m 40s',
  ])
  await expect(cells(5)).toHaveText([
    'Pull request',
    'system',
    'ready',
    '—',
    '—',
    '46s',
  ])
  await expect(cells(6).last()).toHaveText('2h 3m')
})

test('a step that ran more than once shows its round', async ({
  page,
  factory,
}) => {
  await page.goto(`${factory.url}/#/tickets/${factory.tickets.askAfterLimit}`)
  const usage = page.getByRole('region', { name: 'Usage' })
  await usage.locator('summary').click()
  const steps = usage.locator('tbody tr td:first-child')
  await expect(steps).toHaveText([
    'Lead round 1',
    'Approve plan round 1',
    'Lead round 2',
    'Approve plan round 2',
    'Lead round 3',
    'Final test round 1',
    'Review round 1',
    'Lead round 4',
    'Final test round 2',
    'Review round 2',
  ])
})

test.describe('lead tickets', () => {
  test.use({ withTasks: true, withUsage: true })

  test('a lead ticket totals its tasks and links each task to its own table', async ({
    page,
    factory,
  }) => {
    const { lead, child } = factory.taskTickets!
    await page.goto(`${factory.url}/#/tickets/${lead}`)
    const usage = page.getByRole('region', { name: 'Usage' })
    await expect(usage.locator('summary')).toHaveText(
      'Usage · ↑1.3M ↓181k · 8m 26s',
    )
    await usage.locator('summary').click()
    const rows = usage.locator('tbody tr')
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0).locator('td')).toHaveText([
      'Lead',
      'claude',
      'delegate',
      '1.2M',
      '180k',
      '7m 40s',
    ])
    await expect(rows.nth(1).locator('td')).toHaveText([
      `Task api-export #${child}`,
      '1 step run',
      'running',
      '35.7k',
      '950',
      '46s',
    ])
    await expect(rows.nth(2).locator('td')).toHaveText([
      /^Task docs #\d+$/,
      '0 step runs',
      'pr-ready',
      '—',
      '—',
      '0s',
    ])

    await usage.getByRole('link', { name: `api-export #${child}` }).click()
    await expect(page).toHaveURL(new RegExp(`#/tickets/${child}$`))
    const own = page.getByRole('region', { name: 'Usage' })
    await expect(own.locator('summary')).toHaveText('Usage · ↑35.7k ↓950 · 46s')
    await own.locator('summary').click()
    await expect(own.locator('tbody tr td')).toHaveText([
      'Build',
      'claude · opus · high',
      'done',
      '35.7k',
      '950',
      '46s',
    ])
  })
})
