// Serves the built factory against the throwaway database for Playwright.
import { BUILT_WEB_APP, startFactory } from '../../src/server.ts'

const databaseUrl = process.env['KSF_TEST_DATABASE_URL']
const port = Number(process.env['KSF_E2E_PORT'])
if (!databaseUrl || !port) {
  throw new Error('Run through `npm run test:e2e`')
}

const factory = await startFactory({
  databaseUrl,
  port,
  webRoot: BUILT_WEB_APP,
})
console.log(`e2e factory at ${factory.url}`)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void factory.close())
}
