import { test, expect } from './fixtures.ts'
import type { TicketResponse } from '../../src/api/contract.ts'

test('evidence belongs to its test run, media uses the configured API, and logs load on demand', async ({
  page,
  factory,
  request,
}) => {
  const detail = (await (
    await request.get(
      `${factory.url}/api/tickets/${factory.tickets.proofPassed}`,
    )
  ).json()) as TicketResponse
  const log = detail.artifacts.find((artifact) => artifact.kind === 'log')!
  const fetched: string[] = []
  page.on('request', (resource) => {
    if (resource.url().includes('/api/artifacts/')) fetched.push(resource.url())
  })
  await page.addInitScript((url) => {
    Object.assign(globalThis, { KIPSTER_API_BASE_URL: url })
  }, factory.url)
  await page.goto(`/#/tickets/${factory.tickets.proofPassed}`)
  const run = page.locator('.attempt-entry').filter({
    has: page.getByRole('heading', { name: 'test tester', exact: true }),
  })
  await expect(run.locator('.attempt-meta')).toContainText('Commit aaaaaaa')
  const thumbnail = run.getByRole('button', {
    name: 'Enlarge Cart image (synthetic demo)',
  })
  await expect(thumbnail).toBeVisible()
  await thumbnail.focus()
  await page.keyboard.press('Enter')
  const viewer = page.getByRole('dialog', {
    name: 'Cart image (synthetic demo)',
  })
  await expect(viewer).toBeVisible()
  await expect(
    viewer.getByRole('button', { name: 'Close image' }),
  ).toBeFocused()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(
    viewer.getByRole('button', { name: 'Close image' }),
  ).toBeFocused()
  await expect
    .poll(() =>
      viewer
        .locator('img')
        .evaluate(
          (image) =>
            (image as unknown as { naturalWidth: number }).naturalWidth,
        ),
    )
    .toBe(320)
  await page.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)
  await expect(thumbnail).toBeFocused()
  await page.keyboard.press('Space')
  await viewer.getByRole('button', { name: 'Close image' }).click()
  await expect(thumbnail).toBeFocused()
  const video = run.locator('video')
  await expect(video).toHaveAttribute('controls', '')
  await expect(video).not.toHaveAttribute('autoplay')
  await expect
    .poll(() =>
      video.evaluate(
        (element) => (element as unknown as { readyState: number }).readyState,
      ),
    )
    .toBeGreaterThanOrEqual(2)
  expect(fetched).not.toContain(`${factory.url}/api/artifacts/${log.id}`)
  await run
    .getByText('Cart driving log (synthetic demo) log', { exact: true })
    .click()
  await expect(run.getByLabel(log.title, { exact: true })).toContainText(
    'Observed: quantity 2; total €24.00',
  )
  await expect(run.getByLabel(log.title, { exact: true })).toHaveAttribute(
    'tabindex',
    '0',
  )
  expect(
    fetched.filter((url) => url.endsWith(`/artifacts/${log.id}`)),
  ).toHaveLength(1)
  expect(
    fetched.every((url) => url.startsWith(`${factory.url}/api/artifacts/`)),
  ).toBeTruthy()
})

test('passed and stale verdicts link their tested commit; review outcomes are not tester verdicts', async ({
  page,
  factory,
}) => {
  await page.goto(`${factory.url}/#/tickets/${factory.tickets.proofPassed}`)
  const verdict = page.getByRole('region', { name: 'Latest tester verdict' })
  await expect(verdict.getByRole('heading')).toHaveText('Verified at aaaaaaa')
  await expect(verdict.getByRole('link', { name: 'aaaaaaa' })).toHaveAttribute(
    'href',
    `https://github.com/kipster/demo-shop/commit/${'a'.repeat(40)}`,
  )
  await page.goto(`${factory.url}/#/tickets/${factory.tickets.proofStale}`)
  await expect(verdict.getByRole('heading')).toHaveText(
    'Stale: new commits since verification',
  )
  await expect(verdict.getByRole('link', { name: 'aaaaaaa' })).toHaveAttribute(
    'href',
    /\/commit\/a{40}$/,
  )
  await expect(
    page.locator('.attempt-meta').filter({ hasText: 'Commit bbbbbbb' }),
  ).toHaveCount(1)
  await page.goto(`${factory.url}/#/tickets/${factory.tickets.askAfterLimit}`)
  await expect(verdict).toHaveCount(0)
})

