// 模型 HTTP 基础：URL 拼接、认证头、受限读取、SSE/NDJSON 解析。
// 不打印 header/body；错误只携带状态码与脱敏后的短消息。
import { ModelError, errorFromStatus, normalizeModelError } from './errors.js'

export function joinUrl(base, path) {
  const left = String(base || '').replace(/\/+$/, '')
  const right = String(path || '')
  if (!left) throw new ModelError('CONFIG', 'baseUrl 为空')
  if (!right) return left
  return left + (right.startsWith('/') ? right : '/' + right)
}

export function encodeModelPath(model) {
  return String(model || '').split('/').map((part) => encodeURIComponent(part)).join('/')
}

export function buildHeaders(provider, key, { stream = false, sessionId = '', accept = null } = {}) {
  const headers = {
    'content-type': 'application/json',
    accept: accept || (stream ? 'text/event-stream' : 'application/json'),
  }
  for (const [name, value] of Object.entries(provider?.headers || {})) {
    const lower = String(name).toLowerCase()
    if (lower === 'content-length' || lower === 'host' || lower === 'connection') continue
    headers[name] = String(value == null ? '' : value)
  }
  if (provider?.sessionHeader && sessionId) headers[provider.sessionHeader] = String(sessionId)
  const auth = provider?.auth || { type: 'none' }
  if (key) {
    if (auth.type === 'bearer') headers[auth.header || 'Authorization'] = (auth.prefix == null ? 'Bearer ' : auth.prefix) + key
    else if (auth.type === 'x-api-key') headers[auth.header || 'x-api-key'] = key
    else if (auth.type === 'header') headers[auth.header || 'Authorization'] = (auth.prefix || '') + key
  }
  return headers
}

function timeoutController(timeoutMs, outerSignal) {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    const error = new Error('model request timeout')
    error.name = 'TimeoutError'
    controller.abort(error)
  }, Math.max(1000, Number(timeoutMs) || 45000))
  let off = null
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort(outerSignal.reason)
    else {
      const onAbort = () => controller.abort(outerSignal.reason)
      outerSignal.addEventListener('abort', onAbort, { once: true })
      off = () => outerSignal.removeEventListener('abort', onAbort)
    }
  }
  return {
    signal: controller.signal,
    cleanup: () => { clearTimeout(timer); try { off?.() } catch (error) {} },
    abort: () => controller.abort(),
  }
}

export async function readTextLimited(response, maxBytes = 4 * 1024 * 1024) {
  const declared = Number(response?.headers?.get?.('content-length') || 0)
  if (declared && declared > maxBytes) throw new ModelError('PROTOCOL', '模型响应超过大小上限', { maxBytes })
  if (!response?.body) {
    const text = await response.text()
    if (text.length > maxBytes) throw new ModelError('PROTOCOL', '模型响应超过大小上限')
    return text
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value?.byteLength || value?.length || 0
      if (total > maxBytes) throw new ModelError('PROTOCOL', '模型响应超过大小上限', { maxBytes })
      chunks.push(Buffer.from(value))
    }
  } finally {
    try { reader.releaseLock() } catch (error) {}
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 打开一次请求；成功时返回 response/cleanup，失败时已读取错误体并抛出归一化错误。
 * 不跟随重定向（避免把认证头带到另一主机）。
 */
export async function openRequest({ url, method = 'POST', headers, body, signal, timeoutMs = 45000, maxBytes = 4 * 1024 * 1024, fetchImpl = fetch }) {
  const timer = timeoutController(timeoutMs, signal)
  let response
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: timer.signal,
      redirect: 'manual',
    })
  } catch (error) {
    timer.cleanup()
    throw normalizeModelError(error)
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers?.get?.('location') || ''
    try { await response.body?.cancel?.() } catch (error) {}
    timer.cleanup()
    throw new ModelError('CONFIG', '模型端点返回重定向；为避免泄漏认证头，网关不自动跟随' + (location ? `（${location.slice(0, 120)}）` : ''), { status: response.status })
  }
  if (!response.ok) {
    let text = ''
    try { text = await readTextLimited(response, Math.min(maxBytes, 256 * 1024)) } catch (error) { text = '' }
    timer.cleanup()
    throw errorFromStatus(response.status, text, response.headers)
  }
  return { response, cleanup: timer.cleanup, signal: timer.signal }
}

