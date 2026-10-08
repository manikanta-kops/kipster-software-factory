import assert from 'node:assert/strict'
import { access, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { parseStepResult } from '../src/domain/lifecycle.ts'
import type { AgentExecutor } from '../src/executors/cli.ts'
import { run } from '../src/executors/process.ts'
import { reportTasks, updateTask } from '../src/store/tasks.ts'
import { proofFixture } from './helpers/proof.ts'

async function fixture(
  t: TestContext,
  input: Parameters<typeof proofFixture>[0] = {},
) {
  const f = await proofFixture(input)
  t.after(() => f.close())
  return f
}

async function result(
  invocation: Parameters<AgentExecutor>[0],
  value: unknown,
) {
  await writeFile(
    join(invocation.directory, 'result.json'),
    JSON.stringify(value),
  )
}

for (const role of ['builder', 'reviewer', 'tester'] as const) {
  test(`${role} crash without a result records the process error and bounded output tail`, async (t) => {
    const f = await fixture(t, {
      workflow: role === 'reviewer' ? 'planned-change' : 'task',
    })
    if (role === 'reviewer') {
      await f.next('plan')
      await f.approve()
    }
    if (role !== 'builder') await f.next('build')
    const runs: Parameters<AgentExecutor>[0][] = []
    f.options.execute = async (invocation) => {
      runs.push(invocation)
      await run(
        process.execPath,
        [
          '-e',
          `console.log('EARLY OUTPUT MUST BE OMITTED');
           for (let n = 0; n < 80; n++) console.log('line ' + n + ' ' + 'x'.repeat(100));
           console.error('REAL AGENT CRASH: cannot load runtime');
           process.exitCode = 23;`,
        ],
        { cwd: invocation.cwd, log: invocation.log, signal: invocation.signal },
      )
    }
    const step =
      role === 'builder' ? 'build' : role === 'tester' ? 'test' : 'review'
    await assert.rejects(f.next(step), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, new RegExp(`^Error: .* exited 23:`))
      assert.match(error.message, /Agent output \(last lines\):/)
      assert.match(error.message, /REAL AGENT CRASH: cannot load runtime/)
      assert.match(error.message, /after two runs:[\s\S]*ENOENT/)
      assert.doesNotMatch(error.message, /EARLY OUTPUT MUST BE OMITTED/)
      const tail = error.message
        .split('Agent output (last lines):\n')[1]!
        .split('\n\n')[0]!
      assert.ok(Buffer.byteLength(tail) <= 4096)
      assert.ok(tail.split('\n').length <= 40)
      return true
    })
    assert.equal(runs.length, 2)
    const failed = (await f.detail()).attempts.find((a) => a.stepId === step)!
    assert.equal(failed.status, 'failed')
    assert.match(
      failed.error!,
      /exited 23:[\s\S]*REAL AGENT CRASH[\s\S]*ENOENT/,
    )
    assert.match(runs[1]!.prompt, /exited 23/)
    assert.match(
      await readFile(join(runs[0]!.directory, 'result-error.txt'), 'utf8'),
      /exited 23/,
    )
    if (role === 'tester') {
      assert.notEqual(runs[0]!.cwd, runs[1]!.cwd)
      await assert.rejects(access(runs[0]!.cwd))
      await assert.rejects(access(runs[1]!.cwd))
      assert.deepEqual(await readdir(join(f.home, 'verification')), [])
    }
  })
}

for (const mode of ['signal', 'spawn'] as const) {
  test(`agent ${mode} failure without a result preserves process diagnostics`, async (t) => {
    const f = await fixture(t, {
      workflow: 'task',
      execute: async (invocation) => {
        await run(
          mode === 'spawn'
            ? join(invocation.directory, 'missing-agent')
            : process.execPath,
          mode === 'spawn'
            ? []
            : [
                '-e',
                "console.error('SIGNAL CRASH OUTPUT'); process.kill(process.pid, 'SIGTERM')",
              ],
          {
            cwd: invocation.cwd,
            log: invocation.log,
            signal: invocation.signal,
          },
        )
      },
    })
    await assert.rejects(f.next('build'), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /^Error: .* exited [1-9]\d*:/)
      assert.match(
        error.message,
        mode === 'spawn' ? /spawn .* ENOENT/ : /SIGNAL CRASH OUTPUT/,
      )
      assert.match(error.message, /result.json after two runs/)
      return true
    })
    assert.equal(f.invocations.length, 2)
  })
}

