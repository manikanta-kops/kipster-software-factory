import { z } from 'zod'
import { parse } from 'yaml'
import { run } from '../executors/process.ts'
import type { RepositoryKit } from '../domain/records.ts'

const command = z.string().trim().min(1)
export const verifySchema = z
  .strictObject({
    start: command,
    ready: command,
    ports: z.number().int().min(1).max(16),
    database: z.enum(['postgres', 'none']),
    timeoutSeconds: z.number().positive().max(3600),
  })
  .superRefine((verify, ctx) => {
    for (const field of ['start', 'ready'] as const) {
      const value = verify[field]
      if (!value.includes('{port}'))
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: 'must contain {port}',
        })
      for (const match of value.matchAll(/\{(port\d*|databaseUrl)\}/g)) {
        const key = match[1]!
        if (
          key.startsWith('port') &&
          key !== 'port' &&
          (Number(key.slice(4)) < 1 || Number(key.slice(4)) > verify.ports)
        )
          ctx.addIssue({
            code: 'custom',
            path: [field],
            message: `unallocated placeholder {${key}}`,
          })
      }
    }
    if (
      verify.database === 'postgres' &&
      !verify.start.includes('{databaseUrl}')
    )
      ctx.addIssue({
        code: 'custom',
        path: ['start'],
        message: 'postgres start must contain {databaseUrl}',
      })
    try {
      const url = new URL(verify.ready.replaceAll(/\{port\d*\}/g, '12345'))
      if (
        !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\{port\}(?:[/?#]|$)/.test(
          verify.ready,
        ) ||
        url.protocol !== 'http:' ||
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      )
        throw new Error()
    } catch {
      ctx.addIssue({
        code: 'custom',
        path: ['ready'],
        message: 'must be a local http URL with {port}',
      })
    }
  })
export const kitSchema = z.strictObject({
  version: z.literal(1),
  setup: command.optional(),
  check: command,
  verify: verifySchema.optional(),
  merge: z
    .strictObject({
      migrations: z
        .array(
          z
            .string()
            .trim()
            .min(1)
            .max(500)
            .refine(
              (glob) =>
                !glob.startsWith('/') &&
                !glob.split('/').includes('..') &&
                !/[!{}\\]/.test(glob),
            ),
        )
        .optional(),
    })
    .optional(),
})
export type Kit = z.infer<typeof kitSchema>
export type Verify = z.infer<typeof verifySchema>
export function parseKit(source: string): Kit {
  return kitSchema.parse(parse(source))
}
export const FEATURE_SECTIONS = [
  'Sub-features',
  'How to get to it (user point of view)',
  'Driving it',
  'Gotchas',
] as const
export function validateFeatureMap(source: string): void {
  const headings = [
    ...source
      .replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '')
      .matchAll(/^## (.+)\s*$/gm),
  ].map((match) => match[1]!.trim())
  z.tuple(
    FEATURE_SECTIONS.map((heading) => z.literal(heading)) as [
      z.ZodLiteral<string>,
      z.ZodLiteral<string>,
      z.ZodLiteral<string>,
      z.ZodLiteral<string>,
    ],
  ).parse(headings)
  for (const section of source.split(/^## .+$/m).slice(1))
    if (!section.trim())
      throw new Error('Feature map sections must not be empty')
  const driving =
    source.split(/^## Driving it\s*$/m)[1]?.split(/^## /m)[0] ?? ''
  if (
    !/\|\s*User action\s*\|\s*Exact command\s*\|\s*Observable result\s*\|/i.test(
      driving,
    )
  )
    throw new Error(
      'Driving it requires a User action | Exact command | Observable result table',
    )
  const rows = driving
    .split('\n')
    .filter((line) => /^\|/.test(line.trim()))
    .slice(2)
  if (
    !rows.length ||
    rows.some(
      (line) =>
        line.split('|').slice(1, -1).length !== 3 ||
        line
          .split('|')
          .slice(1, -1)
          .some((cell) => !cell.trim()),
    )
  )
    throw new Error(
      'Each driving row must pair an action, exact command and observable result',
    )
}
export type LoadedKit = {
  readonly kit: Kit | null
  readonly state: RepositoryKit
}
/** Reads committed blobs, never the cache checkout (which may lag its remote). */
export async function loadKit(
  repositoryPath: string,
  commit: string,
  signal?: AbortSignal,
): Promise<LoadedKit> {
  const git = (args: string[]) =>
    run('git', args, { cwd: repositoryPath, ...(signal ? { signal } : {}) })
  const files = (
    await git(['ls-tree', '-r', '--name-only', commit, '--', '.kipster'])
  ).split('\n')
  if (!files.includes('.kipster/kit.yml'))
    return {
      kit: null,
      state: { status: 'missing', error: null, capabilities: [] },
    }
  try {
    const read = (path: string) => git(['show', `${commit}:${path}`])
    const kit = parseKit(await read('.kipster/kit.yml'))
    if (kit.verify) {
      if (!(await read('.kipster/verify/README.md')).trim())
        throw new Error('verify/README.md must not be empty')
      const maps = files.filter((path) =>
        /^\.kipster\/verify\/features\/[^/]+\.md$/.test(path),
      )
      if (!maps.length)
        throw new Error('verify/features requires at least one feature map')
      for (const path of maps) {
        try {
          validateFeatureMap(await read(path))
        } catch (error) {
          throw new Error(`${path}: ${String(error)}`, { cause: error })
        }
      }
    }
    return {
      kit,
      state: {
        status: 'valid',
        error: null,
        capabilities: [
          ...(kit.setup ? ['setup'] : []),
          ...(kit.verify ? ['verify'] : []),
        ],
      },
    }
  } catch (error) {
    signal?.throwIfAborted()
    return {
      kit: null,
      state: { status: 'invalid', error: String(error), capabilities: [] },
    }
  }
}
