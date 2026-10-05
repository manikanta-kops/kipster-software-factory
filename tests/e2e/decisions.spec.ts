import { test, expect } from './fixtures.ts'
import type {
  TicketResponse,
  DecisionsResponse,
} from '../../src/api/contract.ts'
test.use({ withDecisions: true })
for (const override of [false, true])
  test(`confirm band: ${override ? 'override' : 'accept'} routes and logs owner choice`, async ({
    page,
    factory,
    request,
  }, testInfo) => {
    await page.goto(`${factory.url}/#/tickets/${factory.decisionTicket}`)
    const panel = page.getByRole('region', {
      name: 'Confirm the proposed option',
    })
    await expect(panel).toBeVisible()
    const confirmScreenshot = testInfo.outputPath('confirm-band.png')
    await page.screenshot({ path: confirmScreenshot, fullPage: true })
    await testInfo.attach('Confirm band', {
      path: confirmScreenshot,
      contentType: 'image/png',
    })
    await expect(panel.getByText(/Confidence: 80.0%/)).toBeVisible()
    await panel
      .getByRole('button', {
        name: override ? 'Choose review' : 'Accept proceed',
        exact: true,
      })
      .click()
    await expect(panel).toBeHidden()
    const detail = (await (
      await request.get(`${factory.url}/api/tickets/${factory.decisionTicket}`)
    ).json()) as TicketResponse
    expect(detail.ticket.currentStep).toBe(override ? 'inspect' : 'accept')
    expect(detail.decisions![0]!.finalOption).toBe(
      override ? 'review' : 'proceed',
    )
    expect(detail.decisions![0]!.overridden).toBe(override)
    await expect(
      page.getByText(
        override
          ? /Answer: review · decided by owner · owner override/
          : /Answer: proceed · decided by owner/,
      ),
    ).toBeVisible()
    await page.getByRole('link', { name: 'Decisions', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: 'Decisions', exact: true }),
    ).toBeVisible()
    const counts = page
      .getByRole('row')
      .filter({ hasText: 'decision-fixture / classify' })
    await expect(counts.getByRole('cell').nth(1)).toHaveText('1')
    await expect(counts.getByRole('cell').nth(2)).toHaveText('1')
    await expect(counts.getByRole('cell').nth(3)).toHaveText(
      override ? '1' : '0',
    )
    const response = (await (
      await request.get(`${factory.url}/api/decisions`)
    ).json()) as DecisionsResponse
    expect(response.steps[0]!.overrides).toBe(override ? 1 : 0)
    const decisionsScreenshot = testInfo.outputPath('decisions-page.png')
    await page.screenshot({ path: decisionsScreenshot, fullPage: true })
    await testInfo.attach('Decisions page', {
      path: decisionsScreenshot,
      contentType: 'image/png',
    })
  })
test('Decisions page puts pending owner choices first and links back to the ticket', async ({
  page,
  factory,
}) => {
  await page.goto(`${factory.url}/#/decisions`)
  await expect(
    page.getByRole('heading', { name: 'Needs you', exact: true }),
  ).toBeVisible()
  await expect(page.getByText('Awaiting owner decision')).toBeVisible()
  await page
    .getByRole('link', {
      name: `#${factory.decisionTicket} · decision-fixture / classify`,
    })
    .click()
  await expect(
    page.getByRole('button', { name: 'Accept proceed' }),
  ).toBeVisible()
})

for (const colorScheme of ['light', 'dark'] as const)
  test(`decision controls and counts fit a phone in ${colorScheme}`, async ({
    page,
    factory,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme })
    for (const path of [`/tickets/${factory.decisionTicket}`, '/decisions']) {
      await page.goto(`${factory.url}/#${path}`)
      await expect(
        page.getByText('Awaiting owner decision').first(),
      ).toBeVisible()
      expect(
        await page.evaluate(
          'document.documentElement.scrollWidth <= window.innerWidth',
        ),
      ).toBeTruthy()
    }
  })
