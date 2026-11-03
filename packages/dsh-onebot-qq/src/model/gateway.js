// 模型网关：provider 注册表 + 协议适配 + 测试/发现/重试/熔断；不持有认知状态。
import { join } from 'node:path'

import { registerSecret, redact } from '../core/redact.js'
import { getPreset, publicPresets } from './presets.js'
import { getProtocol, protocolIds } from './protocols.js'
import { createRegistry, publicProvider, resolveApiKey } from './registry.js'
import { buildHeaders, requestJson, usageOf } from './http.js'
import { ModelError, normalizeModelError } from './errors.js'

import * as openai from './adapters/openai-completions.js'
import * as responses from './adapters/openai-responses.js'
import * as anthropic from './adapters/anthropic-messages.js'
import * as gemini from './adapters/gemini.js'
import * as ollama from './adapters/ollama.js'

const ADAPTERS = {
  'openai-completions': openai,
  'openai-responses': responses,
  'anthropic-messages': anthropic,
  'gemini-generate-content': gemini,
  'ollama-chat': ollama,
}

const ENDPOINT_BY_PROTOCOL = {
  'openai-completions': '/chat/completions',
  'openai-responses': '/responses',
  'anthropic-messages': '/messages',
  'gemini-generate-content': '',
  'ollama-chat': '/api/chat',
}

const RETRYABLE = new Set(['RATE_LIMIT', 'UPSTREAM', 'NETWORK', 'TIMEOUT', 'HTTP_ERROR'])
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)))

function sanitizeMessage(message, key) {
  let value = redact(String(message || '模型调用失败'))
  if (key) value = value.split(String(key)).join('***')
  return value.slice(0, 600)
}

function publicSelected(selected, registry, env) {
  if (!selected) return null
  const provider = registry.get(selected.provider)
  if (!provider) return { provider: selected.provider, model: selected.model, resolved: false, available: false }
  const key = resolveApiKey(provider, env)
  const protocol = getProtocol(provider.protocol)
  return {
    provider: provider.id,
    model: selected.model,
    name: provider.name,
    protocol: provider.protocol,
    protocolLabel: protocol?.label || provider.protocol,
    baseUrl: provider.baseUrl,
    resolved: true,
    hasApiKey: Boolean(key.value) || provider.auth?.type === 'none',
    apiKeySource: key.source,
    enabled: provider.enabled,
    available: provider.enabled && (Boolean(key.value) || provider.auth?.type === 'none'),
  }
}

