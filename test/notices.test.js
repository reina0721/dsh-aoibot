import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../src/cognition/store.js'
import { createNoticeService } from '../src/cognition/notices.js'
import { createTimelineService } from '../src/cognition/timeline.js'
import { createPersonaScopedStore, personaDataCounts, copyPersonaData, dropPersonaData } from '../src/cognition/persona-scope.js'
import { normalizeEvent } from '../src/gateway/normalize.js'
import { normalizeConfig } from '../src/core/config.js'

function harness(t, overrides = {}) {
  const clock = { now: () => 12345 }
  const store = createStore({ clock })
  t.after(() => store.close())
  const config = { access: { ownerQQ: '10001' }, cognition: {} }
  const calls = [], logs = []
  const gateway = { actions: {
    async setFriendAddRequest(...args) { calls.push(['friend', ...args]) },
    async setGroupAddRequest(...args) { calls.push(['group', ...args]) },
  } }
  const service = createNoticeService({ store, clock, getConfig: () => config, gateway, logger: { warn: (...args) => logs.push(args) }, ...overrides })
  return { service, store, config, calls, logs, gateway }
}
const friend = (extra = {}) => ({ type: 'friend', userId: '10002', flag: 'private-opaque-flag', comment: '想成为好友', ...extra })
const group = (extra = {}) => ({ ...friend(), type: 'group', groupId: '20001', subType: 'invite', ...extra })

test('notices: all known mappings normalize, persist bounded timeline events and deterministically dedupe', (t) => {
  const { service, store, calls } = harness(t)
  const cases = [
    ['group_increase', { sub_type: 'approve' }], ['group_decrease', { sub_type: 'kick' }],
    ['group_admin', { sub_type: 'set' }], ['group_ban', { sub_type: 'ban', duration: 60 }],
    ['group_card', { card_old: '旧名片', card_new: '新名片' }], ['group_name', { group_name: '新群名' }],
    ['group_title', { title: '新头衔' }], ['essence', { sub_type: 'add', message_id: -123 }],
    ['friend_add', { group_id: undefined }], ['offline_file', { group_id: undefined, file: { name: 'file.txt', url: 'https://secret.invalid/token' } }],
  ]
  for (const [type, extra] of cases) {
    const event = normalizeEvent({ post_type: 'notice', notice_type: type, user_id: 10002, group_id: 20001, operator_id: 10003, flag: 'never-copy', comment: 'never-copy', time: 123, ...extra })
    const notice = { ...event.notice, time: event.time }
    const row = service.handle(notice)
    assert.ok(row.id.startsWith('nte_'), type)
    assert.equal(row.at, 12345)
    assert.equal(row.source, 'notice')
    assert.equal(row.scopeType, extra.group_id === undefined && ['friend_add', 'offline_file'].includes(type) ? 'private' : 'group')
    assert.equal(row.scopeId, row.scopeType === 'private' ? '10002' : '20001')
    assert.ok(row.title.length <= 200 && row.detail.length <= 500)
    assert.ok(row.detail.includes('10002'))
    assert.doesNotMatch(JSON.stringify(row), /never-copy|https:|secret.invalid/)
    assert.equal(service.handle({ ...notice, comment: 'different raw comment' }), null)
  }
  assert.equal(store.count('timeline_event'), 10)
  const rows = createTimelineService({ scopedStore: store }).timeline({ types: ['event'] })
  assert.equal(rows.length, 10)
  assert.ok(rows.some((r) => r.detail.includes('新群名')))
  assert.ok(rows.some((r) => r.detail.includes('新名片')))
  assert.ok(rows.some((r) => r.detail.includes('新头衔')))
  assert.ok(rows.some((r) => r.detail.includes('duration=60')))
  assert.ok(rows.some((r) => r.detail.includes('file.txt')))
  assert.equal(calls.length, 0)
  // Different upstream timestamps distinguish otherwise identical real occurrences.
  assert.ok(service.handle({ type: 'friend_add', userId: '10002', time: 124 }))
})

