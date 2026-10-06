import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, realpath, rm } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import type { ArtifactInput } from '../domain/lifecycle.ts'
import { inspectArtifactFile } from '../api/artifact-files.ts'

export async function evidenceDirectory(
  home: string,
  ticketId: number,
): Promise<string> {
  const root = await realpath(home)
  const directory = join(resolve(home), 'evidence', String(ticketId))
  await mkdir(directory, { recursive: true })
  if ((await realpath(directory)) !== join(root, 'evidence', String(ticketId)))
    throw new Error('Evidence storage must not contain symlinks')
  return directory
}
export async function newEvidenceFile(
  home: string,
  ticketId: number,
  extension = '.log',
): Promise<string> {
  return join(
    await evidenceDirectory(home, ticketId),
    `${randomUUID()}${extension}`,
  )
}
export async function retainArtifact(
  home: string,
  ticketId: number,
  artifact: ArtifactInput,
): Promise<ArtifactInput> {
  if (!artifact.path) return artifact
  const file = await inspectArtifactFile(home, artifact.path)
  if (!file.ok) throw new Error(`Cannot retain artifact: ${file.reason}`)
  const directory = await evidenceDirectory(home, ticketId)
  if (
    artifact.kind === 'log' &&
    file.path.startsWith(`${await realpath(directory)}/`)
  )
    return { ...artifact, path: resolve(home, artifact.path) }
  const path = join(directory, `${randomUUID()}${extname(file.path)}`)
  try {
    await copyFile(file.path, path)
  } catch (error) {
    await rm(path, { force: true })
    throw error
  }
  return { ...artifact, path }
}

export async function cleanVerificationEvidence(
  home: string,
  directory: string,
) {
  const root = await realpath(home)
  const target = await realpath(directory)
  if (
    !new RegExp(`^evidence-[^/]+$`).test(
      target.slice(target.lastIndexOf('/') + 1),
    ) ||
    !target.startsWith(`${root}/verification/`)
  )
    throw new Error('Not a verification scratch directory')
  await rm(target, { recursive: true })
}
