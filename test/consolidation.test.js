import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createConsolidationService } from '../src/cognition/consolidation.js'

function fakeMemory({ episodes = [], reflect = true } = {}) {
  const remembered = []
  const consolidated = []
  let semantic = []
  return {
    remembered,
    consolidated,
    setSemantic(rows) { semantic = rows },
    consolidateAll({ force = false } = {}) {
      consolidated.push({ force })
      return force ? [{ id: 'sem-1' }] : [{ id: 'sem-1' }]
    },
    list({ type = '', limit = 50 } = {}) {
      if (type === 'episodic') return episodes.slice(0, limit)
      if (type === 'semantic') return semantic.slice(0, limit)
      return []
    },
    remember(text, options) {
      remembered.push({ text, options })
      return { id: `mem-${remembered.length}`, ...options, content: text }
    },
  }
}

function episode(scopeId, index) {
  return {
    id: `e${scopeId}-${index}`,
    type: 'episodic',
    status: 'active',
    scopeType: 'private',
    scopeId,
    personId: 'p1',
    content: `记忆 ${scopeId}-${index}`,
    summary: `记忆 ${scopeId}-${index}`,
    source: 'turn',
  }
}

function config(extra = {}) {
  return { cognition: { consolidation: { enabled: true, hour: 4, reflect: true, reflectMinEpisodes: 3, ...extra } } }
}

test('consolidation：按作用域巩固并生成阶段小结，scope 不串', async () => {
  const episodes = [...Array.from({ length: 6 }, (_, i) => episode('10001', i)), ...Array.from({ length: 5 }, (_, i) => episode('10002', i))]
  const memory = fakeMemory({ episodes })
  const llm = {
    calls: [],
    async completeJson(spec, prompt) {
      this.calls.push({ spec, prompt })
      return { ok: true, json: { summary: `阶段小结-${this.calls.length}`, themes: ['日常'] } }
    },
  }
  const scheduler = { jobs: [], setTimeout(fn, ms) { this.jobs.push({ fn, ms }); return 't1' }, clearTimeout() {} }
  const service = createConsolidationService({ memory, llm, getConfig: () => config(), clock: { now: () => Date.parse('2026-01-01T12:00:00Z') }, scheduler })
  const result = await service.runOnce()
  assert.equal(result.ok, true)
  assert.equal(result.consolidated, 1)
  assert.equal(result.reflected, 2, '两个作用域各反思一次')
  assert.equal(memory.remembered.length, 2)
  const scopes = memory.remembered.map((item) => `${item.options.scope.scopeType}:${item.options.scope.scopeId}`)
  assert.deepEqual(scopes.sort(), ['private:10001', 'private:10002'])
  assert.ok(memory.remembered.every((item) => item.options.source === 'reflection' && item.options.type === 'semantic'))
  assert.equal(llm.calls.length, 2)
  // 每日 4 点调度：从 12 点算到次日 4 点 = 16h
  assert.equal(scheduler.jobs.length, 1)
  assert.equal(scheduler.jobs[0].ms, 16 * 60 * 60 * 1000)
  service.dispose()
})

test('consolidation：禁用时跳过；显式 force 仍可手动整理', async () => {
  const memory = fakeMemory({ episodes: [] })
  const service = createConsolidationService({ memory, llm: null, getConfig: () => config({ enabled: false }), clock: { now: () => 1 }, scheduler: null })
  assert.equal((await service.runOnce()).skipped, true)
  assert.equal((await service.runOnce({ force: true })).ok, true)
  service.dispose()
})

test('consolidation：条数不足不反思；LLM 失败不写记忆', async () => {
  const memory = fakeMemory({ episodes: [episode('10001', 0), episode('10001', 1)] })
  const llm = { async completeJson() { return { ok: false, error: 'BUDGET_EXHAUSTED' } } }
  const service = createConsolidationService({ memory, llm, getConfig: () => config({ reflectMinEpisodes: 5 }), clock: { now: () => 1 }, scheduler: null })
  const result = await service.runOnce()
  assert.equal(result.reflected, 0)
  assert.equal(memory.remembered.length, 0)
  service.dispose()
})

test('consolidation：status 反映开关/上次运行/调度', async () => {
  const memory = fakeMemory({ episodes: [] })
  const service = createConsolidationService({ memory, llm: null, getConfig: () => config({ reflect: false }), clock: { now: () => 1 }, scheduler: null })
  const before = service.status()
  assert.equal(before.enabled, true)
  assert.equal(before.reflect, false)
  await service.runOnce()
  const after = service.status()
  assert.equal(after.runs, 1)
  assert.ok(after.lastRunAt > 0)
  service.dispose()
})
