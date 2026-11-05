import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createLlmClient } from '../src/cognition/llm.js'
import { dayKey } from '../src/cognition/util.js'

function fakeStore() {
  const map = new Map()
  return {
    get(kind, id) { return map.get(kind + ':' + id) || null },
    put(kind, id, value) { map.set(kind + ':' + id, value) },
  }
}

function modelStub(text = 'direct-ok', { calls = null, fail = false } = {}) {
  return {
    selected: () => ({ provider: 'p', model: 'm', resolved: true, available: true }),
    fallback: () => [],
    complete: async () => {
      if (calls) calls.push('direct')
      if (fail) throw Object.assign(new Error('直接失败'), { code: 'NETWORK' })
      return { text, usage: { total: 3 }, route: { provider: 'p', model: 'm', protocol: 'openai-completions' }, finish: { kind: 'stop' }, latencyMs: 1 }
    },
    list: () => ({ providers: [], selected: null }),
  }
}

function config(overrides = {}) {
  return {
    cognition: {
      enabled: true,
      llm: {
        mode: 'direct', fallbackToDsh: true, provider: '', model: '',
        temperature: 0.2, analysisMaxTokens: 300, composeMaxTokens: 300,
        timeoutMs: 1000, dailyTokenBudget: 100000, ...overrides,
      },
    },
  }
}

function fakeCtx({ dshError = false, calls = [] } = {}) {
  return {
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'dsh-p', model: 'dsh-m' }) }
      if (name === 'llm') {
        return {
          stream: async function* () {
            calls.push('dsh')
            if (dshError) {
              yield { type: 'finish', reason: { kind: 'error', failure: { message: 'no key' } } }
              return
            }
            yield { type: 'text-delta', text: 'dsh-ok' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      }
      return undefined
    },
  }
}

test('llm direct：直连模型结果、usage、JSON 解析', async () => {
  const calls = []
  const llm = createLlmClient({
    ctx: fakeCtx({ calls }), models: modelStub('{"intent":"greeting"}', { calls }),
    getConfig: () => config(), store: fakeStore(), clock: { now: () => 1000 }, log: { debug() {} },
  })
  const result = await llm.completeJson({ purpose: 'analysis' }, { system: 's', user: 'u' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.json, { intent: 'greeting' })
  assert.equal(result.route.provider, 'p')
  assert.equal(calls.filter((item) => item === 'direct').length, 1)
  assert.equal(calls.filter((item) => item === 'dsh').length, 0)
})

test('llm auto：DSH 失败回退直连', async () => {
  const calls = []
  const llm = createLlmClient({
    ctx: fakeCtx({ dshError: true, calls }), models: modelStub('fallback-ok', { calls }),
    getConfig: () => config({ mode: 'auto' }), store: fakeStore(), clock: { now: () => 1000 }, log: { debug() {} },
  })
  const result = await llm.complete({ system: 's', user: 'u' })
  assert.equal(result.ok, true)
  assert.equal(result.text, 'fallback-ok')
  assert.deepEqual(calls, ['dsh', 'direct'])
})

test('llm direct：禁止回退 DSH 时失败不调用 DSH', async () => {
  const calls = []
  const llm = createLlmClient({
    ctx: fakeCtx({ calls }), models: modelStub('', { calls }) && { ...modelStub('', { calls }), complete: async () => { calls.push('direct'); throw Object.assign(new Error('bad'), { code: 'EMPTY_OUTPUT' }) } },
    getConfig: () => config({ fallbackToDsh: false }), store: fakeStore(), clock: { now: () => 1000 }, log: { debug() {} },
  })
  const result = await llm.complete({ system: 's', user: 'u' })
  assert.equal(result.ok, false)
  assert.deepEqual(calls, ['direct'])
})

test('llm 空文本：不伪造、返回 degraded', async () => {
  const llm = createLlmClient({
    ctx: fakeCtx(), models: modelStub('   '),
    getConfig: () => config({ fallbackToDsh: false }), store: fakeStore(), clock: { now: () => 1000 }, log: { debug() {} },
  })
  const result = await llm.complete({ system: 's', user: 'u' })
  assert.equal(result.ok, false)
  assert.equal(result.degraded, true)
  assert.equal(result.error, 'EMPTY_OUTPUT')
})

test('llm 预算：记录 token，耗尽时报 BUDGET_EXHAUSTED', async () => {
  const store = fakeStore()
  const clock = { now: () => 1000 }
  store.put('llm_usage', dayKey(clock.now()), { tokens: 99999 })
  const llm = createLlmClient({
    ctx: fakeCtx(), models: modelStub('ok'), getConfig: () => config({ dailyTokenBudget: 1000 }),
    store, clock, log: { debug() {} },
  })
  const result = await llm.complete({ system: 's', user: 'u' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'BUDGET_EXHAUSTED')
})
