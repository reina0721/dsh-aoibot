import { test } from 'node:test'
import assert from 'node:assert/strict'

import { startMockModelServer, json, sse, sseEvents, ndjson } from './helpers/mock-model-http.js'
import * as openai from '../src/model/adapters/openai-completions.js'
import * as anthropic from '../src/model/adapters/anthropic-messages.js'
import * as responses from '../src/model/adapters/openai-responses.js'
import * as gemini from '../src/model/adapters/gemini.js'
import * as ollama from '../src/model/adapters/ollama.js'

function provider(baseUrl, { protocol, requestPath, auth = { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' }, headers = {}, modelsPath = '/models', sessionHeader = '' } = {}) {
  return { id: 'p', protocol, baseUrl, requestPath, modelsPath, auth, headers, sessionHeader, stream: true, timeoutMs: 5000, maxRetries: 0 }
}

function options(p, model = 'test-model', extra = {}) {
  return { provider: p, key: 'test-key', model, system: 'system prompt', messages: [{ role: 'user', content: 'hi' }], maxTokens: 64, temperature: 0.2, stream: true, timeoutMs: 5000, fetchImpl: fetch, ...extra }
}

async function collect(iterable) {
  const events = []
  for await (const event of iterable) events.push(event)
  return events
}

test('openai-completions：请求体/认证/SSE 分块/usage/finish', async () => {
  let server
  server = await startMockModelServer((req, res, call) => {
    assert.equal(req.url, '/v1/chat/completions')
    assert.equal(call.headers.authorization, 'Bearer test-key')
    assert.equal(call.body.model, 'test-model')
    assert.equal(call.body.stream, true)
    assert.equal(call.body.max_tokens, 64)
    sse(res, [
      'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ])
  })
  try {
    const p = provider(server.url + '/v1', { protocol: 'openai-completions', requestPath: '/chat/completions' })
    const result = await openai.complete(options(p))
    assert.equal(result.text, '你好')
    assert.equal(result.reasoning, 'think')
    assert.equal(result.usage.total, 5)
    assert.equal(result.finish.kind, 'stop')
  } finally { await server.close() }
})

test('openai-completions：非流式 JSON 与数组 content', async () => {
  const server = await startMockModelServer((req, res) => json(res, 200, {
    choices: [{ message: { content: [{ type: 'text', text: 'OK' }] }, finish_reason: 'length' }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  }))
  try {
    const p = provider(server.url, { protocol: 'openai-completions', requestPath: '/chat/completions' })
    p.stream = false
    const result = await openai.complete(options(p))
    assert.equal(result.text, 'OK')
    assert.equal(result.finish.kind, 'max-tokens')
    assert.equal(result.usage.total, 3)
  } finally { await server.close() }
})

test('anthropic-messages：x-api-key、version、thinking 不作为可见文本、usage', async () => {
  const server = await startMockModelServer((req, res, call) => {
    assert.equal(call.headers['x-api-key'], 'test-key')
    assert.equal(call.headers['anthropic-version'], '2023-06-01')
    assert.equal(call.body.max_tokens, 64)
    assert.equal(call.body.system, 'system prompt')
    assert.deepEqual(call.body.messages, [{ role: 'user', content: 'hi' }])
    sse(res, sseEvents([
      { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 7, output_tokens: 0 } } } },
      { event: 'content_block_start', data: { type: 'content_block_start', content_block: { type: 'thinking', thinking: 'reason' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'ing' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'OK' } } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]))
  })
  try {
    const p = provider(server.url, { protocol: 'anthropic-messages', requestPath: '/v1/messages', auth: { type: 'x-api-key', header: 'x-api-key', prefix: '' }, headers: { 'anthropic-version': '2023-06-01' } })
    const result = await anthropic.complete(options(p))
    assert.equal(result.text, 'OK')
    assert.equal(result.reasoning, 'reasoning')
    assert.equal(result.usage.total, 9)
    assert.equal(result.finish.kind, 'stop')
  } finally { await server.close() }
})

test('openai-responses：input 内容与 response 事件', async () => {
  const server = await startMockModelServer((req, res, call) => {
    assert.equal(call.body.model, 'test-model')
    assert.equal(call.body.max_output_tokens, 64)
    assert.equal(call.body.stream, true)
    sse(res, [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"你"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"好"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":2,"output_tokens":2,"total_tokens":4}}}\n\n',
    ])
  })
  try {
    const p = provider(server.url, { protocol: 'openai-responses', requestPath: '/responses' })
    const result = await responses.complete(options(p))
    assert.equal(result.text, '你好')
    assert.equal(result.usage.total, 4)
  } finally { await server.close() }
})

test('gemini：路径/header/JSON 解析与 finish', async () => {
  const server = await startMockModelServer((req, res, call) => {
    assert.match(req.url, /\/v1beta\/models\/gemini-test:generateContent$/)
    assert.equal(call.headers['x-goog-api-key'], 'test-key')
    assert.equal(call.body.generationConfig.maxOutputTokens, 64)
    json(res, 200, {
      candidates: [{ content: { parts: [{ text: '你好' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
    })
  })
  try {
    const p = provider(server.url + '/v1beta', { protocol: 'gemini-generate-content', requestPath: '', auth: { type: 'header', header: 'x-goog-api-key', prefix: '' }, modelsPath: '/models' })
    p.stream = false
    const result = await gemini.complete(options(p, 'gemini-test'))
    assert.equal(result.text, '你好')
    assert.equal(result.usage.total, 5)
    assert.equal(result.finish.kind, 'stop')
  } finally { await server.close() }
})

test('ollama：NDJSON 流与 usage', async () => {
  const server = await startMockModelServer((req, res, call) => {
    assert.equal(req.url, '/api/chat')
    ndjson(res, [
      { message: { content: '你' }, done: false },
      { message: { content: '好' }, done: true, done_reason: 'stop', prompt_eval_count: 3, eval_count: 2 },
    ])
  })
  try {
    const p = provider(server.url, { protocol: 'ollama-chat', requestPath: '/api/chat', auth: { type: 'none', header: '', prefix: '' } })
    const result = await ollama.complete(options(p))
    assert.equal(result.text, '你好')
    assert.equal(result.usage.total, 5)
  } finally { await server.close() }
})

test('错误归一：401 不泄漏 key/header', async () => {
  const server = await startMockModelServer((req, res) => json(res, 401, { error: { message: 'bad key test-key' } }))
  try {
    const p = provider(server.url + '/v1', { protocol: 'openai-completions', requestPath: '/chat/completions' })
    let error = null
    try { await openai.complete(options(p)) } catch (caught) { error = caught }
    assert.ok(error)
    assert.equal(error.code, 'AUTH')
    assert.ok(!String(error.message).includes('test-key'))
  } finally { await server.close() }
})

test('错误归一：超时与重定向不跟随', async () => {
  const hanging = await startMockModelServer(() => {})
  try {
    const p = provider(hanging.url + '/v1', { protocol: 'openai-completions', requestPath: '/chat/completions' })
    p.timeoutMs = 1000
    let error = null
    try { await openai.complete(options(p)) } catch (caught) { error = caught }
    assert.ok(error)
    assert.equal(error.code, 'TIMEOUT')
  } finally { await hanging.close() }

  const redirect = await startMockModelServer((req, res) => {
    res.writeHead(302, { location: 'https://evil.example/steal' })
    res.end()
  })
  try {
    const p = provider(redirect.url + '/v1', { protocol: 'openai-completions', requestPath: '/chat/completions' })
    let error = null
    try { await openai.complete(options(p)) } catch (caught) { error = caught }
    assert.ok(error)
    assert.equal(error.code, 'CONFIG')
    assert.equal(redirect.calls.length, 1)
  } finally { await redirect.close() }
})
