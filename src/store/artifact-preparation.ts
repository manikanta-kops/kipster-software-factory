import { rm } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { FactoryError } from '../domain/errors.ts'
import { retainArtifact } from '../artifacts/storage.ts'
import { detectMediaType } from '../artifacts/media-type.ts'
import type { ArtifactInput } from '../domain/lifecycle.ts'
import { artifactHome, type Database } from './database.ts'
export type PreparedArtifact = ArtifactInput & { readonly mediaType?: string }

/** Retain files before opening the ticket transaction; only this call's copies are removed on failure. */
export async function withPreparedArtifacts<T>(
  database: Database,
  attemptId: number,
  inputs: readonly ArtifactInput[],
  work: (artifacts: readonly PreparedArtifact[]) => Promise<T>,
): Promise<T> {
  const { rows } = await database.query<{ ticket_id: number }>(
    'SELECT ticket_id FROM attempts WHERE id = $1',
    [attemptId],
  )
  if (!rows[0])
    throw new FactoryError('not-found', `No attempt with id ${attemptId}`)
  const home = artifactHome(database)
  const copies: string[] = []
  const prepared: PreparedArtifact[] = []
  let recording = false
  try {
    for (const input of inputs) {
      let copy: string | undefined
      try {
        const artifact = home
          ? await retainArtifact(home, rows[0].ticket_id, input)
          : input
        if (
          home &&
          artifact.path &&
          artifact.path !== resolve(home, input.path!)
        ) {
          copy = artifact.path
          copies.push(copy)
        }
        let mediaType =
          artifact.content !== undefined
            ? 'text/markdown'
            : 'application/octet-stream'
        if (artifact.path && isAbsolute(artifact.path)) {
          try {
            mediaType = await detectMediaType(artifact.path)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
        prepared.push({ ...artifact, mediaType })
      } catch (error) {
        if (!input.path) throw error
        if (copy) {
          await rm(copy, { force: true })
          copies.splice(copies.indexOf(copy), 1)
        }
        prepared.push({
          kind: 'note',
          title: 'Artifact file could not be retained',
          content: `${input.title}\n\nFile: ${input.path}\nReason: ${error instanceof Error ? error.message : String(error)}`,
          mediaType: 'text/markdown',
          ...(input.scenario ? { scenario: input.scenario } : {}),
        })
      }
    }
    recording = true
    return await work(prepared)
  } catch (error) {
    let removable = copies
    if (recording && copies.length) {
      // A commit acknowledgement can be lost; preserve referenced files or uncertain state.
      try {
        const { rows: referenced } = await database.query<{ path: string }>(
          'SELECT path FROM artifacts WHERE path = ANY($1::text[])',
          [copies],
        )
        const retained = new Set(referenced.map((artifact) => artifact.path))
        removable = copies.filter((path) => !retained.has(path))
      } catch {
        throw error
      }
    }
    await Promise.all(removable.map((path) => rm(path, { force: true })))
    throw error
  }
}
