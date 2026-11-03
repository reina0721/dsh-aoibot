// 真实厂商连通测试：只有显式设置 OPENCODE_GO_API_KEY 才运行；不打印 key。
// 运行：$env:OPENCODE_GO_API_KEY='...'; node --test test/model-live.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createModelGateway } from '../src/model/gateway.js'

const key = process.env.OPENCODE_GO_API_KEY || ''
const live = Boolean(key)

function withGateway(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-model-live-'))
  const gw = createModelGateway({ dataRoot: dir, env: process.env, logger: { child: () => ({ debug() {}, info() {}, warn() {} }) } })
  return Promise.resolve().then(() => fn(gw, dir)).finally(() => rmSync(dir, { recursive: true, force: true }))
}

test('OpenCode Go OpenAI：真实流式调用', { skip: !live, timeout: 90000 }, async () => {
  await withGateway(async (gw) => {
    gw.saveProvider({ id: 'opencode-openai', preset: 'opencode-go', name: 'OpenCode OpenAI', models: [{ id: 'deepseek-v4.1-flash' }] })
    const result = await gw.test({ provider: 'opencode-openai', model: 'deepseek-v4.1-flash' })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.ok(String(result.textPreview).length > 0)
    assert.equal(result.protocol, 'openai-completions')
  })
})

test('OpenCode Go OpenAI：非流式调用', { skip: !live, timeout: 90000 }, async () => {
  await withGateway(async (gw) => {
    gw.saveProvider({ id: 'opencode-openai-ns', preset: 'opencode-go', name: 'OpenCode OpenAI NS', stream: false, models: [{ id: 'deepseek-v4.1-flash' }] })
    const result = await gw.complete({ provider: 'opencode-openai-ns', model: 'deepseek-v4.1-flash', system: 'Return only OK.', messages: [{ role: 'user', content: 'Reply with exactly: OK' }], maxTokens: 64 })
    assert.ok(result.text.trim().length > 0)
    assert.equal(result.finish.kind, 'stop')
  })
})

test('OpenCode Go Anthropic：真实流式调用（x-api-key + session）', { skip: !live, timeout: 90000 }, async () => {
  await withGateway(async (gw) => {
    gw.saveProvider({ id: 'opencode-anthropic', preset: 'opencode-go-anthropic', name: 'OpenCode Anthropic', models: [{ id: 'qwen3.8-flash' }] })
    const result = await gw.test({ provider: 'opencode-anthropic', model: 'qwen3.8-flash' })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.protocol, 'anthropic-messages')
    assert.ok(String(result.textPreview).length > 0)
  })
})

test('OpenCode Go 模型发现', { skip: !live, timeout: 60000 }, async () => {
  await withGateway(async (gw) => {
    gw.saveProvider({ id: 'opencode-openai', preset: 'opencode-go', name: 'OpenCode OpenAI', models: [] })
    const found = await gw.discover('opencode-openai')
    assert.ok(found.models.length > 5)
    assert.ok(found.models.some((item) => item.id === 'deepseek-v4.1-flash'))
    assert.ok(!JSON.stringify(found).includes(key))
  })
})
