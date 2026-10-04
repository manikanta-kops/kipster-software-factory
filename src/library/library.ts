import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseWorkflow, type Workflow } from '../domain/workflow.ts'

/** The workflows that ship with the factory. */
export const BUILT_IN_WORKFLOWS = fileURLToPath(
  new URL('../../workflows/', import.meta.url),
)

export interface LibraryEntry {
  readonly workflow: Workflow
  /** Content hash of the source; a ticket keeps the version it started with. */
  readonly version: string
  readonly source: string
}

export type Library = ReadonlyMap<string, LibraryEntry>

export type LoadResult =
  | { readonly ok: true; readonly library: Library }
  | { readonly ok: false; readonly errors: readonly string[] }

export function workflowVersion(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 12)
}

/** Loads every `<name>.yml` in a directory and checks references between workflows. */
export async function loadLibrary(directory: string): Promise<LoadResult> {
  const files = (await readdir(directory))
    .filter((file) => extname(file) === '.yml')
    .sort()
  const errors: string[] = []
  const library = new Map<string, LibraryEntry>()

  for (const file of files) {
    const source = await readFile(join(directory, file), 'utf8')
    const result = parseWorkflow(source)
    if (!result.ok) {
      errors.push(...result.errors.map((error) => `${file}: ${error}`))
      continue
    }
    const expected = basename(file, '.yml')
    if (result.workflow.name !== expected) {
      errors.push(
        `${file}: workflow name "${result.workflow.name}" must match the file name "${expected}"`,
      )
      continue
    }
    library.set(expected, {
      workflow: result.workflow,
      version: workflowVersion(source),
      source,
    })
  }

  for (const [name, { workflow }] of library) {
    for (const step of workflow.steps) {
      if (step.kind !== 'system' || step.action !== 'split') continue
      const child = step.with['workflow']
      if (typeof child === 'string' && !library.has(child)) {
        errors.push(
          `${name}.yml: step "${step.id}" splits into unknown workflow "${child}"`,
        )
      }
    }
  }

  if (files.length === 0) errors.push(`${directory}: no workflow files found`)
  return errors.length > 0 ? { ok: false, errors } : { ok: true, library }
}
