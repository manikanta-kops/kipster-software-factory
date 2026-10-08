import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import {
  DECISION_MODEL,
  askTypeSafe,
  typeSafeError,
} from '../src/decider/typesafe.ts'
import { facts } from './helpers/decisions.ts'
import { controlledTimer } from './helpers/timing.ts'

const sentinel = 'test-only-key-not-a-real-credential'
const options = {
  proceed: 'Small change with proof.',
  review: 'Further owner review needed.',
}

for (const [scenario, attempts, message] of [
  [401, 1, 'TypeSafe HTTP 401: invalid key'],
  [422, 1, 'TypeSafe HTTP 422: invalid request'],
  [429, 3, 'TypeSafe HTTP 429: rate limit after retries'],
  [529, 3, 'TypeSafe HTTP 529: overloaded after retries'],
  ['timeout', 3, 'TypeSafe timeout after retries'],
  [
    'invalid',
    1,
    'TypeSafe returned an invalid response or could not complete the request',
  ],
] as const) {
  test(`TypeSafe ${scenario} makes ${attempts} request(s) and reports only a safe error`, async (t) => {
    const deadline =
      scenario === 'timeout' ? controlledTimer(t, 60_123) : undefined
    const received: {
      url: string | undefined
      method: string | undefined
      authorization: string | undefined
      body: { model: string; state: object }
    }[] = []
    const server = createServer(async (req, res) => {
      let text = ''
      for await (const chunk of req) text += chunk
      received.push({
        url: req.url,
        method: req.method,
        authorization: req.headers.authorization,
        body: JSON.parse(text),
      })
      if (deadline) {
        deadline.expire()
        return
      }
      res.setHeader('content-type', 'application/json')
      if (typeof scenario === 'number') {
        res.writeHead(scenario)
        res.end(JSON.stringify({ error: `secret echo ${sentinel}` }))
        return
      }
      res.end(
        JSON.stringify({
          model: DECISION_MODEL,
          answers: {
            decision: {
              type: 'choice',
              choice: 'unknown',
              probabilities: { proceed: 0.9, review: 0.1 },
              confidence: 0.8,
            },
          },
          usage: { input_tokens: 120, output_tokens: 10 },
        }),
      )
    })
    t.after(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    let requests = 0
    const error = await askTypeSafe(
      sentinel,
      facts,
      'Does this change need further owner review?',
      options,
      AbortSignal.timeout(30_000),
      {
        baseURL: `http://127.0.0.1:${address.port}`,
        timeout: scenario === 'timeout' ? 60_123 : 10_000,
        retry: { backoffInitialMs: 1, backoffMaxMs: 2 },
        fetch: (input, init) => {
          requests++
          return fetch(input, init)
        },
      },
    ).then(
      () => assert.fail('TypeSafe must reject'),
      (rejection: unknown) => rejection,
    )
    assert.equal(requests, attempts)
    if (scenario === 'invalid')
      assert.match(String(error), /Invalid TypeSafe choice response/)
    const reason = typeSafeError(error)
    assert.equal(reason, message)
    assert.equal(reason.includes(sentinel), false)
    assert.equal(received.length, attempts)
    for (const request of received) {
      assert.equal(request.url, '/v1/systemone')
      assert.equal(request.method, 'POST')
      assert.equal(request.authorization, `Bearer ${sentinel}`)
      assert.equal(request.body.model, DECISION_MODEL)
      assert.deepEqual(request.body.state, facts)
    }
  })
}
