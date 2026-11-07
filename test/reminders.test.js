import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createReminderService, REMINDER_DEFAULTS } from '../src/cognition/reminders.js'
import { createStore } from '../src/cognition/store.js'
import { createPersonaScopedStore, personaDataCounts, copyPersonaData, dropPersonaData } from '../src/cognition/persona-scope.js'
import { createFakeScheduler } from '../src/cognition/util.js'
import { normalizeConfig, CONFIG_GROUPS } from '../src/core/config.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCognition } from '../src/cognition/index.js'
import { createCommandService } from '../src/cognition/commands.js'
import { createOutbound } from '../src/cognition/outbound.js'

const NOW = Date.parse('2026-11-06T12:00:00Z')
function harness(t, options = {}) {
  const scheduler = createFakeScheduler(NOW)
  const clock = { now: scheduler.now }
  const base = createStore({ clock })
  let persona = 'self'
  const store = createPersonaScopedStore({ base, getPersonaId: () => persona })
  const config = { access: { ownerQQ: '10001' }, cognition: { reminders: { enabled: true, ...options.config } } }
  const sent = []
  const outbound = options.outbound || { async deliver(input) { sent.push(input); return { ok: true } } }
  const service = createReminderService({ store, getConfig: () => config, clock, scheduler, outbound })
  t.after(() => { service.dispose(); base.close() })
  const add = (extra = {}) => service.add({ chatType: 'private', chatId: '10001', text: '喝水 💧', everySeconds: 60, createdBy: '10001', ...extra })
  return { service, store, base, scheduler, config, sent, add, switchPersona: (id) => { persona = id } }
}
const target = { chatType: 'private', chatId: '10001' }

test('reminders default disabled, normalized limits and configuration fields', async (t) => {
  assert.deepEqual(normalizeConfig({}).config.cognition.reminders, REMINDER_DEFAULTS)
  assert.equal(CONFIG_GROUPS.find((g) => g.id === 'cog-reminders').fields.length, 5)
  assert.deepEqual(normalizeConfig({ cognition: { reminders: { maxActive: 0, minIntervalSeconds: 100, maxIntervalSeconds: 60, tickMs: -1 } } }).config.cognition.reminders,
    { enabled: false, maxActive: 1, minIntervalSeconds: 100, maxIntervalSeconds: 100, tickMs: 1000 })
  const h = harness(t, { config: { enabled: false } })
  assert.throws(() => h.add(), /REMINDERS_DISABLED/)
  h.store.list = () => { throw new Error('disabled tick must not read store') }
  h.service.start()
  h.scheduler.advance(30000)
  await h.service.tick()
  assert.equal(h.sent.length, 0)
})

test('reminders require owner, numeric chat scope, Unicode text and exactly one schedule', (t) => {
  const h = harness(t)
  for (const createdBy of ['', '20002', undefined]) assert.throws(() => h.add({ createdBy }), /OWNER_ONLY/)
  for (const chatId of ['', 'x', '-1', 0, '9007199254740992']) assert.throws(() => h.add({ chatId }), /INVALID_TARGET/)
  assert.throws(() => h.add({ chatType: 'global' }), /INVALID_TARGET/)
  for (const text of ['', ' ', '💧'.repeat(501), 123]) assert.throws(() => h.add({ text }), /INVALID_TEXT/)
  assert.throws(() => h.add({ at: NOW + 1000 }), /INVALID_SCHEDULE/)
  assert.throws(() => h.add({ everySeconds: undefined }), /INVALID_SCHEDULE/)
  assert.equal(h.add({ text: '💧'.repeat(500), chatType: 'group', chatId: 20001 }).scopeType, 'group')
})

