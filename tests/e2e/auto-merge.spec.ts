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

test.describe('merge confirmation', () => {
  test.use({ withAutoMerge: true })
  test('Merge authorizes a system merge, factory actor appears, and breakage links to one bug', async ({
    page,
    request,
    factory,
  }) => {
    await page.goto(`${factory.url}/#/tickets/${factory.tickets.proofPassed}`)
    await expect(
      page.getByRole('button', { name: 'Merge', exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'I’ll review', exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Merge', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Merge', exact: true }),
    ).toHaveCount(0)
    const response = await request.post('/__test/auto-merge', {
      data: { url: factory.url },
    })
    expect(response.ok()).toBeTruthy()
    const timeline = page.getByRole('region', { name: 'What happened' })
    await expect(timeline).toContainText('Merged by factory')
    const bug = timeline.getByRole('link', { name: /bug ticket #/ }).first()
    await expect(bug).toBeVisible()
    const href = await bug.getAttribute('href')
    await bug.click()
    await expect(page).toHaveURL(`${factory.url}/${href}`)
    await expect(
      page.getByRole('heading', { name: /Breakage after #/ }),
    ).toBeVisible()
  })
  test('I’ll review retains the owner merge path and records the choice', async ({
    page,
    request,
    factory,
  }) => {
    await page.goto(`${factory.url}/#/tickets/${factory.tickets.proofPassed}`)
    await page.getByRole('button', { name: 'I’ll review', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Merge', exact: true }),
    ).toHaveCount(0)
    await expect(
      page.getByText(
        'Review the pull request and merge it when you’re ready.',
        { exact: false },
      ),
    ).toBeVisible()
    const data = (await (
      await request.get(
        `${factory.url}/api/tickets/${factory.tickets.proofPassed}`,
      )
    ).json()) as TicketResponse
    expect(
      data.decisions!.find((d) => d.purpose === 'merge')!.finalOption,
    ).toBe('owner')
  })
})
