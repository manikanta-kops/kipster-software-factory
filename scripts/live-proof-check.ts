// Explicit opt-in: real default CLI proof sessions against a disposable HTTP fixture.
import assert from 'node:assert/strict'
import { access, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { executeAgent } from '../src/executors/cli.ts'
import { run } from '../src/executors/process.ts'
import {
  claimAttempts,
  completeAttempt,
  markRunning,
} from '../src/store/tickets.ts'
import { isLatestTesterVerdictCurrent } from '../src/store/verdicts.ts'
import { proofFixture } from '../tests/helpers/proof.ts'
import { proofContext } from '../tests/fixtures/proof-agent.ts'

const f = await proofFixture({ execute: executeAgent })
console.log(`Live proof evidence: ${f.root}`)
try {
  const reproduced = await f.next('reproduce', AbortSignal.timeout(180_000))
  assert.equal(reproduced.outcome, 'reproduced')
  assert.equal(reproduced.headCommit, f.base)
  console.log(`reproducer: ${reproduced.outcome} at ${reproduced.headCommit}`)
  // Deterministic fixture fix; the proof sessions never author it.
  const [fix] = await claimAttempts(f.store.database, 1)
  assert.equal(fix?.step.id, 'fix')
  await markRunning(f.store.database, fix.attempt.id, 'fixture')
  await writeFile(join(f.cwd, 'behaviour.txt'), 'fixed')
  const head = await f.commit(f.cwd, 'Fix fixture checkout')
  await completeAttempt(
    f.store.database,
    fix.attempt.id,
    {
      outcome: 'done',
      summary: 'Changed the fixture to return successful checkout.',
      artifacts: [],
    },
    { headCommit: head },
  )
  const tested = await f.next('test', AbortSignal.timeout(180_000))
  assert.equal(tested.outcome, 'passed')
  assert.equal(tested.headCommit, head)
  assert.equal(
    await isLatestTesterVerdictCurrent(f.store.database, f.ticket.id, head),
    true,
  )
  assert.equal(await run('git', ['status', '--porcelain'], { cwd: f.cwd }), '')
  assert.equal(await run('git', ['rev-parse', 'HEAD'], { cwd: f.cwd }), head)
  assert.ok(
    (await readdir(join(f.home, 'verification'))).every((name) =>
      name.startsWith('evidence-'),
    ),
  )
  for (const invocation of f.invocations) {
    for (const instance of proofContext(invocation.prompt).instances) {
      await assert.rejects(access(instance.checkout))
      await assert.rejects(
        fetch(`${instance.url}/health`, { signal: AbortSignal.timeout(500) }),
      )
    }
  }
  const detail = await f.detail()
  await writeFile(
    join(f.root, 'result.json'),
    JSON.stringify(
      { reproduced, tested, artifacts: detail.artifacts },
      null,
      2,
    ),
  )
  console.log(`tester: ${tested.summary}`)
  console.log(
    `PASS: reproduced on base, passed on head; instances removed; branch unchanged by proof. Evidence retained at ${f.root}`,
  )
} finally {
  await f.close(true)
}
