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
  'ci-failed',
  'ci-pending',
  'ci-late-failed',
  'checked-without-verify',
  'checked-with-verify',
  'untested-gate',
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
// Lead tickets default to lights-out, whose badge precedes the status.
const status = page
  .locator('.ticket-meta .badge')
  .filter({ hasNotText: 'Lights-out' })
  .first()
const proofTitle = 'Cart quantity changes are proven'
const askTitle = 'Validate email addresses on sign-up'
// Each owner action has its own seeded ticket, so one instance runs them all.
const ownerActionTitles = {
  approve: 'Add gift notes to orders (plan to approve)',
  changes: 'Add a size guide to product pages (plan to change)',
  reject: 'Add a loyalty points page (plan to reject)',
  retry: 'Validate postcodes at checkout (ask to retry)',
  move: 'Validate phone numbers on the account page (ask to move)',
  cancel: 'Validate coupon codes in the cart (ask to cancel)',
}
const summaries = () => page.getByRole('region', { name: 'Ticket summaries' })
const summaryLink = (title) =>
  summaries().getByRole('link', { name: title, exact: true })
const openFromToday = async (title) => {
  await go('/')
  await page
    .locator(`a[href="#/tickets/${ticket(title)}"]`)
    .first()
    .click()
  await expect(heading(title)).toBeVisible()
}
const ciChecks = () =>
  page
    .getByRole('region', { name: 'Merge gate' })
    .getByRole('list', { name: 'Current CI checks' })
const maintainRun = () =>
  page.locator('.attempt-entry').filter({
    has: page.getByRole('heading', { name: 'maintain-pr', exact: false }),
  })
const withoutVerifyTitle =
  'Document the API rate limits (checked without verify)'
const withVerifyTitle =
  'Show stock levels on product pages (checked with verify)'
const runEntry = (name) =>
  page.locator('.attempt-entry').filter({
    has: page.getByRole('heading', { name, exact: true }),
  })