test('notices: unknown, existing pipeline notices and malformed inputs are ignored; config is dynamic', (t) => {
  const { service, config, store } = harness(t)
  for (const notice of [null, {}, { type: '__proto__' }, { type: 'unknown' }, { type: 'group_recall' }, { type: 'notify', subType: 'poke' }, { type: 'group_msg_emoji_like' },
    { type: 'group_name' }, { type: 'group_admin', groupId: '2', userId: '1', subType: 'invalid' },
    { type: 'friend_add', userId: 'bad' }, { type: 'offline_file', userId: '1', file: { url: 'secret' } },
    { type: 'group_ban', groupId: '2', userId: '1', subType: 'ban', duration: -1 },
    { type: 'essence', groupId: '2', subType: 'add', messageId: 'secret' }]) assert.equal(service.handle(notice), null)
  assert.equal(store.count('timeline_event'), 0)
  config.cognition.notices = { enabled: false }
  assert.equal(service.handle({ type: 'friend_add', userId: '1' }), null)
  config.cognition.notices.enabled = true
  assert.ok(service.handle({ type: 'group_ban', groupId: '2', userId: '0', subType: 'lift_ban', duration: 0 }))
})

test('notices: text fields redact recognizable secrets, strip controls and cap by Unicode code points', (t) => {
  const { service } = harness(t)
  const secret = 'sk-' + 's'.repeat(30)
  const row = service.handle({ type: 'group_card', groupId: '2', userId: '1', cardNew: secret + '\n' + '😀'.repeat(400) })
  assert.doesNotMatch(row.detail, new RegExp(secret))
  assert.doesNotMatch(row.detail, /[\x00-\x1f]/)
  assert.ok(Array.from(row.detail).length <= 500)
  assert.match(row.detail, /REDACTED/)
})

test('requests: persist/list public fields, flag-only dedupe, status/limit filtering and zero auto actions', (t) => {
  const { service, store, calls } = harness(t)
  const first = service.handleRequest(friend())
  assert.deepEqual(first, { id: first.id, type: 'friend', subType: 'add', userId: '10002', groupId: '', comment: '想成为好友', at: 12345, status: 'pending' })
  assert.equal(store.get('qq_request', first.id).flag, 'private-opaque-flag')
  assert.equal(store.get('qq_request', first.id).source, 'request')
  assert.equal(service.handleRequest(group({ comment: 'changed' })), null)
  assert.deepEqual(service.list(), [first])
  service.handleRequest(group({ flag: 'other' }))
  assert.equal(service.list({ limit: 1 }).length, 1)
  assert.equal(service.list({ status: 'unknown' }).length, 0)
  assert.deepEqual(service.status(), { pending: 2 })
  assert.equal(calls.length, 0)
})

test('requests: malformed data and disabled config never store or dispatch; flag/comment secrets stay private', (t) => {
  const { service, store, config, calls, logs } = harness(t)
  for (const input of [null, {}, friend({ type: 'unknown' }), friend({ flag: '' }), friend({ flag: '  ' }), friend({ flag: 'x'.repeat(257) }), friend({ flag: 'a\nb' }), friend({ flag: 123 }), friend({ userId: 'bad' }), group({ groupId: '' }), group({ groupId: 'bad' }), group({ subType: '' }), group({ subType: 'nope' })]) assert.equal(service.handleRequest(input), null)
  assert.equal(store.count('qq_request'), 0)
  config.cognition.requests = { enabled: false }
  assert.equal(service.handleRequest(friend()), null)
  assert.deepEqual(service.list(), [])
  config.cognition.requests.enabled = true
  const secret = 'sk-' + 's'.repeat(30)
  const row = service.handleRequest(friend({ comment: 'private-opaque-flag\n' + secret + '😀'.repeat(600) }))
  assert.ok(Array.from(row.comment).length <= 500)
  assert.doesNotMatch(JSON.stringify(service.list()), /private-opaque-flag|sk-ssss|\\n/)
  assert.doesNotMatch(store.get('qq_request', row.id).comment, /private-opaque-flag|sk-ssss/)
  assert.deepEqual(calls, [])
  assert.deepEqual(logs, [])
})

test('requests: only owner with boolean approve can resolve a pending valid request, once', async (t) => {
  const { service, calls, config } = harness(t)
  const row = service.handleRequest(friend())
  const owner = { operatorId: '10001', approve: true }
  for (const args of [{ approve: true }, { ...owner, operatorId: '10002' }, { ...owner, approve: 'true' }, { ...owner, reason: 'x'.repeat(101) }, { ...owner, reason: 'bad\nreason' }]) await assert.rejects(service.resolve(row.id, args))
  for (const id of ['', 'x'.repeat(101), 'req_' + '0'.repeat(32)]) await assert.rejects(service.resolve(id, owner))
  config.cognition.requests = { enabled: false }
  await assert.rejects(service.resolve(row.id, owner), /未启用/)
  config.cognition.requests.enabled = true
  assert.deepEqual(calls, [])
  const result = await service.resolve(row.id, { ...owner, reason: '备注' })
  assert.deepEqual(calls, [['friend', 'private-opaque-flag', true, '备注']])
  assert.equal(result.status, 'approved')
  assert.equal(result.resolvedAt, 12345)
  assert.equal(result.resolvedBy, '10001')
  assert.equal(Object.hasOwn(result, 'flag'), false)
  assert.deepEqual(service.status(), { pending: 0 })
  assert.equal(service.list().length, 0)
  assert.equal(service.list({ status: 'approved' }).length, 1)
  await assert.rejects(service.resolve(row.id, owner), /已处理/)
  assert.equal(calls.length, 1)
})

