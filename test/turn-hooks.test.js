import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTurnHooks } from '../src/cognition/turn-hooks.js'

test('turn hooks: sequential start, reverse end and same context', async () => {
  const hooks = createTurnHooks(), calls = [], context = { turn: {} }
  for (const id of ['first', 'second']) hooks.register({
    id,
    async onStart(value) { assert.equal(value, context); await new Promise(setImmediate); calls.push(`start:${id}`) },
    async onEnd(value) { assert.equal(value, context); await new Promise(setImmediate); calls.push(`end:${id}`) },
  })
  assert.deepEqual(hooks.list().map(hook => hook.id), ['first', 'second'])
  await hooks.start(context)
  assert.deepEqual(calls, ['start:first', 'start:second'])
  await hooks.end(context)
  assert.deepEqual(calls, ['start:first', 'start:second', 'end:second', 'end:first'])
})

test('turn hooks: sync/async failures isolated, logs contain no descriptor/context/error', async () => {
  const logs = [], calls = [], privateValue = 'private-chat-1000199876543'
  const hooks = createTurnHooks({ logger: { warn: (...args) => logs.push(args) } })
  hooks.register({ id: 'good', onStart() { calls.push('start') }, onEnd() { calls.push('end') } })
  hooks.register({ id: privateValue, onStart() { throw Error(privateValue) }, async onEnd() { throw Error(privateValue) } })
  await hooks.start({ turn: { chatId: privateValue } })
  await hooks.end({ turn: { chatId: privateValue } })
  assert.deepEqual(calls, ['start', 'end'])
  assert.equal(logs.length, 2)
  assert.ok(!JSON.stringify(logs).includes(privateValue))
  const brokenLogger = createTurnHooks({ logger: { warn() { throw Error('logger failed') } } })
  brokenLogger.register({ id: 'fail', onStart() { throw Error('hook failed') } })
  await brokenLogger.start({})
})

test('turn hooks: validation and idempotent disposer cannot remove a replacement', async () => {
  const hooks = createTurnHooks()
  for (const descriptor of [undefined, {}, { id: '' }, { id: ' ' }, { id: 1 }, { id: 'empty' }, { id: 'bad', onStart: true }, { id: 'bad', onEnd: null }, { id: 'bad', onStart() {}, onEnd: 1 }]) {
    assert.throws(() => hooks.register(descriptor))
  }
  const dispose = hooks.register({ id: 'one', onStart() {} })
  assert.throws(() => hooks.register({ id: 'one', onEnd() {} }), /重复/)
  dispose(); dispose()
  assert.deepEqual(hooks.list(), [])
  hooks.register({ id: 'one', onEnd() {} })
  dispose()
  assert.equal(hooks.list().length, 1)
  await hooks.start({})
  await hooks.end({})
})
