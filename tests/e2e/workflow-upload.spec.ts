import { test, expect } from './fixtures.ts'

const file = (name: string, source: string) => ({
  name,
  mimeType: 'application/yaml',
  buffer: Buffer.from(source),
})

const reviewOnly = (name = 'review-only') => `name: ${name}
description: Build it and have it reviewed.
steps:
  - id: build
    kind: agent
    role: builder
  - id: review
    kind: agent
    role: reviewer
    limit: 2
    routes:
      changes-needed: build
`

test('upload a workflow file, fix its errors and start a ticket with it', async ({
  page,
  factory,
}) => {
  await page.goto(`${factory.url}/#/workflows`)
  const picker = page.getByLabel('Upload workflow')

  await picker.setInputFiles(
    file('broken.yml', reviewOnly().replace('role: reviewer', 'role: critic')),
  )
  const problem = page.getByRole('alert')
  await expect(problem).toContainText('The workflow is not valid')
  await expect(problem.getByRole('listitem')).toHaveText([
    /step "review": role must be one of planner, builder/,
  ])

  await picker.setInputFiles(file('review-only.yml', reviewOnly()))
  await expect(page).toHaveURL(/#\/workflows\/review-only$/)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(
    page.getByText(/^Saved review-only, version [0-9a-f]{12}\.$/),
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'review-only', exact: true }),
  ).toBeVisible()
  await expect(page.getByText(/· uploaded$/)).toBeVisible()
  const diagram = page.getByRole('figure', { name: 'review-only workflow' })
  await expect(
    diagram.getByRole('button', { name: 'review: reviewer' }),
  ).toBeVisible()
  await expect(
    page.getByRole('link', { name: /^review-only uploaded/ }),
  ).toBeVisible()

  await picker.setInputFiles(file('feature.yml', reviewOnly('feature')))
  await expect(page.getByRole('alert')).toContainText(
    '"feature" is a workflow file in the factory',
  )

  await page.getByRole('link', { name: 'New ticket' }).click()
  await page
    .getByLabel('Repository', { exact: true })
    .selectOption('kipster/demo-shop')
  await page.getByRole('radio', { name: /^review-only / }).check()
  await page.getByLabel('Title', { exact: true }).fill('Tidy the cart copy')
  await page.getByRole('button', { name: 'Create ticket' }).click()
  await expect(
    page.getByRole('heading', { name: 'Tidy the cart copy' }),
  ).toBeVisible()
  await expect(page).toHaveURL(/#\/tickets\/\d+$/)
})
