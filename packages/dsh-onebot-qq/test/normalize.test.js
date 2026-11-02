// normalize.js 单元测试：OneBot v11 事件 → 内部规范化事件。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeEvent, parseMessage, unescapeCq, truncateRaw } from '../src/gateway/normalize.js'

const BASE = { time: 1700000000, self_id: 20000002 }

test('CQ 码字符串解析：文本/@/图片/引用 全都要，转义要还原', () => {
  const result = normalizeEvent({
    ...BASE,
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    group_id: 30001,
    user_id: 10001,
    message_id: 88,
    message_format: 'string',
    message: '[CQ:at,qq=10002,name=小明] 你好 &#91;x&#93; [CQ:image,file=a.jpg,url=https://x/a.jpg,summary=图片] [CQ:reply,id=42]',
    sender: { user_id: 10001, nickname: '阿明', card: '明', role: 'member' },
  }, { events: { rawMaxBytes: 16384 } })

  assert.equal(result.seqless, true)
  assert.equal(result.kind, 'message')
  assert.equal(result.postType, 'message')
  assert.equal(result.selfId, '20000002')
  assert.equal(result.time, 1700000000)
  assert.equal(result.message.chatType, 'group')
  assert.equal(result.message.chatId, '30001')
  assert.equal(result.message.id, 88)
  assert.equal(result.message.messageFormat, 'string')
  assert.equal(result.message.text, ' 你好 [x]  ')
  assert.deepEqual(result.message.mentions, [{ userId: '10002', name: '小明' }])
  assert.deepEqual(result.message.images, [{ url: 'https://x/a.jpg', file: 'a.jpg', summary: '图片' }])
  assert.equal(result.message.replyId, '42')
  assert.deepEqual(result.message.sender, { userId: '10001', nickname: '阿明', card: '明', role: 'member' })
  assert.deepEqual(result.message.segments.map((segment) => segment.type), ['at', 'text', 'image', 'text', 'reply'])
  assert.equal(result.message.rawMessage, '[CQ:at,qq=10002,name=小明] 你好 &#91;x&#93; [CQ:image,file=a.jpg,url=https://x/a.jpg,summary=图片] [CQ:reply,id=42]')
})

test('消息段数组透传：text/at/image 提取正确，未知段保留', () => {
  const event = normalizeEvent({
    ...BASE,
    post_type: 'message',
    message_type: 'private',
    user_id: 10003,
    message_id: 1,
    message_format: 'array',
    message: [
      { type: 'text', data: { text: '在吗' } },
      { type: 'at', data: { qq: 20000002, name: '' } },
      { type: 'face', data: { id: 178 } },
      { type: 'image', data: { file: 'b.png', url: 'https://x/b.png' } },
    ],
    sender: { user_id: 10003, nickname: '小明' },
  }, { events: { rawMaxBytes: 16384 } })

  assert.equal(event.message.chatType, 'private')
  assert.equal(event.message.chatId, '10003')
  assert.equal(event.message.text, '在吗')
  assert.deepEqual(event.message.mentions, [{ userId: '20000002', name: '' }])
  assert.deepEqual(event.message.images, [{ url: 'https://x/b.png', file: 'b.png', summary: '' }])
  assert.deepEqual(event.message.segments.map((segment) => segment.type), ['text', 'at', 'face', 'image'])
})

test('机器人自己发出的消息（message_sent）也被标成 message', () => {
  const event = normalizeEvent({
    ...BASE,
    post_type: 'message_sent',
    message_type: 'group',
    group_id: 30001,
    message_id: 2,
    message: 'hi',
    sender: { user_id: 20000002, nickname: '机器人' },
  })
  assert.equal(event.kind, 'message')
  assert.equal(event.message.postType, undefined)
  assert.equal(event.message.chatType, 'group')
})

test('缺失字段不伪造：sender 缺省为空串，message 缺失为空数组', () => {
  const event = normalizeEvent({
    post_type: 'message',
    message_type: 'private',
    user_id: 1,
    message_format: 'array',
    message: [],
    sender: {},
  })
  assert.equal(event.postType, 'message')
  assert.deepEqual(event.message.sender, { userId: '', nickname: '', card: '', role: '' })
  assert.deepEqual(event.message.segments, [])
  assert.equal(event.message.text, '')
  assert.equal(event.message.replyId, '')
  assert.equal(event.message.chatId, '1')
})

