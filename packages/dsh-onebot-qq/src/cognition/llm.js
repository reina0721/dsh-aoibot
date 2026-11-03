// LLM 路由与降级层。
//
// - DSH 路由：保留原有 ctx.get('llm').stream() 行为；
// - 直连路由：调用 src/model 的协议网关（OpenAI/Anthropic/Responses/Gemini/Ollama/中转站）；
// - 只在语义分析与表达层投影长期状态，不复制长期记忆。
import { dayKey, estimateTokens, truncate } from './util.js'

export function stripCodeFence(text) {
  let s = String(text || '').trim()
  if (s.startsWith('```')) s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  return s
}

export function parseJsonLoose(text) {
  const raw = stripCodeFence(text)
  try { return { ok: true, value: JSON.parse(raw) } } catch (error) {}
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return { ok: true, value: JSON.parse(raw.slice(start, end + 1)) } } catch (error) {}
  }
  return { ok: false, value: null, error: '不是合法 JSON' }
}

function routeKey(route) {
  return `${route.kind}:${route.provider}:${route.model}`
}

export function createLlmClient({ ctx, models = null, getConfig, store, clock, log } = {}) {
  const cfg = () => getConfig()?.cognition || {}
  let serviceWarning = ''

  function llmService() {
    try {
      const llm = ctx?.get?.('llm')
      if (!llm || typeof llm.stream !== 'function') return null
      return llm
    } catch (error) {
      serviceWarning = error.message
      return null
    }
  }

  async function resolveDshRoute() {
    const c = cfg().llm || {}
    if (c.mode === 'fixed' && c.provider && c.model) {
      return { provider: c.provider, model: c.model, reasoningEffort: c.reasoningEffort || undefined, source: 'fixed' }
    }
    try {
      const selection = ctx?.get?.('agentDefaultModel')?.currentSelection?.()
      if (selection?.provider && selection?.model) return { ...selection, source: 'agentDefaultModel' }
    } catch (error) {}
    const llm = llmService()
    if (!llm) return null
    try {
      const providers = await llm.listProviders?.() || []
      for (const provider of providers) {
        const id = typeof provider === 'string' ? provider : provider?.id
        if (!id) continue
        try {
          const models = await llm.listModels?.(id) || []
          const model = models[0]
          const modelId = typeof model === 'string' ? model : model?.id
          if (modelId) return { provider: id, model: modelId, source: 'firstRegistered' }
        } catch (error) {}
      }
    } catch (error) {}
    return null
  }

  function directCandidates() {
    if (!models) return []
    const selected = models.selected?.()
    const candidates = []
    if (selected?.resolved) candidates.push({ provider: selected.provider, model: selected.model, source: 'direct' })
    for (const item of models.fallback?.() || []) {
      if (!item?.provider || !item?.model) continue
      if (candidates.some((route) => route.provider === item.provider && route.model === item.model)) continue
      candidates.push({ provider: item.provider, model: item.model, source: 'fallback' })
    }
    return candidates
  }

  async function buildAttempts() {
    const c = cfg().llm || {}
    const mode = ['auto', 'dsh', 'fixed', 'direct', 'chain'].includes(c.mode) ? c.mode : 'auto'
    const attempts = []
    const seen = new Set()
    const add = (route) => {
      if (!route) return
      const key = routeKey({ ...route, kind: route.kind || 'dsh' })
      if (seen.has(key)) return
      seen.add(key)
      attempts.push(route)
    }
    const dsh = await resolveDshRoute()
    const direct = directCandidates()

    if (mode === 'dsh') {
      if (dsh) add({ kind: 'dsh', ...dsh })
    } else if (mode === 'fixed') {
      const c2 = cfg().llm || {}
      if (c2.provider && c2.model) add({ kind: 'dsh', provider: c2.provider, model: c2.model, reasoningEffort: c2.reasoningEffort, source: 'fixed' })
      else if (dsh) add({ kind: 'dsh', ...dsh })
    } else if (mode === 'direct') {
      for (const item of direct) add({ kind: 'direct', ...item })
      if (c.fallbackToDsh !== false && dsh) add({ kind: 'dsh', ...dsh })
    } else if (mode === 'chain') {
      for (const item of direct) add({ kind: 'direct', ...item })
      if (dsh) add({ kind: 'dsh', ...dsh })
    } else {
      // auto：保持 DSH 优先；DSH 不可用或无凭据失败时直连兜底。
      if (dsh) add({ kind: 'dsh', ...dsh })
      for (const item of direct) add({ kind: 'direct', ...item })
    }
    return attempts
  }

  function todayUsage() {
    const key = dayKey(clock.now())
    return Number(store?.get('llm_usage', key)?.tokens || 0)
  }

  function recordUsage(tokens) {
    if (!store) return
    const key = dayKey(clock.now())
    const prev = Number(store.get('llm_usage', key)?.tokens || 0)
    store.put('llm_usage', key, { tokens: prev + Math.max(0, Number(tokens) || 0), updatedAt: clock.now() })
  }

  function budgetLeft() {
    const c = cfg().llm || {}
    return Math.max(0, Number(c.dailyTokenBudget || 0) - todayUsage())
  }

  async function callDsh(route, { system, user, maxTokens, temperature, timeoutMs, purpose }) {
    const c = cfg().llm || {}
    const llm = llmService()
    if (!llm) return { ok: false, error: 'LLM_UNAVAILABLE', message: serviceWarning || 'DSH llm service 不可用', degraded: true }
    const controller = new AbortController()
    const timeout = Math.max(1000, Number(timeoutMs || c.timeoutMs || 45000))
    const timer = setTimeout(() => controller.abort(), timeout)
    const messages = []
    if (system) messages.push({ role: 'system', content: [{ type: 'text', text: String(system) }] })
    messages.push({ role: 'user', content: [{ type: 'text', text: String(user || '') }] })
    let text = ''
    let usageTokens = 0
    let finish = null
    const budget = Math.max(64, Number(maxTokens || (purpose === 'compose' ? c.composeMaxTokens : c.analysisMaxTokens) || 700))
    try {
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
        messages,
        temperature: Math.min(1.5, Math.max(0, Number(temperature ?? c.temperature ?? 0.7))),
        maxTokens: budget,
        signal: controller.signal,
      })
      for await (const chunk of stream) {
        if (!chunk || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta' && chunk.text) text += chunk.text
        else if (chunk.type === 'usage') usageTokens += Number(chunk.usage?.totalTokens || chunk.usage?.outputTokens || 0)
        else if (chunk.type === 'finish') finish = chunk
        if (estimateTokens(text) > budget * 2.5) { controller.abort(); break }
      }
    } catch (error) {
      return { ok: false, error: 'LLM_CALL_FAILED', message: String(error?.message || error), route, degraded: true }
    } finally {
      clearTimeout(timer)
    }
    const estimated = usageTokens || (estimateTokens(system) + estimateTokens(user) + estimateTokens(text))
    if (finish?.reason?.kind === 'error' || finish?.reason?.kind === 'aborted') {
      return {
        ok: false,
        error: finish.reason.kind === 'aborted' ? 'LLM_ABORTED' : 'LLM_PROVIDER_ERROR',
        message: finish.reason.failure?.message || '模型调用失败',
        route,
        degraded: true,
      }
    }
    const json = parseJsonLoose(text)
    return {
      ok: true,
      text: text.trim(),
      json: json.ok ? json.value : null,
      jsonError: json.ok ? '' : json.error,
      route: { ...route, source: route.source || 'dsh' },
      tokens: estimated,
      finish: finish?.reason?.kind || 'stop',
      truncated: finish?.reason?.kind === 'max-tokens',
      empty: !text.trim(),
    }
  }

  async function callDirect(route, { system, user, maxTokens, temperature, timeoutMs, purpose, sessionId }) {
    const result = await models.complete({
      provider: route.provider,
      model: route.model,
      system,
      messages: [{ role: 'user', content: user || '' }],
      maxTokens,
      temperature,
      timeoutMs,
      purpose,
      sessionId,
    })
    const text = String(result.text || '').trim()
    if (!text) {
      return { ok: false, error: 'EMPTY_OUTPUT', message: '模型未返回可见文本（可能只有 reasoning 或被截断）', route: result.route, degraded: true }
    }
    const json = parseJsonLoose(text)
    return {
      ok: true,
      text,
      json: json.ok ? json.value : null,
      jsonError: json.ok ? '' : json.error,
      route: { ...result.route, source: 'direct' },
      tokens: Number(result.usage?.total || 0),
      finish: result.finish?.kind || 'stop',
      truncated: result.finish?.kind === 'max-tokens',
      usage: result.usage,
      latencyMs: result.latencyMs,
    }
  }

  async function complete({ system = '', user = '', maxTokens = null, temperature = null, timeoutMs = null, purpose = 'analysis', sessionId = '' } = {}) {
    const c = cfg().llm || {}
    const tokensLeft = budgetLeft()
    if (tokensLeft <= 0) return { ok: false, error: 'BUDGET_EXHAUSTED', message: '今日 LLM token 预算已用完', degraded: true }
    const budget = Math.max(64, Math.min(Number(maxTokens || (purpose === 'compose' ? c.composeMaxTokens : c.analysisMaxTokens) || 700), tokensLeft))
    const attempts = await buildAttempts()
    if (!attempts.length) {
      return {
        ok: false,
        error: 'LLM_ROUTE_UNAVAILABLE',
        message: '没有可用的模型路由：请在「模型」页配置直连 provider，或配置 DSH 模型',
        degraded: true,
        attempts: [],
      }
    }
    const failures = []
    for (const attempt of attempts) {
      let result
      try {
        result = attempt.kind === 'direct'
          ? await callDirect(attempt, { system, user, maxTokens: budget, temperature, timeoutMs, purpose, sessionId })
          : await callDsh(attempt, { system, user, maxTokens: budget, temperature, timeoutMs, purpose })
      } catch (error) {
        result = { ok: false, error: error?.code || 'MODEL_ERROR', message: String(error?.message || error), route: attempt, degraded: true }
      }
      const tokens = Number(result.tokens || result.usage?.total || 0)
        || estimateTokens(system) + estimateTokens(user) + estimateTokens(result.text || '')
      if (tokens) recordUsage(tokens)
      if (result.ok && String(result.text || '').trim()) return result
      failures.push({ provider: attempt.provider, model: attempt.model, source: attempt.source, kind: attempt.kind, error: result.error, message: truncate(result.message || '', 240) })
      log?.debug?.('模型路由失败，尝试下一个：', `${attempt.provider}/${attempt.model}`, result.error || '')
    }
    const last = failures[failures.length - 1] || {}
    return {
      ok: false,
      error: failures.some((item) => item.error === 'EMPTY_OUTPUT') ? 'EMPTY_OUTPUT' : (last.error || 'LLM_ALL_ROUTES_FAILED'),
      message: last.message || '所有模型路由均失败',
      degraded: true,
      attempts: failures,
    }
  }

  async function completeJson(spec, options = {}) {
    const result = await complete({ ...options, purpose: spec?.purpose || options.purpose || 'analysis' })
    if (!result.ok) return result
    if (result.json == null) return { ...result, ok: false, error: 'LLM_BAD_JSON', message: '模型返回不是合法 JSON', degraded: true }
    return result
  }

  async function status() {
    const llm = llmService()
    const dshRoute = llm ? await resolveDshRoute() : null
    let direct = null
    try { direct = models?.selected?.() || null } catch (error) {}
    return {
      available: Boolean(llm) || Boolean(direct?.available),
      serviceWarning,
      route: dshRoute,
      dsh: { available: Boolean(llm), route: dshRoute },
      direct,
      models: models?.list?.() || null,
      usageToday: todayUsage(),
      budget: Number(cfg().llm?.dailyTokenBudget || 0),
      budgetLeft: budgetLeft(),
    }
  }

  async function resolveRoute() {
    return resolveDshRoute()
  }

  return { complete, completeJson, resolveRoute, status, budgetLeft, todayUsage, buildAttempts }
}
