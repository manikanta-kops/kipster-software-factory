import { expect, test } from '@playwright/test'

test('the home page shows only what needs you', async ({ page }) => {
  await page.goto('/')
  await expect(
    page.getByRole('heading', { name: 'Nothing needs you.' }),
  ).toBeVisible()
  await expect(page.locator('output.status')).toHaveText('Online')
})

test('workflows render as steps with their loops', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: 'Workflows' }).click()
  await expect(page).toHaveURL(/\/workflows$/)

  await page.getByRole('link', { name: /^bug/ }).click()
  await expect(page).toHaveURL(/\/workflows\/bug$/)
  const diagram = page.getByRole('figure', { name: 'bug workflow' })
  await expect(diagram.getByText('reproduce', { exact: true })).toBeVisible()
  const testStep = diagram.locator('li.node', {
    has: page.getByText('test', { exact: true }),
  })
  await expect(testStep.getByText('changes-needed → fix')).toBeVisible()
  await expect(testStep.getByText('after 3 rounds → you')).toBeVisible()
  await expect(diagram.locator('path.edge.back')).not.toHaveCount(0)
})

test('a workflow link opens directly', async ({ page }) => {
  await page.goto('/workflows/large-feature')
  await expect(
    page.getByRole('heading', { name: 'large-feature' }),
  ).toBeVisible()
  await expect(page.getByText('after 2 rounds → maintain-pr')).toBeVisible()
})
