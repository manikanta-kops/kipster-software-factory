import type { Page } from '@playwright/test'
import type { SettingsResponse } from '../../src/api/contract.ts'
import { test, expect } from './fixtures.ts'

async function setAgent(
  page: Page,
  label: string,
  cli: string,
  model: string,
  effort: string,
) {
  await page.getByLabel(`${label} CLI`).selectOption(cli)
  await page.getByLabel(`${label} model`).fill(model)
  await page.getByLabel(`${label} effort`).selectOption(effort)
}

test('edit limits, allowed agents and a workflow override; they persist', async ({
  page,
  factory,
  request,
}, testInfo) => {
  await page.goto(`${factory.url}/#/settings`)
  await expect(
    page.getByRole('link', { name: 'Settings', exact: true }),
  ).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('.settings-source')).toHaveText(
    'From config.json. Saving stores these in the factory database.',
  )
  const concurrency = page.getByLabel('Steps running at once')
  const timeout = page.getByLabel('Step timeout (minutes)')
  await expect(concurrency).toHaveValue('2')
  await expect(timeout).toHaveValue('120')

  await concurrency.fill('3')
  await timeout.fill('240')
  await page.getByRole('button', { name: 'Add allowed agent' }).click()
  await setAgent(page, 'Allowed 1', 'claude', 'claude-opus-5-5', 'high')
  await page.getByLabel('Workflow to override').selectOption('task')
  await page.getByRole('button', { name: 'Add override' }).click()
  await page.getByLabel('Step timeout for task (minutes)').fill('240')
  await setAgent(page, 'task builder', 'codex', 'gpt-6.1-sol', 'high')
  await setAgent(page, 'task reviewer', 'claude', 'claude-opus-5-5', 'medium')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByText('Settings saved.')).toBeVisible()
  await expect(page.locator('.settings-source')).toContainText(/^Saved /)
  await page.screenshot({
    path: testInfo.outputPath('settings-saved.png'),
    fullPage: true,
  })

  const saved = (await (
    await request.get(`${factory.url}/api/settings`)
  ).json()) as SettingsResponse
  expect(saved.source).toBe('saved')
  expect(saved.settings).toEqual({
    concurrency: 3,
    stepTimeoutMinutes: 240,
    agents: {
      default: { cli: 'codex' },
      roles: {},
      allowed: [{ cli: 'claude', model: 'claude-opus-5-5', effort: 'high' }],
    },
    workflows: {
      task: {
        stepTimeoutMinutes: 240,
        roles: {
          builder: { cli: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
          reviewer: {
            cli: 'claude',
            model: 'claude-opus-5-5',
            effort: 'medium',
          },
        },
      },
    },
  })

  await page.reload()
  await expect(concurrency).toHaveValue('3')
  await expect(timeout).toHaveValue('240')
  await expect(page.getByLabel('Allowed 1 model')).toHaveValue(
    'claude-opus-5-5',
  )
  await expect(page.getByLabel('task builder model')).toHaveValue('gpt-6.1-sol')
  await expect(page.getByLabel('task reviewer effort')).toHaveValue('medium')
  await expect(page.getByLabel('task tester CLI')).toHaveValue('')

  const override = page.getByRole('region', { name: 'Override for task' })
  await override.getByRole('button', { name: 'Remove override' }).click()
  await page.getByRole('button', { name: 'Remove allowed agent 1' }).click()
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByText('Settings saved.')).toBeVisible()
  await page.reload()
  await expect(concurrency).toHaveValue('3')
  await expect(override).toHaveCount(0)
  await expect(page.getByLabel('Allowed 1 model')).toHaveCount(0)
})

test('invalid values are caught on the page; server issues are shown', async ({
  page,
  factory,
}) => {
  const posts: string[] = []
  page.on('request', (sent) => {
    if (sent.method() === 'POST' && sent.url().endsWith('/api/settings'))
      posts.push(sent.url())
  })
  await page.goto(`${factory.url}/#/settings`)
  const concurrency = page.getByLabel('Steps running at once')
  await expect(concurrency).toHaveValue('2')
  await concurrency.fill('0')
  await page.getByLabel('Step timeout (minutes)').fill('')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByRole('alert')).toHaveText(
    'Fix the highlighted fields before saving.',
  )
  await expect(concurrency).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByText('must be a positive integer')).toBeVisible()
  await expect(
    page.getByText('must be a positive number of minutes'),
  ).toBeVisible()
  expect(posts).toEqual([])

  await concurrency.fill('2')
  await page.getByLabel('Step timeout (minutes)').fill('60')
  // A workflow removed after the page loaded: only the server knows.
  await page.route('**/api/settings', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'The settings are not valid',
            issues: ['workflows.task: unknown workflow'],
          }),
        })
      : route.continue(),
  )
  await page.getByLabel('Workflow to override').selectOption('task')
  await page.getByRole('button', { name: 'Add override' }).click()
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByRole('alert')).toHaveText(
    'The settings are not valid: workflows.task: unknown workflow',
  )
  await expect(
    page
      .getByRole('region', { name: 'Override for task' })
      .getByText('unknown workflow', { exact: true }),
  ).toBeVisible()
  expect(posts).toHaveLength(1)
})