test('missing artifacts defaults to an empty list on the first agent run', async (t) => {
  const f = await fixture(t, {
    workflow: 'task',
    execute: (invocation) =>
      result(invocation, {
        outcome: 'done',
        summary: 'Finished without artifacts',
      }),
  })
  const built = await f.next('build')
  assert.equal(built.outcome, 'done')
  assert.equal(f.invocations.length, 1)
  await assert.rejects(
    access(join(f.invocations[0]!.directory, 'result-error.txt')),
  )
  assert.deepEqual(
    parseStepResult({ outcome: 'done', summary: 'Finished' }).artifacts,
    [],
  )
})

test('NUL bytes in summaries and nested artifacts are stripped before PostgreSQL storage', async (t) => {
  const f = await fixture(t, {
    workflow: 'task',
    execute: async (invocation) => {
      const path = join(invocation.directory, 'evidence.txt')
      await writeFile(path, 'File evidence')
      await result(invocation, {
        outcome: 'do\u0000ne',
        summary: 'Built\u0000 and verified',
        artifacts: [
          {
            kind: 'evidence',
            title: 'Check\u0000 output',
            content: 'All\u0000 passed',
            scenario: 'NU\u0000L',
            scenarioResult: 'pas\u0000sed',
            file: 'app\u0000.ts',
          },
          {
            kind: 'decision',
            title: 'De\u0000cision',
            chose: 'Ch\u0000osen',
            alternative: 'Ot\u0000her',
            reason: 'Rea\u0000son',
          },
          { kind: 'evidence', title: 'File', path: path + '\u0000' },
        ],
      })
    },
  })
  const built = await f.next('build')
  assert.equal(built.summary, 'Built and verified')
  assert.equal(f.invocations.length, 1)
  const artifacts = (await f.detail()).artifacts
  const evidence = artifacts.find((a) => a.title === 'Check output')!
  assert.equal(evidence.content, 'All passed')
  assert.equal(evidence.scenario, 'NUL')
  assert.equal(evidence.scenarioResult, 'passed')
  assert.equal(evidence.file, 'app.ts')
  assert.deepEqual(artifacts.find((a) => a.title === 'Decision')!.decision, {
    chose: 'Chosen',
    alternative: 'Other',
    reason: 'Reason',
  })
  assert.equal(
    await readFile(artifacts.find((a) => a.title === 'File')!.path!, 'utf8'),
    'File evidence',
  )
})

test('NUL stripping covers owner review, repository requests, tasks and pull request decisions without mutating input', () => {
  const values = [
    {
      outcome: 'passed',
      summary: 'Passed',
      ownerReview: { reason: 'Ow\u0000ner' },
    },
    {
      outcome: 'needs-other-repo',
      summary: 'Linked',
      otherRepository: {
        repository: 'own\u0000er/repo',
        title: 'Ti\u0000tle',
        body: 'Bo\u0000dy',
        workflow: 'le\u0000ad',
      },
    },
    {
      outcome: 'delegate',
      summary: 'Delegate',
      tasks: [
        {
          key: 'ta\u0000sk',
          title: 'Ti\u0000tle',
          instructions: 'Wo\u0000rk',
          land: 'br\u0000anch',
          workflow: 'ta\u0000sk',
          agent: {
            cli: 'co\u0000dex',
            model: 'mo\u0000del',
            effort: 'hi\u0000gh',
          },
        },
      ],
      pullRequests: [{ task: 'rea\u0000dy', decision: 'mer\u0000ge' }],
    },
  ]
  for (const value of values) {
    const original = JSON.stringify(value)
    assert.deepEqual(parseStepResult(value), {
      ...JSON.parse(original.replaceAll('\\u0000', '')),
      artifacts: [],
    })
    assert.equal(JSON.stringify(value), original)
  }
  assert.throws(
    () => parseStepResult({ outcome: 'done', summary: '\u0000' }),
    /summary/,
  )
  assert.throws(
    () => parseStepResult({ outcome: 'done', summary: 'Done', unknown: true }),
    /Unrecognized key/,
  )
})

