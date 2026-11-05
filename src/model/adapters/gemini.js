// Google Gemini 原生 generateContent / streamGenerateContent 协议。
import { ModelError } from '../errors.js'
import { buildHeaders, openRequest, readSse, readTextLimited, usageOf } from '../http.js'
import { collectResult, finishOf, normalizedMessages, parseEventData, resultOf } from './common.js'

export const id = 'gemini-generate-content'

function endpointOf(provider, model, stream) {
  const base = provider.baseUrl.replace(/\/+$/, '')
  const modelPath = String(model || '').split('/').map((part) => encodeURIComponent(part)).join('/')
  const suffix = `/models/${modelPath}:${stream ? 'streamGenerateContent' : 'generateContent'}`
  const path = provider.requestPath && provider.requestPath.includes('{model}')
    ? provider.requestPath.replace('{model}', modelPath).replace('{action}', stream ? 'streamGenerateContent' : 'generateContent')
    : provider.requestPath || suffix
  const url = base + (path.startsWith('/') ? path : '/' + path)
  return stream ? url + (url.includes('?') ? '&' : '?') + 'alt=sse' : url
}

function bodyOf({ model, system, messages, maxTokens, temperature, stream }) {
  const contents = normalizedMessages(system, messages)
    .filter((message) => message.role !== 'system')
    .map((message) => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] }))
  if (!contents.length) contents.push({ role: 'user', parts: [{ text: '' }] })
  const body = { contents }
  if (system) body.systemInstruction = { parts: [{ text: String(system) }] }
  const generationConfig = {}
  if (maxTokens) generationConfig.maxOutputTokens = Number(maxTokens)
  if (temperature != null) generationConfig.temperature = Number(temperature)
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig
  return body
}

function resultFromJson(json) {
  const candidate = json?.candidates?.[0] || {}
  const parts = candidate?.content?.parts || []
  let text = ''
  let reasoning = ''
  for (const part of parts) {
    if (part?.thought) reasoning += part.text || ''
    else text += part.text || ''
  }
  const finish = candidate?.finishReason
  return resultOf({
    text,
    reasoning,
    usage: usageOf(json?.usageMetadata),
    finish: finishOf(finish === 'MAX_TOKENS' ? 'max-tokens' : finish === 'STOP' ? 'stop' : finish === 'SAFETY' ? 'error' : 'stop', finish),
  })
}

export async function complete(options) {
  if (options.provider?.stream === false) {
    const opened = await openRequest({
      url: endpointOf(options.provider, options.model, false),
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
    url: endpointOf(options.provider, options.model, true),
    headers: buildHeaders(options.provider, options.key, { stream: true, sessionId: options.sessionId }),
    body: bodyOf({ ...options, stream: true }),
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  })
  const contentType = String(opened.response.headers?.get?.('content-type') || '')
  try {
    if (contentType.includes('application/json') && !contentType.includes('event-stream')) {
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
    let usage = null
    let finish = null
    for await (const item of readSse(opened.response)) {
      const parsed = parseEventData(item.data)
      if (parsed.done) continue
      if (parsed.error) throw new ModelError('PROTOCOL', parsed.error)
      const json = parsed.json
      if (json?.error) throw new ModelError('UPSTREAM', String(json.error.message || '上游返回错误').slice(0, 300))
      const candidate = json?.candidates?.[0]
      if (candidate) {
        for (const part of candidate.content?.parts || []) {
          if (part?.thought) yield { type: 'reasoning-delta', text: part.text || '' }
          else if (part?.text) yield { type: 'text-delta', text: part.text }
        }
        if (candidate.finishReason) finish = finishOf(candidate.finishReason === 'MAX_TOKENS' ? 'max-tokens' : candidate.finishReason === 'STOP' ? 'stop' : 'error', candidate.finishReason)
      }
      if (json?.usageMetadata) usage = json.usageMetadata
    }
    yield { type: 'usage', usage: usageOf(usage) }
    yield { type: 'finish', reason: finish || finishOf('stop', '') }
  } finally {
    opened.cleanup()
  }
}

export function parseModelList(json) {
  const list = Array.isArray(json?.models) ? json.models : Array.isArray(json?.data) ? json.data : []
  return list.map((item) => ({
    id: String(item?.name || item?.id || '').replace(/^models\//, ''),
    label: String(item?.displayName || item?.name || item?.id || ''),
    contextWindow: Number(item?.inputTokenLimit || 0) || null,
    maxOutputTokens: Number(item?.outputTokenLimit || 0) || null,
    supportedEndpoints: [],
  })).filter((item) => item.id)
}
