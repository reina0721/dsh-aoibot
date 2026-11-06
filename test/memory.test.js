import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryService } from '../src/cognition/memory.js'
import { createEmbeddingService } from '../src/cognition/embeddings.js'
import { createStore } from '../src/cognition/store.js'
import { createPersonaScopedStore } from '../src/cognition/persona-scope.js'
import { normalizeConfig } from '../src/core/config.js'

function setup(t, { embedder = null, weight = 0.35, store: scoped = null, log } = {}) {
  const store = scoped || createStore({ file: ':memory:' })
  if (!scoped) t.after(() => store.close())
  const config = normalizeConfig({ cognition: { memory: { embedding: { weight } } } }).config
  const memory = createMemoryService({ store, getConfig: () => config, clock: { now: () => 1000000 }, embedder, log })
  return { store, memory, config }
}
const fake = (similarity) => ({ enabled: () => true, similarity })

test('memory: retrieveAsync reranks lexical candidates, preserves signals and reinforces only selection once', async (t) => {
  let inputs
  const { memory } = setup(t, { embedder: fake(async (query, texts) => { inputs = { query, texts }; return texts.map((text) => text === 'tea' ? 1 : -1) }) })
  const a = memory.remember('coffee'), b = memory.remember('tea')
  const lexical = memory.retrieve({ query: 'coffee', limit: 1 })
  assert.equal(lexical[0].memory.id, a.id)
  const before = memory.get(a.id).memory.accessCount
  const result = await memory.retrieveAsync({ query: 'coffee', limit: 1 })
  assert.equal(result[0].memory.id, b.id)
  assert.equal(result[0].signals.embedding, 1)
  assert.ok('relevance' in result[0].signals)
  assert.ok(Math.abs(result[0].score - (0.65 * memory.retrieve({ query: 'coffee', limit: 2 }).find((row) => row.memory.id === b.id).score + 0.35)) < 1e-10)
  assert.deepEqual(new Set(inputs.texts), new Set(['coffee', 'tea']))
  assert.equal(inputs.query, 'coffee')
  // The extra sync retrieval above increments both once.
  assert.equal(memory.get(a.id).memory.accessCount, before + 1)
  assert.equal(memory.get(b.id).memory.accessCount, 2)
})

test('memory: embedder failure falls back to identical sync scores with no duplicate writes or sensitive logs', async (t) => {
  const logs = []
  const { memory } = setup(t, { embedder: fake(async () => { throw new Error('secret-key private content') }), log: { debug: (...args) => logs.push(args) } })
  const a = memory.remember('coffee'), b = memory.remember('tea')
  const sync = memory.retrieve({ query: 'coffee', limit: 1 })
  const before = memory.get(a.id).memory
  const result = await memory.retrieveAsync({ query: 'coffee', limit: 1 })
  assert.deepEqual(result.map(({ memory, ...scores }) => ({ id: memory.id, ...scores })), sync.map(({ memory, ...scores }) => ({ id: memory.id, ...scores })))
  assert.equal(memory.get(a.id).memory.accessCount, before.accessCount + 1)
  assert.equal(memory.get(a.id).memory.version, before.version + 1)
  assert.equal(memory.get(b.id).memory.accessCount, 0)
  assert.equal(JSON.stringify(logs).includes('secret-key'), false)
  assert.equal(JSON.stringify(logs).includes('private content'), false)
})

test('memory: absent/disabled embedder, blank query, and empty candidates skip embedding', async (t) => {
  const calls = []
  const embedder = { enabled: () => false, similarity: async () => { calls.push(1); throw new Error('must not call') } }
  const { memory } = setup(t, { embedder })
  const a = memory.remember('coffee')
  assert.equal((await memory.retrieveAsync({ query: 'coffee' }))[0].memory.id, a.id)
  embedder.enabled = () => true
  await memory.retrieveAsync({ query: '   ' })
  memory.remove(a.id)
  assert.deepEqual(await memory.retrieveAsync({ query: 'coffee' }), [])
  assert.equal(calls.length, 0)
  const absent = setup(t)
  absent.memory.remember('coffee')
  assert.equal((await absent.memory.retrieveAsync({ query: 'coffee' })).length, 1)
})

test('memory: sync retrieve remains synchronous and never invokes enabled embedding', (t) => {
  const { memory } = setup(t, { embedder: fake(() => { throw new Error('must not call') }) })
  memory.remember('coffee')
  const result = memory.retrieve({ query: 'coffee' })
  assert.ok(Array.isArray(result))
  assert.equal(result[0].signals.embedding, undefined)
  assert.equal(memory.get(result[0].memory.id).memory.accessCount, 1)
})

test('memory: default embedding service yields zero fetches during async lexical retrieval', async (t) => {
  let fetches = 0
  const config = normalizeConfig({}).config
  const embedder = createEmbeddingService({ getConfig: () => config, fetchImpl: () => { fetches += 1; throw new Error('network forbidden') } })
  const { memory } = setup(t, { embedder })
  memory.remember('coffee')
  assert.equal((await memory.retrieveAsync({ query: 'coffee' })).length, 1)
  assert.equal(fetches, 0)
})