test('add one-time/recurring public records; future, interval and active bounds', (t) => {
  const h = harness(t, { config: { maxActive: 2, minIntervalSeconds: 90, maxIntervalSeconds: 120 } })
  for (const at of [NOW, NOW - 1, Infinity, 'no', '123', true]) assert.throws(() => h.add({ everySeconds: undefined, at }), /INVALID_AT/)
  for (const everySeconds of [59, 60, 121, 2592001, '90', 90.5]) assert.throws(() => h.add({ everySeconds }), /INVALID_INTERVAL/)
  const one = h.add({ everySeconds: undefined, at: new Date(NOW + 1000).toISOString() })
  assert.match(one.id, /^rem_[a-f0-9]+$/)
  assert.equal(one.at, NOW + 1000)
  assert.equal(one.nextAt, one.at)
  assert.equal(one.status, 'active')
  assert.equal(one.createdAt, NOW)
  assert.equal(one.createdBy, '10001')
  assert.equal(one.sentCount, 0)
  assert.equal(one.lastError, '')
  assert.equal(one.kind, undefined)
  const recurring = h.add({ everySeconds: 90 })
  assert.equal(recurring.nextAt, NOW + 90000)
  assert.equal(recurring.at, null)
  assert.throws(() => h.add({ text: 'third', everySeconds: 120 }), /MAX_ACTIVE/)
})

test('duplicates use same scope/text/normalized time; list and cancellation stay scoped', (t) => {
  const h = harness(t)
  const row = h.add()
  assert.throws(() => h.add(), /REMINDER_DUPLICATE/)
  h.add({ chatType: 'group' })
  const once = h.add({ everySeconds: undefined, at: NOW + 1000 })
  assert.throws(() => h.add({ everySeconds: undefined, at: new Date(NOW + 1000).toISOString() }), /REMINDER_DUPLICATE/)
  assert.equal(h.service.list({ ...target, limit: 1 }).length, 1)
  assert.equal(h.service.list(target).length, 2)
  assert.throws(() => h.service.cancel(row.id, { ...target, operatorId: '2' }), /OWNER_ONLY/)
  assert.throws(() => h.service.cancel(row.id, { ...target, chatType: 'group', operatorId: '10001' }), /REMINDER_NOT_FOUND/)
  assert.equal(h.service.cancel(row.id, { ...target, operatorId: '10001' }).status, 'cancelled')
  assert.throws(() => h.service.cancel(row.id, { ...target, operatorId: '10001' }), /REMINDER_NOT_FOUND/)
  assert.deepEqual(h.service.list(target).map((r) => r.id), [once.id])
  assert.equal(h.service.list({ ...target, status: 'cancelled' }).length, 1)
  h.config.cognition.reminders.enabled = false
  h.service.cancel(once.id, { ...target, operatorId: '10001' })
})

test('tick sends once and skips missed repeats using now plus interval and source reminder', async (t) => {
  const h = harness(t)
  const once = h.add({ everySeconds: undefined, at: NOW + 1000 })
  const recurring = h.add()
  await h.service.tick()
  assert.equal(h.sent.length, 0)
  h.scheduler.advance(180000)
  await h.service.tick()
  assert.equal(h.sent.length, 2)
  assert.deepEqual(h.sent[0], { ...target, segments: [{ type: 'text', data: { text: once.text } }], source: 'reminder' })
  assert.equal(h.store.get('reminder', once.id).status, 'sent')
  assert.equal(h.store.get('reminder', once.id).sentCount, 1)
  assert.equal(h.store.get('reminder', recurring.id).nextAt, NOW + 240000)
  await h.service.tick()
  assert.equal(h.sent.length, 2)
  h.scheduler.advance(60000)
  await h.service.tick()
  assert.equal(h.store.get('reminder', recurring.id).sentCount, 2)
  h.config.cognition.reminders.enabled = false
  h.scheduler.advance(60000)
  await h.service.tick()
  assert.equal(h.sent.length, 3)
})

test('failure uses safe errors and delayed retry without tight loop; success clears error', async (t) => {
  let calls = 0
  const h = harness(t, { config: { minIntervalSeconds: 90 }, outbound: { async deliver() {
    calls++
    if (calls === 1) throw new Error('Bearer private-secret')
    return calls === 2 ? { ok: false, error: 'api_key=private-secret' } : { ok: true }
  } } })
  const row = h.add({ everySeconds: undefined, at: NOW + 1 })
  h.scheduler.advance(1)
  await h.service.tick()
  assert.equal(h.store.get('reminder', row.id).nextAt, NOW + 90001)
  assert.equal(h.store.get('reminder', row.id).lastError, 'SEND_FAILED')
  assert.equal(h.store.get('reminder', row.id).status, 'active')
  await h.service.tick()
  assert.equal(calls, 1)
  h.scheduler.advance(90000)
  await h.service.tick()
  assert.equal(h.store.get('reminder', row.id).lastError, 'SEND_FAILED')
  h.scheduler.advance(90000)
  await h.service.tick()
  assert.equal(h.store.get('reminder', row.id).lastError, '')
  assert.equal(h.store.get('reminder', row.id).sentCount, 1)
})

