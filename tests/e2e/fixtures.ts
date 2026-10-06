import { test as base, expect } from '@playwright/test'
import type { DemoTickets } from '../../scripts/demo-data.ts'

interface FactoryFixture {
  url: string
  tickets: DemoTickets
  artifactTicket: number | null
  decisionTicket: number | null
  linkedTickets: { original: number; linked: number } | null
  taskTickets: { lead: number; child: number } | null
}
export const test = base.extend<{
  factory: FactoryFixture
  withAutoMerge: boolean
  withLinks: boolean
  withTasks: boolean
  withArtifacts: boolean
  withDecisions: boolean
  verdict: 'changes-needed' | 'unobserved' | 'default'
}>({
  withAutoMerge: [false, { option: true }],
  withLinks: [false, { option: true }],
  withTasks: [false, { option: true }],
  withDecisions: [false, { option: true }],
  withArtifacts: [false, { option: true }],
  verdict: ['default', { option: true }],
  factory: async (
    {
      request,
      withArtifacts,
      verdict,
      withDecisions,
      withAutoMerge,
      withLinks,
      withTasks,
    },
    runTest,
  ) => {
    const response = await request.post(
      `/__test/fixtures?artifacts=${withArtifacts}&decisions=${withDecisions}&verdict=${verdict}&autoMerge=${withAutoMerge}&links=${withLinks}&tasks=${withTasks}`,
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
