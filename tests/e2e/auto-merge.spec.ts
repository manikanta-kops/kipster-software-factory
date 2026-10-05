import { test, expect } from './fixtures.ts'
import type {
  RepositoriesResponse,
  TicketResponse,
} from '../../src/api/contract.ts'

test('repository auto-merge starts off, toggles through the API and survives reload', async ({
  page,
  request,
  factory,
}) => {
  await page.goto(`${factory.url}/#/repositories`)
  const toggle = page.getByRole('checkbox', {
    name: 'Auto-merge for kipster/demo-shop',
    exact: true,
  })
  await expect(toggle).not.toBeChecked()
  await toggle.click()
  await expect(toggle).toBeChecked()
  await page.reload()
  await expect(toggle).toBeChecked()
  const data = (await (
    await request.get(`${factory.url}/api/repositories`)
  ).json()) as RepositoriesResponse
  expect(
    data.repositories.find((r) => r.slug === 'kipster/demo-shop')!.autoMerge,
  ).toBe(true)
  await toggle.click()
  await expect(toggle).not.toBeChecked()
})

test.describe('rule-based auto-merge', () => {
  test.use({ withAutoMerge: true })
  test('Today keeps a factory merge moving and restores attention for owner reasons or disabled auto-merge', async ({
    page,
    request,
    factory,
  }) => {
    const detail = (await (
      await request.get(
        `${factory.url}/api/tickets/${factory.tickets.proofPassed}`,
      )
    ).json()) as TicketResponse
    const title = detail.ticket.title
    await page.goto(`${factory.url}/#/`)
    const needsYou = page.getByRole('region', {
      name: 'Needs you',
      exact: true,
    })
    const moving = page.getByRole('region', { name: 'Moving', exact: true })
    const factoryRow = moving.getByRole('link', { name: new RegExp(title) })
    await expect(factoryRow).toContainText('Factory merge pending')
    await expect(
      needsYou.getByRole('link', { name: title, exact: true }),
    ).toHaveCount(0)
    await request.post('/__test/gate', {
      data: { url: factory.url, state: 'reviewer-owner' },
    })
    await expect(
      needsYou.getByRole('link', { name: title, exact: true }),
    ).toBeVisible()
    await expect(factoryRow).toHaveCount(0)
    await request.post('/__test/gate', {
      data: { url: factory.url, state: 'ready' },
    })
    await expect(factoryRow).toContainText('Factory merge pending')
    await request.post(
      `${factory.url}/api/repositories/${detail.ticket.repository.id}/auto-merge`,
      { data: { enabled: false } },
    )
    await expect(
      needsYou.getByRole('link', { name: title, exact: true }),
    ).toBeVisible()
    await expect(factoryRow).toHaveCount(0)
  })
  test('system merge records factory actor and breakage links to one bug without model controls', async ({
    page,
    request,
    factory,
  }) => {
    await page.goto(`${factory.url}/#/tickets/${factory.tickets.proofPassed}`)
    await expect(
      page.getByRole('heading', { name: 'Factory merge pending', exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Merge', exact: true }),
    ).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: 'I’ll review', exact: true }),
    ).toHaveCount(0)
    const response = await request.post('/__test/auto-merge', {
      data: { url: factory.url },
    })
    expect(response.ok()).toBeTruthy()
    const timeline = page.getByRole('region', { name: 'What happened' })
    await expect(timeline).toContainText('Merged by factory')
    const data = (await (
      await request.get(
        `${factory.url}/api/tickets/${factory.tickets.proofPassed}`,
      )
    ).json()) as TicketResponse
    expect(data.decisions).toEqual([])
    const bug = timeline.getByRole('link', { name: /bug ticket #/ }).first()
    await expect(bug).toBeVisible()
    const href = await bug.getAttribute('href')
    await bug.click()
    await expect(page).toHaveURL(`${factory.url}/${href}`)
    await expect(
      page.getByRole('heading', { name: /Breakage after #/ }),
    ).toBeVisible()
  })
  for (const state of ['reviewer-owner', 'unreviewed']) {
    test(`${state} shows the owner reason and preserves owner merging`, async ({
      page,
      request,
      factory,
    }) => {
      await request.post('/__test/gate', { data: { url: factory.url, state } })
      await page.goto(`${factory.url}/#/tickets/${factory.tickets.proofPassed}`)
      const gate = page.getByRole('region', { name: 'Merge gate' })
      await expect(gate.getByRole('heading')).toHaveText('Ready to merge')
      await expect(gate).toContainText(
        state === 'unreviewed'
          ? 'Unreviewed workflow'
          : 'Reviewer requests owner review: Changes public API behavior',
      )
      await expect(
        page.getByText(
          'Review the pull request and merge it when you’re ready.',
          { exact: false },
        ),
      ).toBeVisible()
      await expect(
        page.getByRole('button', { name: 'Merge', exact: true }),
      ).toHaveCount(0)
    })
  }
})