test('requests: group add/invite reject with correct params; gateway failure stays pending with safe errors/logs', async (t) => {
  const { service, gateway, calls, logs } = harness(t)
  for (const subType of ['add', 'invite']) {
    const row = service.handleRequest(group({ subType, flag: subType }))
    assert.equal((await service.resolve(row.id, { approve: false, operatorId: '10001', reason: '拒绝' })).status, 'rejected')
    assert.deepEqual(calls.at(-1), ['group', subType, subType, false, '拒绝'])
  }
  const pending = service.handleRequest(friend())
  gateway.actions.setFriendAddRequest = async () => { throw new Error('private-opaque-flag raw-comment provider-secret') }
  await assert.rejects(service.resolve(pending.id, { approve: true, operatorId: '10001' }), (error) => /网关/.test(error.message) && !/private-opaque|raw-comment|provider-secret/.test(error.message))
  assert.equal(service.list()[0].status, 'pending')
  assert.doesNotMatch(JSON.stringify(logs), /private-opaque|raw-comment|provider-secret/)
  delete gateway.actions.setFriendAddRequest
  await assert.rejects(service.resolve(pending.id, { approve: true, operatorId: '10001' }), /不可用/)
})

test('requests: concurrent resolve dispatches once and persona switches cannot redirect completion writes', async (t) => {
  const { store: base, config } = harness(t)
  let active = 'self', release, calls = 0
  const store = createPersonaScopedStore({ base, getPersonaId: () => active })
  const service = createNoticeService({ store, getConfig: () => config, clock: { now: () => 12345 }, gateway: { actions: { setFriendAddRequest: () => { calls++; return new Promise((r) => { release = r }) } } } })
  const row = service.handleRequest(friend())
  const result = service.resolve(row.id, { approve: true, operatorId: '10001' })
  await assert.rejects(service.resolve(row.id, { approve: false, operatorId: '10001' }), /正在处理/)
  active = 'other'
  assert.deepEqual(service.list(), [])
  release()
  await result
  assert.equal(calls, 1)
  assert.equal(base.get('persona_self:qq_request', row.id).status, 'approved')
  assert.equal(base.get('persona_other:qq_request', row.id), null)
})

test('requests: persona data group participates in counts/copy/drop with timeline notices', (t) => {
  const { store: base, config } = harness(t)
  for (const id of ['self', 'other']) base.put('persona', id, { id })
  const store = createPersonaScopedStore({ base, getPersonaId: () => 'self' })
  const service = createNoticeService({ store, getConfig: () => config })
  const row = service.handleRequest(friend())
  service.handle({ type: 'friend_add', userId: '10002' })
  assert.equal(personaDataCounts({ base, personaId: 'self' }).groups.find((g) => g.id === 'requests').count, 1)
  assert.equal(copyPersonaData({ base, from: 'self', to: 'other', groups: ['requests', 'timeline'] }).ok, true)
  assert.ok(base.get('persona_other:qq_request', row.id))
  assert.equal(dropPersonaData({ base, personaId: 'other' }), 2)
  assert.equal(base.count('persona_self:qq_request'), 1)
})

test('requests/notices config: defaults enabled, explicit false survives normalization and invalid values default safe', () => {
  for (const input of [{}, { cognition: { notices: { enabled: 'bad' }, requests: { enabled: 'bad' } } }]) {
    const { config } = normalizeConfig(input)
    assert.equal(config.cognition.notices.enabled, true)
    assert.equal(config.cognition.requests.enabled, true)
  }
  const { config } = normalizeConfig({ cognition: { notices: { enabled: false }, requests: { enabled: false } } })
  assert.equal(config.cognition.notices.enabled, false)
  assert.equal(config.cognition.requests.enabled, false)
})