export function createModelGateway({ dataRoot, env = process.env, logger = null, clock = { now: () => Date.now() }, fetchImpl = fetch } = {}) {
  if (!dataRoot) throw new Error('模型网关缺少 dataRoot')
  const file = join(dataRoot, 'models.json')
  const log = logger?.child?.('model') || logger || { debug() {}, warn() {}, info() {} }
  const registry = createRegistry({ file, env, log })
  const health = new Map()
  const startedAt = clock.now()

  function healthOf(providerId) {
    return health.get(providerId) || { calls: 0, failures: 0, successes: 0, consecutiveFailures: 0, lastAt: 0, lastLatencyMs: 0, lastError: '' }
  }

  function noteHealth(providerId, { ok, latencyMs = 0, error = '', usage = null }) {
    const item = { ...healthOf(providerId) }
    item.calls += 1
    item.lastAt = clock.now()
    item.lastLatencyMs = Math.max(0, Math.round(latencyMs))
    if (ok) {
      item.successes += 1
      item.consecutiveFailures = 0
      item.lastError = ''
    } else {
      item.failures += 1
      item.consecutiveFailures += 1
      item.lastError = sanitizeMessage(error, '')
    }
    if (usage) item.lastUsage = usage
    health.set(providerId, item)
  }

  function ensureProvider(id) {
    const provider = registry.get(id)
    if (!provider) throw new ModelError('PROVIDER_NOT_FOUND', '模型 provider 不存在')
    if (!provider.enabled) throw new ModelError('PROVIDER_DISABLED', '模型 provider 已禁用')
    return provider
  }

  function resolve(providerId, modelId) {
    let provider = null
    let model = String(modelId || '')
    if (providerId) provider = ensureProvider(providerId)
    else {
      const selected = registry.selected()
      if (!selected) throw new ModelError('NO_ROUTE', '尚未选择直连模型')
      provider = ensureProvider(selected.provider)
      model = model || selected.model
    }
    if (!model) throw new ModelError('NO_MODEL', '未指定模型 ID')
    const adapter = ADAPTERS[provider.protocol]
    if (!adapter) throw new ModelError('PROTOCOL', `不支持的协议：${provider.protocol}`)
    const key = resolveApiKey(provider, env)
    if (provider.auth?.type !== 'none' && !key.value) throw new ModelError('NO_KEY', '未配置 API key 或环境变量')
    return { provider, model, adapter, key, protocol: getProtocol(provider.protocol), keySource: key.source }
  }

  function assertModelSupports(provider, model) {
    const entry = (provider.models || []).find((item) => item.id === model)
    if (!entry?.supportedEndpoints?.length) return
    const expected = ENDPOINT_BY_PROTOCOL[provider.protocol]
    if (expected && !entry.supportedEndpoints.includes(expected)) {
      throw new ModelError('PROTOCOL_MISMATCH', `模型 ${model} 不支持当前协议端点 ${expected}；请换用匹配的 provider 预设`, { supportedEndpoints: entry.supportedEndpoints.slice(0, 5) })
    }
  }

  async function complete({ provider: providerId, model: modelId, system = '', messages = [], maxTokens = null, temperature = null, timeoutMs = null, signal = null, sessionId = '', purpose = 'analysis', retry = null } = {}) {
    const route = resolve(providerId, modelId)
    assertModelSupports(route.provider, route.model)
    const item = healthOf(route.provider.id)
    if (item.consecutiveFailures >= 3 && clock.now() - item.lastAt < 30000) {
      throw new ModelError('CIRCUIT_OPEN', '该 provider 连续失败，暂时熔断（30 秒后重试）')
    }
    const maxRetries = Math.max(0, Math.min(5, Number(retry == null ? route.provider.maxRetries : retry) || 0))
    let lastError = null
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const startedAt = clock.now()
      try {
        const result = await route.adapter.complete({
          provider: route.provider,
          key: route.key.value,
          model: route.model,
          system,
          messages,
          maxTokens: maxTokens || null,
          temperature: temperature == null ? null : temperature,
          timeoutMs: timeoutMs || route.provider.timeoutMs,
          signal,
          sessionId: sessionId || `dsh-${route.provider.id}-${clock.now().toString(36)}`,
          purpose,
          fetchImpl,
          maxBytes: 4 * 1024 * 1024,
        })
        noteHealth(route.provider.id, { ok: true, latencyMs: clock.now() - startedAt, usage: result.usage })
        return {
          ...result,
          ok: true,
          route: { provider: route.provider.id, model: route.model, protocol: route.provider.protocol, label: route.provider.name, baseUrl: route.provider.baseUrl, source: 'direct' },
          latencyMs: clock.now() - startedAt,
        }
      } catch (error) {
        const normalized = normalizeModelError(error)
        normalized.message = sanitizeMessage(normalized.message, route.key.value)
        noteHealth(route.provider.id, { ok: false, latencyMs: clock.now() - startedAt, error: normalized.message })
        lastError = normalized
        if (!RETRYABLE.has(normalized.code) || attempt >= maxRetries) break
        const retryAfter = Number(normalized.details?.retryAfter)
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(8000, retryAfter * 1000) : Math.min(5000, 300 * (2 ** attempt))
        log.debug?.(`模型请求重试（${attempt + 1}/${maxRetries}）：${normalized.code}`)
        await sleep(delay)
        if (signal?.aborted) break
      }
    }
    throw lastError || new ModelError('MODEL_ERROR', '模型调用失败')
  }

  async function test({ provider: providerId, model: modelId, prompt = 'Reply with exactly: OK' } = {}) {
    const startedAt = clock.now()
    try {
      const result = await complete({
        provider: providerId,
        model: modelId,
        system: 'You are a connectivity test. Do not explain.',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 96,
        temperature: 0,
        timeoutMs: 45000,
        purpose: 'test',
        retry: 0,
      })
      const preview = String(result.text || '').slice(0, 160)
      return {
        ok: Boolean(preview),
        warning: preview ? '' : 'EMPTY_OUTPUT',
        provider: result.route.provider,
        model: result.route.model,
        protocol: result.route.protocol,
        latencyMs: result.latencyMs,
        usage: result.usage,
        finish: result.finish?.kind || 'stop',
        textPreview: preview,
      }
    } catch (error) {
      const normalized = normalizeModelError(error)
      return {
        ok: false,
        code: normalized.code,
        message: sanitizeMessage(normalized.message, ''),
        provider: providerId || '',
        model: modelId || '',
        latencyMs: clock.now() - startedAt,
      }
    }
  }

  async function discover(providerId) {
    const provider = ensureProvider(providerId)
    const adapter = ADAPTERS[provider.protocol]
    if (!adapter?.parseModelList) throw new ModelError('PROTOCOL', '该协议不支持模型发现')
    const key = resolveApiKey(provider, env)
    // 模型发现端点通常是公开的（OpenCode/OpenRouter/CommandCode）；没有 key 也先尝试，
    // 需要认证的端点会返回 401 并由统一错误层报告。
    const url = provider.baseUrl.replace(/\/+$/, '') + provider.modelsPath
    const { json } = await requestJson({
      url,
      method: 'GET',
      headers: buildHeaders(provider, key.value, { stream: false }),
      signal: null,
      timeoutMs: provider.timeoutMs || 30000,
      fetchImpl,
    })
    let models = adapter.parseModelList(json)
    const expected = ENDPOINT_BY_PROTOCOL[provider.protocol]
    if (expected) {
      models = models.filter((item) => !item.supportedEndpoints?.length || item.supportedEndpoints.includes(expected))
    }
    return { provider: provider.id, protocol: provider.protocol, models, rawCount: Array.isArray(json?.data) ? json.data.length : Array.isArray(json?.models) ? json.models.length : Array.isArray(json?.data) ? json.data.length : 0 }
  }

  function saveProvider(input) {
    if (!input || typeof input !== 'object') throw new ModelError('CONFIG', 'provider 必须是对象')
    try {
      const provider = registry.saveProvider(input)
      refreshSecrets()
      return publicProvider(provider, { env })
    } catch (error) {
      if (error instanceof ModelError) throw error
      throw new ModelError('CONFIG', sanitizeMessage(error.message || error))
    }
  }

  function removeProvider(id) {
    const removed = registry.removeProvider(id)
    if (!removed) throw new ModelError('PROVIDER_NOT_FOUND', '模型 provider 不存在')
    return { removed: true, id }
  }

  function select(providerId, modelId) {
    try { return registry.select(providerId, modelId) } catch (error) { throw new ModelError('CONFIG', sanitizeMessage(error.message || error)) }
  }

  function setFallback(list) {
    try { return registry.setFallback(list) } catch (error) { throw new ModelError('CONFIG', sanitizeMessage(error.message || error)) }
  }

  function list() {
    const selected = registry.selected()
    return {
      registryVersion: 1,
      file,
      issue: registry.issue,
      selected: publicSelected(selected, registry, env),
      fallback: registry.raw().fallback.map((item) => publicSelected(item, registry, env)).filter(Boolean),
      providers: registry.list().map((provider) => publicProvider(provider, { env })),
      presets: publicPresets(),
      protocols: protocolIds().map((id) => ({ id, ...getProtocol(id) })),
      health: Object.fromEntries(Array.from(health.entries()).map(([id, item]) => [id, { ...item, lastError: sanitizeMessage(item.lastError, '') }])),
      startedAt,
      available: Boolean(selected && selected.providerRecord) && registry.list().some((provider) => provider.id === selected.provider && provider.enabled),
    }
  }

  function refreshSecrets() {
    registry.refreshSecrets(registerSecret)
    for (const provider of registry.list()) {
      const key = resolveApiKey(provider, env)
      if (key.value) registerSecret(key.value)
    }
  }

  function applyModels(providerId, models) {
    try {
      const updated = registry.upsertModels(providerId, models)
      return { provider: providerId, models: updated }
    } catch (error) {
      throw new ModelError('CONFIG', sanitizeMessage(error.message || error))
    }
  }

  refreshSecrets()
  return {
    file,
    ready: true,
    list,
    get: (id) => { const provider = registry.get(id); return provider ? publicProvider(provider, { env }) : null },
    saveProvider,
    removeProvider,
    select,
    setFallback,
    discover,
    applyModels,
    test,
    complete,
    refreshSecrets,
    status: list,
    selected: () => {
      const selected = registry.selected()
      return selected ? { provider: selected.provider, model: selected.model, ...publicSelected(selected, registry, env) } : null
    },
    fallback: () => registry.raw().fallback.map((item) => ({ ...item })),
    resolve,
    dispose: () => {},
  }
}

export { ADAPTERS, ENDPOINT_BY_PROTOCOL }
