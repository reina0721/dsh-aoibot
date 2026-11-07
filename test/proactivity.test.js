import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProactivityService } from '../src/cognition/proactivity.js'

function harness({ delivery = null, outbound = null, dryRun = false } = {}) {
  const records = []
  const gatewayCalls = []
  const marked = []
  const service = createProactivityService({
    delivery, outbound,
    getConfig: () => ({ cognition: { enabled: true, dryRun, proactivity: { enabled: true, quietStart: 0, quietEnd: 0 } } }),
    clock: { now: () => 1_800_000_000_000 },
    store: {
      list: () => [],
      put(kind, id, value) { records.push({ kind, id, value }) },
    },
    relationships: { list: () => [{ personId: 'p1', scopeId: '10001', dimensions: { familiarity: 1 } }] },
    person: { detail: () => ({ person: { displayName: 'friend' } }) },
    memory: { retrieveAsync: async () => [] },
    persona: { get: () => ({}) }, emotion: { get: () => ({}) },
    llm: { complete: async () => ({ ok: true, text: 'hello' }) },
    gateway: { actions: { async sendMessage(intent) { gatewayCalls.push(intent); return { message_id: 'legacy' } } } },
    policy: { markSent(...args) { marked.push(args) } },
  })
  return { service, records, gatewayCalls, marked }
}

test('proactivity: delivery takes precedence, carries decision/dryRun and never retries rejection', async () => {
  for (const dryRun of [false, true]) {
    const calls = []
    let rejected = false
    const h = harness({ dryRun,
      delivery: { async deliver(intent) { calls.push(intent); return rejected ? { ok: false, error: 'ACCESS_DENIED', reason: 'not_allowed', blocked: true } : { ok: true, messageId: dryRun ? '' : 'd1', dryRun } } },
      outbound: { deliver() { assert.fail('injected delivery must handle send') } },
    })
    const result = await h.service.tick()
    assert.equal(result.ok, true)
    assert.deepEqual(calls, [{ chatType: 'private', chatId: '10001', segments: [{ type: 'text', data: { text: 'hello' } }], decisionId: result.decisionId, source: 'proactivity', dryRun: dryRun ? true : null }])
    const intent = h.records.find((item) => item.kind === 'proactive_intent').value
    assert.equal(intent.messageId, dryRun ? '' : 'd1')
    assert.equal(intent.dryRun, dryRun)
    rejected = true
    assert.deepEqual(await h.service.tick(), { ok: false, reason: 'not_allowed', blocked: true })
    assert.equal(calls.length, 2)
    assert.equal(h.records.filter((item) => item.kind === 'proactive_intent').length, 1)
    assert.deepEqual(h.gatewayCalls, [])
    assert.deepEqual(h.marked, [])
  }
})

test('proactivity: old outbound path and legacy gateway/dryRun remain available without injection', async () => {
  const calls = []
  const h = harness({ outbound: { async deliver(intent) { calls.push(intent); return { ok: true, messageId: 'o1' } } } })
  assert.equal((await h.service.tick()).ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].source, 'proactivity')
  assert.deepEqual(h.gatewayCalls, [])
  for (const dryRun of [false, true]) {
    const legacy = harness({ dryRun })
    assert.equal((await legacy.service.tick()).dryRun, dryRun)
    assert.equal(legacy.gatewayCalls.length, dryRun ? 0 : 1)
    assert.equal(legacy.marked.length, 1)
    assert.deepEqual(legacy.marked[0][1], { messageId: dryRun ? '' : 'legacy', dryRun })
  }
})
