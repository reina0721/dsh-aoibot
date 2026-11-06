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
