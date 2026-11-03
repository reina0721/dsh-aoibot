// Anthropic Messages 协议（官方与兼容网关；OpenCode Go Anthropic 也走这里）。
import { ModelError } from '../errors.js'
import { buildHeaders, openRequest, readSse, readTextLimited, textOfContent, usageOf } from '../http.js'
import { collectResult, finishOf, normalizedMessages, parseEventData, resultOf } from './common.js'

export const id = 'anthropic-messages'

function bodyOf({ model, system, messages, maxTokens, temperature, stream }) {
  const list = normalizedMessages(system, messages).filter((message) => message.role !== 'system')
  if (!list.length) list.push({ role: 'user', content: '' })
  const body = {
    model,
    max_tokens: Number(maxTokens) || 1024,
    messages: list.map((message) => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content })),
    stream: Boolean(stream),
  }
  if (system) body.system = String(system)
  if (temperature != null) body.temperature = Number(temperature)
  return body
}

function resultFromJson(json) {
  let text = ''
  let reasoning = ''
  for (const block of Array.isArray(json?.content) ? json.content : []) {
    if (block?.type === 'text') text += block.text || ''
    else if (block?.type === 'thinking') reasoning += block.thinking || ''
  }
  const stop = json?.stop_reason
  return resultOf({
    text,
    reasoning,
    usage: usageOf(json?.usage),
    finish: finishOf(stop === 'max_tokens' ? 'max-tokens' : stop === 'tool_use' ? 'tool-calls' : 'stop', stop),
  })
}

function stopKind(stop) {
  if (stop === 'max_tokens') return 'max-tokens'
  if (stop === 'tool_use') return 'tool-calls'
  return 'stop'
}

export async function complete(options) {
  if (options.provider?.stream === false) {
    const opened = await openRequest({
      url: options.provider.baseUrl.replace(/\/+$/, '') + options.provider.requestPath,
      headers: buildHeaders(options.provider, options.key, { stream: false, sessionId: options.sessionId }),
      body: bodyOf({ ...options, stream: false }),
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    })
    try {
      const text = await readTextLimited(opened.response, options.maxBytes || 4 * 1024 * 1024)
      let json
      try { json = JSON.parse(text) } catch (error) { throw new ModelError('PROTOCOL', '模型响应不是合法 JSON') }
      return resultFromJson(json)
    } finally { opened.cleanup() }
  }
  return collectResult(stream(options))
}

export async function* stream(options) {
  const headers = buildHeaders(options.provider, options.key, { stream: true, sessionId: options.sessionId })
  if (!Object.keys(headers).some((name) => name.toLowerCase() === 'anthropic-version')) headers['anthropic-version'] = '2023-06-01'
  const opened = await openRequest({
    url: options.provider.baseUrl.replace(/\/+$/, '') + options.provider.requestPath,
    headers,
    body: bodyOf({ ...options, stream: true }),
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  })
  const contentType = String(opened.response.headers?.get?.('content-type') || '')
  try {
    if (contentType.includes('application/json')) {
      const text = await readTextLimited(opened.response, options.maxBytes || 4 * 1024 * 1024)
      let json
      try { json = JSON.parse(text) } catch (error) { throw new ModelError('PROTOCOL', '模型响应不是合法 JSON') }
      const result = resultFromJson(json)
      if (result.text) yield { type: 'text-delta', text: result.text }
      if (result.reasoning) yield { type: 'reasoning-delta', text: result.reasoning }
      yield { type: 'usage', usage: result.usage }
      yield { type: 'finish', reason: result.finish }
      return
    }
    let stop = ''
    let usage = { input: 0, output: 0, total: 0 }
    let finished = false
    for await (const item of readSse(opened.response)) {
      const parsed = parseEventData(item.data)
      if (parsed.done) continue
      if (parsed.error) throw new ModelError('PROTOCOL', parsed.error)
      const json = parsed.json
      if (json?.type === 'error') throw new ModelError('UPSTREAM', String(json?.error?.message || '上游返回错误').slice(0, 300))
      if (json?.type === 'message_start' && json.message?.usage) usage = usageOf(json.message.usage)
      else if (json?.type === 'content_block_start') {
        const block = json.content_block || {}
        if (block.type === 'text' && block.text) yield { type: 'text-delta', text: block.text }
        if (block.type === 'thinking' && block.thinking) yield { type: 'reasoning-delta', text: block.thinking }
      } else if (json?.type === 'content_block_delta') {
        const delta = json.delta || {}
        if (delta.type === 'text_delta' && delta.text) yield { type: 'text-delta', text: delta.text }
        else if (delta.type === 'thinking_delta' && delta.thinking) yield { type: 'reasoning-delta', text: delta.thinking }
      } else if (json?.type === 'message_delta') {
        if (json.delta?.stop_reason) stop = json.delta.stop_reason
        if (json.usage) {
          const next = usageOf(json.usage)
          usage.output = Math.max(usage.output, next.output)
          usage.input = Math.max(usage.input, next.input)
          usage.total = usage.input + usage.output
        }
      } else if (json?.type === 'message_stop') {
        finished = true
      }
    }
    yield { type: 'usage', usage }
    yield { type: 'finish', reason: finishOf(finished ? stopKind(stop) : 'stop', stop) }
  } finally {
    opened.cleanup()
  }
}

export function parseModelList(json) {
  return Array.isArray(json?.data) ? json.data.map((item) => ({
    id: String(item?.id || ''),
    label: String(item?.display_name || item?.name || item?.id || ''),
    contextWindow: Number(item?.context_window || item?.contextWindow || 0) || null,
    maxOutputTokens: Number(item?.max_output_tokens || item?.maxOutputTokens || 0) || null,
    supportedEndpoints: Array.isArray(item?.supported_endpoints) ? item.supported_endpoints.map(String) : Array.isArray(item?.supportedEndpoints) ? item.supportedEndpoints.map(String) : [],
  })).filter((item) => item.id) : []
}
