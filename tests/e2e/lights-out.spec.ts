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

test('seeded decision list shows typed choices and links to child decisions', async ({
  page,
  factory,
}, testInfo) => {
  await page.goto(`${factory.url}/#/tickets/${factory.tickets.lightsOutLead}`)
  await expect(
    page.locator('.ticket-meta').getByText('Lights-out', { exact: true }),
  ).toBeVisible()
  const log = page.getByRole('region', { name: 'Decision log', exact: true })
  await expect(
    log.getByRole('heading', { name: 'Export format (synthetic demo)' }),
  ).toBeVisible()
  for (const label of ['Chose', 'Alternative', 'Reason'])
    await expect(log.getByText(label, { exact: true })).toBeVisible()
  await expect(log.getByText('CSV', { exact: true })).toBeVisible()
  await expect(
    log.getByText('An Excel workbook', { exact: true }),
  ).toBeVisible()
  await expect(
    log.getByText(
      'CSV works with the existing report data and common spreadsheet tools.',
      { exact: true },
    ),
  ).toBeVisible()
  const leadScreenshot = testInfo.outputPath('seeded-lead-decisions.png')
  await log.screenshot({ path: leadScreenshot })
  await testInfo.attach('Seeded lead decision log', {
    path: leadScreenshot,
    contentType: 'image/png',
  })
  const link = log.getByRole('link', {
    name: /Decisions from Add the report export endpoint/,
  })
  await expect(link).toHaveAttribute(
    'href',
    `#/tickets/${factory.tickets.lightsOutChild}`,
  )
  await link.click()
  await expect(
    page.getByRole('heading', {
      name: 'Add the report export endpoint (synthetic demo)',
      exact: true,
    }),
  ).toBeVisible()
  const childLog = page.getByRole('region', {
    name: 'Decision log',
    exact: true,
  })
  await expect(
    childLog.getByRole('heading', {
      name: 'CSV column order (synthetic demo)',
    }),
  ).toBeVisible()
  await expect(
    childLog.getByText('Use the displayed report column order', {
      exact: true,
    }),
  ).toBeVisible()
  await expect(
    childLog.getByText('Sort columns alphabetically', { exact: true }),
  ).toBeVisible()
  await expect(
    childLog.getByText(
      'Matching the report makes the export familiar to shop owners.',
      { exact: true },
    ),
  ).toBeVisible()
  const childScreenshot = testInfo.outputPath('seeded-child-decisions.png')
  await childLog.screenshot({ path: childScreenshot })
  await testInfo.attach('Seeded child decision log', {
    path: childScreenshot,
    contentType: 'image/png',
  })
})
