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
  /** Added through the API rather than loaded from a workflow file. */
  readonly uploaded?: true
}

export type Library = ReadonlyMap<string, LibraryEntry>

export type LoadResult =
  | { readonly ok: true; readonly library: Map<string, LibraryEntry> }
  | { readonly ok: false; readonly errors: readonly string[] }

export function workflowVersion(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 12)
}

/** Loads every `<name>.yml` in a directory and validates each workflow. */
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

  if (files.length === 0) errors.push(`${directory}: no workflow files found`)
  return errors.length > 0 ? { ok: false, errors } : { ok: true, library }
}

export type UploadResult =
  | { readonly ok: true; readonly entry: LibraryEntry }
  | { readonly ok: false; readonly errors: readonly string[] }

/** Validates workflow source added through the API. */
export function parseUpload(source: string): UploadResult {
  const result = parseWorkflow(source)
  if (!result.ok) return result
  return {
    ok: true,
    entry: {
      workflow: result.workflow,
      version: workflowVersion(source),
      source,
      uploaded: true,
    },
  }
}

/**
 * Adds saved uploads to a library loaded from files. A workflow file keeps its
 * name, and an upload the current catalog no longer accepts is left out.
 */
export function addUploads(
  library: Map<string, LibraryEntry>,
  uploads: readonly { readonly name: string; readonly source: string }[],
): readonly string[] {
  const warnings: string[] = []
  for (const { name, source } of uploads) {
    if (library.has(name)) {
      warnings.push(
        `Uploaded workflow "${name}" is hidden by the workflow file with the same name`,
      )
      continue
    }
    const result = parseUpload(source)
    if (!result.ok) {
      warnings.push(
        `Uploaded workflow "${name}" is no longer valid: ${result.errors.join('; ')}`,
      )
      continue
    }
    library.set(name, result.entry)
  }
  return warnings
}
