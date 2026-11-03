// Bot 长期人格：稳定特质、价值边界、表达风格，以及操作者可编辑的文本人设。
// 状态独立于情绪/关系/技能；单次互动不能改变；演化有速率上限与历史。

import { clamp, deepClone, round } from './util.js'

export const TRAIT_KEYS = [
  'extraversion', 'openness', 'agreeableness', 'conscientiousness', 'emotionalSensitivity',
  'humor', 'socialInitiative', 'caution', 'expressiveness', 'conflictApproach',
  'riskTolerance', 'consistency',
]
export const STYLE_KEYS = ['formality', 'verbosity', 'emojiRate', 'punctuation', 'teasingBound', 'warmth']

export const PROFILE_TEXT_LIMITS = {
  displayName: 40,
  tagline: 120,
  identity: 300,
  background: 1500,
  personality: 1000,
  speakingStyle: 800,
  examples: 1500,
}
export const PROFILE_TEXT_FIELDS = Object.keys(PROFILE_TEXT_LIMITS)
export const PROFILE_LIST_FIELDS = ['likes', 'dislikes', 'boundaries']
export const PROFILE_LIST_MAX_ITEMS = 20
export const PROFILE_LIST_ITEM_MAX = 80
export const PROFILE_PROMPT_MAX_CHARS = 2000

const SINGLE_LINE_FIELDS = new Set(['displayName', 'tagline', 'identity'])

function cleanText(value, max, { multiline = false } = {}) {
  let text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
  if (!multiline) text = text.replace(/\s+/g, ' ')
  const chars = [...text]
  if (chars.length > max) text = chars.slice(0, max).join('').trimEnd()
  return text
}

function cleanList(value, maxItems = PROFILE_LIST_MAX_ITEMS, itemMax = PROFILE_LIST_ITEM_MAX) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const items = []
  for (const item of value) {
    const text = cleanText(item, itemMax)
    if (!text || seen.has(text)) continue
    seen.add(text)
    items.push(text)
    if (items.length >= maxItems) break
  }
  return items
}

export function defaultProfile(config = {}) {
  const source = config.persona?.profile && typeof config.persona.profile === 'object' ? config.persona.profile : {}
  const profile = {}
  for (const key of PROFILE_TEXT_FIELDS) profile[key] = cleanText(source[key], PROFILE_TEXT_LIMITS[key], { multiline: !SINGLE_LINE_FIELDS.has(key) })
  for (const key of PROFILE_LIST_FIELDS) profile[key] = cleanList(source[key])
  return profile
}

export function sanitizeProfile(input, config = {}) {
  const base = defaultProfile(config)
  const source = input && typeof input === 'object' ? input : {}
  const profile = {}
  for (const key of PROFILE_TEXT_FIELDS) {
    profile[key] = source[key] === undefined
      ? base[key]
      : cleanText(source[key], PROFILE_TEXT_LIMITS[key], { multiline: !SINGLE_LINE_FIELDS.has(key) })
  }
  for (const key of PROFILE_LIST_FIELDS) {
    profile[key] = source[key] === undefined ? base[key] : cleanList(source[key])
  }
  return profile
}

export function personaProfileText(profile, { maxChars = PROFILE_PROMPT_MAX_CHARS } = {}) {
  const p = profile || {}
  const lines = []
  if (p.displayName) lines.push(`名字/自称：${p.displayName}`)
  if (p.tagline) lines.push(`一句话介绍：${p.tagline}`)
  if (p.identity) lines.push(`身份：${p.identity}`)
  if (p.background) lines.push(`背景：${p.background}`)
  if (p.personality) lines.push(`性格：${p.personality}`)
  if (p.speakingStyle) lines.push(`说话风格：${p.speakingStyle}`)
  if (Array.isArray(p.likes) && p.likes.length) lines.push(`喜欢：${p.likes.join('、')}`)
  if (Array.isArray(p.dislikes) && p.dislikes.length) lines.push(`不喜欢：${p.dislikes.join('、')}`)
  if (Array.isArray(p.boundaries) && p.boundaries.length) lines.push(`边界/禁忌：${p.boundaries.join('、')}`)
  if (p.examples) lines.push(`示例对话（参考语气，不要照抄）：${p.examples}`)
  const text = lines.join('\n')
  const chars = [...text]
  const limit = Math.max(0, Number(maxChars) || PROFILE_PROMPT_MAX_CHARS)
  if (chars.length <= limit) return text
  return chars.slice(0, Math.max(0, limit - 1)).join('').trimEnd() + '…'
}

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
    profile: defaultProfile(config),
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
    profile: sanitizeProfile(src.profile, config),
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
  if (patch.profile && typeof patch.profile === 'object') {
    if (!next.profile || typeof next.profile !== 'object') next.profile = defaultProfile()
    for (const key of PROFILE_TEXT_FIELDS) {
      if (patch.profile[key] === undefined) continue
      const before = String(next.profile[key] || '')
      const after = cleanText(patch.profile[key], PROFILE_TEXT_LIMITS[key], { multiline: !SINGLE_LINE_FIELDS.has(key) })
      if (before !== after) {
        next.profile[key] = after
        changes.push({ key: `profile.${key}`, before, after })
      }
    }
    for (const key of PROFILE_LIST_FIELDS) {
      if (patch.profile[key] === undefined) continue
      const before = Array.isArray(next.profile[key]) ? next.profile[key] : []
      const after = cleanList(patch.profile[key])
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        next.profile[key] = after
        changes.push({ key: `profile.${key}`, before: [...before], after: [...after] })
      }
    }
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
  const profile = persona?.profile || {}
  return {
    openness: t.openness,
    humor: t.humor,
    caution: t.caution,
    socialInitiative: t.socialInitiative,
    warmth: persona?.style?.warmth,
    formality: persona?.style?.formality,
    values: Array.isArray(persona?.values) ? persona.values.slice(0, 8) : [],
    version: persona?.version || 1,
    profile: {
      displayName: profile.displayName || '',
      tagline: profile.tagline || '',
      identity: profile.identity || '',
      personality: profile.personality || '',
      speakingStyle: profile.speakingStyle || '',
      boundaries: Array.isArray(profile.boundaries) ? profile.boundaries.slice(0, 8) : [],
    },
    hasProfile: Object.values(profile).some((value) => Array.isArray(value) ? value.length > 0 : Boolean(String(value || '').trim())),
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
