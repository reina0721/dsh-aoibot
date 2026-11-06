import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createPurposeService } from '../src/cognition/purpose.js'

function fakeStore() {
  const map = new Map()
  return {
    get(kind, id) { return map.get(`${kind}:${id}`) || null },
    put(kind, id, value) { map.set(`${kind}:${id}`, value) },
    remove(kind, id) { map.delete(`${kind}:${id}`) },
    list(kind, { limit = 500, where = null } = {}) {
      return [...map.entries()]
        .filter(([key]) => key.startsWith(`${kind}:`))
        .map(([, value]) => value)
        .filter((value) => (typeof where === 'function' ? where(value) : true))
        .slice(0, limit)
    },
  }
}

function harness(config = {}) {
  const store = fakeStore()
  let now = 1_700_000_000_000
  const service = createPurposeService({
    store,
    getConfig: () => ({ cognition: { purpose: { enabled: true, injectPrompt: true, promptLimit: 3, ...config } } }),
    clock: { now: () => now },
  })
  return { service, store, advance: (ms) => { now += ms } }
}

test('purpose：创建/校验/默认值', () => {
  const { service } = harness()
  assert.equal(service.create({ title: '' }), null)
  const goal = service.create({ title: '  学会做面包  ', priority: 2, steps: ['买面粉', { text: '揉面', done: true }] })
  assert.ok(goal.id.startsWith('goal_'))
  assert.equal(goal.title, '学会做面包')
  assert.equal(goal.priority, 1)
  assert.equal(goal.progress, 0.5)
  assert.equal(goal.scopeType, 'global')
  assert.equal(service.get(goal.id).title, '学会做面包')
})

test('purpose：更新进度/步骤/状态，进度满自动完成', () => {
  const { service } = harness()
  const goal = service.create({ title: '写周报', steps: ['列大纲', '写正文'] })
  const half = service.update(goal.id, { steps: [{ text: '列大纲', done: true }, { text: '写正文' }] })
  assert.equal(half.progress, 0.5)
  assert.equal(half.status, 'active')

  const done = service.update(goal.id, { progress: 1 })
  assert.equal(done.status, 'done')
  assert.ok(done.completedAt > 0)

  const resumed = service.resume(goal.id)
  assert.equal(resumed.status, 'active')
  assert.equal(resumed.completedAt, 0)
  assert.equal(service.pause(goal.id).status, 'paused')
  assert.equal(service.abandon(goal.id).status, 'abandoned')
  assert.equal(service.remove(goal.id), true)
  assert.equal(service.get(goal.id), null)
})

test('purpose：作用域隔离与 global 可见', () => {
  const { service } = harness()
  const a = service.create({ title: 'A 的私聊目的', scope: { scopeType: 'private', scopeId: '10001' } })
  const b = service.create({ title: 'B 的私聊目的', scope: { scopeType: 'private', scopeId: '10002' } })
  const global = service.create({ title: '全局目的' })
  const onlyA = service.list({ status: 'active', scopeType: 'private', scopeId: '10001' })
  assert.deepEqual(onlyA.map((item) => item.id), [a.id])
  const activeForA = service.activeFor({ scopeType: 'private', scopeId: '10001' })
  assert.ok(activeForA.some((item) => item.id === a.id))
  assert.ok(activeForA.some((item) => item.id === global.id))
  assert.ok(!activeForA.some((item) => item.id === b.id))
})

test('purpose：promptContext 限量、带进度与截止；可关闭注入', () => {
  const { service } = harness({ promptLimit: 2 })
  service.create({ title: '高优先', priority: 0.9, dueAt: Date.parse('2030-01-01T00:00:00Z') })
  service.create({ title: '中优先', priority: 0.5 })
  service.create({ title: '低优先', priority: 0.1 })
  const lines = service.promptContext({ scopeType: 'global', scopeId: '' })
  assert.equal(lines.length, 2)
  assert.match(lines[0], /高优先/)
  assert.match(lines[0], /截止 2030-01-01/)
  assert.match(lines[0], /进度 0%/)

  const off = createPurposeService({
    store: fakeStore(),
    getConfig: () => ({ cognition: { purpose: { enabled: true, injectPrompt: false } } }),
    clock: { now: () => 1 },
  })
  off.create({ title: '不注入' })
  assert.deepEqual(off.promptContext({}), [])
})

test('purpose：tick 按优先级/紧迫度/停滞度选择；stats 汇总', () => {
  const { service, advance } = harness()
  const low = service.create({ title: '低', priority: 0.2 })
  const high = service.create({ title: '高', priority: 0.9 })
  advance(8 * 86400000)
  const tick = service.tick({ scopeType: 'global', scopeId: '' })
  assert.equal(tick.purpose.id, high.id)
  assert.ok(tick.score > 0)
  assert.ok(tick.candidates.length >= 2)
  service.complete(low.id)
  const stats = service.stats()
  assert.equal(stats.total, 2)
  assert.equal(stats.active, 1)
  assert.equal(stats.byStatus.done, 1)
})
