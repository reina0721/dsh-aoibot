// OpenAI Responses 协议。
import { ModelError } from '../errors.js'
import { buildHeaders, openRequest, readSse, readTextLimited, textOfContent, usageOf } from '../http.js'
import { collectResult, finishOf, normalizedMessages, parseEventData, resultOf } from './common.js'

export const id = 'openai-responses'

function bodyOf({ model, system, messages, maxTokens, temperature, stream }) {
  const input = normalizedMessages(system, messages).map((message) => ({
    role: message.role,
    content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: message.content }],
  }))
  const body = { model, input, stream: Boolean(stream) }
  if (maxTokens) body.max_output_tokens = Number(maxTokens)
  if (temperature != null) body.temperature = Number(temperature)
  return body
}

function outputTextFromJson(json) {
  if (typeof json?.output_text === 'string') return json.output_text
  if (typeof json?.output?.text === 'string') return json.output.text
  let text = ''
  for (const item of Array.isArray(json?.output) ? json.output : []) {
    if (item?.type !== 'message') continue
    for (const content of Array.isArray(item.content) ? item.content : []) {
      if (content?.type === 'output_text' && content.text) text += content.text
      else if (content?.type === 'text' && content.text) text += content.text
    }
  }
  return text
}

function resultFromJson(json) {
  const status = json?.status
  return resultOf({
    text: outputTextFromJson(json),
    usage: usageOf(json?.usage),
    finish: finishOf(status === 'incomplete' ? 'max-tokens' : status === 'failed' ? 'error' : 'stop', status),
  })
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
  const opened = await openRequest({
    url: options.provider.baseUrl.replace(/\/+$/, '') + options.provider.requestPath,
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
      yield { type: 'usage', usage: result.usage }
      yield { type: 'finish', reason: result.finish }
      return
    }
    let text = ''
    let usage = { input: 0, output: 0, total: 0 }
    let finish = null
    for await (const item of readSse(opened.response)) {
      const parsed = parseEventData(item.data)
      if (parsed.done) continue
      if (parsed.error) throw new ModelError('PROTOCOL', parsed.error)
      const json = parsed.json
      if (json?.type === 'error') throw new ModelError('UPSTREAM', String(json?.error?.message || json?.message || '上游返回错误').slice(0, 300))
      if (json?.type === 'response.output_text.delta' && json.delta) {
        text += json.delta
        yield { type: 'text-delta', text: json.delta }
      } else if (json?.type === 'response.completed' || json?.type === 'response.incomplete') {
        const response = json.response || {}
        if (!text) {
          const output = outputTextFromJson(response)
          if (output) { text = output; yield { type: 'text-delta', text: output } }
        }
        usage = usageOf(response.usage)
        finish = finishOf(json.type === 'response.incomplete' ? 'max-tokens' : 'stop', response.status)
      } else if (json?.type === 'response.failed') {
        const failure = json.response?.error || json.error || {}
        throw new ModelError('UPSTREAM', String(failure.message || '模型响应失败').slice(0, 300))
      }
    }
    yield { type: 'usage', usage }
    yield { type: 'finish', reason: finish || finishOf('stop', '') }
  } finally {
    opened.cleanup()
  }
}

export function parseModelList(json) {
  return Array.isArray(json?.data) ? json.data.map((item) => ({
    id: String(item?.id || ''),
    label: String(item?.name || item?.id || ''),
    contextWindow: Number(item?.context_window || item?.contextWindow || 0) || null,
    maxOutputTokens: Number(item?.max_output_tokens || 0) || null,
    supportedEndpoints: [],
  })).filter((item) => item.id) : []
}
