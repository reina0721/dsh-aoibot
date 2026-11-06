import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIdentityService } from '../src/cognition/identities.js'
import { createStore } from '../src/cognition/store.js'
import { createPersonService } from '../src/cognition/person.js'
import { createPersonaScopedStore, migrateLegacyPersonaData } from '../src/cognition/persona-scope.js'

function harness(t) {
  let now = 1700000000000
  const clock = { now: () => now }
  const store = createStore({ clock })
  t.after(() => store.close())
  const service = createIdentityService({ store, clock })
  return { store, service, clock, advance: () => { now += 1000 } }
}

const input = { platform: 'qq', externalId: '10001', personId: 'person_one' }

test('identities: empty by default; links have fixed fields, random IDs and manual source', (t) => {
  const { store, service, clock } = harness(t)
  const before = store.info().stats.puts
  assert.deepEqual(service.list(), [])
  assert.equal(service.resolve(input), null)
  assert.equal(service.unlink(input), false)
  assert.deepEqual(service.counts(), { total: 0, byPlatform: { qq: 0, telegram: 0, discord: 0, matrix: 0, custom: 0 } })
  assert.equal(store.info().stats.puts, before)
  const row = service.link({ ...input, label: '  我的账号  ', source: 'automatic', token: 'ignored' })
  assert.match(row.id, /^idn_[a-f0-9]{24}$/)
  assert.deepEqual(row, { ...input, id: row.id, kind: 'manual_identity', label: '我的账号', source: 'manual', createdAt: clock.now(), updatedAt: clock.now() })
  assert.deepEqual(service.resolve(input), row)
  row.personId = 'mutated'
  assert.equal(service.resolve(input).personId, input.personId)
})

test('identities: exact platform/external key is unique; relink preserves ID and creation time', (t) => {
  const { service, advance } = harness(t)
  const first = service.link({ ...input, label: 'first' })
  advance()
  const relink = service.link({ ...input, personId: 'person_two', label: 'second' })
  assert.equal(relink.id, first.id)
  assert.equal(relink.createdAt, first.createdAt)
  assert.ok(relink.updatedAt > first.updatedAt)
  assert.equal(relink.personId, 'person_two')
  assert.equal(relink.label, 'second')
  assert.equal(service.link({ ...input }).label, 'second')
  assert.equal(service.link({ ...input, label: '' }).label, '')
  const other = service.link({ ...input, platform: 'telegram' })
  assert.notEqual(other.id, first.id)
  assert.equal(service.counts().total, 2)
  assert.equal(service.unlink(input), true)
  assert.equal(service.unlink(input), false)
  assert.equal(service.resolve(input), null)
  assert.equal(service.resolve({ ...input, platform: 'telegram' }).id, other.id)
})

test('identities: all five platforms, identifier boundaries and clean Unicode labels', (t) => {
  const { service } = harness(t)
  for (const platform of ['qq', 'telegram', 'discord', 'matrix', 'custom']) {
    const row = service.link({ platform, externalId: 'A_.:@-0'.padEnd(64, 'x'), personId: 'A_-0'.padEnd(80, 'z'), label: '星'.repeat(80) })
    assert.equal(row.platform, platform)
  }
  service.link({ platform: 'custom', externalId: 'a', personId: 'b', label: '😀'.repeat(80) })
  assert.equal(service.counts().total, 6)
  assert.equal(service.counts().byPlatform.custom, 2)
})

test('identities: invalid inputs and known secrets fail without writes or value disclosure', (t) => {
  const { store, service } = harness(t)
  const secret = 'sk-' + 'a'.repeat(24)
  const bad = [
    { platform: 'onebot11' }, { platform: 'QQ' }, { platform: '' }, { platform: null },
    { externalId: '' }, { externalId: 'a'.repeat(65) }, { externalId: 10001 }, { externalId: 'a/b' }, { externalId: ' a' }, { externalId: 'a\n' }, { externalId: '用户' },
    { personId: '' }, { personId: 'x'.repeat(81) }, { personId: 1 }, { personId: 'person.a' }, { personId: 'a@b' }, { personId: 'a\u202e' },
    { label: null }, { label: 5 }, { label: 'x'.repeat(81) }, { label: 'a\nb' }, { label: 'a\tb' }, { label: 'a\u0000b' }, { label: 'a\u007fb' }, { label: 'a\u0085b' }, { label: 'a\u202eb' }, { label: 'a\u2066b' }, { label: 'a\u2028b' },
    { externalId: secret }, { personId: secret }, { label: secret }, { label: 'api_key=' + 'a'.repeat(24) }, { label: 'Bearer ' + 'a'.repeat(24) },
  ]
  const before = store.info().stats.puts
  for (const patch of bad) assert.throws(() => service.link({ ...input, ...patch }), (error) => /^IDENTITY_(INVALID_|SECRET$)/.test(error.message) && !error.message.includes(secret))
  for (const method of ['resolve', 'unlink']) {
    assert.throws(() => service[method]({ platform: 'unknown', externalId: 'a' }), /IDENTITY_INVALID_PLATFORM/)
    assert.throws(() => service[method]({ platform: 'qq', externalId: '../a' }), /IDENTITY_INVALID_EXTERNAL_ID/)
  }
  assert.throws(() => service.list({ platform: 'unknown' }), /IDENTITY_INVALID_PLATFORM/)
  assert.throws(() => service.list({ personId: 'a.b' }), /IDENTITY_INVALID_PERSON_ID/)
  for (const limit of [0, -1, 1.5, NaN, '20', null]) assert.throws(() => service.list({ limit }), /IDENTITY_INVALID_LIMIT/)
  assert.equal(store.info().stats.puts, before)
  assert.equal(service.counts().total, 0)
})

