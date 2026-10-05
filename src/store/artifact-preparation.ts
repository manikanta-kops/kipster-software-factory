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
  try {
    for (const input of inputs) {
      const artifact = home
        ? await retainArtifact(home, rows[0].ticket_id, input)
        : input
      if (home && artifact.path && artifact.path !== resolve(home, input.path!))
        copies.push(artifact.path)
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
    }
    return await work(prepared)
  } catch (error) {
    await Promise.all(copies.map((path) => rm(path, { force: true })))
    throw error
  }
}