export async function requestJson({ url, method = 'POST', headers, body, signal, timeoutMs = 45000, maxBytes = 4 * 1024 * 1024, fetchImpl = fetch }) {
  const opened = await openRequest({ url, method, headers, body, signal, timeoutMs, maxBytes, fetchImpl })
  try {
    const text = await readTextLimited(opened.response, maxBytes)
    let json = null
    try { json = JSON.parse(text) } catch (error) { throw new ModelError('PROTOCOL', '模型响应不是合法 JSON', { status: 200 }) }
    return { status: opened.response.status, headers: opened.response.headers, json, text }
  } finally {
    opened.cleanup()
  }
}

/** 读取 SSE；对跨 chunk、CRLF、多行 data、注释和 [DONE] 都做处理。 */
export async function* readSse(response, { maxBytes = 32 * 1024 * 1024, maxEventBytes = 1024 * 1024 } = {}) {
  if (!response?.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let event = ''
  let data = []
  let total = 0
  const flush = () => {
    if (!data.length) { event = ''; return null }
    const payload = data.join('\n')
    const item = { event: event || 'message', data: payload }
    event = ''
    data = []
    return item
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value?.byteLength || 0
      if (total > maxBytes) throw new ModelError('PROTOCOL', '模型流式响应超过大小上限')
      buffer += decoder.decode(value, { stream: true })
      for (;;) {
        const lineBreak = buffer.indexOf('\n')
        if (lineBreak < 0) break
        let line = buffer.slice(0, lineBreak)
        buffer = buffer.slice(lineBreak + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line === '') {
          const item = flush()
          if (item) yield item
          continue
        }
        if (line.startsWith(':')) continue
        if (line.startsWith('event:')) { event = line.slice(6).trim(); continue }
        if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''))
          if (data.join('\n').length > maxEventBytes) throw new ModelError('PROTOCOL', '模型 SSE 单事件超过大小上限')
        }
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) {
      let line = buffer.trim()
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    const item = flush()
    if (item) yield item
  } finally {
    try { reader.releaseLock() } catch (error) {}
  }
}

/** 读取 NDJSON 流（Ollama）。 */
export async function* readNdjson(response, { maxBytes = 32 * 1024 * 1024 } = {}) {
  if (!response?.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value?.byteLength || 0
      if (total > maxBytes) throw new ModelError('PROTOCOL', '模型流式响应超过大小上限')
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        try { yield JSON.parse(line) } catch (error) { throw new ModelError('PROTOCOL', '模型 NDJSON 行不是合法 JSON') }
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) {
      try { yield JSON.parse(buffer.trim()) } catch (error) { throw new ModelError('PROTOCOL', '模型 NDJSON 行不是合法 JSON') }
    }
  } finally {
    try { reader.releaseLock() } catch (error) {}
  }
}

export function usageOf(usage) {
  if (!usage || typeof usage !== 'object') return { input: 0, output: 0, total: 0 }
  const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokenCount ?? usage.inputTokens ?? usage.input ?? 0) || 0
  const output = Number(usage.output_tokens ?? usage.completion_tokens ?? usage.candidatesTokenCount ?? usage.outputTokens ?? usage.output ?? 0) || 0
  const total = Number(usage.total_tokens ?? usage.totalTokenCount ?? usage.totalTokens ?? usage.total ?? (input + output)) || 0
  return { input, output, total: total || input + output }
}

export function textOfContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => {
    if (typeof part === 'string') return part
    if (part?.type === 'text') return part.text || ''
    return ''
  }).join('')
  return ''
}
