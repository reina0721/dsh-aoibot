// LLM 适配器：只做「结构化认知任务的语义投影/生成」，不持有状态。
//
// - 路由默认继承 DSH agentDefaultModel；fixed 则由 cog-llm 配置；
// - 请求通过 ctx.get('llm').stream()，不复制 API Key；
// - 统一超时/预算/JSON 解析/降级；失败不会伪造结果。

import { clamp, dayKey, estimateTokens, nowMs, safeJson, truncate } from './util.js'

export function stripCodeFence(text) {
  let s = String(text || '').trim()
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  }
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

export function createLlmClient({ ctx, getConfig, store, clock, log } = {}) {
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

  async function resolveRoute() {
    const c = cfg().llm || {}
    if (c.mode === 'fixed' && c.provider && c.model) {
      return { provider: c.provider, model: c.model, reasoningEffort: c.reasoningEffort || undefined, source: 'fixed' }
    }
    try {
      const selection = ctx?.get?.('agentDefaultModel')?.currentSelection?.()
      if (selection?.provider && selection?.model) {
        return { ...selection, source: 'agentDefaultModel' }
      }
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

  async function complete({ system = '', user = '', maxTokens = null, temperature = null, timeoutMs = null, purpose = 'analysis' } = {}) {
    const c = cfg().llm || {}
    const llm = llmService()
    if (!llm) return { ok: false, error: 'LLM_UNAVAILABLE', message: serviceWarning || 'DSH llm service 不可用', degraded: true }
    const route = await resolveRoute()
    if (!route) return { ok: false, error: 'LLM_ROUTE_UNAVAILABLE', message: '没有可用的模型路由', degraded: true }
    const tokensLeft = budgetLeft()
    if (tokensLeft <= 0) return { ok: false, error: 'BUDGET_EXHAUSTED', message: `今日 LLM token 预算已用完`, degraded: true, route }
    const budget = Math.max(64, Math.min(Number(maxTokens || (purpose === 'compose' ? c.composeMaxTokens : c.analysisMaxTokens) || 700), tokensLeft))
    const controller = new AbortController()
    const timeout = Math.max(1000, Number(timeoutMs || c.timeoutMs || 20000))
    const timer = setTimeout(() => controller.abort(), timeout)
    const messages = []
    if (system) messages.push({ role: 'system', content: [{ type: 'text', text: String(system) }] })
    messages.push({ role: 'user', content: [{ type: 'text', text: String(user || '') }] })
    let text = ''
    let usageTokens = 0
    let finish = null
    try {
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
        messages,
        temperature: clamp(Number(temperature ?? c.temperature ?? 0.7), 0, 1.5),
        maxTokens: budget,
        signal: controller.signal,
      })
      for await (const chunk of stream) {
        if (!chunk || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta' && chunk.text) text += chunk.text
        else if (chunk.type === 'usage') usageTokens += Number(chunk.usage?.totalTokens || chunk.usage?.outputTokens || 0)
        else if (chunk.type === 'finish') finish = chunk
        if (estimateTokens(text) > budget * 2.5) {
          controller.abort()
          break
        }
      }
    } catch (error) {
      clearTimeout(timer)
      recordUsage(usageTokens || estimateTokens(user) + estimateTokens(text))
      return { ok: false, error: 'LLM_CALL_FAILED', message: String(error?.message || error), route, degraded: true }
    }
    clearTimeout(timer)
    const estimated = usageTokens || (estimateTokens(system) + estimateTokens(user) + estimateTokens(text))
    recordUsage(estimated)
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
      route,
      tokens: estimated,
      finish: finish?.reason?.kind || 'stop',
      truncated: finish?.reason?.kind === 'max-tokens',
    }
  }

  async function completeJson(spec, options = {}) {
    const result = await complete({ ...options, purpose: spec?.purpose || options.purpose || 'analysis' })
    if (!result.ok) return result
    if (result.json == null) {
      return { ...result, ok: false, error: 'LLM_BAD_JSON', message: '模型返回不是合法 JSON', degraded: true }
    }
    return result
  }

  async function status() {
    const llm = llmService()
    const route = llm ? await resolveRoute() : null
    return {
      available: Boolean(llm),
      serviceWarning,
      route,
      usageToday: todayUsage(),
      budget: Number(cfg().llm?.dailyTokenBudget || 0),
      budgetLeft: budgetLeft(),
    }
  }

  return { complete, completeJson, resolveRoute, status, budgetLeft, todayUsage }
}
