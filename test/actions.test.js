// actions.js 单元测试：参数校验 + action 映射 + 消息段转换。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createActions, idParam, toSegments } from '../src/gateway/actions.js'

function createRecorder() {
  const calls = []
  const call = async (action, params, opts = {}) => {
    calls.push({ action, params, opts })
    return { message_id: calls.length }
  }
  return { calls, call }
}

test('idParam：数字串转 Number，超长/非数字保留字符串', () => {
  assert.equal(idParam('10001'), 10001)
  assert.equal(idParam(30001), 30001)
  assert.equal(idParam('abc'), 'abc')
  assert.equal(idParam(''), 0)
  assert.equal(idParam('9007199254740993'), '9007199254740993')
})

test('toSegments：字符串 → text 段；数组透传；非法输入抛错', () => {
  assert.deepEqual(toSegments('你好'), [{ type: 'text', data: { text: '你好' } }])
  assert.deepEqual(
    toSegments([{ type: 'at', data: { qq: '1' } }, { type: 'text', data: { text: 'hi' } }]),
    [{ type: 'at', data: { qq: '1' } }, { type: 'text', data: { text: 'hi' } }],
  )
  assert.throws(() => toSegments(''), /不能为空/)
  assert.throws(() => toSegments([]), /不能为空/)
  assert.throws(() => toSegments(12), /字符串或消息段数组/)
  assert.throws(() => toSegments([{ data: {} }]), /缺少 type/)
})

test('sendMessage：群聊/私聊走正确 action，id 转数字，字符串转消息段', async () => {
  const { calls, call } = createRecorder()
  const actions = createActions({ call })

  const groupResult = await actions.sendMessage({ chatType: 'group', chatId: '30001', message: 'hi' })
  assert.deepEqual(groupResult, { message_id: 1 })
  assert.equal(calls[0].action, 'send_group_msg')
  assert.deepEqual(calls[0].params, { group_id: 30001, message: [{ type: 'text', data: { text: 'hi' } }] })

  await actions.sendMessage({ chatType: 'private', chatId: 10001, message: [{ type: 'text', data: { text: 'yo' } }] })
  assert.equal(calls[1].action, 'send_private_msg')
  assert.deepEqual(calls[1].params, { user_id: 10001, message: [{ type: 'text', data: { text: 'yo' } }] })

  await assert.rejects(() => actions.sendMessage({ chatType: 'other', chatId: 1, message: 'x' }), /chatType/)
  await assert.rejects(() => actions.sendMessage({ chatType: 'group', chatId: '', message: 'x' }), /群号/)
  await assert.rejects(() => actions.sendMessage({ chatType: 'group', chatId: '1', message: '' }), /不能为空/)
})

test('sendPrivate / sendGroup 显式接口 + autoEscape 透传', async () => {
  const { calls, call } = createRecorder()
  const actions = createActions({ call })
  await actions.sendPrivate('10001', 'a', { autoEscape: true })
  await actions.sendGroup('30001', 'b')
  assert.deepEqual(calls[0].params, { user_id: 10001, message: [{ type: 'text', data: { text: 'a' } }], auto_escape: true })
  assert.deepEqual(calls[1].params, { group_id: 30001, message: [{ type: 'text', data: { text: 'b' } }] })
})

test('查询类 action：登录/好友/群/成员/撤回/消息/状态/版本', async () => {
  const { calls, call } = createRecorder()
  const actions = createActions({ call })
  await actions.getLoginInfo()
  await actions.getFriendList()
  await actions.getGroupList()
  await actions.getGroupMemberInfo('30001', '10001')
  await actions.deleteMsg('42')
  await actions.getMsg(42)
  await actions.getStatus()
  await actions.getVersionInfo()
  assert.deepEqual(calls.map((item) => item.action), [
    'get_login_info', 'get_friend_list', 'get_group_list', 'get_group_member_info',
    'delete_msg', 'get_msg', 'get_status', 'get_version_info',
  ])
  assert.deepEqual(calls[3].params, { group_id: 30001, user_id: 10001, no_cache: true })
  assert.deepEqual(calls[4].params, { message_id: 42 })
  assert.deepEqual(calls[5].params, { message_id: 42 })
})

test('raw 透传：校验 action 非空；opts 原样透传', async () => {
  const { calls, call } = createRecorder()
  const actions = createActions({ call })
  await actions.raw('set_group_ban', { group_id: 1, user_id: 2, duration: 60 }, { timeoutMs: 1234 })
  assert.equal(calls[0].action, 'set_group_ban')
  assert.deepEqual(calls[0].params, { group_id: 1, user_id: 2, duration: 60 })
  assert.deepEqual(calls[0].opts, { timeoutMs: 1234 })
  assert.throws(() => actions.raw('', {}), /action 不能为空/)
})

test('createActions 缺少 call 直接失败', () => {
  assert.throws(() => createActions({}), /需要 call/)
})

