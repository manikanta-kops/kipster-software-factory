import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseStepResult } from '../src/domain/lifecycle.ts'
import { parseUpload } from '../src/library/library.ts'
import { createTicket, resolveAsk } from '../src/store/tickets.ts'
import {
  build,
  deferred,
  leadFixture,
  leadState,
  result,
  until,
} from './helpers/lead.ts'

const decision = {
  kind: 'decision',
  title: 'Storage choice',
  chose: 'PostgreSQL',
  alternative: 'A file',
  reason: 'Keep writes transactional',
}

test('decision artifacts require three typed nonempty fields; other artifact kinds still work', () => {
  const parse = (artifact: unknown) =>
    parseStepResult({ outcome: 'done', summary: 'Done', artifacts: [artifact] })
  assert.deepEqual(parse(decision).artifacts[0], decision)
  for (const field of ['chose', 'alternative', 'reason']) {
    assert.throws(
      () => parse({ ...decision, [field]: '' }),
      /Invalid step result/,
    )
    const missing = { ...decision } as Record<string, unknown>
    delete missing[field]
    assert.throws(() => parse(missing), /Invalid step result/)
  }
  assert.throws(
    () => parse({ ...decision, content: 'Untyped' }),
    /Invalid step result/,
  )
  assert.throws(
    () =>
      parse({ kind: 'note', title: 'Note', content: 'Okay', chose: 'Extra' }),
    /Invalid step result/,
  )
  for (const kind of [
    'plan',
    'comment',
    'finding',
    'evidence',
    'log',
    'note',
  ]) {
    assert.equal(
      parse({ kind, title: kind, content: 'Still accepted' }).artifacts[0]!
        .kind,
      kind,
    )
  }
})

for (const lightsOut of [true, false])
  test(`lead plan-ready auto-approval with lights-out ${lightsOut}`, async (t) => {
    const f = await leadFixture()
    t.after(() => f.close())
    const entry = parseUpload(
      f.library
        .get('lead')!
        .source.replace(
          '      delegate: run',
          '      plan-ready: approve-plan\n      delegate: run',
        )
        .replace(
          '  - id: run',
          '  - id: approve-plan\n    kind: human\n    routes:\n      approved: lead\n      changes-needed: lead\n  - id: run',
        ),
    )
    assert.ok(entry.ok)
    const hold = deferred()
    f.setBehaviour(async (role, invocation) => {
      if (role === 'lead') {
        if (!invocation.prompt.includes('"planApproved": true'))
          return result(invocation.directory, {
            outcome: 'plan-ready',
            summary: 'Plan ready',
            artifacts: [
              {
                kind: 'plan',
                title: 'Approved plan',
                content: 'Build one file.',
              },
              decision,
            ],
          })
        assert.match(invocation.prompt, /Approved plan/)
        assert.match(invocation.prompt, /PostgreSQL/)
        return result(invocation.directory, {
          outcome: 'delegate',
          summary: 'Run it',
          artifacts: [],
          tasks: [{ key: 'one', title: 'One', instructions: 'Write one file' }],
        })
      }
      await hold.wait(invocation.signal)
    })
    const lead = await createTicket(f.database, {
      repository: f.repository.slug,
      workflow: entry.entry,
      title: 'Plan lead',
      lightsOut,
    })
    await f.start()
    const detail = await until(
      () => f.detail(lead.number),
      (d) =>
        lightsOut
          ? d.ticket.waiting?.for === 'tasks' && !!d.tasks[0]?.child
          : d.ticket.waiting?.for === 'human',
    )
    assert.equal(
      detail.artifacts.find((a) => a.kind === 'decision')?.decision?.chose,
      'PostgreSQL',
    )
    assert.equal(
      detail.artifacts.find((a) => a.kind === 'decision')?.mediaType,
      'text/markdown',
    )
    if (lightsOut) {
      const approval = detail.attempts.find((a) => a.stepId === 'approve-plan')!
      assert.equal(approval.status, 'finished')
      assert.equal(approval.executor, 'system')
      assert.equal(approval.outcome, 'approved')
      assert.match(approval.summary!, /auto-approved under lights-out/)
      assert.ok(
        detail.events.some(
          (e) => e.kind === 'decision.made' && e.data.autoApproved === true,
        ),
      )
      assert.equal(
        (await f.detail(detail.tasks[0]!.child!.number)).ticket.lightsOut,
        true,
      )
    } else {
      assert.equal(f.invocations.filter((i) => i.role === 'lead').length, 1)
      assert.ok(!detail.events.some((e) => e.data.autoApproved))
    }
    assert.deepEqual(f.errors, [])
  })