test('ticks handle at most 20 due items and never overlap; cancellation during send survives', async (t) => {
  let release
  let calls = 0
  const h = harness(t, { outbound: { async deliver() { calls++; await new Promise((r) => { release = r }); return { ok: true } } } })
  const row = h.add({ everySeconds: undefined, at: NOW + 1 })
  h.scheduler.advance(1)
  const pending = h.service.tick()
  await h.service.tick()
  assert.equal(calls, 1)
  h.service.cancel(row.id, { ...target, operatorId: '10001' })
  release()
  await pending
  assert.equal(h.store.get('reminder', row.id).status, 'cancelled')
  const limited = harness(t)
  for (let i = 0; i < 25; i++) limited.add({ text: `reminder ${i}`, everySeconds: undefined, at: NOW + 1 })
  limited.scheduler.advance(1)
  await limited.service.tick()
  assert.equal(limited.sent.length, 20)
  await limited.service.tick()
  assert.equal(limited.sent.length, 25)
})

test('self scheduling is idempotent, supports enabling and stops on dispose even in flight', async (t) => {
  const h = harness(t, { config: { enabled: false } })
  h.service.start(); h.service.start()
  h.config.cognition.reminders.enabled = true
  h.add({ everySeconds: undefined, at: NOW + 1 })
  h.scheduler.advance(30000)
  await new Promise(setImmediate)
  assert.equal(h.sent.length, 1)
  h.add({ text: 'second', everySeconds: undefined, at: NOW + 30001 })
  h.service.dispose()
  h.scheduler.advance(60000)
  await h.service.tick()
  assert.equal(h.sent.length, 1)
  let release
  const pending = harness(t, { outbound: { deliver: () => new Promise((r) => { release = r }) } })
  const row = pending.add({ everySeconds: undefined, at: NOW + 1 })
  pending.scheduler.advance(1)
  const work = pending.service.tick()
  pending.service.dispose()
  pending.base.close()
  release({ ok: true })
  await work // no access to a closed store after dispose
  assert.ok(row)
})

test('persona data groups count/copy/delete reminders; pending writes stay with source persona', async (t) => {
  let release
  const h = harness(t, { outbound: { deliver: () => new Promise((r) => { release = r }) } })
  h.base.put('persona', 'self', {})
  h.base.put('persona', 'other', {})
  const row = h.add({ everySeconds: undefined, at: NOW + 1 })
  h.scheduler.advance(1)
  const work = h.service.tick()
  h.switchPersona('other')
  assert.equal(h.service.list(target).length, 0)
  release({ ok: true })
  await work
  assert.equal(h.base.get('persona_self:reminder', row.id).status, 'sent')
  assert.equal(h.base.count('persona_other:reminder'), 0)
  assert.equal(personaDataCounts({ base: h.base, personaId: 'self' }).groups.find((g) => g.id === 'reminders').count, 1)
  assert.equal(copyPersonaData({ base: h.base, from: 'self', to: 'other', groups: ['reminders'] }).copied.reminders, 1)
  dropPersonaData({ base: h.base, personaId: 'other' })
  assert.equal(h.base.count('persona_other:reminder'), 0)
})

test('real outbound gates reminder access, rate, leak guard and dry-run before gateway', async (t) => {
  const config = { cognition: { dryRun: false }, security: { leakGuard: { enabled: true, action: 'block' } } }
  let allowed = false, rate = false, calls = 0
  const outbound = createOutbound({ getConfig: () => config, access: { canSend: () => ({ allowed }) },
    policy: { canSend: () => ({ ok: rate }) }, gateway: { actions: { sendMessage: async () => { calls++; return {} } } } })
  const h = harness(t, { outbound })
  const row = h.add({ text: 'api_key=abcdefghijklmnopqrstuvwxyz', everySeconds: undefined, at: NOW + 1 })
  h.scheduler.advance(1)
  for (const error of ['ACCESS_DENIED', 'RATE_LIMITED', 'LEAK_BLOCKED']) {
    await h.service.tick()
    assert.equal(h.store.get('reminder', row.id).lastError, error)
    allowed = true
    if (error === 'RATE_LIMITED') rate = true
    h.scheduler.advance(60000)
  }
  config.security.leakGuard.action = 'redact'
  config.cognition.dryRun = true
  await h.service.tick()
  assert.equal(h.store.get('reminder', row.id).status, 'sent')
  assert.equal(calls, 0)
})