const mergeGate = () => page.getByRole('region', { name: 'Merge gate' })
// The lead's final check, its merged task's result, then the task's own build and test.
const checkedLead = async (title, taskKey, result) => {
  await openFromToday(title)
  await expect(runEntry('final-test tester')).toContainText('passed')
  await expect(runEntry('final-test tester')).toContainText(
    'Final check of the whole change.',
  )
  const tasks = page.getByRole('region', { name: 'Tasks' })
  await tasks.locator('.finished-tasks-toggle').click()
  await tasks.getByRole('button', { name: taskKey, exact: false }).click()
  await expect(tasks.locator('.task-result')).toHaveText(result)
  await page.screenshot({
    path: join(evidence, `${scenario}-lead.png`),
    fullPage: true,
  })
  await tasks.locator('a.task-child').click()
  await expect(runEntry('build builder')).toContainText('done')
  await expect(runEntry('test tester')).toContainText('passed')
}
let result = 'failed'
try {
  switch (scenario) {
    case 'today': {
      await go('/')
      await expect(heading('Ticket summaries')).toBeVisible()
      await expect(heading('Moving')).toBeVisible()
      await expect(page.locator('output.status')).toHaveText('Live')
      await expect(summaryLink(askTitle)).toBeVisible()
      await expect(
        page
          .getByRole('region', { name: 'Moving' })
          .getByText('Update the README badges', { exact: true }),
      ).toBeVisible()
      // Counted from the API, so earlier reject or cancel runs do not matter.
      const finished = tickets.tickets.filter((item) =>
        ['done', 'cancelled'].includes(item.status),
      ).length
      const finishedList = page.locator('.finished-list')
      await expect(finishedList).toBeHidden()
      await page
        .getByText(`Show finished (${finished})`, { exact: true })
        .click()
      await expect(
        finishedList.getByText('Add a dark mode toggle', { exact: true }),
      ).toBeVisible()
      observations.push(`Show finished (${finished})`)
      break
    }
    case 'filter': {
      await go('/')
      await page
        .getByRole('button', { name: 'everything', exact: true })
        .click()
      const filters = page.getByRole('dialog', { name: 'Filters' })
      await filters.getByLabel('Task pr', { exact: true }).check()
      await page.keyboard.press('Escape')
      await expect(filters).toBeHidden()
      await expect(
        page.getByRole('button', { name: 'task pr work', exact: true }),
      ).toBeFocused()
      await expect(summaryLink(askTitle)).toBeHidden()
      await expect(summaryLink('Optional check still running')).toBeVisible()
      await page
        .getByRole('button', { name: 'Show everything', exact: true })
        .click()
      await expect(summaryLink(askTitle)).toBeVisible()
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
      // The toggle is controlled by the saved policy, so click and wait for it.
      try {
        await toggle.click()
        await expect(toggle).toBeChecked()
        await page.reload()
        await expect(toggle).toBeChecked()
      } finally {
        await expect(toggle).toBeEnabled()
        if (await toggle.isChecked()) await toggle.click()
      }
      await expect(toggle).not.toBeChecked()
      await page.reload()
      await expect(toggle).not.toBeChecked()
      break
    }
    case 'workflows': {
      await go('/workflows/bug')
      await expect(heading('bug')).toBeVisible()
      const diagram = page.getByRole('figure', {
        name: 'bug workflow',
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
      await page.getByRole('radio', { name: /^lead / }).check()
      await page
        .getByRole('group', { name: 'Read-only dependencies' })
        .getByRole('checkbox', { name: 'kipster/legacy-api', exact: true })
        .check()
      const title = `Map ticket ${Date.now()}`
      await page.getByLabel('Title', { exact: true }).fill(title)
      await page
        .getByLabel('Description Markdown supported', { exact: true })
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
      await expect(page.getByRole('radio', { name: /^bug / })).toBeDisabled()
      await expect(
        page.getByText(
          'This repository needs a verified kit to run this workflow.',
          { exact: true },
        ),
      ).toBeVisible()
      await expect(page.getByRole('radio', { name: /^lead / })).toBeEnabled()
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
      await openTicket(ownerActionTitles[scenario])
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
          .getByLabel('Comment Required for changes', { exact: true })
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
      await openTicket(ownerActionTitles[scenario])
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
          .selectOption('lead')
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
        .getByRole('button', {
          name: 'Cart quantity updates the total',
          exact: true,
        })
        .click()
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
        has: page.getByRole('heading', {
          name: 'final-test tester',
          exact: true,
        }),
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
    case 'ci-failed': {
      await openFromToday('Bundle check failed on the pull request')
      await expect(status).toHaveText('queued')
      const now = page.getByRole('region', { name: 'Now' })
      await expect(now).toContainText('Step 1 of 5')
      await expect(now).toContainText('CI failed: Bundle')
      await expect(
        page.getByRole('region', { name: 'Merge gate' }).getByRole('heading'),
      ).toContainText('Blocked: CI failed')
      await expect(ciChecks()).toContainText(
        'Demo repository checks: passed · required',
      )
      await expect(ciChecks()).toContainText('Bundle: failed · not required')
      const run = maintainRun()
      await expect(run).toContainText('ci failed')
      await run.getByText('CI failed: Bundle finding', { exact: true }).click()
      await expect(
        run.getByRole('link', { name: 'Bundle', exact: true }),
      ).toHaveAttribute(
        'href',
        'https://github.com/kipster/demo-shop/actions/runs/440/job/442',
      )
      await expect(run).toContainText(
        'dist/assets/index.js is 312.4 kB, over the 250 kB budget',
      )
      break
    }
    case 'ci-pending': {
      await openFromToday('Optional check still running')
      await expect(
        page.getByRole('region', { name: 'Merge gate' }).getByRole('heading'),
      ).toHaveText('Ready to merge')
      await page
        .getByRole('region', { name: 'Merge gate' })
        .getByText('Live CI at', { exact: false })
        .click()
      await expect(ciChecks()).toContainText(
        'Demo repository checks: passed · required',
      )
      await expect(ciChecks()).toContainText('Bundle: pending · not required')
      await expect(maintainRun()).toContainText('ready')
      await expect(maintainRun()).toContainText('CI passed.')
      break
    }
    case 'ci-late-failed': {
      await openFromToday('Bundle check failed while waiting to merge')
      await expect(status).toHaveText('queued')
      const now = page.getByRole('region', { name: 'Now' })
      await expect(now).toContainText('Step 1 of 5')
      await expect(now).toContainText('Latest from Merge')
      await expect(now).toContainText('CI failed: Bundle')
      await expect(mergeGate().getByRole('heading')).toContainText(
        'Blocked: CI failed',
      )
      await expect(ciChecks()).toContainText('Bundle: failed · not required')
      await expect(maintainRun()).toContainText('ready')
      await expect(maintainRun()).toContainText('CI passed.')
      const merge = page.locator('.attempt-entry').filter({
        has: page.getByRole('heading', { name: /^merge\b/ }),
      })
      await expect(merge).toContainText('changes needed')
      await expect(merge).toContainText('CI failed: Bundle')
      await merge
        .getByText('CI failed: Bundle finding', { exact: true })
        .click()
      await expect(
        merge.getByRole('link', { name: 'Bundle', exact: true }),
      ).toHaveAttribute(
        'href',
        'https://github.com/kipster/demo-shop/actions/runs/480/job/482',
      )
      await expect(merge).toContainText(
        'dist/assets/vendor.js is 410.2 kB, over the 250 kB budget',
      )
      break
    }
    case 'checked-without-verify':
      await checkedLead(
        withoutVerifyTitle,
        'rate-limit-page',
        `Merged into the lead branch at ${'2'.repeat(40)}. Checker test passed at ${'1'.repeat(40)} with unverified items. Unverified by test: Open the rate limit page in a browser.`,
      )
      await expect(page.locator('.ticket-meta')).toContainText(
        'Unverified by test: Open the rate limit page in a browser',
      )
      await expect(
        page.getByRole('region', { name: 'Scenario evidence' }),
      ).toContainText('1 unverified')
      break
    case 'checked-with-verify':
      await checkedLead(
        withVerifyTitle,
        'stock-badge',
        `Merged into the lead branch at ${'4'.repeat(40)}. Checker test passed at ${'3'.repeat(40)}.`,
      )
      await expect(page.locator('.ticket-meta')).not.toContainText('Unverified')
      await expect(
        page.getByRole('region', { name: 'Scenario evidence' }),
      ).toContainText('1 passed')
      break
    case 'untested-gate':
      await openFromToday(withoutVerifyTitle)
      await expect(mergeGate().getByRole('heading')).toHaveText(
        'Ready to merge',
      )
      await expect(mergeGate()).toContainText(
        'Needs you: Unverified by final-test: Open the rate limit page in a browser',
      )
      await expect(mergeGate()).not.toContainText('Untested workflow')
      await page.screenshot({
        path: join(evidence, `${scenario}-unverified.png`),
        fullPage: true,
      })
      await openFromToday(withVerifyTitle)
      await expect(mergeGate().getByRole('heading')).toHaveText(
        'Ready to merge',
      )
      await expect(mergeGate()).not.toContainText('Needs you')
      await expect(mergeGate()).not.toContainText('Unverified')
      break
    case 'decisions':
      await go('/decisions')
      await expect(heading('Decisions')).toBeVisible()
      await expect(
        page.getByText(
          'No decisions yet. They appear here when a step decides how a ticket moves on.',
          { exact: true },
        ),
      ).toBeVisible()
      break
    case 'responsive':
      for (const colorScheme of ['light', 'dark']) {
        await page.setViewportSize({ width: 390, height: 844 })
        await page.emulateMedia({ colorScheme })
        for (const path of [
          '/',
          '/repositories',
          '/workflows/lead',
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
