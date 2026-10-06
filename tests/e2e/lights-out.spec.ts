import { test, expect } from './fixtures.ts'

test('lights-out defaults follow workflow until touched, and the chosen value is saved', async ({
  page,
  factory,
  request,
}) => {
  await page.goto(`${factory.url}/#/tickets/new`)
  await page
    .getByLabel('Repository', { exact: true })
    .selectOption('kipster/demo-shop')
  const checkbox = page.getByRole('checkbox', { name: /Lights-out/ })
  await expect(checkbox).not.toBeChecked()
  await page.getByRole('radio', { name: /^lead / }).check()
  await expect(checkbox).toBeChecked()
  await page.getByRole('radio', { name: /^quick-change / }).check()
  await expect(checkbox).not.toBeChecked()
  const upload = await request.post(`${factory.url}/api/workflows`, {
    data: {
      source:
        'name: program-lead\ndescription: Program lead fixture\nsteps:\n  - id: build\n    kind: agent\n    role: builder\n',
    },
  })
  expect(upload.ok()).toBeTruthy()
  await page.reload()
  await page
    .getByLabel('Repository', { exact: true })
    .selectOption('kipster/demo-shop')
  await page.getByRole('radio', { name: /^program-lead / }).check()
  await expect(checkbox).toBeChecked()
  await checkbox.uncheck()
  await page.getByRole('radio', { name: /^lead / }).check()
  await expect(checkbox).not.toBeChecked()
  await checkbox.check()
  await page.getByRole('radio', { name: /^quick-change / }).check()
  await expect(checkbox).toBeChecked()
  await page.getByLabel('Title', { exact: true }).fill('Overnight ticket')
  await page.getByRole('button', { name: 'Create ticket', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Overnight ticket', exact: true }),
  ).toBeVisible()
  await expect(
    page.locator('.ticket-meta').getByText('Lights-out', { exact: true }),
  ).toBeVisible()
  const number = page.url().split('/').at(-1)
  const detail = await (
    await request.get(`${factory.url}/api/tickets/${number}`)
  ).json()
  expect(detail.ticket.lightsOut).toBe(true)
})

test.describe('decision list', () => {
  test.use({ withArtifacts: true, withTasks: true })
  test('shows typed choices and links to decisions from child tasks', async ({
    page,
    factory,
  }) => {
    await page.goto(`${factory.url}/#/tickets/${factory.artifactTicket}`)
    await expect(
      page.locator('.ticket-meta').getByText('Lights-out', { exact: true }),
    ).toBeVisible()
    const log = page.getByRole('region', { name: 'Decision log', exact: true })
    await expect(
      log.getByRole('heading', { name: 'Storage choice' }),
    ).toBeVisible()
    await expect(log.getByText('PostgreSQL', { exact: true })).toBeVisible()
    await expect(log.getByText('A file', { exact: true })).toBeVisible()
    await expect(
      log.getByText('Keep writes transactional', { exact: true }),
    ).toBeVisible()
    await page.goto(`${factory.url}/#/tickets/${factory.taskTickets!.lead}`)
    const link = page
      .getByRole('region', { name: 'Decision log' })
      .getByRole('link', { name: /Decisions from Add the export endpoint/ })
    await expect(link).toHaveAttribute(
      'href',
      `#/tickets/${factory.taskTickets!.child}`,
    )
    await link.click()
    await expect(
      page.getByRole('heading', {
        name: 'Add the export endpoint',
        exact: true,
      }),
    ).toBeVisible()
  })
})
