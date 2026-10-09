import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { newEvidenceFile } from '../artifacts/storage.ts'
import type { ArtifactInput } from '../domain/lifecycle.ts'

export function createPromptFiles(
  home: string,
  ticketId: number,
  directory: string,
) {
  const artifacts: ArtifactInput[] = []
  async function section(title: string, content: string, extension: string) {
    // Prompts are retained after step cleanup, so their references must live as long.
    const path = await newEvidenceFile(home, ticketId, extension)
    await writeFile(path, content)
    artifacts.push({
      kind: 'log',
      title: `Session context: ${title}`.slice(0, 200),
      path,
    })
    return `${title}\nRead file: ${JSON.stringify(path)}`
  }
  return {
    json: (title: string, value: unknown) =>
      section(title, JSON.stringify(value, null, 2), '.json'),
    text: (title: string, value: string) => section(title, value, '.md'),
    finish: () =>
      writeFile(
        join(directory, 'context-files.json'),
        JSON.stringify(artifacts),
      ),
  }
}

export async function readPromptFiles(
  directory: string,
): Promise<ArtifactInput[]> {
  try {
    return JSON.parse(
      await readFile(join(directory, 'context-files.json'), 'utf8'),
    ) as ArtifactInput[]
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