test('real reminder commands report validation/duplicate/cancel errors and bound listing', async (t) => {
  const h = harness(t)
  const commands = createCommandService({ getConfig: () => h.config, reminders: h.service,
    access: { canSend: () => ({ allowed: true }) } })
  const command = (text, extra = {}) => commands.handle({ ...target, senderId: '10001', text, ...extra })
  for (const text of ['/remind 59 low', '/remind 2592001 high', '/remind 2020-01-01T00:00:00Z past', `/remind 60 ${'💧'.repeat(501)}`]) {
    assert.match((await command(text)).reply, /范围|未来|Unicode/)
  }
  assert.match((await command('/remind 60 water')).reply, /已创建/)
  assert.match((await command('/remind 60 water')).reply, /相同/)
  for (let i = 0; i < 12; i++) h.add({ text: `item ${i}` })
  assert.equal((await command('/reminders')).reply.split('\n').length, 11)
  const row = h.service.list(target)[0]
  assert.match((await command(`/forgetreminder ${row.id}`, { chatType: 'group' })).reply, /没有/)
  assert.match((await command(`/forgetreminder ${row.id}`)).reply, /已取消/)
})

test('cognition defers reminder timers until explicit activation, persists across restart and disposes', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-reminders-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const config = normalizeConfig({ access: { ownerQQ: '10001' }, cognition: {
    reminders: { enabled: true, tickMs: 1000 }, consolidation: { enabled: false }, learning: { enabled: false },
  } }).config
  let scheduler = createFakeScheduler(NOW)
  const sends = []
  const access = { isOwner: (cfg, id) => cfg.access.ownerQQ === id, canSend: () => ({ allowed: true }) }
  const options = () => ({ dataRoot: dir, getConfig: () => config, clock: { now: scheduler.now }, scheduler, access,
    gateway: { actions: { sendMessage: async (payload) => { sends.push(payload); return { message_id: 1 } } } } })
  const schedule = t.mock.method(scheduler, 'setTimeout')
  let cog = createCognition(options())
  t.after(() => cog.dispose())
  assert.equal(await cog.ready, true)
  assert.equal(schedule.mock.calls.filter(call => call.arguments[1] === 1000).length, 0)
  const response = await cog.services.commands.handle({ ...target, senderId: '10001', text: '/remind 2099-01-01T00:00:00Z persist' })
  assert.match(response.reply, /rem_[a-f0-9]+/)
  const row = cog.services.reminders.add({ ...target, createdBy: '10001', text: 'due', at: NOW + 1000 })
  scheduler.advance(1000)
  await new Promise(setImmediate)
  assert.equal(cog.store.get('persona_self:reminder', row.id).status, 'active')
  assert.equal(sends.length, 1) // only the command reply, no constructor-side reminder timer
  cog.dispose()
  scheduler = createFakeScheduler(NOW + 1000)
  cog = createCognition(options())
  assert.equal(await cog.ready, true)
  assert.equal(cog.services.reminders.list(target).length, 2)
  const start = t.mock.method(cog.services.reminders, 'start')
  cog.startReminders()
  cog.startReminders()
  assert.equal(start.mock.callCount(), 1)
  scheduler.advance(1000)
  await new Promise(setImmediate)
  assert.equal(cog.store.get('persona_self:reminder', row.id).status, 'sent')
  assert.equal(sends.length, 2) // command reply plus scheduled message
  assert.equal(sends[1].message[0].data.text, 'due')
  assert.equal(cog.store.count('llm_usage'), 0)
  cog.dispose()
  cog.startReminders()
  assert.equal(start.mock.callCount(), 1)
  scheduler.advance(60000)
  await new Promise(setImmediate)
  assert.equal(sends.length, 2)
})
