// OpenAI Chat Completions 协议适配（也覆盖多数兼容网关）。
import { ModelError } from '../errors.js'
import { buildHeaders, openRequest, readSse, readTextLimited, textOfContent, usageOf } from '../http.js'
import { collectResult, finishOf, normalizedMessages, parseEventData, resultOf } from './common.js'

export const id = 'openai-completions'

function bodyOf({ provider, model, messages, system, maxTokens, temperature, stream }) {
  const body = {
    model,
    messages: normalizedMessages(system, messages).map((message) => ({ role: message.role, content: message.content })),
    stream: Boolean(stream),
  }
  const field = provider?.maxTokensField === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens'
  if (maxTokens) body[field] = Number(maxTokens)
  if (temperature != null) body.temperature = Number(temperature)
  if (provider?.reasoningEffort) body.reasoning_effort = provider.reasoningEffort
  if (provider?.extraBody && typeof provider.extraBody === 'object') Object.assign(body, provider.extraBody)
  if (stream && provider?.streamUsage !== false) body.stream_options = { include_usage: true }
  return body
}

function resultFromJson(json) {
  const choice = json?.choices?.[0] || {}
  const message = choice.message || {}
  return resultOf({
    text: textOfContent(message.content),
    reasoning: textOfContent(message.reasoning_content || message.reasoning),
    usage: usageOf(json?.usage),
    finish: finishOf(choice.finish_reason === 'length' ? 'max-tokens' : choice.finish_reason === 'tool_calls' ? 'tool-calls' : 'stop', choice.finish_reason),
  })
}

export async function complete(options) {
  if (options.provider?.stream === false) {
    const url = options.provider.baseUrl.replace(/\/+$/, '') + options.provider.requestPath
    const opened = await openRequest({
      url,
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
  const url = options.provider.baseUrl.replace(/\/+$/, '') + options.provider.requestPath
  const opened = await openRequest({
    url,
    headers: buildHeaders(options.provider, options.key, { stream: true, sessionId: options.sessionId }),
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
    let finish = null
    let usage = null
    for await (const item of readSse(opened.response)) {
      if (item.data === '[DONE]') break
      const parsed = parseEventData(item.data)
      if (parsed.done) continue
      if (parsed.error) throw new ModelError('PROTOCOL', parsed.error)
      const json = parsed.json
      if (json?.error) throw new ModelError('UPSTREAM', String(json.error.message || '上游返回错误').slice(0, 300))
      if (json?.usage) usage = json.usage
      const choice = json?.choices?.[0]
      if (!choice) continue
      const delta = choice.delta || {}
      const text = textOfContent(delta.content)
      const reasoning = textOfContent(delta.reasoning_content || delta.reasoning)
      if (text) yield { type: 'text-delta', text }
      if (reasoning) yield { type: 'reasoning-delta', text: reasoning }
      if (choice.finish_reason) finish = finishOf(choice.finish_reason === 'length' ? 'max-tokens' : choice.finish_reason === 'tool_calls' ? 'tool-calls' : 'stop', choice.finish_reason)
    }
    if (usage) yield { type: 'usage', usage: usageOf(usage) }
    yield { type: 'finish', reason: finish || finishOf('stop', '') }
  } finally {
    opened.cleanup()
  }
}

export function parseModelList(json) {
  return Array.isArray(json?.data) ? json.data.map((item) => ({
    id: String(item?.id || ''),
    label: String(item?.name || item?.display_name || item?.id || ''),
    contextWindow: Number(item?.context_window || item?.context_length || item?.contextWindow || 0) || null,
    maxOutputTokens: Number(item?.max_output_tokens || item?.maxOutputTokens || 0) || null,
    supportedEndpoints: Array.isArray(item?.supported_endpoints) ? item.supported_endpoints.map(String) : Array.isArray(item?.supportedEndpoints) ? item.supportedEndpoints.map(String) : [],
  })).filter((item) => item.id) : []
}