test('文件上传 actions 校验并映射 OneBot 参数', async () => {
  const calls = []
  const actions = createActions({ call: async (action, params) => { calls.push({ action, params }); return {} } })
  await actions.uploadGroupFile('123', '/tmp/a.txt', 'a.txt')
  await actions.uploadPrivateFile('456', '/tmp/b.txt', 'b.txt')
  assert.deepEqual(calls, [
    { action: 'upload_group_file', params: { group_id: 123, file: '/tmp/a.txt', name: 'a.txt' } },
    { action: 'upload_private_file', params: { user_id: 456, file: '/tmp/b.txt', name: 'b.txt' } },
  ])
  assert.throws(() => actions.uploadGroupFile('', '/tmp/a.txt', 'a.txt'), /群号 不能为空/)
})

test('admin actions: fixed OneBot names/params, boolean false and duration zero preserved', async () => {
  const { calls, call } = createRecorder()
  const api = createActions({ call })
  await api.setProfile({ nickname: '昵称' })
  await api.setGroupCard('20001', '10002', '名片')
  await api.setGroupName('20001', '群名')
  await api.setGroupAdmin('20001', '10002', false)
  await api.setGroupBan('20001', '10002', 0)
  await api.setGroupWholeBan('20001', true)
  await api.setGroupKick('20001', '10002')
  await api.setEssence('-123')
  await api.deleteMsg('-123')
  assert.deepEqual(calls.map(({ action, params }) => [action, params]), [
    ['set_qq_profile', { nickname: '昵称' }],
    ['set_group_card', { group_id: 20001, user_id: 10002, card: '名片' }],
    ['set_group_name', { group_id: 20001, group_name: '群名' }],
    ['set_group_admin', { group_id: 20001, user_id: 10002, enable: false }],
    ['set_group_ban', { group_id: 20001, user_id: 10002, duration: 0 }],
    ['set_group_whole_ban', { group_id: 20001, enable: true }],
    ['set_group_kick', { group_id: 20001, user_id: 10002, reject_add_request: false }],
    ['set_essence_msg', { message_id: -123 }], ['delete_msg', { message_id: -123 }],
  ])
  for (const invalid of ['abc', 0, -1, '9007199254740993']) assert.throws(() => api.setGroupName(invalid, '群名'), /ID/)
  assert.throws(() => api.setProfile({ nickname: 'x'.repeat(101) }), /100/)
  assert.throws(() => api.setGroupCard('1', '2', 'a\nb'), /控制字符/)
  assert.throws(() => api.setGroupAdmin('1', '2', 'false'), /boolean/)
  for (const duration of [-1, 1.5, 2592001, '0']) assert.throws(() => api.setGroupBan('1', '2', duration), /秒数/)
  for (const id of ['x', 0, 2147483648, -2147483649]) assert.throws(() => api.setEssence(id), /ID/)
  assert.equal(calls.length, 9)
})

test('request actions: fixed OneBot names/params preserve opaque flags, booleans and defaults', async () => {
  const { calls, call } = createRecorder()
  const api = createActions({ call })
  await api.setFriendAddRequest('opaque flag', true)
  await api.setFriendAddRequest('opaque flag', false, '备注')
  await api.setGroupAddRequest('group flag', 'invite', false, '拒绝原因')
  await api.setGroupAddRequest('group flag', 'add', true)
  assert.deepEqual(calls.map(({ action, params }) => [action, params]), [
    ['set_friend_add_request', { flag: 'opaque flag', approve: true, remark: '' }],
    ['set_friend_add_request', { flag: 'opaque flag', approve: false, remark: '备注' }],
    ['set_group_add_request', { flag: 'group flag', sub_type: 'invite', approve: false, reason: '拒绝原因' }],
    ['set_group_add_request', { flag: 'group flag', sub_type: 'add', approve: true, reason: '' }],
  ])
})

test('request actions: invalid flags, booleans, subtype and bounded optional text never call gateway', () => {
  const { calls, call } = createRecorder()
  const api = createActions({ call })
  for (const flag of ['', ' ', 'x'.repeat(257), 'bad\nflag', 'bad\x00flag', 'bad\x85flag', 123, null, {}]) {
    assert.throws(() => api.setFriendAddRequest(flag, true), /flag/)
    assert.throws(() => api.setGroupAddRequest(flag, 'add', false), /flag/)
  }
  for (const approve of [undefined, null, 0, 1, 'false', 'true']) {
    assert.throws(() => api.setFriendAddRequest('flag', approve), /boolean/)
    assert.throws(() => api.setGroupAddRequest('flag', 'add', approve), /boolean/)
  }
  for (const subType of ['', 'unknown', null]) assert.throws(() => api.setGroupAddRequest('flag', subType, true), /subType/)
  for (const text of ['x'.repeat(101), 'bad\ntext', 'bad\x85text', 123, null]) {
    assert.throws(() => api.setFriendAddRequest('flag', true, text), /remark/)
    assert.throws(() => api.setGroupAddRequest('flag', 'invite', false, text), /reason/)
  }
  assert.equal(calls.length, 0)
})
