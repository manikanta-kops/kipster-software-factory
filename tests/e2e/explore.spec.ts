import { test, expect } from './fixtures.ts'

test.use({ withExplore: true })

test('a ticket without a repository can explore but not open a pull request', async ({
  page,
  factory,
}) => {
  await page.goto(`${factory.url}/#/tickets/new`)
  await page
    .getByLabel('Repository', { exact: true })
    .selectOption('No repository')
  const lead = page.getByRole('radio', { name: /^lead/ })
  await expect(lead).toBeDisabled()
  await expect(
    page
      .locator('label', { has: lead })
      .getByText('Opens a pull request, so it needs a repository.'),
  ).toBeVisible()
  await expect(page.getByRole('radio', { name: /^research / })).toBeEnabled()
  await page.getByRole('radio', { name: /^explore/ }).check()
  await page.getByLabel('Title').fill('Moodboard for the onboarding')
  await page.getByRole('button', { name: 'Create ticket' }).click()
  await expect(page).toHaveURL(/#\/tickets\/\d+$/)
  await expect(
    page.getByRole('heading', { name: 'Moodboard for the onboarding' }),
  ).toBeVisible()
  await expect(page.locator('.ticket-kicker')).toContainText('No repository')
  const details = page.getByRole('region', { name: 'Details' })
  await expect(details).toContainText('No repository')
  await expect(details.getByText('Pull request')).toHaveCount(0)
  await page.goto(`${factory.url}/#/repositories`)
  await expect(page.getByText('_local/scratch')).toHaveCount(0)
})

test('an output opens sandboxed: its styles and scripts run, the factory API stays out of reach', async ({
  page,
  factory,
}) => {
  await page.goto(`${factory.url}/#/tickets/${factory.exploreTicket}`)
  const outputs = page.getByRole('region', { name: 'Outputs' })
  await expect(outputs).toBeVisible()
  const [design] = await Promise.all([
    page.waitForEvent('popup'),
    outputs.getByRole('link', { name: 'Calm home page' }).click(),
  ])
  await expect(design).toHaveURL(/\/files\/[0-9a-f-]{36}\/$/)
  await expect(design.getByRole('heading', { name: 'Calm home' })).toHaveCSS(
    'color',
    'rgb(0, 128, 128)',
  )
  await expect(design.locator('#script')).toHaveText('script ran')
  await expect(design.locator('#api')).toHaveText('API blocked')
  expect(await design.evaluate('window.origin')).toBe('null')
})
