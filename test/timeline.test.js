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

test('timeline：导入事件默认合并、event 过滤、标题/正文、时间分页和作用域', () => {
  const events = [
    { id: 'e1', at: 1000, text: 'global detail', scopeType: 'global', status: 'active' },
    { id: 'e2', at: 3000, text: 'private detail', title: '旧日回忆', scopeType: 'private', scopeId: '123' },
    { id: 'e3', at: 2000, text: 'group detail', scopeType: 'group', scopeId: '456' },
  ]
  const calls = []
  const service = createTimelineService({
    store: { list: () => [{ id: 't1', startedAt: 2500, text: 'turn' }] },
    scopedStore: { list: (kind) => { calls.push(kind); return kind === 'timeline_event' ? events : [] } },
  })
  assert.deepEqual(service.timeline().map((row) => row.id), ['event:e2', 'turn:t1', 'event:e3', 'event:e1'])
  const rows = service.timeline({ types: ['event'] })
  assert.equal(rows.length, 3)
  assert.deepEqual(rows[0], { id: 'event:e2', type: 'event', at: 3000, scopeType: 'private', scopeId: '123', title: '旧日回忆', detail: 'private detail', status: '' })
  assert.equal(rows[2].title, '回忆事件')
  assert.deepEqual(service.timeline({ types: ['event'], scopeType: 'private', scopeId: '123' }).map((row) => row.id), ['event:e2', 'event:e1'])
  assert.deepEqual(service.timeline({ types: ['event'], scopeType: 'group', scopeId: '456' }).map((row) => row.id), ['event:e3', 'event:e1'])
  assert.deepEqual(service.timeline({ types: ['event'], scopeType: 'private', scopeId: '999', before: 2000 }).map((row) => row.id), ['event:e1'])
  assert.equal(service.stats().byType.event, 3)
  calls.length = 0
  service.timeline({ types: ['memory', 'nope'] })
  assert.deepEqual(calls, ['memory'])
})
