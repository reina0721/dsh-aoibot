import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { apply } from '../src/host.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

async function boot(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-host-providers-'))
  const previous = process.env.DSH_BOT_DATA_DIR
  process.env.DSH_BOT_DATA_DIR = root
  const fake = createFakeDsh()
  const host = apply(fake.ctx, { enabled: false })
  t.after(async () => {
    host.dispose()
    await host.ready
    await host.modules.dispose()
    fake.dispose()
    if (previous === undefined) delete process.env.DSH_BOT_DATA_DIR
    else process.env.DSH_BOT_DATA_DIR = previous
    await rm(root, { recursive: true, force: true })
  })
  const coreStart = t.mock.method(host.cognition.services.reminders, 'start')
  return { host, fake, coreStart }
}

test('host default install starts core reminders exactly once after module setup', async t => {
  const { host, coreStart } = await boot(t)
  assert.equal(coreStart.mock.callCount(), 0)
  assert.deepEqual(host.providerRegistry.list(), [])
  await host.ready
  assert.equal(coreStart.mock.callCount(), 1)
  assert.equal(host.modules.list().filter(record => record.builtin).length, 3)
  host.cognition.startReminders()
  await host.ready
  await host.modules.start()
  assert.equal(coreStart.mock.callCount(), 1)
})

test('host waits for provider start before gateway readiness; provider owns reminders and stops before cognition', async t => {
  const { host, coreStart } = await boot(t)
  const order = []
  let release, started
  const starting = new Promise(resolve => { started = resolve })
  const gate = new Promise(resolve => { release = resolve })
  host.providerRegistry.register('reminders', {
    async start() {
      assert.ok(host.modules.list().every(record => ['loaded', 'disabled'].includes(record.status)))
      order.push('provider start'); started(); await gate
    },
    stop() { order.push('provider stop'); assert.equal(host.cognition.state.ready, true) },
  }, { moduleId: 'builtin-test' })
  t.mock.method(host.gateway, 'stop', () => { order.push('gateway stop') })
  await starting
  assert.deepEqual(order, ['provider start'])
  assert.equal(coreStart.mock.callCount(), 0)
  release()
  await host.ready
  await host.ready
  assert.deepEqual(order, ['provider start', 'gateway stop'])
  assert.equal(coreStart.mock.callCount(), 0)
  assert.equal(host.dispose(), undefined)
  assert.equal(host.cognition.state.ready, false)
  host.dispose()
  assert.equal(order.filter(item => item === 'provider stop').length, 1)
})

test('host cleans up failed provider startup then falls back to core once with safe logs', async t => {
  for (const asyncFailure of [false, true]) {
    await t.test(asyncFailure ? 'rejection' : 'throw', async t => {
      const { host, fake, coreStart } = await boot(t)
      let starts = 0, stops = 0
      host.providerRegistry.register('reminders', {
        start() {
          starts++
          if (asyncFailure) return Promise.reject(new Error('secret-start-marker'))
          throw new Error('secret-start-marker')
        },
        async stop() { stops++; assert.equal(coreStart.mock.callCount(), 0) },
      }, { moduleId: 'builtin-test' })
      await host.ready
      await host.ready
      assert.equal(starts, 1)
      assert.equal(stops, 1)
      assert.equal(coreStart.mock.callCount(), 1)
      assert.ok(fake.logs.some(entry => /回退核心提醒/.test(entry.message)))
      assert.ok(fake.logs.every(entry => !entry.message.includes('secret-start-marker')))
      host.dispose()
      assert.equal(stops, 1)
    })
  }
})

test('host provider stop failures are contained without changing synchronous disposal or fallback', async t => {
  for (const startFails of [false, true]) {
    await t.test(startFails ? 'fallback' : 'dispose', async t => {
      const { host, coreStart } = await boot(t)
      host.providerRegistry.register('reminders', {
        start() { if (startFails) throw new Error('start failed') },
        stop() { return Promise.reject(new Error('secret-stop-marker')) },
      }, { moduleId: 'builtin-test' })
      await host.ready
      assert.equal(coreStart.mock.callCount(), startFails ? 1 : 0)
      assert.equal(host.dispose(), undefined)
      await new Promise(setImmediate)
      assert.equal(host.cognition.state.ready, false)
    })
  }
})

test('host disposal before modules settle prevents all reminder and gateway startup', async t => {
  const { host, coreStart } = await boot(t)
  const start = t.mock.fn()
  host.providerRegistry.register('reminders', { start, stop() {} }, { moduleId: 'builtin-test' })
  host.dispose()
  await host.ready
  assert.equal(start.mock.callCount(), 0)
  assert.equal(coreStart.mock.callCount(), 0)
})

test('host disposal during asynchronous provider start stops late startup without core fallback', async t => {
  const { host, coreStart } = await boot(t)
  let release, started, stops = 0
  const starting = new Promise(resolve => { started = resolve })
  const gate = new Promise(resolve => { release = resolve })
  host.providerRegistry.register('reminders', {
    async start() { started(); await gate },
    stop() { stops++ },
  }, { moduleId: 'builtin-test' })
  await starting
  host.dispose()
  assert.equal(stops, 1)
  release()
  await host.ready
  assert.equal(stops, 2) // cleanup again after the in-flight start settles
  assert.equal(coreStart.mock.callCount(), 0)
})
