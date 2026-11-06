import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEmbeddingService } from '../src/cognition/embeddings.js'

const envName = 'DSH_BOT_TEST_EMBEDDINGS_KEY'
const vector = (x = 1) => [x, 0, 0, 0, 0, 0, 0, 0]
const response = (vectors) => ({ ok: true, json: async () => ({ data: vectors.map((embedding, index) => ({ index, embedding })) }) })
function setup(t, { fetchImpl, embedding = {}, callMs = 1000, logger } = {}) {
  const previous = process.env[envName]
  process.env[envName] = 'private-test-key'
  t.after(() => { if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous })
  const config = { cognition: { memory: { embedding: { enabled: true, baseUrl: 'https://embedding.invalid/v1/', model: 'test-model', apiKeyEnv: envName, ...embedding } } }, timeouts: { callMs } }
  const requests = []
  const service = createEmbeddingService({ getConfig: () => config, logger, fetchImpl: async (...args) => {
    requests.push(args)
    return fetchImpl ? fetchImpl(...args) : response(JSON.parse(args[1].body).input.map(() => vector()))
  } })
  return { service, config, requests }
}

test('embeddings: default disabled and status never fetch; configured describes fields only', async (t) => {
  let calls = 0
  const service = createEmbeddingService({ getConfig: () => ({}), fetchImpl: () => { calls += 1; throw new Error('network forbidden') } })
  assert.equal(service.enabled(), false)
  assert.deepEqual(service.status(), { enabled: false, configured: false })
  await assert.rejects(service.embed(['hello']), /embeddings 已禁用/)
  assert.equal(calls, 0)
  const configured = setup(t)
  delete process.env[envName]
  assert.deepEqual(configured.service.status(), { enabled: true, configured: true })
  await assert.rejects(configured.service.embed(['hello']), /embeddings 未配置密钥/)
  assert.equal(configured.requests.length, 0)
})

test('embeddings: POST shape, Bearer env auth, configured endpoint, redirect policy and AbortSignal', async (t) => {
  const { service, requests } = setup(t)
  assert.deepEqual(await service.embed(['hello', '世界']), [vector(), vector()])
  const [url, request] = requests[0]
  assert.equal(url, 'https://embedding.invalid/v1/embeddings')
  assert.equal(request.method, 'POST')
  assert.equal(request.redirect, 'error')
  assert.equal(request.headers.Authorization, 'Bearer private-test-key')
  assert.equal(request.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(request.body), { model: 'test-model', input: ['hello', '世界'] })
  assert.ok(request.signal instanceof AbortSignal)
  assert.equal(request.signal.aborted, false)
})

test('embeddings: validate input before any fetch and allow 32 / 4000 Unicode characters', async (t) => {
  const { service, requests } = setup(t)
  for (const input of [null, [], [''], ['  '], [12], ['a'.repeat(4001)], Array(33).fill('a')]) {
    await assert.rejects(service.embed(input), /embeddings 输入不合法/)
  }
  assert.equal(requests.length, 0)
  await service.embed(Array.from({ length: 32 }, (_, i) => `${i}`))
  await service.embed(['😀'.repeat(4000)])
  assert.equal(requests.length, 2)
})

test('embeddings: reject unconfigured / arbitrary protocols / embedded credentials without fetch', async (t) => {
  const { service, config, requests } = setup(t)
  for (const baseUrl of ['', 'file:///tmp/test', 'ftp://example.invalid', 'https://user:secret@example.invalid/v1', 'https://example.invalid/v1?q=secret', 'https://example.invalid/#fragment']) {
    config.cognition.memory.embedding.baseUrl = baseUrl
    assert.equal(service.status().configured, false)
    await assert.rejects(service.embed(['hi']), /embeddings 未配置/)
  }
  assert.equal(requests.length, 0)
})

test('embeddings: timeout aborts fetch and covers response body reading', async (t) => {
  for (const bodyTimeout of [false, true]) {
    let signal
    const { service } = setup(t, { callMs: 10, fetchImpl: async (_, request) => {
      signal = request.signal
      if (bodyTimeout) return { ok: true, json: () => new Promise(() => {}) }
      return new Promise(() => {})
    } })
    await assert.rejects(service.embed(['secret text']), /^Error: embeddings 超时$/)
    assert.equal(signal.aborted, true)
  }
})

test('embeddings: HTTP and transport errors/logs never expose provider body, content or secrets', async (t) => {
  const logs = []
  const logger = { debug: (...args) => logs.push(args) }
  const secret = 'private-test-key sensitive memory'
  const { service, config } = setup(t, { logger, fetchImpl: async () => ({ ok: false, status: 401, json() { throw new Error(secret) } }) })
  await assert.rejects(service.embed(['sensitive memory']), /^Error: embeddings HTTP 401$/)
  const failing = setup(t, { logger, fetchImpl: async () => { throw new Error(secret) } })
  await assert.rejects(failing.service.embed(['sensitive memory']), /^Error: embeddings 请求失败$/)
  assert.equal(JSON.stringify(logs).includes('private-test-key'), false)
  assert.equal(JSON.stringify(logs).includes('sensitive memory'), false)
  assert.equal(JSON.stringify(service.status()).includes(process.env[config.cognition.memory.embedding.apiKeyEnv]), false)
})

