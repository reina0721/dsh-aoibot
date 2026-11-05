// 模型注册表：持久化 provider/模型/密钥引用；原子写；密钥永不通过公开 API 返回。
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

import { getPreset, PRESETS } from './presets.js'
import { getProtocol, protocolIds } from './protocols.js'

export const REGISTRY_VERSION = 1
const MAX_PROVIDERS = 32
const MAX_MODELS = 500
const MAX_HEADERS = 50
const BLOCKED_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'keep-alive', 'proxy-authorization'])

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function text(value, max = 300) {
  return String(value == null ? '' : value).trim().slice(0, max)
}

function number(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

export function validProviderId(id) {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(String(id || ''))
}

export function validHeaderName(name) {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(String(name || ''))
}

export function normalizeBaseUrl(value) {
  const raw = text(value, 2048)
  if (!raw) return ''
  let url
  try { url = new URL(raw) } catch (error) { throw new Error('baseUrl 不是合法 URL') }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('baseUrl 只支持 http/https')
  if (url.username || url.password) throw new Error('baseUrl 不能包含用户名/密码')
  return raw.replace(/\/+$/, '')
}

export function normalizePath(value, fallback) {
  const raw = text(value, 500)
  if (!raw) return fallback
  if (/^[a-z]+:\/\//i.test(raw)) throw new Error('requestPath/modelsPath 必须是相对路径')
  return raw.startsWith('/') ? raw : '/' + raw
}

function normalizeAuth(source, protocol) {
  const d = protocol?.auth || 'bearer'
  const raw = isObject(source) ? source : {}
  const type = ['bearer', 'x-api-key', 'header', 'none'].includes(raw.type) ? raw.type : (d === 'none' ? 'none' : d)
  const header = type === 'bearer' ? 'Authorization'
    : type === 'x-api-key' ? 'x-api-key'
      : type === 'none' ? ''
        : text(raw.header || 'Authorization', 100)
  const prefix = type === 'bearer' ? 'Bearer '
    : type === 'none' ? ''
      : text(raw.prefix == null ? '' : raw.prefix, 60)
  if (type === 'header' && !validHeaderName(header)) throw new Error('auth.header 不是合法 HTTP header')
  if (header && BLOCKED_HEADERS.has(header.toLowerCase())) throw new Error('auth.header 不能使用受限 header')
  return { type, header, prefix }
}

function normalizeHeaders(source, previous = {}) {
  if (source == null) return { ...(previous || {}) }
  if (!isObject(source)) throw new Error('headers 必须是对象')
  const entries = Object.entries(source)
  if (entries.length > MAX_HEADERS) throw new Error('headers 数量超过上限')
  const result = {}
  for (const [name, value] of entries) {
    const key = text(name, 100)
    if (!validHeaderName(key)) throw new Error(`非法 header 名：${name}`)
    if (BLOCKED_HEADERS.has(key.toLowerCase())) throw new Error(`不允许的 header：${key}`)
    const raw = String(value == null ? '' : value)
    if (raw === '***' && previous && previous[key] !== undefined) { result[key] = previous[key]; continue }
    if (/[\r\n]/.test(raw)) throw new Error(`header ${key} 含换行`)
    if (raw.length > 4096) throw new Error(`header ${key} 过长`)
    result[key] = raw
  }
  return result
}

function normalizeModels(source, previous = []) {
  if (source == null) return previous.map((item) => ({ ...item }))
  if (!Array.isArray(source)) throw new Error('models 必须是数组')
  if (source.length > MAX_MODELS) throw new Error('models 数量超过上限')
  const seen = new Set()
  const result = []
  for (const item of source) {
    const row = isObject(item) ? item : { id: item }
    const id = text(row.id, 200)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const endpoints = Array.isArray(row.supportedEndpoints) ? row.supportedEndpoints.map((entry) => text(entry, 100)).filter(Boolean).slice(0, 10) : []
    result.push({
      id,
      label: text(row.label || row.name || id, 200),
      contextWindow: row.contextWindow == null ? null : number(row.contextWindow, 0, 1, 100000000) || null,
      maxOutputTokens: row.maxOutputTokens == null ? null : number(row.maxOutputTokens, 0, 1, 100000000) || null,
      supportedEndpoints: endpoints,
    })
  }
  return result
}

function protocolDefault(presetId, protocolId) {
  const preset = getPreset(presetId)
  if (preset && preset.protocol === protocolId) return preset
  return PRESETS.find((item) => item.protocol === protocolId) || null
}

export function normalizeProvider(input, { existing = null, env = process.env } = {}) {
  if (!isObject(input)) throw new Error('provider 必须是对象')
  const presetId = text(input.preset || existing?.preset || '', 64)
  const preset = getPreset(presetId) || protocolDefault(presetId, input.protocol)
  const id = text(input.id || existing?.id || presetId, 64)
  if (!validProviderId(id)) throw new Error('provider.id 必须是小写字母/数字/._-，且以字母数字开头')
  const protocolId = text(input.protocol || existing?.protocol || preset?.protocol || 'openai-completions', 64)
  const protocol = getProtocol(protocolId)
  if (!protocol) throw new Error(`不支持的协议：${protocolId}`)
  const baseUrl = input.baseUrl !== undefined ? normalizeBaseUrl(input.baseUrl) : normalizeBaseUrl(existing?.baseUrl || preset?.baseUrl || '')
  if (!baseUrl) throw new Error('baseUrl 不能为空')
  const requestPath = input.requestPath !== undefined
    ? normalizePath(input.requestPath, protocol.requestPath)
    : normalizePath(existing?.requestPath || preset?.requestPath || '', protocol.requestPath)
  const modelsPath = input.modelsPath !== undefined
    ? normalizePath(input.modelsPath, protocol.modelsPath)
    : normalizePath(existing?.modelsPath || preset?.modelsPath || '', protocol.modelsPath)
  const auth = normalizeAuth(input.auth !== undefined ? input.auth : (existing?.auth || preset?.auth), protocol)
  let apiKeyEnv = input.apiKeyEnv !== undefined ? text(input.apiKeyEnv, 128) : text(existing?.apiKeyEnv || preset?.apiKeyEnv || '', 128)
  if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) throw new Error('apiKeyEnv 不是合法环境变量名')
  const previousKey = existing?.apiKey || ''
  let apiKey = previousKey
  if (input.clearApiKey === true) apiKey = ''
  else if (input.apiKey !== undefined && input.apiKey !== null) {
    const next = String(input.apiKey).trim()
    if (next && next !== '***') apiKey = next.slice(0, 4096)
  }
  const headers = normalizeHeaders(input.headers !== undefined ? input.headers : (existing?.headers || preset?.headers || {}), existing?.headers || preset?.headers || {})
  const sessionHeader = input.sessionHeader !== undefined
    ? text(input.sessionHeader, 100)
    : text(existing?.sessionHeader || preset?.sessionHeader || '', 100)
  if (sessionHeader && (!validHeaderName(sessionHeader) || BLOCKED_HEADERS.has(sessionHeader.toLowerCase()))) throw new Error('sessionHeader 不是合法 header')
  const models = normalizeModels(input.models !== undefined ? input.models : existing?.models || [], existing?.models || [])
  const envFallbacks = Array.isArray(input.apiKeyEnvFallbacks) ? input.apiKeyEnvFallbacks
    : Array.isArray(existing?.apiKeyEnvFallbacks) ? existing.apiKeyEnvFallbacks
      : Array.isArray(preset?.apiKeyEnvFallbacks) ? preset.apiKeyEnvFallbacks : []
  return {
    id,
    preset: presetId,
    name: text(input.name || existing?.name || preset?.label || id, 100) || id,
    protocol: protocolId,
    baseUrl,
    requestPath,
    modelsPath,
    auth,
    apiKey,
    apiKeyEnv,
    apiKeyEnvFallbacks: envFallbacks.map((entry) => text(entry, 128)).filter((entry) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry)).slice(0, 4),
    headers,
    sessionHeader,
    models,
    timeoutMs: Math.round(number(input.timeoutMs ?? existing?.timeoutMs, 45000, 1000, 180000)),
    stream: bool(input.stream, existing?.stream !== false),
    maxRetries: Math.round(number(input.maxRetries ?? existing?.maxRetries, 1, 0, 5)),
    enabled: bool(input.enabled, existing?.enabled !== false),
    notes: text(input.notes ?? existing?.notes ?? preset?.notes, 500),
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
    version: (existing?.version || 0) + 1,
  }
}

