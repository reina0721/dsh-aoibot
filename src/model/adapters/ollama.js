// Ollama 原生 /api/chat（NDJSON 流）。
import { ModelError } from '../errors.js'
import { buildHeaders, openRequest, readNdjson, readTextLimited, usageOf } from '../http.js'
import { collectResult, finishOf, normalizedMessages, resultOf } from './common.js'

export const id = 'ollama-chat'

function bodyOf({ model, system, messages, maxTokens, temperature, stream }) {
  const list = normalizedMessages(system, messages)
  const options = {}
  if (maxTokens) options.num_predict = Number(maxTokens)
  if (temperature != null) options.temperature = Number(temperature)
  const body = { model, messages: list.map((message) => ({ role: message.role, content: message.content })), stream: Boolean(stream) }
  if (system) body.system = String(system)
  if (Object.keys(options).length) body.options = options
  return body
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
      return resultOf({ text: json?.message?.content || '', usage: usageOf({ input_tokens: json?.prompt_eval_count, output_tokens: json?.eval_count }), finish: finishOf(json?.done ? 'stop' : 'stop', json?.done_reason) })
    } finally { opened.cleanup() }
  }
  return collectResult(stream(options))
}

export async function* stream(options) {
  const opened = await openRequest({
    url: options.provider.baseUrl.replace(/\/+$/, '') + options.provider.requestPath,
    headers: buildHeaders(options.provider, options.key, { stream: true, sessionId: options.sessionId }),
    body: bodyOf({ ...options, stream: true }),
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  })
  try {
    let input = 0
    let output = 0
    let finish = null
    for await (const json of readNdjson(opened.response)) {
      if (json?.error) throw new ModelError('UPSTREAM', String(json.error).slice(0, 300))
      if (json?.message?.content) yield { type: 'text-delta', text: json.message.content }
      if (json?.prompt_eval_count) input = Number(json.prompt_eval_count) || input
      if (json?.eval_count) output = Number(json.eval_count) || output
      if (json?.done) finish = finishOf('stop', json.done_reason)
    }
    yield { type: 'usage', usage: usageOf({ input_tokens: input, output_tokens: output }) }
    yield { type: 'finish', reason: finish || finishOf('stop', '') }
  } finally {
    opened.cleanup()
  }
}

export function parseModelList(json) {
  const list = Array.isArray(json?.models) ? json.models : []
  return list.map((item) => ({
    id: String(item?.name || item?.model || ''),
    label: String(item?.name || item?.model || ''),
    contextWindow: null,
    maxOutputTokens: null,
    supportedEndpoints: [],
  })).filter((item) => item.id)
}