for (const [name, payload] of [
  ['missing data', {}], ['wrong count', { data: [] }], ['null row', { data: [null] }],
  ['short dimension', { data: [{ embedding: Array(7).fill(1) }] }],
  ['long dimension', { data: [{ embedding: Array(4097).fill(1) }] }],
  ['non-finite', { data: [{ embedding: [Infinity, ...Array(7).fill(0)] }] }],
  ['NaN', { data: [{ embedding: [NaN, ...Array(7).fill(0)] }] }],
  ['string element', { data: [{ embedding: ['1', ...Array(7).fill(0)] }] }],
  ['bad index', { data: [{ index: 1, embedding: vector() }] }],
]) {
  test(`embeddings: malformed response (${name}) rejects without fake vectors`, async (t) => {
    const { service } = setup(t, { fetchImpl: async () => ({ ok: true, json: async () => payload }) })
    await assert.rejects(service.embed(['hello']), /^Error: embeddings 响应不合法$/)
  })
}

test('embeddings: mixed dimensions and duplicate indexes reject; standard indexes restore order', async (t) => {
  let payload = { data: [{ embedding: vector() }, { embedding: Array(9).fill(1) }] }
  const { service } = setup(t, { fetchImpl: async () => ({ ok: true, json: async () => payload }) })
  await assert.rejects(service.embed(['one', 'two']), /embeddings 响应不合法/)
  payload = { data: [{ index: 0, embedding: vector() }, { index: 0, embedding: vector(2) }] }
  await assert.rejects(service.embed(['one', 'two']), /embeddings 响应不合法/)
  payload = { data: [{ index: 1, embedding: vector(2) }, { index: 0, embedding: vector() }] }
  assert.deepEqual(await service.embed(['one', 'two']), [vector(), vector(2)])
})

test('embeddings: invalid JSON is a sanitized malformed response', async (t) => {
  const { service } = setup(t, { fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('sensitive body') } }) })
  await assert.rejects(service.embed(['hi']), /^Error: embeddings 响应不合法$/)
})

test('embeddings: cache hits, duplicate input, returned vector isolation, model and endpoint changes', async (t) => {
  const { service, requests, config } = setup(t)
  const vectors = await service.embed(['one', 'one'])
  assert.equal(JSON.parse(requests[0][1].body).input.length, 1)
  vectors[0][0] = 999
  assert.deepEqual(await service.embed(['one']), [vector()])
  assert.equal(requests.length, 1)
  await service.embed(['one', 'two'])
  assert.deepEqual(JSON.parse(requests[1][1].body).input, ['two'])
  config.cognition.memory.embedding.model = 'other-model'
  await service.embed(['one'])
  config.cognition.memory.embedding.baseUrl = 'https://other.invalid/v1'
  await service.embed(['one'])
  assert.equal(requests.length, 4)
})

test('embeddings: dimension change between cached and new vectors rejects', async (t) => {
  let dimension = 8
  const { service } = setup(t, { fetchImpl: async () => response([Array(dimension).fill(1)]) })
  await service.embed(['cached'])
  dimension = 9
  await assert.rejects(service.embed(['cached', 'new']), /embeddings 响应不合法/)
})

test('embeddings: LRU stays at 2000 and promotes cache hits', async (t) => {
  const { service, requests } = setup(t)
  for (let i = 0; i < 2000; i += 25) await service.embed(Array.from({ length: 25 }, (_, j) => `text-${i + j}`))
  await service.embed(['text-0']) // promote oldest
  await service.embed(['extra'])
  const count = requests.length
  await service.embed(['text-0'])
  assert.equal(requests.length, count)
  await service.embed(['text-1'])
  assert.equal(requests.length, count + 1)
})

test('embeddings: similarity uses one query+texts request, cosine, zero norms and large finite values', async (t) => {
  const v = [1, 1, 0, 0, 0, 0, 0, 0]
  const vectors = [vector(), vector(), vector(-1), [0, 1, 0, 0, 0, 0, 0, 0], Array(8).fill(0), v, vector(1e308)]
  const { service, requests } = setup(t, { fetchImpl: async () => response(vectors) })
  const scores = await service.similarity('query', ['same', 'opposite', 'orthogonal', 'zero', 'angle', 'large'])
  assert.deepEqual(scores.slice(0, 4), [1, -1, 0, 0])
  assert.ok(Math.abs(scores[4] - Math.SQRT1_2) < 1e-12)
  assert.equal(scores[5], 1)
  assert.equal(requests.length, 1)
  assert.deepEqual(JSON.parse(requests[0][1].body).input, ['query', 'same', 'opposite', 'orthogonal', 'zero', 'angle', 'large'])
  const zero = setup(t, { fetchImpl: async () => response([Array(8).fill(0), vector()]) })
  assert.deepEqual(await zero.service.similarity('zero query', ['same']), [0])
})
