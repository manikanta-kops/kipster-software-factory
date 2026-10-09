import { readPromptContext } from '../helpers/prompt.ts'
import { spawn, execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const [directory, scriptFile, stateRoot] = process.argv.slice(2) as [
  string,
  string,
  string,
]
const prompt = readPromptContext(
  await readFile(join(directory, 'prompt.md'), 'utf8'),
)
const role =
  /You are (?:an independent |the )(\w+)/i.exec(prompt)?.[1]?.toLowerCase() ??
  'unknown'
const script = JSON.parse(await readFile(scriptFile, 'utf8')) as Record<
  string,
  {
    outcome?: string
    invalid?: boolean
    missing?: boolean
    wait?: boolean
    commit?: boolean
    descendant?: boolean
    proof?: boolean
    fixed?: boolean
    edit?: boolean
    crash?: boolean
    noEvidence?: boolean
    proseOnly?: boolean
  }[]
>
const counter = join(stateRoot, `${role}.count`)
let count = 0
try {
  count = Number(await readFile(counter, 'utf8'))
} catch {}
await writeFile(counter, String(count + 1))
const instruction = script[role]?.[count] ?? script[role]?.at(-1) ?? {}
console.log(`fake ${role} run ${count + 1}`)
await writeFile(join(directory, 'pid'), String(process.pid))
if (instruction.descendant) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })
  await writeFile(join(directory, 'descendant.pid'), String(child.pid))
}
if (instruction.proof) {
  const { driveProof } = await import('./proof-agent.ts')
  await driveProof({ instruction, prompt, directory })
  process.exit(0)
}
if (instruction.wait) await new Promise(() => setInterval(() => {}, 1000))
if (instruction.fixed !== undefined)
  await writeFile('behaviour.txt', instruction.fixed ? 'fixed' : 'broken')
if (instruction.commit) {
  await writeFile(`change-${count}.txt`, `implemented change ${count}\n`)
  execFileSync('git', ['add', '.'])
  execFileSync('git', [
    '-c',
    'user.name=Fake Builder',
    '-c',
    'user.email=fake@example.test',
    'commit',
    '-m',
    `Build ${count}`,
  ])
}
if (role === 'builder')
  await writeFile(
    join(directory, 'verification.md'),
    `Verification build ${count + 1}: checks passed.`,
  )
if (!instruction.missing)
  await writeFile(
    join(directory, 'result.json'),
    instruction.invalid
      ? '{invalid'
      : JSON.stringify({
          outcome:
            instruction.outcome ?? (role === 'reviewer' ? 'passed' : 'done'),
          summary: `fake ${role} completed ${count + 1}`,
          artifacts:
            role === 'planner'
              ? [
                  {
                    kind: 'plan',
                    title: 'Approved plan',
                    content: `Acceptance plan ${count + 1}: POST /checkout with an empty JSON body returns HTTP 200 and Order placed.`,
                  },
                ]
              : role === 'writer'
                ? [
                    {
                      kind: 'note',
                      title: 'PR description',
                      content: `This change implements the requested behavior.\n\nEvidence on ticket #${/Ticket number: (\d+)/.exec(prompt)?.[1]} in the factory. Independent proof: ${/Workflow has tester: true/.test(prompt) ? 'tester scenario evidence' : 'untested workflow'}. ${(JSON.parse(/Independent proof scenarios: (.+)/.exec(prompt)?.[1] ?? '[]') as { scenario: string; result: string }[]).map((s) => `${s.scenario}: ${s.result}`).join('; ')} Repository checks: CI pending at publication.\n\nVerified at ${/Head commit: ([a-f0-9]+)/.exec(prompt)?.[1]}\n\nMerge danger: two-way door; revert the commit. Blast radius: this repository.`,
                    },
                  ]
                : role === 'builder'
                  ? [
                      {
                        kind: 'evidence',
                        title: 'Verification',
                        path: join(directory, 'verification.md'),
                      },
                    ]
                  : instruction.outcome === 'changes-needed'
                    ? [
                        {
                          kind: 'finding',
                          title: 'Serious correction',
                          content: 'Add a second change file.',
                        },
                      ]
                    : [],
        }),
  )
