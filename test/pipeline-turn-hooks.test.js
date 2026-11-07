import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPipeline } from '../src/cognition/pipeline.js'
import { createTurnHooks } from '../src/cognition/turn-hooks.js'

const turn = { id: 'turn', chatType: 'private', chatId: '10001', senderId: '10001', text: '/status' }

function harness({ turnHooks = null, typingEnabled = true, failure = null } = {}) {
  const calls = []
  const pipeline = createPipeline({
    turnHooks,
    getConfig: () => ({ cognition: { enabled: true, typing: { enabled: typingEnabled } } }),
    clock: { now() { if (failure) { calls.push('process'); throw failure } return 42 } },
    gateway: { actions: { async setInputStatus(id, event) { await new Promise(setImmediate); calls.push([id, event]) } } },
    commands: { async handle() { if (failure) return null; calls.push('process'); return { handled: true, reply: 'ok' } } },
  })
  return { pipeline, calls }
}

test('pipeline: null turn hooks preserve awaited legacy typing', async () => {
  const { pipeline, calls } = harness()
  const result = await pipeline.handleTurn(turn)
  assert.equal(result.reply, 'ok')
  assert.deepEqual(calls, [['10001', 1], 'process', ['10001', 2]])
})

test('pipeline: present empty registry suppresses legacy typing', async () => {
  const { pipeline, calls } = harness({ turnHooks: createTurnHooks() })
  assert.equal((await pipeline.handleTurn(turn)).reply, 'ok')
  assert.deepEqual(calls, ['process'])
})

test('pipeline: hooks get narrow context and are awaited around processing without legacy typing', async () => {
  for (const typingEnabled of [true, false, 'true']) {
    const hooks = createTurnHooks(), h = harness({ turnHooks: hooks, typingEnabled })
    let context
    hooks.register({ id: 'observer', async onStart(value) {
      await new Promise(setImmediate)
      context = value
      assert.deepEqual(value, { turn, settings: { typingEnabled: typingEnabled === true } })
      h.calls.push('start')
    }, async onEnd(value) {
      await new Promise(setImmediate)
      assert.equal(value, context)
      h.calls.push('end')
    } })
    const result = await h.pipeline.handleTurn(turn)
    assert.deepEqual(result, await harness({ typingEnabled: false }).pipeline.handleTurn(turn))
    assert.deepEqual(h.calls, ['start', 'process', 'end'])
  }
})

test('pipeline: end awaited on processing failure; hook failures preserve original error', async () => {
  const failure = Error('clock service failed'), hooks = createTurnHooks()
  const h = harness({ turnHooks: hooks, failure })
  hooks.register({ id: 'failing', onStart() { h.calls.push('start'); throw Error('start failed') }, async onEnd() {
    await new Promise(setImmediate)
    h.calls.push('end')
    throw Error('end failed')
  } })
  await assert.rejects(h.pipeline.handleTurn(turn), error => error === failure)
  assert.deepEqual(h.calls, ['start', 'process', 'end'])
})
