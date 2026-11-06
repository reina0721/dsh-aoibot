import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createTimelineService } from '../src/cognition/timeline.js'

function harness() {
  const turns = [
    { id: 't1', chatType: 'private', chatId: '10001', text: '私聊一', status: 'ready', startedAt: 1000 },
    { id: 't2', chatType: 'group', chatId: 'g1', text: '群聊一', status: 'ready', startedAt: 3000 },
  ]
  const memories = [
    { id: 'm1', type: 'episodic', scopeType: 'private', scopeId: '10001', content: '记忆一', summary: '记忆一', status: 'active', createdAt: 2000 },
    { id: 'm2', type: 'semantic', scopeType: 'group', scopeId: 'g1', content: '记忆二', summary: '记忆二', status: 'active', createdAt: 4000 },
  ]
  const decisions = [
    { id: 'd1', action: 'reply', chatType: 'private', chatId: '10001', reason: '自然回应', status: 'sent', createdAt: 1500 },
  ]
  const store = { list: (kind, options) => (kind === 'turn' ? turns.slice(0, options.limit) : []) }
  const scopedStore = {
    list: (kind, options) => (kind === 'memory' ? memories.slice(0, options.limit) : kind === 'decision' ? decisions.slice(0, options.limit) : []),
  }
  return { service: createTimelineService({ store, scopedStore, clock: { now: () => 5000 } }) }
}

test('timeline：合并轮次/记忆/决策并按时间倒序', () => {
  const { service } = harness()
  const rows = service.timeline({ limit: 10 })
  assert.deepEqual(rows.map((row) => row.type), ['memory', 'turn', 'memory', 'decision', 'turn'])
  assert.equal(rows[0].id, 'memory:m2')
  assert.equal(rows[1].id, 'turn:t2')
  assert.match(rows[1].title, /群聊轮次/)
})

test('timeline：before 分页、types 过滤、scope 过滤', () => {
  const { service } = harness()
  const before = service.timeline({ limit: 10, before: 3000 })
  assert.ok(before.every((row) => row.at < 3000))
  assert.deepEqual(before.map((row) => row.id), ['memory:m1', 'decision:d1', 'turn:t1'])

  const onlyMemory = service.timeline({ limit: 10, types: ['memory'] })
  assert.ok(onlyMemory.every((row) => row.type === 'memory'))

  const privateOnly = service.timeline({ limit: 10, scopeType: 'private', scopeId: '10001' })
  assert.ok(privateOnly.every((row) => row.scopeType === 'private' && row.scopeId === '10001'))
  assert.equal(privateOnly.length, 3)
})

test('timeline：空输入/未知类型安全降级', () => {
  const { service } = harness()
  assert.ok(Array.isArray(service.timeline({ types: ['nope'] })))
  assert.equal(service.timeline({ types: ['nope'] }).length, 0)
  assert.ok(service.stats().total > 0)
})
