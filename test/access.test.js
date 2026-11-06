import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ACCESS_MODES,
  normalizeAccess,
  isOwner,
  isOperator,
  decideInbound,
  canSend,
  createAccess,
  parseRawForAccess,
  reasonText,
} from '../src/core/access.js'

function cfg(access, extra = {}) {
  return { botQQ: '999999', access: normalizeAccess(access || {}), ...extra }
}

test('normalizeAccess：默认 open、主人 QQ 去非数字、白名单去空去重、非法值回退', () => {
  const issues = []
  const a = normalizeAccess({
    mode: 'wild',
    ownerQQ: ' 12-34 56 ',
    ownerName: '  ',
    private: ['10001', '10001', '', 10002],
    groups: ['20001'],
    auditSize: 99999,
  }, issues)
  assert.equal(a.mode, 'open')
  assert.equal(a.ownerQQ, '123456')
  assert.equal(a.ownerName, '主人')
  assert.deepEqual(a.private, ['10001', '10002'])
  assert.deepEqual(a.groups, ['20001'])
  assert.equal(a.auditSize, 1000)
  assert.ok(issues.some((item) => item.includes('access.mode')), JSON.stringify(issues))
  assert.deepEqual(ACCESS_MODES, ['open', 'allowlist'])
})

test('normalizeAccess：allowlist 无主人 QQ 给出可读 issue', () => {
  const issues = []
  const a = normalizeAccess({ mode: 'allowlist', ownerQQ: '' }, issues)
  assert.equal(a.mode, 'allowlist')
  assert.ok(issues.some((item) => item.includes('主人 QQ')))
})

test('decideInbound：open 放行一切消息', () => {
  const c = cfg({ mode: 'open' })
  assert.deepEqual(decideInbound(c, { chatType: 'group', chatId: '1', senderId: '2' }), { allowed: true, reason: 'mode_open' })
  assert.deepEqual(decideInbound(c, { chatType: 'private', chatId: '2', senderId: '2' }), { allowed: true, reason: 'mode_open' })
})

test('decideInbound：allowlist 主人/私聊白名单/群白名单/陌生人', () => {
  const c = cfg({ mode: 'allowlist', ownerQQ: '10001', private: ['10002'], groups: ['20001'] })
  assert.deepEqual(decideInbound(c, { chatType: 'private', chatId: '10001', senderId: '10001' }), { allowed: true, reason: 'owner' })
  assert.deepEqual(decideInbound(c, { chatType: 'private', chatId: '10002', senderId: '10002' }), { allowed: true, reason: 'private_allowlist' })
  assert.deepEqual(decideInbound(c, { chatType: 'private', chatId: '10003', senderId: '10003' }), { allowed: false, reason: 'private_not_allowed' })
  assert.deepEqual(decideInbound(c, { chatType: 'group', chatId: '20001', senderId: '10003' }), { allowed: true, reason: 'group_allowlist' })
  assert.deepEqual(decideInbound(c, { chatType: 'group', chatId: '20002', senderId: '10001' }), { allowed: false, reason: 'group_not_allowed' })
})

test('decideInbound：机器人自己与非消息事件不拦', () => {
  const c = cfg({ mode: 'allowlist', ownerQQ: '10001' })
  assert.equal(decideInbound(c, { chatType: 'group', chatId: '1', senderId: '999999', selfId: '999999' }).allowed, true)
  assert.equal(decideInbound(c, { chatType: 'group', chatId: '1', senderId: '999999' }).reason, 'self')
  assert.equal(decideInbound(c, { kind: 'notice', chatType: 'group', chatId: '1' }).allowed, true)
})

test('canSend：出站只看目标会话', () => {
  const open = cfg({ mode: 'open' })
  assert.equal(canSend(open, { chatType: 'group', chatId: '1' }).allowed, true)
  const c = cfg({ mode: 'allowlist', ownerQQ: '10001', private: ['10002'], groups: ['20001'] })
  assert.equal(canSend(c, { chatType: 'group', chatId: '20001' }).allowed, true)
  assert.equal(canSend(c, { chatType: 'group', chatId: '20002' }).allowed, false)
  assert.equal(canSend(c, { chatType: 'private', chatId: '10001' }).allowed, true)
  assert.equal(canSend(c, { chatType: 'private', chatId: '10002' }).allowed, true)
  assert.equal(canSend(c, { chatType: 'private', chatId: '10003' }).allowed, false)
})

test('parseRawForAccess：群/私聊/非消息', () => {
  assert.deepEqual(parseRawForAccess({ post_type: 'message', message_type: 'group', group_id: 1, user_id: 2, self_id: 3 }), {
    kind: 'message', chatType: 'group', chatId: '1', senderId: '2', selfId: '3',
  })
  assert.deepEqual(parseRawForAccess({ post_type: 'message', message_type: 'private', user_id: 2, self_id: 3 }), {
    kind: 'message', chatType: 'private', chatId: '2', senderId: '2', selfId: '3',
  })
  assert.equal(parseRawForAccess({ post_type: 'notice' }).kind, 'other')
})

