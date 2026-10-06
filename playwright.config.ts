import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env['KSF_E2E_PORT'] ?? 4617)

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: process.env['KSF_E2E_OUTPUT_DIR'] ?? 'test-results',
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command:
      'npm run build && node scripts/with-test-database.ts node tests/e2e/server.ts',
    url: `http://127.0.0.1:${port}/api/health`,
    env: { KSF_E2E_PORT: String(port) },
    reuseExistingServer: false,
    timeout: 120_000,
    // The default SIGKILL leaves the throwaway PostgreSQL cluster running.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 30_000 },
  },
})
