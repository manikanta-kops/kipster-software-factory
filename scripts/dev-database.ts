// The persistent development database under .local/, shared by `npm run dev` and `npm run seed:demo`.
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type Cluster,
  clusterUrl,
  ensureDatabase,
} from '../src/store/cluster.ts'

export const root = fileURLToPath(new URL('..', import.meta.url))
const repoKey = createHash('sha256').update(root).digest('hex').slice(0, 8)

export const devCluster: Cluster = {
  data: join(root, '.local', 'postgres'),
  socketDirectory: join('/tmp', `ksf-dev-${repoKey}`),
}

const DATABASE = 'factory'

export const devDatabaseUrl = clusterUrl(devCluster, DATABASE)

export async function ensureDevDatabase(): Promise<void> {
  await ensureDatabase(devCluster, DATABASE)
}
