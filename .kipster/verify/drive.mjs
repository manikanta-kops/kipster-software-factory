import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, expect } from '@playwright/test'

const [scenario] = process.argv.slice(2)
const scenarios = [
  'today',
  'filter',
  'repositories',
  'register',
  'policy',
  'workflows',
  'upload',
  'remove-in-use',
  'new-ticket',
  'gate-workflows',
  'approve',
  'changes',
  'reject',
  'retry',
  'move',
  'cancel',
  'timeline',
  'proof',
  'stale',
  'decisions',
  'responsive',
]
if (!scenarios.includes(scenario))
  throw new Error(`Choose one scenario: ${scenarios.join(', ')}`)
if (!process.env.APP_URL || !process.env.EVIDENCE_DIR)
  throw new Error('Set APP_URL and EVIDENCE_DIR from the supplied instance')
const supplied = new URL(process.env.APP_URL)
assert.equal(supplied.protocol, 'http:')
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(supplied.hostname))
assert.ok(supplied.port, 'Use the allocated port')
const origin = supplied.origin
const evidence = process.env.EVIDENCE_DIR
await mkdir(evidence, { recursive: true })
const health = await fetch(`${origin}/api/health`)
assert.equal(health.status, 200)

const browser = await chromium.launch()
const context = await browser.newContext({ reducedMotion: 'reduce' })
await context.route('**/*', (route) => {
  const url = new URL(route.request().url())
  return url.origin === origin || ['data:', 'blob:'].includes(url.protocol)
    ? route.continue()
    : route.abort()
})
await context.tracing.start({
  screenshots: true,
  snapshots: true,
  sources: true,
})
const page = await context.newPage()
const observations = []
page.on('console', (message) => observations.push(`console: ${message.text()}`))
page.on('pageerror', (error) =>
  observations.push(`pageerror: ${error.message}`),
)
const heading = (name) => page.getByRole('heading', { name, exact: true })
const go = (path) => page.goto(`${origin}/#${path}`)
const tickets = await fetch(`${origin}/api/tickets`).then((response) => {
  assert.equal(response.status, 200)
  return response.json()
})
const ticket = (title) => {
  const found = tickets.tickets.find((item) => item.title === title)
  assert.ok(found, `Missing seeded ticket: ${title}`)
  return found.number
}
const openTicket = (title) => go(`/tickets/${ticket(title)}`)
const status = page.locator('.ticket-meta .badge').first()
const proofTitle = 'Cart quantity changes are proven'
const planTitle = 'Add CSV export to reports'
const askTitle = 'Validate email addresses on sign-up'
let result = 'failed'
try {
  switch (scenario) {
    case 'today':
      await go('/')
      await expect(heading('Needs you')).toBeVisible()
      await expect(heading('Moving')).toBeVisible()
      await expect(page.locator('output.status')).toHaveText('Live')
      await expect(page.getByText('Add a dark mode toggle')).toBeHidden()
      await page.getByText('Show finished (2)', { exact: true }).click()
      await expect(page.getByText('Add a dark mode toggle')).toBeVisible()
      break
    case 'filter': {
      await go('/')
      await page
        .getByRole('button', { name: 'everything', exact: true })
        .click()
      const filters = page.getByRole('dialog', { name: 'Filters' })
      await filters.getByLabel('Feature', { exact: true }).check()
      await page.keyboard.press('Escape')
      await expect(filters).toBeHidden()
      await expect(
        page.getByRole('button', { name: 'feature work', exact: true }),
      ).toBeFocused()
      await expect(heading(askTitle)).toBeHidden()
      await expect(heading(proofTitle)).toBeVisible()
      break
    }
    case 'repositories':
      await go('/repositories')
      await expect(heading('Repositories')).toBeVisible()
      await expect(
        page
          .locator('.repository-list li')
          .filter({ hasText: 'kipster/demo-shop' }),
      ).toContainText('Kit ready')
      await expect(
        page
          .locator('.repository-list li')
          .filter({ hasText: 'kipster/invalid-kit' }),
      ).toContainText('verify.ready:')
      await expect(
        page.getByText('git clone failed: Repository not found.', {
          exact: true,
        }),
      ).toBeVisible()
      break
    case 'register': {
      await go('/repositories')
      const slug = `verification/map-${Date.now()}`
      await page.getByLabel('Add a repository', { exact: true }).fill(slug)
      await page
        .getByRole('button', { name: 'Add repository', exact: true })
        .click()
      await expect(heading(slug)).toBeVisible()
      await expect(
        page.getByText('Repository added. Waiting for setup.', { exact: true }),
      ).toBeVisible()
      observations.push(`registered ${slug}; remains pending without scheduler`)
      break
    }
    case 'policy': {
      await go('/repositories')
      const toggle = page.getByRole('checkbox', {
        name: 'Auto-merge for kipster/demo-shop',
        exact: true,
      })
      await expect(toggle).not.toBeChecked()
      try {
        await toggle.check()
        await page.reload()
        await expect(toggle).toBeChecked()
      } finally {
        await toggle.uncheck()
      }
      await expect(toggle).not.toBeChecked()
      break
    }
    case 'workflows': {
      await go('/workflows/quick-change')
      await expect(heading('quick-change')).toBeVisible()
      const diagram = page.getByRole('figure', {
        name: 'quick-change workflow',
      })
      const step = diagram.getByRole('button', {
        name: 'review: reviewer',
        exact: true,
      })
      await step.click()
      await expect(step).toHaveAttribute('aria-pressed', 'true')
      await diagram.getByLabel('Show all loops', { exact: true }).check()
      await expect(
        diagram.getByLabel('Show all loops', { exact: true }),
      ).toBeChecked()
      break
    }
    case 'upload': {
      await go('/workflows')
      const picker = page.getByLabel('Upload workflow', { exact: true })
      const name = `map-review-${Date.now()}`
      const source = `name: ${name}\ndescription: Isolated map upload\nsteps:\n  - id: review\n    kind: agent\n    role: reviewer\n`
      const file = (buffer) => ({
        name: `${name}.yml`,
        mimeType: 'application/yaml',
        buffer: Buffer.from(buffer),
      })
      await picker.setInputFiles(
        file(source.replace('role: reviewer', 'role: critic')),
      )
      await expect(page.getByRole('alert')).toContainText(
        'The workflow is not valid',
      )
      await picker.setInputFiles(file(source))
      await expect(heading(name)).toBeVisible()
      await expect(
        page.getByText(new RegExp(`^Saved ${name}, version [0-9a-f]{12}\\.$`)),
      ).toBeVisible()
      observations.push(`uploaded ${name}; no agent executed`)
      break
    }
    case 'remove-in-use': {
      const inUse = [
        'Shorten the checkout labels (synthetic upload)',
        'Tidy the cart copy (synthetic upload lead)',
        'Tidy the cart copy (synthetic upload task)',
      ].map(ticket)
      await go('/workflows/lead')
      await expect(heading('lead')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(0)
      await go('/workflows/synthetic-review')
      await expect(heading('synthetic-review')).toBeVisible()
      await page.getByRole('button', { name: 'Remove', exact: true }).click()
      const confirm = page.getByRole('group', {
        name: 'Remove synthetic-review?',
      })
      await confirm.getByRole('button', { name: 'Remove workflow' }).click()
      await expect(page.getByRole('alert')).toHaveText(
        `"synthetic-review" is used by unfinished tickets ${inUse.map((n) => `#${n}`).join(', ')}; finish or cancel them first`,
      )
      const refused = await fetch(`${origin}/api/workflows/synthetic-review`, {
        method: 'DELETE',
      })
      assert.equal(refused.status, 409)
      assert.deepEqual((await refused.json()).tickets, inUse)
      await go('/workflows')
      await expect(
        page.getByRole('link', { name: /^synthetic-review uploaded/ }),
      ).toBeVisible()
      observations.push(`refused removal for #${inUse.join(', #')}`)
      break
    }
    case 'new-ticket': {
      await go('/tickets/new')
      await page
        .getByLabel('Repository', { exact: true })
        .selectOption('kipster/demo-shop')
      await page.getByRole('radio', { name: /^quick-change / }).check()
      await page
        .getByRole('group', { name: 'Read-only dependencies' })
        .getByRole('checkbox', { name: 'kipster/legacy-api', exact: true })
        .check()
      const title = `Map ticket ${Date.now()}`
      await page.getByLabel('Title', { exact: true }).fill(title)
      await page
        .getByLabel('Description', { exact: true })
        .fill('## Goal\n\nKeep **Unicode** filenames.')
      await page.getByText('Preview description', { exact: true }).click()
      await expect(heading('Goal')).toBeVisible()
      await page
        .getByRole('button', { name: 'Create ticket', exact: true })
        .click()
      await expect(heading(title)).toBeVisible()
      await expect(status).toHaveText('queued')
      await expect(
        page.getByRole('region', { name: 'Repository context' }),
      ).toContainText('kipster/legacy-api')
      observations.push(`created ${page.url()}`)
      break
    }
    case 'gate-workflows':
      await go('/tickets/new')
      await page
        .getByLabel('Repository', { exact: true })
        .selectOption('kipster/invalid-kit')
      for (const name of ['feature', 'bug'])
        await expect(
          page.getByRole('radio', { name: new RegExp(`^${name} `) }),
        ).toBeDisabled()
      await page
        .getByRole('button', { name: 'Start onboard-repo ticket', exact: true })
        .click()
      await expect(
        heading('Verify the kit for kipster/invalid-kit'),
      ).toBeVisible()
      await expect(status).toHaveText('queued')
      break
    case 'approve':
    case 'changes':
    case 'reject': {
      await openTicket(planTitle)
      const panel = page.getByRole('region', {
        name: 'Review and approve the plan',
      })
      await expect(
        panel.getByRole('heading', {
          name: 'Acceptance scenarios',
          exact: true,
        }),
      ).toBeVisible()
      if (scenario === 'changes') {
        await panel
          .getByRole('button', { name: 'Request changes', exact: true })
          .click()
        await expect(page.getByRole('alert')).toHaveText(
          'Add a comment to explain the changes needed.',
        )
        await page
          .getByLabel('Comment', { exact: true })
          .fill('Cover empty reports and Unicode filenames.')
      }
      const button =
        scenario === 'approve'
          ? 'Approve'
          : scenario === 'reject'
            ? 'Reject'
            : 'Request changes'
      await panel.getByRole('button', { name: button, exact: true }).click()
      await expect(status).toHaveText(
        scenario === 'reject' ? 'cancelled' : 'queued',
      )
      break
    }
    case 'retry':
    case 'move':
    case 'cancel':
      await openTicket(askTitle)
      await expect(heading('A loop reached its limit.')).toBeVisible()
      if (scenario !== 'cancel') {
        await page
          .getByRole('button', { name: 'Retry step', exact: true })
          .click()
        await expect(page.getByRole('alert')).toHaveText(
          'Add a note for the next attempt.',
        )
        await page
          .getByLabel('Note', { exact: false })
          .fill('Use the existing validation helper.')
      }
      if (scenario === 'move')
        await page
          .getByLabel('Move to step', { exact: true })
          .selectOption('build')
      await page
        .getByRole('button', {
          name:
            scenario === 'retry'
              ? 'Retry step'
              : scenario === 'move'
                ? 'Move ticket'
                : 'Cancel ticket',
          exact: true,
        })
        .click()
      await expect(status).toHaveText(
        scenario === 'cancel' ? 'cancelled' : 'queued',
      )
      break
    case 'timeline': {
      await openTicket(askTitle)
      const timeline = page.getByRole('region', { name: 'What happened' })
      await expect(timeline.locator('.event-entry')).toHaveCount(0)
      const toggle = timeline.getByRole('button', {
        name: 'Show all events',
        exact: true,
      })
      await toggle.focus()
      await page.keyboard.press('Space')
      await expect(toggle).toHaveAttribute('aria-pressed', 'true')
      await expect(
        timeline.getByText('attempt · claimed', { exact: false }).first(),
      ).toBeVisible()
      break
    }
    case 'proof': {
      await openTicket(proofTitle)
      await expect(
        page.getByRole('region', { name: 'Latest tester verdict' }),
      ).toContainText('Verified at aaaaaaa')
      await expect(
        page.getByRole('region', { name: 'Merge gate' }),
      ).toContainText('Ready to merge')
      const index = page.getByRole('region', { name: 'Scenario evidence' })
      await index
        .getByRole('button', {
          name: 'Enlarge Cart image (synthetic demo)',
          exact: true,
        })
        .click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await index
        .getByRole('link', { name: 'Open evidence item', exact: true })
        .click()
      await expect(
        page.getByRole('region', { name: 'Evidence item' }).getByRole('img'),
      ).toBeVisible()
      await page.reload()
      await expect(
        page.getByRole('region', { name: 'Evidence item' }).getByRole('img'),
      ).toBeVisible()
      await page
        .getByRole('link', {
          name: `‹ Back to ticket #${ticket(proofTitle)}`,
          exact: true,
        })
        .click()
      const run = page.locator('.attempt-entry').filter({
        has: page.getByRole('heading', { name: 'test tester', exact: true }),
      })
      await run
        .getByText('Cart driving log (synthetic demo) log', { exact: true })
        .click()
      await expect(
        run.getByLabel('Cart driving log (synthetic demo)', { exact: true }),
      ).toContainText('Observed: quantity 2; total €24.00')
      await expect(run.locator('video')).toHaveAttribute('controls', '')
      break
    }
    case 'stale':
      await openTicket('Cart proof needs another run')
      await expect(
        page.getByRole('region', { name: 'Latest tester verdict' }),
      ).toContainText('Stale: new commits since verification')
      await expect(
        page.getByRole('region', { name: 'Merge gate' }),
      ).toContainText('Waiting for build work')
      await expect(
        page.getByRole('region', { name: 'Merge gate' }),
      ).toContainText('Earlier green head: aaaaaaa')
      break
    case 'decisions':
      await go('/decisions')
      await expect(heading('Decisions')).toBeVisible()
      await expect(
        page.getByText('No pending decisions in the latest 100 outcomes.', {
          exact: true,
        }),
      ).toBeVisible()
      await expect(
        page.getByText('No decisions yet.', { exact: true }),
      ).toBeVisible()
      break
    case 'responsive':
      for (const colorScheme of ['light', 'dark']) {
        await page.setViewportSize({ width: 390, height: 844 })
        await page.emulateMedia({ colorScheme })
        for (const path of [
          '/',
          '/repositories',
          '/workflows/quick-change',
          '/tickets/new',
          '/decisions',
        ]) {
          await go(path)
          await expect(page.locator('output.status')).toHaveText('Live')
          await expect(page.locator('main h1').first()).toBeVisible()
          assert.ok(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
            `Overflow at ${path} in ${colorScheme}`,
          )
          await page.screenshot({
            path: join(
              evidence,
              `responsive-${colorScheme}-${path.replaceAll('/', '_')}.png`,
            ),
            fullPage: true,
          })
        }
      }
      await page
        .getByRole('link', { name: 'Skip to content', exact: true })
        .focus()
      await page.keyboard.press('Enter')
      await expect(page.locator('main')).toBeFocused()
      break
  }
  result = 'passed'
  console.log(`${scenario}: passed at ${origin}`)
} catch (error) {
  observations.push(error.stack ?? String(error))
  throw error
} finally {
  try {
    await page.screenshot({
      path: join(evidence, `${scenario}-${result}.png`),
      fullPage: true,
    })
    await context.tracing.stop({
      path: join(evidence, `${scenario}-trace.zip`),
    })
    await writeFile(
      join(evidence, `${scenario}.json`),
      JSON.stringify(
        { scenario, result, origin, finalUrl: page.url(), observations },
        null,
        2,
      ),
    )
  } finally {
    await browser.close()
  }
}
