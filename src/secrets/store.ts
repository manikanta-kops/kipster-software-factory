import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const SECRET_SERVICE = 'kipster-software-factory'
export type SecretBackend =
  'keychain' | 'secret-service' | 'credential-manager' | 'file'
export interface Secrets {
  get(name: string): Promise<string | null>
  set(name: string, value: string): Promise<SecretBackend>
  list(): Promise<{ name: string; backend: SecretBackend }[]>
  remove(name: string): Promise<void>
}
function validName(name: string) {
  if (!/^[a-z][a-z0-9._-]*$/.test(name))
    throw new Error(
      'Secret names use lowercase letters, digits, dots, underscores and hyphens.',
    )
}
export function secretStore(
  home: string,
  backend: SecretBackend = 'keychain',
  warn: (message: string) => void = console.warn,
): Secrets {
  const osBackend: SecretBackend =
    process.platform === 'darwin'
      ? 'keychain'
      : process.platform === 'win32'
        ? 'credential-manager'
        : 'secret-service'
  const path = join(home, 'secrets.json')
  const read = async (): Promise<Record<string, string | null>> => {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as Record<
        string,
        string | null
      >
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw new Error('Cannot read the file secret store.', { cause: error })
    }
  }
  const write = async (values: Record<string, string | null>) => {
    await mkdir(home, { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomUUID()}`
    try {
      await writeFile(temporary, `${JSON.stringify(values, null, 2)}\n`, {
        mode: 0o600,
        flag: 'wx',
      })
      await chmod(temporary, 0o600)
      await rename(temporary, path)
    } finally {
      await unlink(temporary).catch(() => {})
    }
  }
  const keyring = () => import('@napi-rs/keyring')
  const entry = async (name: string) => {
    const { AsyncEntry } = await keyring()
    return new AsyncEntry(SECRET_SERVICE, name, {
      linux: { store: 'secret-service' },
    })
  }
  const fallback = () =>
    warn(
      'OS credential store unavailable; using secrets.json (mode 0600) in the factory home.',
    )
  return {
    async get(name) {
      validName(name)
      const values = await read()
      if (Object.hasOwn(values, name)) return values[name] ?? null
      if (backend === 'file') return null
      try {
        return (await (await entry(name)).getPassword()) ?? null
      } catch {
        fallback()
        return null
      }
    },
    async set(name, value) {
      validName(name)
      if (!value.trim()) throw new Error('A secret cannot be empty.')
      const values = await read()
      if (backend !== 'file') {
        try {
          await (await entry(name)).setPassword(value)
        } catch {
          fallback()
          values[name] = value
          await write(values)
          return 'file'
        }
        if (Object.hasOwn(values, name)) {
          delete values[name]
          await write(values)
        }
        return osBackend
      }
      values[name] = value
      await write(values)
      return 'file'
    },
    async list() {
      const values = await read()
      const names = new Map<string, SecretBackend>()
      if (backend !== 'file') {
        try {
          const credentials = await (
            await keyring()
          ).findCredentialsAsync(SECRET_SERVICE)
          for (const { account } of credentials) names.set(account, osBackend)
        } catch {
          fallback()
        }
      }
      for (const [name, value] of Object.entries(values)) {
        if (value === null) names.delete(name)
        else names.set(name, 'file')
      }
      return [...names]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, heldBy]) => ({ name, backend: heldBy }))
    },
    async remove(name) {
      validName(name)
      const values = await read()
      if (backend !== 'file') {
        try {
          await (await entry(name)).deleteCredential()
        } catch {
          if (!Object.hasOwn(values, name))
            throw new Error(
              'Cannot remove the OS credential; unlock the credential store and retry.',
            )
          // A tombstone prevents an inaccessible older OS copy from resurfacing later.
          values[name] = null
          await write(values)
          warn(
            'File secret removed. OS credential store unavailable; any OS copy can only be deleted once the store is available. Re-run remove then.',
          )
          return
        }
      }
      if (Object.hasOwn(values, name)) {
        delete values[name]
        await write(values)
      }
    },
  }
}
