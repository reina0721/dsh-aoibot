import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createQqActions } from '../src/cognition/qq-actions.js'

function harness({ owner = '10001', actions = null } = {}) {
  const calls = []
  const gateway = {
    actions: actions || {
      async sendLike(userId, times) { calls.push(['like', userId, times]); },
      async groupPoke(groupId, userId) { calls.push(['group_poke', groupId, userId]); },
      async friendPoke(userId) { calls.push(['friend_poke', userId]); },
      async getGroupInfo(groupId) { calls.push(['group_info', groupId]); return { data: { group_id: groupId, group_name: '测试群', member_count: 3, max_member_count: 200, owner_id: '10001' } } },
      async getGroupMemberInfo(groupId, userId) { calls.push(['member_info', groupId, userId]); return { data: { user_id: userId, nickname: '小明', card: '小明卡', role: 'owner', join_time: 1 } } },
    },
  }
  return {
    calls,
    service: createQqActions({ gateway, getConfig: () => ({ access: { ownerQQ: owner } }) }),
  }
}

test('qq-actions：点赞只允许主人、限制次数、目标为当前聊天对象', async () => {
  const { service, calls } = harness()
  assert.equal((await service.like({ operatorId: '10002', chatType: 'private', chatId: '10002' })).error, 'NOT_OWNER')
  assert.equal(calls.length, 0)

  const result = await service.like({ operatorId: '10001', chatType: 'private', chatId: '10002', times: 99 })
  assert.deepEqual(result, { ok: true, target: '10002', times: 10 })
  assert.deepEqual(calls[0], ['like', '10002', 10])
})

test('qq-actions：拍一拍按群/私聊走不同 action', async () => {
  const { service, calls } = harness()
  const group = await service.poke({ operatorId: '10001', chatType: 'group', chatId: 'g1', userId: '20002' })
  assert.equal(group.ok, true)
  assert.deepEqual(calls[0], ['group_poke', 'g1', '20002'])

  const privateChat = await service.poke({ operatorId: '10001', chatType: 'private', chatId: '10002' })
  assert.equal(privateChat.ok, true)
  assert.deepEqual(calls[1], ['friend_poke', '10002'])
})

test('qq-actions：群信息/成员信息映射字段，非群聊拒绝', async () => {
  const { service } = harness()
  const groupInfo = await service.groupInfo({ operatorId: '10001', chatType: 'group', chatId: 'g1' })
  assert.equal(groupInfo.ok, true)
  assert.equal(groupInfo.groupName, '测试群')
  assert.equal(groupInfo.memberCount, 3)
  assert.equal(groupInfo.ownerId, '10001')
  assert.equal((await service.groupInfo({ operatorId: '10001', chatType: 'private', chatId: '10001' })).error, 'GROUP_ONLY')

  const member = await service.memberInfo({ operatorId: '10001', chatType: 'group', chatId: 'g1', userId: '20002' })
  assert.equal(member.ok, true)
  assert.equal(member.nickname, '小明')
  assert.equal(member.role, 'owner')
  assert.equal((await service.memberInfo({ operatorId: '10001', chatType: 'private', chatId: '10001' })).error, 'GROUP_ONLY')
})

test('qq-actions：网关不可用/动作失败返回结构化错误', async () => {
  const noGateway = createQqActions({ getConfig: () => ({ access: { ownerQQ: '10001' } }) })
  assert.equal((await noGateway.like({ operatorId: '10001', chatType: 'private', chatId: '10002' })).error, 'GATEWAY_UNAVAILABLE')

  const failing = createQqActions({
    getConfig: () => ({ access: { ownerQQ: '10001' } }),
    gateway: { actions: { async sendLike() { throw new Error('风控') } } },
  })
  const result = await failing.like({ operatorId: '10001', chatType: 'private', chatId: '10002' })
  assert.equal(result.ok, false)
  assert.match(result.error, /风控/)
})

function adminHarness({ enabled = true, requireConfirm = true, maxText = 100, response = undefined, scope = { message_type: 'group', group_id: 20001 } } = {}) {
  const calls = [], audit = []
  const api = Object.fromEntries(['setProfile', 'setGroupCard', 'setGroupName', 'setGroupAdmin', 'setGroupBan', 'setGroupWholeBan', 'setGroupKick', 'setEssence', 'deleteMsg'].map((method) => [method, async (...args) => { calls.push([method, ...args]); if (response instanceof Error) throw response; return response }]))
  api.getMsg = async (id) => { calls.push(['getMsg', id]); return { data: scope } }
  const service = createQqActions({ gateway: { actions: api }, getConfig: () => ({ access: { ownerQQ: '10001' }, cognition: { qqAdmin: { enabled, requireConfirm, maxText } } }), logger: { info: (...args) => audit.push(args) } })
  return { service, calls, audit, api }
}
const adminContext = { operatorId: '10001', chatType: 'group', chatId: '20001' }

