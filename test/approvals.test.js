import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../src/cognition/store.js'
import { createApprovalService, ADMIN_APPROVAL_ACTIONS } from '../src/core/approvals.js'

const intent = { action: 'kick', args: '10002 confirm', chatType: 'group', chatId: '20001', senderId: '10001' }
function fixture(t) {
  let now = 1000000
  const clock = { now: () => now }
  const store = createStore({ clock })
  t.after(() => store.close())
  return { store, service: createApprovalService({ store, clock }), advance: (ms) => { now += ms } }
}

test('approvals: validate fixed actions, args, controls, numeric targets; random IDs and selected fields only', (t) => {
  const { service } = fixture(t)
  for (const action of ADMIN_APPROVAL_ACTIONS) {
    const row = service.create({ ...intent, action, args: '', token: 'never-copy-this', raw: { secret: true } })
    assert.match(row.id, /^apr_[a-f0-9]{32}$/)
    assert.equal(row.status, 'pending')
    assert.equal(row.createdAt, 1000000)
    assert.equal(row.expiresAt, 1600000)
    assert.ok(!JSON.stringify(row).includes('never-copy-this'))
    assert.ok(!('raw' in row))
  }
  const patches = [{ action: 'say' }, { action: 'constructor' }, { args: null }, { args: 'a'.repeat(301) },
    ...['\0', '\n', '\r', '\t', '\x7f', '\x85'].map((args) => ({ args })),
    { chatType: 'channel' }, { chatId: 'bad' }, { chatId: '0' }, { chatId: '01' }, { chatId: Number.MAX_SAFE_INTEGER + 1 }, { senderId: '-1' }, { senderId: {} }]
  for (const patch of patches) assert.throws(() => service.create({ ...intent, ...patch }), /APPROVAL_INVALID_INPUT/)
  const row = service.create({ ...intent, args: '猫'.repeat(300), chatId: 20001 })
  assert.equal(row.chatId, '20001')
  assert.notEqual(row.id, service.create(intent).id)
  const otherStore = createStore({ clock: { now: () => 2000000 } })
  t.after(() => otherStore.close())
  const ownClock = createApprovalService({ store: otherStore, clock: { now: () => 1000000 } })
  const timed = ownClock.create(intent)
  assert.equal(timed.createdAt, 1000000)
  assert.equal(ownClock.get(timed.id).expiresAt - ownClock.get(timed.id).createdAt, 600000)
})

test('approvals: secrets are rejected before persistence and never logged', (t) => {
  const { store } = fixture(t)
  const logs = []
  const service = createApprovalService({ store, logger: { debug: (...args) => logs.push(args) } })
  for (const args of ['sk-' + 's'.repeat(30), 'Bearer ' + 's'.repeat(30), 'api_key=' + 's'.repeat(30), '-----BEGIN PRIVATE KEY-----secret']) {
    assert.throws(() => service.create({ ...intent, args }), /APPROVAL_SECRET/)
  }
  assert.equal(store.count('qq_admin_approval'), 0)
  assert.deepEqual(logs, [])
})

test('approvals: expiry on list/get/resolve is persisted and pending is newest first', (t) => {
  const { service, store, advance } = fixture(t)
  const first = service.create(intent)
  advance(1)
  const second = service.create(intent)
  assert.deepEqual(service.list({ limit: 1 }).map((row) => row.id), [second.id])
  advance(599999)
  assert.equal(service.get(first.id).status, 'expired')
  assert.equal(store.get('qq_admin_approval', first.id).status, 'expired')
  assert.throws(() => service.resolve(first.id, { approve: true, operatorId: '10001' }), /NOT_PENDING/)
  assert.equal(service.list().length, 1)
  advance(1)
  assert.equal(service.list().length, 0)
  assert.equal(store.get('qq_admin_approval', second.id).status, 'expired')
  assert.equal(service.list({ status: 'expired' }).length, 2)
  assert.equal(service.get('apr_bad'), null)
  assert.equal(service.get('apr_' + 'a'.repeat(32)), null)
})

test('approvals: fifty pending capacity rejects new entries and releases expired/resolved slots', (t) => {
  const { service, advance } = fixture(t)
  for (let i = 0; i < 50; i++) service.create(intent)
  assert.throws(() => service.create(intent), /APPROVAL_FULL/)
  service.resolve(service.list()[0].id, { approve: false, operatorId: '10001' })
  service.create(intent)
  assert.throws(() => service.create(intent), /APPROVAL_FULL/)
  advance(600000)
  assert.equal(service.create(intent).status, 'pending')
  assert.equal(service.list().length, 1)
})

test('approvals: resolve/complete are one-time transitions, validate boolean/operator and never execute', (t) => {
  const { service } = fixture(t)
  const row = service.create(intent)
  assert.throws(() => service.complete(row.id, { ok: true }), /NOT_APPROVED/)
  for (const options of [{ approve: 'true', operatorId: '10001' }, { approve: true, operatorId: 'bad' }]) assert.throws(() => service.resolve(row.id, options), /INVALID_INPUT/)
  const approved = service.resolve(row.id, { approve: true, operatorId: '10001' })
  assert.equal(approved.status, 'approved')
  assert.equal(approved.resolvedBy, '10001')
  assert.equal(approved.resolvedAt, 1000000)
  assert.throws(() => service.resolve(row.id, { approve: false, operatorId: '10001' }), /NOT_PENDING/)
  assert.throws(() => service.complete(row.id, { ok: 1 }), /INVALID_INPUT/)
  assert.equal(service.complete(row.id, { ok: true }).status, 'executed')
  assert.throws(() => service.complete(row.id, { ok: true }), /NOT_APPROVED/)
  const failed = service.create(intent)
  service.resolve(failed.id, { approve: true, operatorId: '10001' })
  assert.equal(service.complete(failed.id, { ok: false }).status, 'failed')
  const rejected = service.create(intent)
  assert.equal(service.resolve(rejected.id, { approve: false, operatorId: '10001' }).status, 'rejected')
  assert.throws(() => service.complete(rejected.id, { ok: false }), /NOT_APPROVED/)
  assert.throws(() => service.resolve('apr_' + '0'.repeat(32), { approve: true, operatorId: '10001' }), /NOT_PENDING/)
})

test('approvals: pending and terminal records survive reopening the persistent store', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-approvals-'))
  const file = join(dir, 'approvals.sqlite')
  const clock = { now: () => 1000000 }
  let store = createStore({ file, clock })
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const service = createApprovalService({ store, clock })
  const pending = service.create(intent)
  const done = service.create(intent)
  service.resolve(done.id, { approve: true, operatorId: '10001' })
  service.complete(done.id, { ok: true })
  store.close()
  store = createStore({ file, clock })
  const reopened = createApprovalService({ store, clock })
  assert.equal(reopened.get(pending.id).status, 'pending')
  assert.equal(reopened.get(done.id).status, 'executed')
})