export function resolveApiKey(provider, env = process.env) {
  if (!provider) return { value: '', source: 'none' }
  for (const name of [provider.apiKeyEnv, ...(provider.apiKeyEnvFallbacks || [])]) {
    if (!name) continue
    const value = env?.[name]
    if (value) return { value: String(value), source: 'env', envName: name }
  }
  if (provider.apiKey) return { value: String(provider.apiKey), source: 'stored' }
  return { value: '', source: 'none' }
}

export function maskKey(value) {
  const key = String(value || '')
  if (!key) return ''
  return key.length <= 8 ? '••••' : '…' + key.slice(-4)
}

function maskHeaderValue(name, value) {
  if (/authorization|api[-_]?key|token|secret|cookie/i.test(name)) return value ? '***' : ''
  return value
}

export function publicProvider(provider, { env = process.env } = {}) {
  const key = resolveApiKey(provider, env)
  return {
    id: provider.id,
    preset: provider.preset,
    name: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    requestPath: provider.requestPath,
    modelsPath: provider.modelsPath,
    auth: { ...(provider.auth || {}) },
    authType: provider.auth?.type || 'none',
    apiKeyEnv: provider.apiKeyEnv,
    hasApiKey: Boolean(key.value),
    apiKeySource: key.source,
    apiKeyHint: maskKey(key.value),
    headers: Object.fromEntries(Object.entries(provider.headers || {}).map(([name, value]) => [name, maskHeaderValue(name, value)])),
    sessionHeader: provider.sessionHeader,
    models: (provider.models || []).map((model) => ({ ...model })),
    timeoutMs: provider.timeoutMs,
    stream: provider.stream,
    maxRetries: provider.maxRetries,
    enabled: provider.enabled,
    notes: provider.notes,
    updatedAt: provider.updatedAt,
  }
}

