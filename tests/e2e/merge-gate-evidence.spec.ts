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
    await expect(gate.getByRole('heading')).toContainText(`CI ${state}`)
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
  await expect(gate.getByRole('heading')).toContainText('Untested workflow')
  await expect(gate).toContainText('Needs you: Untested workflow')
  await page.goto(`${factory.url}/#/tickets/${factory.tickets.proofStale}`)
  await expect(gate).toContainText('Build work is queued or running')
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
  const archive = page.locator('.evidence-archive')
  await expect(archive).not.toHaveAttribute('open', '')
  await archive.locator('summary').first().click()
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
