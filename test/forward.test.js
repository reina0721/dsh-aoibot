import { test } from 'node:test'
import assert from 'node:assert/strict'

import { flattenForward, forwardIdsOf } from '../src/gateway/forward.js'
import { createActions } from '../src/gateway/actions.js'
import { normalizeEvent } from '../src/gateway/normalize.js'

test('flattenForward：常见 get_forward_msg 结构压平为发送者+文本', () => {
  const payload = {
    messages: [
      { sender: { nickname: '小明' }, content: [{ type: 'text', data: { text: '第一句' } }, { type: 'image', data: {} }] },
      { sender: { card: '群名片' }, content: '第二句' },
      { sender: { nickname: '小红' }, content: [{ type: 'at', data: { name: '小明' } }, { type: 'text', data: { text: ' 你好' } }, { type: 'face', data: {} }] },
    ],
  }
  const text = flattenForward(payload)
  assert.match(text, /小明：第一句\[图片\]/)
  assert.match(text, /群名片：第二句/)
  assert.match(text, /小红：@小明 你好\[表情\]/)
})

test('flattenForward：兼容 data.messages 与超长截断', () => {
  const long = '字'.repeat(5000)
  const payload = { data: { messages: [{ sender: { nickname: 'A' }, content: [{ type: 'text', data: { text: long } }] }] } }
  const text = flattenForward(payload, { maxChars: 300 })
  assert.equal(text.length, 301)
  assert.ok(text.endsWith('…'))
})

test('flattenForward：空/非法输入返回空串', () => {
  assert.equal(flattenForward(null), '')
  assert.equal(flattenForward({}), '')
  assert.equal(flattenForward({ messages: [] }), '')
})

test('forwardIdsOf：去重并忽略空 id', () => {
  assert.deepEqual(forwardIdsOf({ forwards: [{ id: 'a' }, { id: 'a' }, { id: '' }, {}] }), ['a'])
  assert.deepEqual(forwardIdsOf(null), [])
})

test('normalizeEvent：forward 段进入 message.forwards，不混进 text', () => {
  const normalized = normalizeEvent({
    post_type: 'message', message_type: 'private', self_id: 999, user_id: 10001,
    message_id: 1, message_format: 'array',
    message: [{ type: 'text', data: { text: '看这个' } }, { type: 'forward', data: { id: 'f1', title: '聊天记录' } }],
    sender: { user_id: 10001, nickname: 'A' },
  })
  assert.equal(normalized.kind, 'message')
  assert.equal(normalized.message.text, '看这个')
  assert.deepEqual(normalized.message.forwards, [{ id: 'f1', title: '聊天记录', summary: '' }])
})

test('actions.getForwardMsg：先 id 后 message_id 兼容两类网关', async () => {
  const calls = []
  const actions = createActions({
    call: async (action, params) => {
      calls.push({ action, params })
      if (calls.length === 1) throw new Error('id not supported')
      return { messages: [] }
    },
  })
  const result = await actions.getForwardMsg('12345')
  assert.deepEqual(result, { messages: [] })
  assert.deepEqual(calls[0].params, { id: '12345' })
  assert.deepEqual(calls[1].params, { message_id: 12345 })
})
