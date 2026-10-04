import { spawn, execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const [directory, scriptFile, stateRoot] = process.argv.slice(2) as [
  string,
  string,
  string,
]
const prompt = await readFile(join(directory, 'prompt.md'), 'utf8')
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
if (instruction.wait) await new Promise(() => setInterval(() => {}, 1000))
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
                    content: 'Acceptance: committed change file exists.',
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