function atomicWrite(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
  try { renameSync(tmp, file) } catch (error) {
    // Windows 上 rename 覆盖可能失败；先备份再替换。
    if (existsSync(file)) copyFileSync(file, `${file}.bak`)
    writeFileSync(file, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
    try { renameSync(tmp, file) } catch (inner) {}
  }
}

export function createRegistry({ file, env = process.env, log = null, presets = PRESETS } = {}) {
  if (!file) throw new Error('模型注册表缺少文件路径')
  let state = { version: REGISTRY_VERSION, selected: null, fallback: [], providers: [] }
  let issue = ''
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      const providers = Array.isArray(raw?.providers) ? raw.providers : []
      state.providers = providers.slice(0, MAX_PROVIDERS).map((item) => {
        try { return normalizeProvider(item, { env }) } catch (error) { return null }
      }).filter(Boolean)
      state.selected = normalizeSelected(raw?.selected, state.providers)
      state.fallback = Array.isArray(raw?.fallback) ? raw.fallback.map((item) => normalizeSelected(item, state.providers)).filter(Boolean).slice(0, 8) : []
    }
  } catch (error) {
    issue = `模型注册表读取失败：${error.message}`
    log?.warn?.(issue)
    state = { version: REGISTRY_VERSION, selected: null, fallback: [], providers: [] }
  }

  function normalizeSelected(value, providers) {
    if (!isObject(value)) return null
    const provider = text(value.provider, 64)
    const model = text(value.model, 200)
    if (!provider || !model) return null
    if (!providers.some((item) => item.id === provider)) return null
    return { provider, model }
  }

  function saveState() {
    atomicWrite(file, state)
  }

  function selected() {
    if (!state.selected) return null
    const provider = state.providers.find((item) => item.id === state.selected.provider)
    if (!provider) return null
    return { ...state.selected, providerRecord: provider }
  }

  function list() {
    return state.providers.map((item) => ({ ...item }))
  }

  function get(id) {
    return state.providers.find((item) => item.id === String(id || '')) || null
  }

  function saveProvider(input) {
    const existing = get(input?.id)
    const provider = normalizeProvider(input, { existing, env })
    if (existing) {
      const index = state.providers.indexOf(existing)
      state.providers[index] = provider
    } else {
      if (state.providers.length >= MAX_PROVIDERS) throw new Error('provider 数量超过上限')
      state.providers.push(provider)
    }
    if (state.selected?.provider === provider.id && !provider.models.some((model) => model.id === state.selected.model)) {
      // 允许保留模型后补；状态由 selected() 判断 provider 是否存在，UI 显示 unresolved。
    }
    saveState()
    return provider
  }

  function removeProvider(id) {
    const provider = get(id)
    if (!provider) return false
    state.providers = state.providers.filter((item) => item.id !== provider.id)
    state.fallback = state.fallback.filter((item) => item.provider !== provider.id)
    if (state.selected?.provider === provider.id) state.selected = null
    saveState()
    return true
  }

  function select(providerId, modelId) {
    const provider = get(providerId)
    if (!provider) throw new Error('provider 不存在')
    if (!provider.enabled) throw new Error('provider 已禁用')
    const model = text(modelId, 200)
    if (!model) throw new Error('model 不能为空')
    if (provider.models.length && !provider.models.some((item) => item.id === model)) {
      throw new Error('该 provider 的模型列表中没有这个 model')
    }
    state.selected = { provider: provider.id, model }
    saveState()
    return state.selected
  }

  function setFallback(list) {
    if (!Array.isArray(list)) throw new Error('fallback 必须是数组')
    const next = list.map((item) => normalizeSelected(item, state.providers)).filter(Boolean).slice(0, 8)
    state.fallback = next
    saveState()
    return next
  }

  function upsertModels(providerId, models) {
    const provider = get(providerId)
    if (!provider) throw new Error('provider 不存在')
    provider.models = normalizeModels(models, provider.models)
    provider.updatedAt = Date.now()
    saveState()
    return provider.models
  }

  function refreshSecrets(registerSecret) {
    if (typeof registerSecret !== 'function') return
    for (const provider of state.providers) {
      const key = resolveApiKey(provider, env)
      if (key.value) registerSecret(key.value)
    }
  }

  return {
    file,
    get issue() { return issue },
    selected,
    list,
    get,
    saveProvider,
    removeProvider,
    select,
    setFallback,
    upsertModels,
    refreshSecrets,
    raw: () => state,
  }
}