test('createAccess：入站/出站计数与审计只存元数据、环形上限生效', () => {
  const c = cfg({ mode: 'allowlist', ownerQQ: '10001', groups: ['20001'], auditSize: 2 })
  let now = 1000
  const access = createAccess({ getConfig: () => c, clock: () => now++, size: 2 })

  assert.equal(access.decideRaw({ post_type: 'message', message_type: 'private', user_id: 10002 }).allowed, false)
  assert.equal(access.decideRaw({ post_type: 'message', message_type: 'group', group_id: 20002, user_id: 10003 }).allowed, false)
  assert.equal(access.decideRaw({ post_type: 'message', message_type: 'group', group_id: 20001, user_id: 10003 }).allowed, true)
  assert.equal(access.decideRaw({ post_type: 'notice', group_id: 20002 }).allowed, true)

  const counters = access.counters()
  assert.equal(counters.inbound, 4)
  assert.equal(counters.inboundBlocked, 2)
  assert.equal(counters.inboundAllowed, 2)

  assert.equal(access.canSend({ chatType: 'group', chatId: 20002 }).allowed, false)
  assert.equal(access.canSend({ chatType: 'group', chatId: 20001 }).allowed, true)

  const recent = access.recent()
  assert.equal(recent.length, 2, '审计环形上限为 2')
  assert.ok(recent.every((entry) => entry.chatId && entry.reason && !('text' in entry)))
  assert.equal(recent[0].direction, 'in')

  const summary = access.summary()
  assert.equal(summary.mode, 'allowlist')
  assert.equal(summary.ownerQQ, '10001')
  assert.equal(summary.allow.groups, 1)
  assert.equal(summary.counters.outboundBlocked, 1)
})

test('reasonText：中文原因可读且未知原因原样返回', () => {
  assert.match(reasonText('group_not_allowed'), /群白名单/)
  assert.match(reasonText('private_not_allowed'), /私聊白名单/)
  assert.equal(reasonText('something_else'), 'something_else')
})

test('operators: normalize like private list, default empty, deduplicate and cap at 500', () => {
  assert.deepEqual(normalizeAccess({}).operators, [])
  for (const operators of [undefined, null, '10002', {}, 42]) {
    const issues = []
    assert.deepEqual(normalizeAccess({ operators }, issues).operators, [])
    if (operators != null) assert.ok(issues.some((issue) => issue.includes('access.operators')))
  }
  const list = [' 10 002 ', '10002', '', null, 10003, '9'.repeat(40)]
  const original = structuredClone(list)
  const normalized = normalizeAccess({ operators: list }).operators
  assert.deepEqual(normalized, normalizeAccess({ private: list }).private)
  assert.deepEqual(normalized, ['10002', '10003', '9'.repeat(32)])
  assert.deepEqual(list, original)
  assert.equal(normalizeAccess({ operators: Array.from({ length: 600 }, (_, i) => String(10000 + i)) }).operators.length, 500)
})

test('operators: owner precedence, ID/turn methods and live config changes', () => {
  let config = cfg({ ownerQQ: '10001', operators: ['10001', '10002'] })
  const access = createAccess({ getConfig: () => config })
  assert.equal(isOwner(config, '10001'), true)
  assert.equal(isOperator(config, '10001'), false)
  assert.equal(isOwner(config, '10002'), false)
  assert.equal(isOperator(config, 10002), true)
  assert.equal(isOperator({}, '10002'), false)
  for (const operators of ['10002', {}, 10002]) assert.equal(isOperator({ access: { operators } }, '10002'), false)
  for (const id of ['', null, undefined, '10003']) assert.equal(isOperator(config, id), false)
  assert.equal(access.isOperator(10002), true)
  assert.equal(access.isOperator({ senderId: '10002' }), true)
  assert.equal(access.isOperator({ senderId: '10001' }), false)
  assert.equal(access.isOperator({}), false)
  config = cfg({ ownerQQ: '10002', operators: ['10002'] })
  assert.equal(access.isOperator('10002'), false)
  config = cfg({ operators: [] })
  assert.equal(access.isOperator({ senderId: '10002' }), false)
})

test('operators: allowlist private inbound/outbound reason, owner and operator precede private list', () => {
  const config = cfg({ mode: 'allowlist', ownerQQ: '10001', operators: ['10001', '10002'], private: ['10001', '10002', '10003'] })
  for (const [id, reason] of [['10001', 'owner'], ['10002', 'operator'], ['10003', 'private_allowlist']]) {
    assert.deepEqual(decideInbound(config, { chatType: 'private', senderId: id, chatId: id }), { allowed: true, reason })
    assert.deepEqual(canSend(config, { chatType: 'private', chatId: id }), { allowed: true, reason })
  }
  const access = createAccess({ getConfig: () => config })
  assert.equal(access.decideRaw({ post_type: 'message', message_type: 'private', user_id: 10002 }).reason, 'operator')
  assert.equal(access.canSend({ chatType: 'private', chatId: '10002' }).reason, 'operator')
  assert.equal(reasonText('operator'), '只读操作员')
  assert.equal(canSend(config, { chatType: 'private', chatId: '10004' }).allowed, false)
  assert.equal(decideInbound(config, { chatType: 'private', senderId: '10004' }).allowed, false)
  assert.equal(canSend(cfg({ mode: 'open', operators: ['10002'] }), { chatType: 'private', chatId: '10002' }).reason, 'mode_open')
})

test('operators: membership does not grant group access to inbound or outbound', () => {
  const config = cfg({ mode: 'allowlist', ownerQQ: '10001', operators: ['10002'], groups: ['20001'] })
  for (const senderId of ['10001', '10002', '10003']) {
    for (const [chatId, allowed, reason] of [['20001', true, 'group_allowlist'], ['20002', false, 'group_not_allowed'], ['10002', false, 'group_not_allowed']]) {
      assert.deepEqual(decideInbound(config, { chatType: 'group', chatId, senderId }), { allowed, reason })
      assert.deepEqual(canSend(config, { chatType: 'group', chatId }), { allowed, reason })
    }
  }
})