test('identities: list filters before limiting, newest first, and caps at 100', (t) => {
  const { service, advance } = harness(t)
  for (let i = 0; i < 110; i += 1) {
    advance()
    service.link({ platform: i % 2 ? 'qq' : 'discord', externalId: String(i), personId: i % 3 ? 'p1' : 'p2' })
  }
  assert.equal(service.list({ limit: 1000 }).length, 100)
  assert.equal(service.list({ limit: 1 })[0].externalId, '109')
  const filtered = service.list({ platform: 'discord', personId: 'p2', limit: 2 })
  assert.deepEqual(filtered.map((row) => row.externalId), ['108', '102'])
  assert.ok(service.list().every((row, index, items) => !index || items[index - 1].createdAt >= row.createdAt))
  assert.equal(service.counts().total, 110)
})

test('identities: capacity is 5000; full registry still permits relink and unlink', (t) => {
  const { store, service } = harness(t)
  store.tx(() => {
    for (let i = 0; i < 5000; i += 1) {
      const id = 'idn_' + i.toString(16).padStart(24, '0')
      store.put('manual_identity', id, { id, platform: 'qq', externalId: String(i), personId: 'p', label: '', source: 'manual' })
    }
  })
  assert.equal(service.counts().total, 5000)
  assert.throws(() => service.link({ ...input, externalId: 'new' }), /IDENTITY_FULL/)
  service.link({ ...input, externalId: '0', personId: 'updated' })
  assert.equal(service.counts().total, 5000)
  assert.equal(service.resolve({ platform: 'qq', externalId: '0' }).personId, 'updated')
  service.unlink({ platform: 'qq', externalId: '0' })
  service.link({ ...input, externalId: 'new' })
  assert.equal(service.counts().total, 5000)
})

test('identities: isolated from person creation/lookup, persona migration, switching and deletion', (t) => {
  const { store, service, clock } = harness(t)
  let personaId = 'self'
  const scoped = createPersonaScopedStore({ base: store, getPersonaId: () => personaId })
  const person = createPersonService({ store: scoped, clock, getConfig: () => ({}) })
  const existing = person.ensurePerson({ platform: 'qq', platformUserId: '10001', nickname: 'Alice' })
  const before = scoped.list('person')
  const oldIdentities = scoped.list('identity')
  service.link({ ...input, personId: existing.person.id })
  service.link({ platform: 'matrix', externalId: '@alice:example.org', personId: 'does_not_exist' })
  service.link({ ...input, personId: 'does_not_exist', label: 'manual' })
  assert.deepEqual(scoped.list('person'), before)
  assert.deepEqual(scoped.list('identity'), oldIdentities)
  assert.equal(person.findPersonByPlatform('qq', '10001').id, existing.person.id)
  assert.equal(person.findPersonByPlatform('matrix', '@alice:example.org'), null)
  assert.equal(person.detail(existing.person.id).identities.length, 1)
  migrateLegacyPersonaData({ base: store, targetId: 'self', clock })
  personaId = 'other'
  assert.equal(service.counts().total, 2)
  service.unlink(input)
  assert.deepEqual(store.list('persona_self:person'), before)
  assert.equal(scoped.count('person'), 0)
})

test('identities: persistent across store reopen, with fixed log messages containing only IDs', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-identities-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'cognition.sqlite')
  let store = createStore({ file })
  const logs = []
  const logger = { debug: (...args) => logs.push(args) }
  const row = createIdentityService({ store, logger }).link({ ...input, label: 'private label' })
  store.close()
  store = createStore({ file })
  t.after(() => store.close())
  const service = createIdentityService({ store, logger })
  assert.equal(service.resolve(input).id, row.id)
  service.unlink(input)
  assert.deepEqual(logs, [['Manual identity link saved', row.id], ['Manual identity link removed', row.id]])
})

test('identities: store failures propagate, without attempting to change person records', () => {
  for (const method of ['list', 'link', 'resolve', 'unlink', 'counts']) {
    const service = createIdentityService({ store: { list(kind) { assert.equal(kind, 'manual_identity'); throw new Error('STORE_FAILED') } } })
    assert.throws(() => service[method](input), /STORE_FAILED/)
  }
})