test('builder gets exactly one retry naming uncommitted files and succeeds after committing them', async (t) => {
  let runs = 0
  const f = await fixture(t, {
    workflow: 'task',
    execute: async (invocation) => {
      runs++
      if (runs === 1) {
        await writeFile(
          join(invocation.cwd, 'unfinished.txt'),
          'Finished product work',
        )
      } else {
        assert.match(invocation.prompt, /\?\? unfinished\.txt/)
        assert.match(invocation.prompt, /Commit these files or remove them/)
        await run('git', ['add', 'unfinished.txt'], { cwd: invocation.cwd })
        await run(
          'git',
          [
            '-c',
            'user.name=Fixture',
            '-c',
            'user.email=fixture@example.test',
            'commit',
            '-m',
            'Keep finished work',
          ],
          { cwd: invocation.cwd },
        )
      }
      await result(invocation, {
        outcome: 'done',
        summary: 'Finished work',
        artifacts: [],
      })
    },
  })
  const built = await f.next('build')
  assert.equal(built.outcome, 'done')
  assert.equal(runs, 2)
  assert.match(
    await readFile(
      join(f.invocations[0]!.directory, 'result-error.txt'),
      'utf8',
    ),
    /unfinished\.txt/,
  )
  assert.equal(await run('git', ['status', '--porcelain'], { cwd: f.cwd }), '')
  assert.equal(
    await run('git', ['show', 'HEAD:unfinished.txt'], { cwd: f.cwd }),
    'Finished product work',
  )
})

test('builder that remains dirty after the retry fails naming the files and preserves them', async (t) => {
  const f = await fixture(t, {
    workflow: 'task',
    execute: async (invocation) => {
      await writeFile(
        join(invocation.cwd, 'unfinished.txt'),
        'Keep for inspection',
      )
      await result(invocation, { outcome: 'done', summary: 'Done' })
    },
  })
  await assert.rejects(
    f.next('build'),
    /after two runs:[\s\S]*Builder left uncommitted changes:[\s\S]*unfinished\.txt/,
  )
  assert.equal(f.invocations.length, 2)
  assert.equal(
    await readFile(join(f.cwd, 'unfinished.txt'), 'utf8'),
    'Keep for inspection',
  )
})

test('lead retry refreshes task context after a stale pull request decision', async (t) => {
  let runs = 0
  const f = await fixture(t, {
    workflow: 'lead',
    execute: async (invocation) => {
      runs++
      assert.equal(runs, 1)
      await result(invocation, {
        outcome: 'delegate',
        summary: 'Delegate PR work',
        tasks: [
          { key: 'api', title: 'API', instructions: 'Build API', land: 'pr' },
        ],
      })
    },
  })
  await f.next('lead')
  const parked = await f.next('run-tasks')
  const task = (await f.detail()).tasks[0]!
  await updateTask(f.store.database, task.id, 'pr-ready', 'PR ready')
  assert.equal(await reportTasks(f.store.database, parked.id), true)
  const prompts: string[] = []
  f.options.execute = async (invocation) => {
    prompts.push(invocation.prompt)
    const packet = JSON.parse(
      invocation.prompt
        .split(
          'Your tasks and choices (factory state, current as of this session):\n',
        )[1]!
        .split('\n\n')[0]!,
    )
    if (prompts.length === 1) {
      assert.equal(packet.tasks[0].status, 'pr-ready')
      await updateTask(
        f.store.database,
        task.id,
        'merged',
        'Concurrent task merge completed',
      )
      await result(invocation, {
        outcome: 'delegate',
        summary: 'Stale merge decision',
        pullRequests: [{ task: 'api', decision: 'merge' }],
      })
    } else {
      assert.equal(packet.tasks[0].status, 'merged')
      assert.equal(packet.tasks[0].result, 'Concurrent task merge completed')
      await result(invocation, { outcome: 'done', summary: 'All work merged' })
    }
  }
  const finished = await f.next('lead')
  assert.equal(finished.outcome, 'done')
  assert.equal(prompts.length, 2)
  assert.match(prompts[1]!, /Previous result validation failed/)
})
