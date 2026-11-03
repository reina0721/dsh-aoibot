// DSH 一次性调用形状：system 顶层、messages 只含 user input、错误详情保留。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createLlmClient } from '../src/cognition/llm.js'

function makeStore() {
  const data = new Map()
  return {
    get(kind, id) { return data.get(kind + ':' + id) || null },
    put(kind, id, value) { data.set(kind + ':' + id, value) },
    get data() { return data },
  }
}

function makeClient(streamFactory) {
  const calls = []
  const llm = {
    async *stream(options) { calls.push(options); yield* streamFactory(options) },
    async listProviders() { return [{ id: 'fake-provider' }] },
    async listModels() { return [{ id: 'fake-model' }] },
  }
  const ctx = {
    get(key) {
      if (key === 'llm') return llm
      if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }
      return undefined
    },
  }
  const client = createLlmClient({
    ctx,
    getConfig: () => ({ cognition: { llm: { mode: 'dsh', dailyTokenBudget: 10000 } } }),
    store: makeStore(),
    clock: { now: () => 1000 },
    log: { debug() {}, warn() {} },
  })
  return { client, calls }
}

test('DSH one-shot uses top-level system and identity-free user messages', async () => {
  const { client, calls } = makeClient(() => (async function* () {
    yield { type: 'text-delta', index: 0, text: 'OK' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })())
  const result = await client.complete({ system: 'SYSTEM-RULES', user: 'USER-INPUT', maxTokens: 64 })
  assert.equal(result.ok, true)
  assert.equal(result.text, 'OK')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].system, 'SYSTEM-RULES')
  assert.equal(calls[0].messages.length, 1)
  assert.equal(calls[0].messages[0].role, 'user')
  assert.equal(calls[0].messages[0].content[0].text, 'USER-INPUT')
  assert.equal(calls[0].temperature, undefined, 'DSH 默认不发送 temperature')
})

test('DSH provider failure keeps failure message and exposes lastFailure', async () => {
  const { client } = makeClient(() => (async function* () {
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: '401 invalid api key for provider', code: 'AUTH' },
      },
    }
  })())
  const result = await client.complete({ system: 'S', user: 'U' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'LLM_PROVIDER_ERROR')
  assert.match(result.message, /401/)
  const status = await client.status()
  assert.equal(status.lastFailure.error, 'LLM_PROVIDER_ERROR')
  assert.match(status.lastFailure.message, /401/)

  const probe = await client.test({ system: 'S', user: 'U' })
  assert.equal(probe.ok, false)
  assert.match(probe.message, /401/)
  assert.ok(Array.isArray(probe.attempts) && probe.attempts.length >= 1)
})
