import { test } from 'node:test'
import assert from 'node:assert/strict'

import { splitReply } from '../src/cognition/reply-split.js'

test('splitReply：短文本不切', () => {
  assert.deepEqual(splitReply('你好'), ['你好'])
  assert.deepEqual(splitReply(''), [])
  assert.deepEqual(splitReply('  '), [])
})

test('splitReply：优先按段落/换行切，内容不丢', () => {
  const text = '第一段内容。'.repeat(8) + '\n\n' + '第二段内容。'.repeat(8)
  const parts = splitReply(text, { maxChars: 80, maxParts: 3 })
  assert.ok(parts.length >= 2)
  assert.ok(parts.every((part) => part.length <= 100), JSON.stringify(parts.map((p) => p.length)))
  assert.equal(parts.join('').replace(/\s+/g, ''), text.replace(/\s+/g, ''))
})

test('splitReply：maxParts 上限内合并剩余内容', () => {
  const text = 'a'.repeat(1000)
  const parts = splitReply(text, { maxChars: 100, maxParts: 2 })
  assert.equal(parts.length, 2)
  assert.equal(parts.join('').length, 1000)
  assert.ok(parts[1].length > 100, '剩余内容并入最后一条，不截断')
})

test('splitReply：中文句末标点优先于硬切', () => {
  const text = '这是第一句话。'.repeat(10) + '这是最后一句。'
  const parts = splitReply(text, { maxChars: 40, maxParts: 4 })
  assert.ok(parts.length > 1)
  assert.ok(parts[0].endsWith('。'), parts[0])
})

test('splitReply：无标点时硬切且不产生空条', () => {
  const text = '字'.repeat(150)
  const parts = splitReply(text, { maxChars: 50, maxParts: 4 })
  assert.equal(parts.length, 3)
  assert.ok(parts.every((part) => part.length > 0))
  assert.equal(parts.join('').length, 150)
})
