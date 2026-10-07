import { test, expect } from './fixtures.ts'

test.use({ withLessons: true })
test('accept and reject suggestions without blocking tickets, then retire an accepted lesson', async ({
  page,
  factory,
  request,
}) => {
  await page.goto(`${factory.url}/#/`)
  const lessons = page.getByRole('region', { name: 'Lessons', exact: true })
  const repositoryLesson = lessons
    .getByRole('listitem')
    .filter({ hasText: 'Check empty inputs before review' })
  await repositoryLesson
    .getByRole('button', { name: 'Accept', exact: true })
    .click()
  await expect(repositoryLesson).toHaveCount(0)
  const engineLesson = lessons.getByRole('listitem').filter({
    hasText: 'Validate agent result files before reporting completion',
  })
  await engineLesson
    .getByRole('button', { name: 'Reject', exact: true })
    .click()
  await expect(engineLesson).toHaveCount(0)
  const response = await request.get(
    `${factory.url}/api/tickets/${factory.tickets.running}`,
  )
  expect((await response.json()).ticket.status).toBe('running')
  await page.goto(`${factory.url}/#/repositories`)
  const accepted = page.getByRole('region', {
    name: 'Accepted lessons',
    exact: true,
  })
  await expect(accepted).toContainText('Check empty inputs before review')
  await accepted.getByRole('button', { name: 'Retire', exact: true }).click()
  await accepted
    .getByLabel('Reason for retiring')
    .fill('Replaced by empty-input check')
  await accepted
    .getByRole('button', { name: 'Retire lesson', exact: true })
    .click()
  await expect(accepted).toHaveCount(0)
  const retired = await request.get(`${factory.url}/api/lessons?status=retired`)
  expect((await retired.json()).lessons[0].retiredReason).toBe(
    'Replaced by empty-input check',
  )
})

for (const colorScheme of ['light', 'dark'] as const) {
  for (const width of [390, 1280]) {
    test(`lessons at ${width}px in ${colorScheme}`, async ({
      page,
      factory,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
      await page.goto(`${factory.url}/#/`)
      const proposed = page.getByRole('region', {
        name: 'Lessons',
        exact: true,
      })
      await expect(proposed).toBeVisible()
      await expect(page.locator('output.status')).toHaveText('Live')
      expect(
        await page.evaluate(
          'document.documentElement.scrollWidth <= window.innerWidth',
        ),
      ).toBeTruthy()
      const proposedPath = testInfo.outputPath(
        `lessons-proposed-${width}-${colorScheme}.png`,
      )
      await proposed.screenshot({ path: proposedPath })
      await testInfo.attach('Proposed lessons', {
        path: proposedPath,
        contentType: 'image/png',
      })
      await proposed
        .getByRole('button', { name: 'Accept', exact: true })
        .first()
        .click()
      await page.goto(`${factory.url}/#/repositories`)
      const accepted = page.getByRole('region', {
        name: 'Accepted lessons',
        exact: true,
      })
      await expect(accepted).toBeVisible()
      await accepted
        .getByRole('button', { name: 'Retire', exact: true })
        .click()
      await accepted
        .getByLabel('Reason for retiring')
        .fill('Replaced by check X')
      expect(
        await page.evaluate(
          'document.documentElement.scrollWidth <= window.innerWidth',
        ),
      ).toBeTruthy()
      const acceptedPath = testInfo.outputPath(
        `lessons-accepted-${width}-${colorScheme}.png`,
      )
      await accepted.screenshot({ path: acceptedPath })
      await testInfo.attach('Accepted lessons and retirement', {
        path: acceptedPath,
        contentType: 'image/png',
      })
    })
  }
}

test('lesson decisions in another client update Today live', async ({
  page,
  factory,
  request,
}) => {
  await page.goto(`${factory.url}/#/`)
  const lessons = page.getByRole('region', { name: 'Lessons', exact: true })
  const target = lessons
    .getByRole('listitem')
    .filter({ hasText: 'Check empty inputs before review' })
  await expect(target).toBeVisible()
  await expect(page.locator('output.status')).toHaveText('Live')
  const response = await request.get(
    `${factory.url}/api/lessons?status=proposed`,
  )
  const proposed = (await response.json()).lessons.find(
    (lesson: { text: string }) =>
      lesson.text === 'Check empty inputs before review',
  )
  expect(
    (
      await request.post(`${factory.url}/api/lessons/${proposed.id}/accept`)
    ).ok(),
  ).toBeTruthy()
  await expect(target).toHaveCount(0)
})
