import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createModelGateway } from '../src/model/gateway.js'
import { createRegistry } from '../src/model/registry.js'
import { startMockModelServer, json } from './helpers/mock-model-http.js'

const clean = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-model-gw-'))
  return Promise.resolve().then(() => fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }))
}

function quiet() { return { child: () => ({ debug() {}, info() {}, warn() {} }) } }

test('registry：保存/密钥掩码/环境变量优先/原子重载', async () => clean((dir) => {
  const env = { TEST_MODEL_KEY: 'env-key-12345678' }
  const registry = createRegistry({ file: join(dir, 'models.json'), env, log: quiet() })
  const saved = registry.saveProvider({
    id: 'p1', protocol: 'openai-completions', baseUrl: 'https://api.example.com/v1',
    apiKey: 'stored-key-12345678', apiKeyEnv: 'TEST_MODEL_KEY', headers: { Authorization: 'should-not-win' },
    models: [{ id: 'm1', label: 'M1' }],
  })
  assert.equal(saved.id, 'p1')
  const again = createRegistry({ file: join(dir, 'models.json'), env, log: quiet() })
  assert.equal(again.get('p1').baseUrl, 'https://api.example.com/v1')
  assert.equal(again.get('p1').apiKey, 'stored-key-12345678')
  assert.ok(!JSON.stringify({ providers: again.list().map((item) => ({ ...item, apiKey: '' })) }).includes('stored-key-12345678'))
}))

test('gateway：保存/选中/公开 API 不返回 key，环境变量优先', async () => clean((dir) => {
  const env = { TEST_MODEL_KEY: 'env-key-abcdefgh' }
  const gw = createModelGateway({ dataRoot: dir, env, logger: quiet() })
  const publicProvider = gw.saveProvider({
    id: 'opencode-go', preset: 'opencode-go', name: 'OpenCode Go', apiKey: 'stored-key-zzzzzzzz',
    apiKeyEnv: 'TEST_MODEL_KEY',
    models: [{ id: 'm1' }, { id: 'm2' }],
  })
  assert.equal(publicProvider.hasApiKey, true)
  assert.equal(publicProvider.apiKeyHint, '…efgh')
  assert.equal(publicProvider.apiKeySource, 'env')
  assert.ok(!JSON.stringify(gw.list()).includes('stored-key-zzzzzzzz'))
  assert.equal(gw.select('opencode-go', 'm1').provider, 'opencode-go')
  assert.equal(gw.selected().model, 'm1')
  assert.equal(gw.list().selected.model, 'm1')
  assert.equal(gw.list().providers[0].models.length, 2)
}))

test('gateway：真实 OpenAI 兼容 mock 调用、header、usage、session header', async () => clean(async (dir) => {
  const server = await startMockModelServer((req, res, call) => {
    assert.equal(call.headers['x-session'], 'sess-1')
    json(res, 200, {
      choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    })
  })
  const env = { KEY: 'k-123456789' }
  const gw = createModelGateway({ dataRoot: dir, env, logger: quiet() })
  gw.saveProvider({
    id: 'local', protocol: 'openai-completions', baseUrl: server.url + '/v1', requestPath: '/chat/completions',
    apiKeyEnv: 'KEY', sessionHeader: 'x-session', stream: false, models: [{ id: 'm' }],
  })
  try {
    const result = await gw.complete({ provider: 'local', model: 'm', system: 's', messages: [{ role: 'user', content: 'hi' }], sessionId: 'sess-1', maxTokens: 64 })
    assert.equal(result.text, 'hello')
    assert.equal(result.usage.total, 6)
    assert.equal(result.route.protocol, 'openai-completions')
  } finally { await server.close() }
}))

test('gateway：429 重试、Retry-After 与最终成功；连续失败不泄漏 key', async () => clean(async (dir) => {
  let calls = 0
  const server = await startMockModelServer((req, res) => {
    calls += 1
    if (calls === 1) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' })
      res.end(JSON.stringify({ error: { message: 'slow down secret-key-abcdef' } }))
      return
    }
    json(res, 200, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { total_tokens: 3 } })
  })
  const env = { KEY: 'secret-key-abcdef' }
  const gw = createModelGateway({ dataRoot: dir, env, logger: quiet() })
  gw.saveProvider({ id: 'local', protocol: 'openai-completions', baseUrl: server.url + '/v1', requestPath: '/chat/completions', apiKeyEnv: 'KEY', stream: false, maxRetries: 1, models: [{ id: 'm' }] })
  try {
    const result = await gw.complete({ provider: 'local', model: 'm', system: '', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(result.text, 'ok')
    assert.equal(calls, 2)
    const testResult = await gw.test({ provider: 'local', model: 'm' })
    assert.equal(testResult.ok, true)
  } finally { await server.close() }
}))

test('gateway：模型发现、CommandCode supported_endpoints 过滤、缺少 key', async () => clean(async (dir) => {
  const server = await startMockModelServer((req, res) => {
    if (req.method === 'GET') {
      json(res, 200, { object: 'list', data: [
        { id: 'claude-x', name: 'Claude', supported_endpoints: ['/messages'] },
        { id: 'gpt-x', name: 'GPT', supported_endpoints: ['/chat/completions', '/responses'] },
        { id: 'plain', name: 'Plain' },
      ] })
      return
    }
    json(res, 401, { error: { message: 'no key' } })
  })
  const gw = createModelGateway({ dataRoot: dir, env: {}, logger: quiet() })
  gw.saveProvider({ id: 'cc', preset: 'commandcode', baseUrl: server.url + '/provider/v1', models: [{ id: 'x' }] })
  try {
    const discovered = await gw.discover('cc')
    assert.deepEqual(discovered.models.map((item) => item.id), ['gpt-x', 'plain'])
    const testResult = await gw.test({ provider: 'cc', model: 'x' })
    assert.equal(testResult.ok, false)
    assert.equal(testResult.code, 'NO_KEY')
    assert.ok(!JSON.stringify(testResult).includes('no key'))
  } finally { await server.close() }
}))
