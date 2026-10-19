import { test, expect } from './fixtures.ts'

test.use({ withUpdate: true })

test('an available update waits for running steps, can be cancelled, then installs and offers a reload', async ({
  page,
  factory,
  request,
}, testInfo) => {
  await page.goto(factory.url)
  const pill = page.getByRole('button', { name: 'Update available' })
  await expect(pill).toBeVisible()
  await pill.click()
  const panel = page.locator('#update-panel')
  await expect(panel).toContainText(
    'v9.9.9 is available. This factory runs v0.4.3.',
  )
  await expect(panel).toContainText('Otherwise it installs tonight.')
  await expect(
    panel.getByRole('link', { name: 'Release notes' }),
  ).toHaveAttribute(
    'href',
    'https://github.com/manikanta-kops/kipster-software-factory/releases/tag/v9.9.9',
  )
  await page.screenshot({ path: testInfo.outputPath('update-available.png') })

  await panel.getByRole('button', { name: 'Update now' }).click()
  await expect(
    page.getByRole('button', { name: 'Update waiting' }),
  ).toBeVisible()
  await expect(panel).toContainText(
    'Updating to v9.9.9 after 1 running step finish.',
  )
  await panel.getByRole('button', { name: 'Cancel update' }).click()
  await expect(pill).toBeVisible()

  await panel.getByRole('button', { name: 'Update now' }).click()
  await expect(
    page.getByRole('button', { name: 'Update waiting' }),
  ).toBeVisible()
  await request.post('/__test/finish-steps', { data: { url: factory.url } })
  await expect(page.getByRole('button', { name: 'Updating…' })).toBeVisible()
  const reload = page.getByRole('button', {
    name: 'Updated to v9.9.9 · Reload',
  })
  await expect(reload).toBeVisible({ timeout: 15_000 })
  await page.screenshot({ path: testInfo.outputPath('update-done.png') })
  await reload.click()
  await expect(page.getByRole('link', { name: 'Today' })).toBeVisible()
  await expect(reload).toHaveCount(0)
})

test('with no newer release the header shows no update', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('link', { name: 'Today' })).toBeVisible()
  await expect(page.locator('.update-pill')).toHaveCount(0)
})