test('memory: lexical candidate expansion, batches of 31, requested limit and character budget', async (t) => {
  const batches = []
  const { memory } = setup(t, { embedder: fake(async (_, texts) => { batches.push(texts); return texts.map(() => 0.5) }) })
  for (let i = 0; i < 90; i += 1) memory.remember(`item-${i}`)
  const result = await memory.retrieveAsync({ query: 'item', limit: 30 })
  assert.equal(result.length, 30)
  assert.deepEqual(batches.map((batch) => batch.length), [31, 31, 28])
  assert.equal(memory.list({ limit: 100 }).filter((row) => row.accessCount === 1).length, 30)
  assert.equal(memory.list({ limit: 100 }).filter((row) => row.accessCount === 0).length, 60)
  batches.length = 0
  const small = await memory.retrieveAsync({ query: 'item', limit: 1 })
  assert.equal(small.length, 1)
  assert.deepEqual(batches.map((batch) => batch.length), [24])
  const budgeted = await memory.retrieveAsync({ query: 'item', limit: 10, maxChars: 13 })
  assert.ok(budgeted.length <= 10)
  assert.ok(budgeted.reduce((sum, row) => sum + row.memory.summary.length, 0) <= 13)
  assert.deepEqual(await memory.retrieveAsync({ query: 'item', maxChars: 1 }), [])
})

test('memory: malformed cosine results fall back, and weight clamps / defaults', async (t) => {
  const embedder = fake(async () => [NaN])
  const { memory, config } = setup(t, { embedder })
  const a = memory.remember('coffee')
  for (const scores of [[NaN], [], [Infinity], [2]]) {
    embedder.similarity = async () => scores
    assert.equal((await memory.retrieveAsync({ query: 'coffee' }))[0].signals.embedding, undefined)
  }
  assert.equal(memory.get(a.id).memory.accessCount, 4)
  embedder.similarity = async () => [1]
  const base = memory.retrieve({ query: 'coffee' })[0].score
  for (const [weight, expected] of [[2, 1], [-1, base], [undefined, 0.65 * base + 0.35], [NaN, 0.65 * base + 0.35]]) {
    config.cognition.memory.embedding.weight = weight
    assert.ok(Math.abs((await memory.retrieveAsync({ query: 'coffee' }))[0].score - expected) < 1e-12)
  }
})

test('memory: async candidates honor private scope and person filters', async (t) => {
  const textsSeen = []
  const { memory } = setup(t, { embedder: fake(async (_, texts) => { textsSeen.push(...texts); return texts.map(() => 1) }) })
  memory.remember('own', { scope: { scopeType: 'private', scopeId: '1' }, personId: 'p1' })
  memory.remember('other private', { scope: { scopeType: 'private', scopeId: '2' }, personId: 'p1' })
  memory.remember('other person', { scope: { scopeType: 'private', scopeId: '1' }, personId: 'p2' })
  const result = await memory.retrieveAsync({ query: 'query', personId: 'p1', scope: { scopeType: 'private', scopeId: '1' } })
  assert.deepEqual(textsSeen, ['own'])
  assert.equal(result.length, 1)
})

test('memory: switching persona while embedding awaits avoids cross-persona writeback', async (t) => {
  const base = createStore({ file: ':memory:' })
  t.after(() => base.close())
  let personaId = 'a', resolveScores
  const scoped = createPersonaScopedStore({ base, getPersonaId: () => personaId })
  const { memory } = setup(t, { store: scoped, embedder: fake(() => new Promise((resolve) => { resolveScores = resolve })) })
  const a = memory.remember('persona a')
  personaId = 'b'
  const b = memory.remember('persona b')
  personaId = 'a'
  const pending = memory.retrieveAsync({ query: 'persona' })
  personaId = 'b'
  resolveScores([1])
  const result = await pending
  assert.equal(result[0].memory.id, b.id)
  assert.equal(scoped.get('memory', a.id), null)
  assert.equal(memory.get(b.id).memory.accessCount, 1)
  personaId = 'a'
  assert.equal(memory.get(a.id).memory.accessCount, 0)
})

test('memory: deleting a candidate while embeddings await never resurrects it', async (t) => {
  let resolveScores
  const { memory } = setup(t, { embedder: fake(() => new Promise((resolve) => { resolveScores = resolve })) })
  const a = memory.remember('private memory')
  const pending = memory.retrieveAsync({ query: 'private' })
  memory.remove(a.id)
  resolveScores([1])
  assert.deepEqual(await pending, [])
  assert.equal(memory.get(a.id), null)
})

test('memory: overlapping retrievals preserve both access updates', async (t) => {
  const resolves = []
  const { memory } = setup(t, { embedder: fake(() => new Promise((resolve) => { resolves.push(resolve) })) })
  const a = memory.remember('coffee')
  const one = memory.retrieveAsync({ query: 'coffee' })
  const two = memory.retrieveAsync({ query: 'coffee' })
  resolves[0]([1])
  assert.equal((await one)[0].signals.embedding, 1)
  resolves[1]([1])
  assert.equal((await two)[0].signals.embedding, undefined)
  assert.equal(memory.get(a.id).memory.accessCount, 2)
  assert.equal(memory.get(a.id).memory.version, a.version + 2)
})
