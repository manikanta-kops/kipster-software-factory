import { test, expect } from './fixtures.ts'
import type { TicketResponse } from '../../src/api/contract.ts'

test('live CI transitions pending → failed → ready, while path rules and behind base need attention', async ({
  page,
  request,
  factory,
}) => {
  await page.goto(`${factory.url}/#/tickets/${factory.tickets.proofPassed}`)
  const gate = page.getByRole('region', { name: 'Merge gate' })
  await expect(
    gate.getByRole('heading', { name: 'Ready to merge' }),
  ).toBeVisible()
  for (const state of ['pending', 'failed']) {
    await request.post('/__test/gate', { data: { url: factory.url, state } })
    await expect(gate.getByRole('heading')).toContainText(
      state === 'pending' ? 'Waiting for CI' : 'Blocked: CI failed',
    )
    await expect(
      gate.getByRole('list', { name: 'Current CI checks' }),
    ).toContainText(`Demo repository checks: ${state} · required`)
  }
  await request.post('/__test/gate', {
    data: { url: factory.url, state: 'paths' },
  })
  await expect(gate.getByRole('heading')).toHaveText('Ready to merge')
  await expect(gate).toContainText(
    'Needs you: touches .github/workflows/ci.yml, .kipster/kit.yml, db/migrations/001.sql',
  )
  await request.post('/__test/gate', {
    data: { url: factory.url, state: 'behind' },
  })
  await expect(gate.getByRole('heading')).toContainText(
    'Behind base by 2 commits',
  )
  await expect(gate).toContainText('Earlier green head: aaaaaaa')
})

test('untested workflows always need the owner and older green heads remain visible during rebuilding', async ({
  page,
  factory,
}) => {
  await page.goto(`${factory.url}/#/tickets/${factory.tickets.waitingForMerge}`)
  const gate = page.getByRole('region', { name: 'Merge gate' })
  await expect(gate.getByRole('heading')).toHaveText('Ready to merge')
  await expect(gate).toContainText('Needs you: Untested workflow')
  await page.goto(`${factory.url}/#/tickets/${factory.tickets.proofStale}`)
  await expect(gate.getByRole('heading')).toHaveText('Waiting for build work')
  await expect(gate).toContainText('Earlier green head: aaaaaaa')
})

test('curated scenario evidence opens at a stable same-origin address; archive and pruned rows are explicit', async ({
  page,
  request,
  factory,
}) => {
  const number = factory.tickets.proofPassed
  await page.goto(`${factory.url}/#/tickets/${number}`)
  const index = page.getByRole('region', { name: 'Scenario evidence' })
  await expect(
    index.getByRole('heading', { name: 'Cart quantity updates the total' }),
  ).toBeVisible()
  await expect(index).toContainText('tester: passed · Commit aaaaaaa · current')
  const detail = (await (
    await request.get(`${factory.url}/api/tickets/${number}`)
  ).json()) as TicketResponse
  const key = detail.evidenceIndex![0]!.artifactId
  await index.getByRole('link', { name: 'Open evidence item' }).click()
  await expect(page).toHaveURL(
    `${factory.url}/#/tickets/${number}/evidence/${key}`,
  )
  await page.reload()
  await expect(
    page.getByRole('region', { name: 'Evidence item' }).getByRole('img'),
  ).toBeVisible()
  await expect(
    page.getByRole('region', { name: 'Evidence item' }).getByRole('img'),
  ).toHaveAttribute('src', `/api/artifacts/${key}`)
  await page.getByRole('link', { name: `‹ Back to ticket #${number}` }).click()
  const archive = page.getByRole('region', { name: 'What happened' })
  await expect(
    archive.getByLabel('Cart recording (synthetic demo)', { exact: true }),
  ).toBeVisible()
  const recording = detail.artifacts.find((a) => a.mediaType === 'video/webm')!
  await request.post('/__test/prune', { data: { url: factory.url } })
  await expect(archive).toContainText(
    'Cart recording (synthetic demo): removed after 30 days',
  )
  await page.goto(`${factory.url}/#/tickets/${number}/evidence/${recording.id}`)
  await expect(
    page.getByRole('region', { name: 'Evidence item' }),
  ).toContainText('removed after 30 days')
  await expect(
    page.getByRole('region', { name: 'Evidence item' }).locator('video'),
  ).toHaveCount(0)
})

const inks = {
  light: { red: 'rgb(217, 51, 40)', amber: 'rgb(176, 122, 0)' },
  dark: { red: 'rgb(255, 115, 105)', amber: 'rgb(240, 192, 74)' },
}
for (const colorScheme of ['light', 'dark'] as const)
  test(`gate card separates waits from real problems in ${colorScheme}`, async ({
    page,
    request,
    factory,
  }) => {
    await page.emulateMedia({ colorScheme })
    const { red, amber } = inks[colorScheme]
    const gate = page.getByRole('region', { name: 'Merge gate' })
    const heading = gate.getByRole('heading')
    // Waits on plan approval: before merge, with no build work running.
    const number = factory.tickets.approvePlan
    await request.post('/__test/gate', {
      data: { url: factory.url, state: 'pending-untested', number },
    })
    await page.goto(`${factory.url}/#/tickets/${number}`)
    await expect(heading).toHaveText('Waiting for CI')
    await expect(gate).toHaveClass(/\bwaiting\b/)
    await expect(heading).toHaveCSS('color', amber)
    await expect(gate).toContainText(
      'You will merge this one: the workflow has no tester',
    )
    await expect(gate).not.toContainText('Needs you')
    await expect(gate).not.toContainText('Blocked')
    await gate.screenshot({ path: test.info().outputPath('waiting.png') })

    await request.post('/__test/gate', {
      data: { url: factory.url, state: 'failed', number },
    })
    await expect(heading).toHaveText('Blocked: CI failed')
    await expect(gate).toHaveClass(/\bchanges-needed\b/)
    await expect(heading).toHaveCSS('color', red)

    await request.post('/__test/gate', {
      data: { url: factory.url, state: 'pending-conflict', number },
    })
    await expect(heading).toHaveText('Blocked: PR has conflicts')
    await expect(heading).toHaveCSS('color', red)
    await gate.screenshot({ path: test.info().outputPath('blocked.png') })

    await page.goto(`${factory.url}/#/tickets/${factory.tickets.proofPassed}`)
    await expect(heading).toHaveText('Ready to merge')
    await expect(gate).toHaveClass(/\bpassed\b/)
    await gate.screenshot({ path: test.info().outputPath('ready.png') })
  })
