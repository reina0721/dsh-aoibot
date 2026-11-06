import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createLlmClient } from '../src/cognition/llm.js'
import { dayKey } from '../src/cognition/util.js'
import { createPersonaScopedStore } from '../src/cognition/persona-scope.js'

function fakeStore() {
  const map = new Map()
  return {
    get(kind, id) { return map.get(kind + ':' + id) || null },
    put(kind, id, value) { map.set(kind + ':' + id, value) },
    remove(kind, id) { return map.delete(kind + ':' + id) },
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

test('llm 按聊天覆盖：优先当前会话 provider/model，不影响其他会话', async () => {
  const calls = []
  const models = {
    selected: () => ({ provider: 'p', model: 'm', resolved: true, available: true }),
    fallback: () => [],
    list: () => ({ providers: [{ id: 'chat-p' }], selected: null }),
    complete: async (payload) => {
      calls.push({ provider: payload.provider, model: payload.model })
      return { text: 'chat-ok', usage: { total: 1 }, route: { provider: payload.provider, model: payload.model }, finish: { kind: 'stop' } }
    },
  }
  const cfg = {
    cognition: {
      enabled: true,
      llm: { mode: 'direct', fallbackToDsh: true, provider: '', model: '', analysisMaxTokens: 200, composeMaxTokens: 200, dailyTokenBudget: 100000 },
      modelRouting: { privateDefault: '', groupDefault: '', routes: ['10001=chat-p/chat-m'] },
    },
  }
  const llm = createLlmClient({
    ctx: fakeCtx(), models, getConfig: () => cfg, store: fakeStore(), clock: { now: () => 1000 }, log: { debug() {} },
  })
  const route = await llm.currentRoute({ chatType: 'private', chatId: '10001' })
  assert.equal(route.provider, 'chat-p')
  assert.equal(route.model, 'chat-m')
  assert.equal(route.source, 'chat')

  const result = await llm.complete({ system: 's', user: 'u', chat: { chatType: 'private', chatId: '10001' } })
  assert.equal(result.ok, true)
  assert.deepEqual(calls[0], { provider: 'chat-p', model: 'chat-m' })

  const other = await llm.complete({ system: 's', user: 'u', chat: { chatType: 'private', chatId: '10002' } })
  assert.equal(other.ok, true)
  assert.deepEqual(calls[1], { provider: 'p', model: 'm' })
})

for (const [budget, used, left, exhausted] of [[500, 120, 380, false], [500, 700, 0, true], [0, 0, 0, true], [-5, -10, 0, true], ['450', '50', 400, false], [undefined, 'invalid', 0, true]]) {
  test(`llm usageStatus: budget=${budget}, used=${used}`, () => {
    const store = fakeStore(), clock = { now: () => Date.parse('2026-11-06T23:59:59Z') }
    store.put('llm_usage', '2026-11-06', { tokens: used })
    const llm = createLlmClient({ getConfig: () => config({ dailyTokenBudget: budget }), store, clock })
    assert.deepEqual(llm.usageStatus(), { date: '2026-11-06', budget: Math.max(0, Number(budget) || 0), usageToday: Math.max(0, Number(used) || 0), budgetLeft: left, exhausted, personaScoped: true })
    assert.deepEqual(llm.usage(), llm.usageStatus())
    clock.now = () => Date.parse('2026-11-07T00:00:00Z')
    assert.equal(llm.usageStatus().usageToday, 0)
    assert.equal(llm.usageStatus().date, '2026-11-07')
  })
}

test('llm resetUsage: removes today only, is idempotent, preserves config and unblocks complete', async () => {
  const store = fakeStore(), clock = { now: () => Date.parse('2026-11-06T12:00:00Z') }, calls = []
  const cfg = config({ dailyTokenBudget: 500 }), before = structuredClone(cfg)
  store.put('llm_usage', '2026-11-06', { tokens: 700 })
  store.put('llm_usage', '2026-11-05', { tokens: 200 })
  const llm = createLlmClient({ ctx: fakeCtx({ calls }), models: modelStub('ok', { calls }), getConfig: () => cfg, store, clock })
  assert.equal((await llm.complete()).error, 'BUDGET_EXHAUSTED')
  assert.deepEqual(llm.resetUsage(), { reset: true, removed: true, date: '2026-11-06', budget: 500, usageToday: 0, budgetLeft: 500, exhausted: false, personaScoped: true })
  assert.equal(store.get('llm_usage', '2026-11-06'), null)
  assert.equal(store.get('llm_usage', '2026-11-05').tokens, 200)
  assert.equal(llm.resetUsage().removed, false)
  assert.deepEqual(calls, [], 'status/reset must not resolve a model or call a network')
  assert.deepEqual(cfg, before)
  assert.equal((await llm.complete()).ok, true)
  assert.equal(llm.usageStatus().usageToday, 3)
})

test('llm resetUsage: store without remove writes zero and zero budget stays exhausted', async () => {
  const store = fakeStore(), clock = { now: () => 1000 }
  delete store.remove
  store.put('llm_usage', dayKey(clock.now()), { tokens: 15 })
  const llm = createLlmClient({ getConfig: () => config({ dailyTokenBudget: 0 }), store, clock })
  for (let i = 0; i < 2; i++) {
    const result = llm.resetUsage()
    assert.equal(result.reset, true)
    assert.equal(result.removed, false)
    assert.equal(result.usageToday, 0)
    assert.equal(result.exhausted, true)
    assert.deepEqual(store.get('llm_usage', dayKey(clock.now())), { tokens: 0, updatedAt: 1000 })
  }
  assert.equal((await llm.complete()).error, 'BUDGET_EXHAUSTED')
})

test('llm usage: a pending completion stays charged to its starting persona after a switch', async () => {
  const base = fakeStore(), clock = { now: () => 1000 }
  let active = 'a', release, started
  const ready = new Promise((resolve) => { started = resolve })
  const pending = new Promise((resolve) => { release = resolve })
  const store = createPersonaScopedStore({ base, getPersonaId: () => active })
  const models = { ...modelStub(), complete: async () => { started(); await pending; return { text: 'ok', usage: { total: 3 } } } }
  const llm = createLlmClient({ models, getConfig: () => config(), store, clock })
  const completion = llm.complete()
  await ready
  active = 'b'
  store.put('llm_usage', dayKey(clock.now()), { tokens: 20 })
  release()
  assert.equal((await completion).ok, true)
  assert.equal(llm.usageStatus().usageToday, 20)
  llm.resetUsage()
  active = 'a'
  assert.equal(llm.usageStatus().usageToday, 3)
})