test('qq admin: fixed operations use current group, validate values, and retain unmute/off', async () => {
  const { service, calls } = adminHarness()
  const cases = [
    ['setGroupCard', { userId: '10002', card: '名片' }, ['20001', '10002', '名片']],
    ['setGroupName', { name: '新群名', groupId: '99999' }, ['20001', '新群名']],
    ['setGroupAdmin', { userId: '10002', enable: false }, ['20001', '10002', false]],
    ['setGroupBan', { userId: '10002', durationSeconds: 0 }, ['20001', '10002', 0]],
    ['setGroupWholeBan', { enable: true }, ['20001', true]],
    ['setGroupKick', { userId: '10002', confirmed: 'confirm' }, ['20001', '10002']],
    ['setEssence', { messageId: '-12' }, ['-12']],
    ['deleteMsg', { messageId: '-12', confirmed: 'confirm' }, ['-12']],
    ['setProfile', { chatType: 'private', chatId: '10001', nickname: '新昵称' }, [{ nickname: '新昵称' }]],
  ]
  for (const [method, args, expected] of cases) {
    assert.equal((await service[method]({ ...adminContext, ...args })).ok, true, method)
    assert.deepEqual(calls.at(-1), [method, ...expected])
  }
})

test('qq admin: owner/default-off/chat/validation/confirmation guards have no side effects', async () => {
  const { service, calls } = adminHarness({ maxText: 3 })
  const cases = [
    ['setGroupName', { operatorId: '10002', name: '群' }, 'NOT_OWNER'],
    ['setGroupName', { chatType: 'private', name: '群' }, 'GROUP_ONLY'],
    ['setProfile', { nickname: '名' }, 'OWNER_PRIVATE_ONLY'],
    ['setProfile', { chatType: 'private', chatId: '10002', nickname: '名' }, 'OWNER_PRIVATE_ONLY'],
    ['setGroupName', { chatId: 'x', name: '群' }, 'INVALID_CHAT'],
    ['setGroupName', { name: '太长的群名' }, 'INVALID_TEXT'],
    ['setGroupCard', { userId: 'x', card: '群' }, 'INVALID_USER_ID'],
    ['setGroupAdmin', { userId: '10002', enable: 'on' }, 'INVALID_ENABLE'],
    ['setGroupBan', { userId: '10002', durationSeconds: -1 }, 'INVALID_DURATION'],
    ['setGroupKick', { userId: '10002', confirmed: true }, 'CONFIRM_REQUIRED'],
    ['deleteMsg', { messageId: '12' }, 'CONFIRM_REQUIRED'],
    ['setEssence', { messageId: 'bad' }, 'INVALID_MESSAGE_ID'],
  ]
  for (const [method, args, error] of cases) assert.equal((await service[method]({ ...adminContext, ...args })).error, error, method)
  assert.equal(calls.length, 0)
  assert.equal((await adminHarness({ enabled: false }).service.setGroupName({ ...adminContext, name: '群' })).error, 'QQ_ADMIN_DISABLED')
  const defaultOff = createQqActions({ getConfig: () => ({ ownerQQ: '10001' }) })
  assert.equal((await defaultOff.setGroupName({ ...adminContext, name: '群' })).error, 'QQ_ADMIN_DISABLED')
  const optional = adminHarness({ requireConfirm: false })
  assert.equal((await optional.service.setGroupKick({ ...adminContext, userId: '10002' })).error, 'CONFIRM_REQUIRED')
  assert.equal((await optional.service.deleteMsg({ ...adminContext, messageId: '12' })).ok, true)
})

test('qq admin: message actions fail closed across chats, missing scope or unavailable query', async () => {
  for (const scope of [{}, { message_type: 'group', group_id: '99999' }, { message_type: 'private', user_id: '10001' }]) {
    const { service, calls } = adminHarness({ scope })
    for (const method of ['setEssence', 'deleteMsg']) assert.equal((await service[method]({ ...adminContext, messageId: '12', confirmed: 'confirm' })).error, 'MESSAGE_SCOPE_UNVERIFIED')
    assert.ok(calls.every(([method]) => method === 'getMsg'))
  }
  const { service, api, calls } = adminHarness()
  delete api.getMsg
  assert.equal((await service.deleteMsg({ ...adminContext, messageId: '12', confirmed: 'confirm' })).error, 'MESSAGE_SCOPE_UNVERIFIED')
  assert.equal(calls.length, 0)
  const privateChat = adminHarness({ scope: { message_type: 'private', sender: { user_id: 10001 } } })
  assert.equal((await privateChat.service.deleteMsg({ ...adminContext, chatType: 'private', chatId: '10001', messageId: '12', confirmed: 'confirm' })).ok, true)
})

test('qq admin: unsupported profile, gateway rejection and destructive audit contain no secrets', async () => {
  for (const response of [new Error('token=secret'), { status: 'failed', retcode: 1404 }]) {
    const { service, audit } = adminHarness({ response })
    assert.deepEqual(await service.setProfile({ ...adminContext, chatType: 'private', chatId: '10001', nickname: '名' }), { ok: false, error: 'UNSUPPORTED_SET_QQ_PROFILE' })
    assert.deepEqual(await service.setGroupKick({ ...adminContext, userId: '10002', confirmed: 'confirm' }), { ok: false, error: 'GATEWAY_REJECTED' })
    assert.match(JSON.stringify(audit), /setGroupKick/)
    assert.doesNotMatch(JSON.stringify(audit), /token|secret|nickname/)
  }
  const { service, api } = adminHarness()
  delete api.setProfile
  assert.equal((await service.setProfile({ ...adminContext, chatType: 'private', chatId: '10001', nickname: '名' })).error, 'UNSUPPORTED_SET_QQ_PROFILE')
})