test('通知事件：撤回/戳一戳 的公共字段被规范出来', () => {
  const recall = normalizeEvent({
    ...BASE,
    post_type: 'notice',
    notice_type: 'friend_recall',
    user_id: 10001,
    message_id: 99,
  })
  assert.equal(recall.kind, 'notice')
  assert.deepEqual(recall.notice, { type: 'friend_recall', subType: '', userId: '10001', messageId: '99' })

  const poke = normalizeEvent({
    ...BASE,
    post_type: 'notice',
    notice_type: 'notify',
    sub_type: 'poke',
    user_id: 10001,
    target_id: 20000002,
    group_id: 30001,
  })
  assert.equal(poke.kind, 'notice')
  assert.equal(poke.subType, 'poke')
  assert.deepEqual(poke.notice, { type: 'notify', subType: 'poke', userId: '10001', groupId: '30001', targetId: '20000002' })

  const upload = normalizeEvent({
    ...BASE,
    post_type: 'notice',
    notice_type: 'group_upload',
    user_id: 10001,
    group_id: 30001,
    file: { id: 'f1', name: 'a.txt', size: 12 },
  })
  assert.deepEqual(upload.notice.file, { id: 'f1', name: 'a.txt', size: 12 })
})

test('请求事件与元事件', () => {
  const request = normalizeEvent({
    ...BASE,
    post_type: 'request',
    request_type: 'group',
    sub_type: 'add',
    user_id: 10005,
    group_id: 30001,
    comment: '想加群',
    flag: 'flag-1',
  })
  assert.equal(request.kind, 'request')
  assert.equal(request.subType, 'add')
  assert.deepEqual(request.request, {
    type: 'group', subType: 'add', userId: '10005', groupId: '30001', comment: '想加群', flag: 'flag-1',
  })

  const meta = normalizeEvent({
    ...BASE,
    post_type: 'meta_event',
    meta_event_type: 'heartbeat',
    status: { online: true, good: true },
    interval: 5000,
  })
  assert.equal(meta.kind, 'meta_event')
  assert.equal(meta.meta.type, 'heartbeat')
  assert.equal(meta.meta.interval, 5000)
  assert.deepEqual(meta.meta.status, { online: true, good: true })
})

test('无法识别的事件返回 null，不抛异常', () => {
  assert.equal(normalizeEvent(null), null)
  assert.equal(normalizeEvent('x'), null)
  assert.equal(normalizeEvent({ foo: 1 }), null)
  assert.equal(normalizeEvent({ post_type: 'unknown_type' }), null)
})

test('原始事件超限时被截断（rawMaxBytes）', () => {
  const event = normalizeEvent({
    ...BASE,
    post_type: 'message',
    message_type: 'private',
    user_id: 1,
    message_id: 3,
    message: 'x'.repeat(4000),
    sender: { user_id: 1 },
  }, { events: { rawMaxBytes: 1024 } })
  assert.equal(event.raw.__truncated, true)
  assert.ok(event.raw.bytes > 1024)
  assert.equal(typeof event.raw.preview, 'string')
  // 原始事件小的时候原样保留
  const small = normalizeEvent({ ...BASE, post_type: 'meta_event', meta_event_type: 'lifecycle' }, { events: { rawMaxBytes: 16384 } })
  assert.equal(small.raw.__truncated, undefined)
  assert.equal(small.raw.meta_event_type, 'lifecycle')
})

test('导出工具函数：unescapeCq / parseMessage / truncateRaw', () => {
  assert.equal(unescapeCq('a&#91;b&#93;&#44;&amp;'), 'a[b],&')
  assert.deepEqual(parseMessage('hi'), [{ type: 'text', data: { text: 'hi' } }])
  assert.deepEqual(parseMessage('[CQ:face,id=1]'), [{ type: 'face', data: { id: '1' } }])
  assert.deepEqual(parseMessage([], 'array'), [])
  assert.deepEqual(truncateRaw({ a: 1 }, 16384), { a: 1 })
  assert.equal(truncateRaw({ a: 'y'.repeat(2000) }, 512).__truncated, true)
})
