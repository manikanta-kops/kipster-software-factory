import { test, expect } from './fixtures.ts'

for (const colorScheme of ['light', 'dark'] as const) {
  for (const size of ['phone', 'desktop'] as const) {
    test(`${size} pages in ${colorScheme}`, async ({
      page,
      factory,
    }, testInfo) => {
      await page.setViewportSize(
        size === 'phone'
          ? { width: 390, height: 844 }
          : { width: 1280, height: 900 },
      )
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
      const pages = [
        {
          name: 'proof',
          route: `/tickets/${factory.tickets.proofPassed}`,
          heading: 'Cart quantity changes are proven',
        },
        {
          name: 'stale',
          route: `/tickets/${factory.tickets.proofStale}`,
          heading: 'Cart proof needs another run',
        },
        { name: 'needs-you', route: '/', heading: 'Needs you' },
        { name: 'new-ticket', route: '/tickets/new', heading: 'New ticket' },
        {
          name: 'ticket',
          route: `/tickets/${factory.tickets.approvePlan}`,
          heading: 'Add CSV export to reports',
        },
        {
          name: 'ask',
          route: `/tickets/${factory.tickets.askAfterLimit}`,
          heading: 'Validate email addresses on sign-up',
        },
        {
          name: 'merge',
          route: `/tickets/${factory.tickets.waitingForMerge}`,
          heading: 'Show order totals in the header',
        },
        {
          name: 'repositories',
          route: '/repositories',
          heading: 'Repositories',
        },
        {
          name: 'workflows',
          route: '/workflows/quick-change',
          heading: 'quick-change',
        },
      ]
      for (const screen of pages) {
        await page.goto(`${factory.url}/#${screen.route}`)
        await expect(
          page.getByRole('heading', { name: screen.heading, exact: true }),
        ).toBeVisible()
        await expect(page.locator('output.status')).toHaveText('Live')
        if (screen.name === 'new-ticket') {
          await page
            .getByLabel('Repository', { exact: true })
            .selectOption('kipster/invalid-kit')
          await expect(
            page.getByRole('button', { name: 'Start onboard-repo ticket' }),
          ).toBeVisible()
        }
        await page.mouse.move(0, 0)
        await page.evaluate('window.scrollTo(0, 0)')
        expect(
          await page.evaluate(
            'document.documentElement.scrollWidth <= window.innerWidth',
          ),
        ).toBeTruthy()
        const path = testInfo.outputPath(
          `${screen.name}-${size}-${colorScheme}.png`,
        )
        await page.screenshot({
          path,
          fullPage: [
            'needs-you',
            'new-ticket',
            'repositories',
            'workflows',
          ].includes(screen.name),
        })
        await testInfo.attach(`${screen.name}-${size}-${colorScheme}`, {
          path,
          contentType: 'image/png',
        })
        if (screen.name === 'proof') {
          const run = page.locator('.attempt-entry').filter({
            has: page.getByRole('heading', {
              name: 'test tester',
              exact: true,
            }),
          })
          await run
            .getByText('Cart driving log (synthetic demo) log', { exact: true })
            .click()
          await expect(run.locator('pre')).toContainText(
            'Observed: quantity 2; total €24.00',
          )
          await expect
            .poll(() =>
              run
                .locator('video')
                .evaluate(
                  (element) =>
                    (element as unknown as { readyState: number }).readyState,
                ),
            )
            .toBeGreaterThanOrEqual(2)
          const evidencePath = testInfo.outputPath(
            `evidence-${size}-${colorScheme}.png`,
          )
          await run.screenshot({ path: evidencePath })
          await testInfo.attach(`evidence-${size}-${colorScheme}`, {
            path: evidencePath,
            contentType: 'image/png',
          })
          await run
            .getByRole('button', {
              name: 'Enlarge Cart image (synthetic demo)',
            })
            .click()
          const dialog = page.getByRole('dialog')
          await expect(dialog).toBeVisible()
          const bounds = await dialog.boundingBox()
          const viewport = page.viewportSize()!
          expect(bounds!.x).toBeGreaterThanOrEqual(0)
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
          expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
            viewport.height,
          )
          const viewerPath = testInfo.outputPath(
            `image-viewer-${size}-${colorScheme}.png`,
          )
          await page.screenshot({ path: viewerPath })
          await testInfo.attach(`image-viewer-${size}-${colorScheme}`, {
            path: viewerPath,
            contentType: 'image/png',
          })
          await page.keyboard.press('Escape')
          expect(
            await page.evaluate(
              'document.documentElement.scrollWidth <= window.innerWidth',
            ),
          ).toBeTruthy()
        }
        if (screen.name === 'ticket') {
          const panel = page.getByRole('region', {
            name: 'Review and approve the plan',
          })
          await expect(
            panel.getByRole('heading', { name: 'Acceptance scenarios' }),
          ).toBeVisible()
          await expect(panel.locator('details')).toHaveAttribute('open', '')
          const planPath = testInfo.outputPath(
            `open-plan-${size}-${colorScheme}.png`,
          )
          await panel.screenshot({ path: planPath })
          await testInfo.attach(`open-plan-${size}-${colorScheme}`, {
            path: planPath,
            contentType: 'image/png',
          })
        }
        if (screen.name === 'ask') {
          const timeline = page.getByRole('region', { name: 'What happened' })
          await expect(timeline.locator('.event-entry')).toHaveCount(0)
          const timelinePath = testInfo.outputPath(
            `timeline-${size}-${colorScheme}.png`,
          )
          await timeline.screenshot({ path: timelinePath })
          await testInfo.attach(`timeline-${size}-${colorScheme}`, {
            path: timelinePath,
            contentType: 'image/png',
          })
          await timeline
            .getByRole('button', { name: 'Show all events' })
            .click()
          await expect(
            timeline.getByText('attempt · claimed', { exact: false }).first(),
          ).toBeVisible()
          await timeline
            .getByRole('heading', { name: 'What happened', exact: true })
            .scrollIntoViewIfNeeded()
          expect(
            await page.evaluate(
              'document.documentElement.scrollWidth <= window.innerWidth',
            ),
          ).toBeTruthy()
          const eventsPath = testInfo.outputPath(
            `all-events-${size}-${colorScheme}.png`,
          )
          await page.screenshot({ path: eventsPath })
          await testInfo.attach(`all-events-${size}-${colorScheme}`, {
            path: eventsPath,
            contentType: 'image/png',
          })
        }
      }
    })
  }
}
