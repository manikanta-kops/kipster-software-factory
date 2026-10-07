import { test, expect } from './fixtures.ts'

const reviewOnly = `name: review-only
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

test('remove an uploaded workflow once its tickets finish; built-ins have no Remove', async ({
  page,
  factory,
}) => {
  const api = (path: string, data: unknown) =>
    page.request.post(`${factory.url}/api${path}`, { data })
  expect((await api('/workflows', { source: reviewOnly })).status()).toBe(201)
  const created = await api('/tickets', {
    repository: 'kipster/demo-shop',
    workflow: 'review-only',
    title: 'Tidy the cart copy',
  })
  expect(created.status()).toBe(201)
  const { ticket } = (await created.json()) as { ticket: { number: number } }

  await page.goto(`${factory.url}/#/workflows/lead`)
  await expect(
    page.getByRole('heading', { name: 'lead', exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(0)

  await page.getByRole('link', { name: /^review-only uploaded/ }).click()
  await page.getByRole('button', { name: 'Remove', exact: true }).click()
  const confirm = page.getByRole('group', { name: 'Remove review-only?' })
  await expect(confirm).toContainText('Finished tickets keep their copy.')
  await confirm.getByRole('button', { name: 'Keep it' }).click()
  await expect(confirm).toHaveCount(0)

  await page.getByRole('button', { name: 'Remove', exact: true }).click()
  await confirm.getByRole('button', { name: 'Remove workflow' }).click()
  await expect(page.getByRole('alert')).toHaveText(
    `"review-only" is used by unfinished tickets #${ticket.number}; finish or cancel them first`,
  )
  await expect(
    page.getByRole('link', { name: /^review-only uploaded/ }),
  ).toBeVisible()

  expect((await api(`/tickets/${ticket.number}/cancel`, {})).status()).toBe(200)
  await confirm.getByRole('button', { name: 'Remove workflow' }).click()
  await expect(page).toHaveURL(/#\/workflows$/)
  await expect(page.getByText('Removed review-only.')).toBeVisible()
  await expect(
    page.getByRole('link', { name: /^review-only uploaded/ }),
  ).toHaveCount(0)

  await page.goto(`${factory.url}/#/tickets/${ticket.number}`)
  await expect(
    page.getByRole('heading', { name: 'Tidy the cart copy' }),
  ).toBeVisible()
  const steps = page.getByRole('region', { name: /^Steps / })
  await expect(steps.getByRole('listitem')).toHaveText([/^Build/, /^Review/])
  await page.getByRole('link', { name: 'Review only' }).first().click()
  await expect(
    page.getByText(
      'review-only is not in the library. Tickets that ran it keep their copy.',
    ),
  ).toBeVisible()
})