test.describe('failed tester verdict', () => {
  test.use({ verdict: 'changes-needed' })
  for (const colorScheme of ['light', 'dark'] as const) {
    for (const width of [390, 1280]) {
      test(`latest failed verdict and safe findings at ${width}px in ${colorScheme}`, async ({
        page,
        factory,
      }, testInfo) => {
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
        await page.goto(
          `${factory.url}/#/tickets/${factory.tickets.proofStale}`,
        )
        const verdict = page.getByRole('region', {
          name: 'Latest tester verdict',
        })
        await expect(
          verdict.getByRole('heading', { name: 'Changes needed', exact: true }),
        ).toBeVisible()
        await expect(
          verdict.getByRole('heading', { name: 'Quantity change' }),
        ).toBeVisible()
        await expect(verdict).toContainText(
          'changing quantity leaves the total unchanged.',
        )
        await expect(
          verdict.getByRole('link', { name: 'bbbbbbb' }),
        ).toHaveAttribute('href', /\/commit\/b{40}$/)
        await expect(verdict.locator('script')).toHaveCount(0)
        await expect(verdict).not.toContainText('Verified at')
        expect(
          await page.evaluate(
            'document.documentElement.scrollWidth <= window.innerWidth',
          ),
        ).toBeTruthy()
        const path = testInfo.outputPath(
          `changes-needed-${width}-${colorScheme}.png`,
        )
        await page.screenshot({ path })
        await testInfo.attach('Changes needed', {
          path,
          contentType: 'image/png',
        })
      })
    }
  }
})

test.describe('legacy verdict', () => {
  test.use({ verdict: 'unobserved' })
  test('a missing commit never inherits an older verification', async ({
    page,
    factory,
  }) => {
    await page.goto(`${factory.url}/#/tickets/${factory.tickets.proofStale}`)
    const verdict = page.getByRole('region', { name: 'Latest tester verdict' })
    await expect(verdict.getByRole('heading')).toHaveText(
      'Verification commit unknown',
    )
    await expect(verdict).toContainText('Current changes are not verified.')
    await expect(verdict.getByRole('link')).toHaveCount(0)
  })
})

test('invalid kits explain disabled workflows and create an onboarding ticket in one click', async ({
  page,
  factory,
  request,
}) => {
  await page.goto(`${factory.url}/#/tickets/new`)
  await page
    .getByLabel('Repository', { exact: true })
    .selectOption('kipster/invalid-kit')
  for (const name of ['feature', 'bug']) {
    const choice = page.getByRole('radio', { name: new RegExp(`^${name} `) })
    await expect(choice).toBeDisabled()
    await expect(choice).toHaveAccessibleName(/needs a verified kit/)
  }
  await page.getByRole('button', { name: 'Start onboard-repo ticket' }).click()
  await expect(
    page.getByRole('heading', {
      name: 'Verify the kit for kipster/invalid-kit',
    }),
  ).toBeVisible()
  const number = page.url().split('/').at(-1)
  const detail = (await (
    await request.get(`${factory.url}/api/tickets/${number}`)
  ).json()) as TicketResponse
  expect(detail.ticket.repository.slug).toBe('kipster/invalid-kit')
  expect(detail.workflow.name).toBe('onboard-repo')
  expect(detail.ticket.status).toBe('queued')
  expect(detail.ticket.currentStep).toBe('write-kit')
})

test('onboarding shortcut follows repository readiness and kit capabilities', async ({
  page,
  factory,
}) => {
  await page.goto(`${factory.url}/#/tickets/new`)
  const repository = page.getByLabel('Repository', { exact: true })
  const shortcut = page.getByRole('button', {
    name: 'Start onboard-repo ticket',
  })
  for (const slug of [
    'kipster/website',
    'kipster/legacy-api',
    'kipster/demo-shop',
  ]) {
    await repository.selectOption(slug)
    await expect(shortcut).toHaveCount(0)
  }
  await expect(page.getByRole('radio', { name: /^feature / })).toBeEnabled()
})