test('a parked child reports to the lead, frees a slot, and siblings finish; owner retry resumes only that child', async (t) => {
  const f = await leadFixture()
  t.after(() => f.close())
  let answered = false
  const sibling = deferred()
  f.setBehaviour(async (role, invocation, title) => {
    if (role === 'lead') {
      const { tasks } = leadState(invocation.prompt)
      return result(invocation.directory, {
        outcome:
          tasks.length && tasks.every((task) => task.status === 'merged')
            ? 'done'
            : 'delegate',
        summary: 'Keep working',
        artifacts: [],
        ...(tasks.length
          ? {}
          : {
              tasks: ['Question', 'Sibling', 'Queued'].map((name) => ({
                key: name.toLowerCase(),
                title: name,
                instructions: `Build ${name}`,
              })),
            }),
      })
    }
    if (role === 'builder') {
      if (title === 'Question' && !answered)
        return result(invocation.directory, {
          outcome: 'needs-decision',
          summary: 'Delete existing customer data?',
          artifacts: [],
        })
      if (title === 'Sibling') await sibling.wait(invocation.signal)
      return build(invocation, `${title.toLowerCase()}.txt`, title)
    }
    return result(invocation.directory, {
      outcome: 'passed',
      summary: 'Reviewed',
      artifacts: [],
    })
  })
  const lead = await f.lead('Parked child lead', true)
  await f.start()
  await until(
    () => f.detail(lead.number),
    (d) => d.tasks.find((task) => task.key === 'queued')?.status === 'merged',
  )
  const whileSiblingRuns = await f.detail(lead.number)
  assert.equal(
    whileSiblingRuns.tasks.find((task) => task.key === 'sibling')?.status,
    'running',
  )
  assert.equal(
    whileSiblingRuns.tasks.find((task) => task.key === 'question')?.status,
    'parked',
  )
  sibling.release()
  const parked = await until(
    () => f.detail(lead.number),
    (d) =>
      d.tasks.filter((task) => task.status === 'merged').length === 2 &&
      d.ticket.waiting?.for === 'tasks',
  )
  const question = parked.tasks.find((task) => task.key === 'question')!
  assert.equal(question.status, 'parked')
  assert.match(question.result!, /Delete existing customer data/)
  assert.ok(
    f.invocations
      .filter((i) => i.role === 'lead')
      .some(
        (i) =>
          leadState(i.prompt).tasks.some((task) => task.status === 'parked') &&
          i.prompt.includes('Delete existing customer data'),
      ),
  )
  const child = await f.detail(question.child!.number)
  assert.equal(child.ticket.waiting?.askReason, 'needs-decision')
  assert.equal(child.ticket.status, 'needs-you')
  assert.equal(child.ticket.lightsOut, true)
  answered = true
  await resolveAsk(f.database, {
    ticketNumber: child.ticket.number,
    attemptId: child.ticket.waiting!.attemptId,
    resolution: { action: 'retry' },
  })
  const done = await until(
    () => f.detail(lead.number),
    (d) => d.ticket.currentStep === 'confirm',
  )
  assert.ok(done.tasks.every((task) => task.status === 'merged'))
  assert.deepEqual(f.errors, [])
})
