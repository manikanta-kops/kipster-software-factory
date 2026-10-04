import { test as base, expect } from '@playwright/test'
import type { DemoTickets } from '../../scripts/demo-data.ts'

interface FactoryFixture {
  url: string
  tickets: DemoTickets
  artifactTicket: number | null
}
export const test = base.extend<{
  factory: FactoryFixture
  withArtifacts: boolean
  verdict: 'changes-needed' | 'unobserved' | 'default'
}>({
  withArtifacts: [false, { option: true }],
  verdict: ['default', { option: true }],
  factory: async ({ request, withArtifacts, verdict }, runTest) => {
    const response = await request.post(
      `/__test/fixtures?artifacts=${withArtifacts}&verdict=${verdict}`,
    )
    expect(response.ok()).toBeTruthy()
    const fixture = (await response.json()) as FactoryFixture
    try {
      await runTest(fixture)
    } finally {
      await request.post('/__test/dispose', { data: { url: fixture.url } })
    }
  },
})
export { expect }
