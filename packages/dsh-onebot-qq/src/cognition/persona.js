// Bot 长期人格：稳定特质、价值边界、表达风格。
// 状态独立于情绪/关系/技能；单次互动不能改变；演化有速率上限与历史。

import { clamp, deepClone, round, safeJson } from './util.js'

export const TRAIT_KEYS = [
  'extraversion', 'openness', 'agreeableness', 'conscientiousness', 'emotionalSensitivity',
  'humor', 'socialInitiative', 'caution', 'expressiveness', 'conflictApproach',
  'riskTolerance', 'consistency',
]
export const STYLE_KEYS = ['formality', 'verbosity', 'emojiRate', 'punctuation', 'teasingBound', 'warmth']

export function defaultPersona(config = {}) {
  const persona = config.persona || {}
  const traits = {}
  for (const key of TRAIT_KEYS) traits[key] = clamp(persona.traits?.[key] ?? 0.5, 0.1, 0.9)
  const style = {}
  for (const key of STYLE_KEYS) style[key] = clamp(persona.style?.[key] ?? 0.5, 0, 1)
  return {
    id: 'self',
    traits,
    style,
    values: Array.isArray(persona.values) ? [...persona.values] : [],
    locked: [],
    history: [],
    version: 1,
  }
}

export function sanitizePersona(input, config = {}) {
  const base = defaultPersona(config)
  const src = input && typeof input === 'object' ? input : {}
  const traits = {}
  for (const key of TRAIT_KEYS) traits[key] = clamp(src.traits?.[key] ?? base.traits[key], 0.1, 0.9)
  const style = {}
  for (const key of STYLE_KEYS) style[key] = clamp(src.style?.[key] ?? base.style[key], 0, 1)
  return {
    ...base,
    ...deepClone(src),
    id: 'self',
    traits,
    style,
    values: Array.isArray(src.values) ? src.values.map(String).slice(0, 30) : base.values,
    locked: Array.isArray(src.locked) ? src.locked.filter((key) => TRAIT_KEYS.includes(key) || STYLE_KEYS.includes(key)) : [],
    history: Array.isArray(src.history) ? src.history.slice(-100) : [],
    version: Math.max(1, Number(src.version) || 1),
  }
}

/** 长期慢演化：evidence 是 [-1,1] 的目标偏移；每天最多 evolutionPerDay。 */
export function evolvePersona(persona, evidence = {}, { config = {}, elapsedDays = 1, now = Date.now() } = {}) {
  const cfg = config.persona || {}
  if (cfg.evolutionEnabled === false) return persona
  const maxDelta = clamp(Number(cfg.evolutionPerDay ?? 0.005) * Math.max(0, elapsedDays), 0, 0.05)
  const next = deepClone(persona)
  const changes = []
  for (const key of TRAIT_KEYS) {
    if (next.locked.includes(key)) continue
    const delta = Number(evidence[key])
    if (!Number.isFinite(delta) || delta === 0) continue
    const bounded = clamp(delta, -1, 1) * maxDelta
    const before = next.traits[key]
    next.traits[key] = round(clamp(before + bounded, 0.1, 0.9), 4)
    if (next.traits[key] !== before) changes.push({ key, before, after: next.traits[key] })
  }
  if (changes.length) {
    next.version += 1
    next.history.push({ at: now, changes, reason: 'slow_evolution' })
    next.history = next.history.slice(-100)
  }
  return next
}

export function applyPersonaEdit(persona, patch = {}, { now = Date.now() } = {}) {
  const next = deepClone(persona)
  const changes = []
  for (const key of TRAIT_KEYS) {
    if (patch.traits?.[key] === undefined) continue
    const before = next.traits[key]
    next.traits[key] = round(clamp(Number(patch.traits[key]), 0.1, 0.9), 4)
    if (before !== next.traits[key]) changes.push({ key: `traits.${key}`, before, after: next.traits[key] })
  }
  for (const key of STYLE_KEYS) {
    if (patch.style?.[key] === undefined) continue
    const before = next.style[key]
    next.style[key] = round(clamp(Number(patch.style[key]), 0, 1), 4)
    if (before !== next.style[key]) changes.push({ key: `style.${key}`, before, after: next.style[key] })
  }
  if (Array.isArray(patch.values)) next.values = patch.values.map(String).slice(0, 30)
  if (Array.isArray(patch.locked)) next.locked = patch.locked.filter((key) => TRAIT_KEYS.includes(key) || STYLE_KEYS.includes(key))
  if (patch.locked) {
    for (const key of patch.locked) if (TRAIT_KEYS.includes(key) || STYLE_KEYS.includes(key)) {
      if (!next.locked.includes(key)) next.locked.push(key)
    }
  }
  if (patch.unlock) {
    next.locked = next.locked.filter((key) => !patch.unlock.includes(key))
  }
  if (changes.length || patch.values || patch.locked) {
    next.version += 1
    next.history.push({ at: now, changes, reason: patch.reason || 'user_edit' })
    next.history = next.history.slice(-100)
  }
  return { persona: next, changes }
}

export function personaSummary(persona) {
  const t = persona?.traits || {}
  return {
    openness: t.openness,
    humor: t.humor,
    caution: t.caution,
    socialInitiative: t.socialInitiative,
    warmth: persona?.style?.warmth,
    formality: persona?.style?.formality,
    values: Array.isArray(persona?.values) ? persona.values.slice(0, 8) : [],
    version: persona?.version || 1,
  }
}

export function createPersonaService({ store, getConfig, clock }) {
  function ensure() {
    const existing = store.get('persona', 'self')
    if (existing) return sanitizePersona(existing, getConfig()?.cognition || {})
    const persona = defaultPersona(getConfig()?.cognition || {})
    store.put('persona', 'self', persona)
    return persona
  }

  function get() { return ensure() }

  function save(next, reason = 'update') {
    const persona = sanitizePersona(next, getConfig()?.cognition || {})
    store.put('persona', 'self', { ...persona, reason, at: clock.now() })
    return persona
  }

  function edit(patch) {
    const result = applyPersonaEdit(ensure(), patch, { now: clock.now() })
    store.tx(() => save(result.persona, 'user_edit'))
    return { ...result, persona: store.get('persona', 'self') }
  }

  function maybeEvolve(evidence, elapsedDays = 1) {
    const before = ensure()
    const next = evolvePersona(before, evidence, { config: getConfig()?.cognition || {}, elapsedDays, now: clock.now() })
    if (next.version !== before.version) store.put('persona', 'self', next)
    store.put('state', 'persona.lastEvolutionAt', { at: clock.now(), elapsedDays })
    return next
  }

  function reset() {
    const persona = defaultPersona(getConfig()?.cognition || {})
    store.put('persona', 'self', persona)
    return persona
  }

  return { ensure, get, save, edit, maybeEvolve, reset, summary: () => personaSummary(ensure()) }
}
