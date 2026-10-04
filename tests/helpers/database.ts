import { randomUUID } from 'node:crypto'
import { Client } from 'pg'

export interface TestDatabase {
  readonly url: string
  drop(): Promise<void>
}

/** Creates an empty database in the throwaway cluster started by `npm test`. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = process.env['KSF_TEST_DATABASE_URL']
  if (!adminUrl) {
    throw new Error(
      'KSF_TEST_DATABASE_URL is not set; run tests with `npm test`',
    )
  }
  const name = `test_${randomUUID().replaceAll('-', '')}`
  await withAdmin(adminUrl, (client) => client.query(`CREATE DATABASE ${name}`))
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  return {
    url: url.href,
    drop: () =>
      withAdmin(adminUrl, (client) =>
        client.query(`DROP DATABASE ${name} WITH (FORCE)`),
      ),
  }
}

async function withAdmin(
  url: string,
  work: (client: Client) => Promise<unknown>,
) {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    await work(client)
  } finally {
    await client.end()
  }
}
