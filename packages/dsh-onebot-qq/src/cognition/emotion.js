// 情绪系统：OCC 评价 → PAD/离散情绪 → 衰减/调节/决策影响。
// 模拟状态，不声称主观体验；安全规则不因情绪降低。

import { clamp, deepClone, round } from './util.js'

export const DISCRETE = [
  'joy', 'sadness', 'anger', 'fear', 'anxiety', 'surprise',
  'pride', 'shame', 'gratitude', 'envy', 'disappointment', 'calm',
]

export function defaultEmotion() {
  return {
    id: 'self',
    valence: 0.05,
    arousal: 0.3,
    dominance: 0.55,
    stress: 0.2,
    fatigue: 0.1,
    moodValence: 0.1,
    discrete: Object.fromEntries(DISCRETE.map((key) => [key, 0])),
    appraisal: null,
    updatedAt: 0,
    version: 1,
  }
}

export function sanitizeEmotion(input) {
  const base = defaultEmotion()
  const src = input && typeof input === 'object' ? input : {}
  return {
    ...base,
    ...deepClone(src),
    id: 'self',
    valence: clamp(src.valence ?? base.valence, -1, 1),
    arousal: clamp(src.arousal ?? base.arousal, 0, 1),
    dominance: clamp(src.dominance ?? base.dominance, 0, 1),
    stress: clamp(src.stress ?? base.stress, 0, 1),
    fatigue: clamp(src.fatigue ?? base.fatigue, 0, 1),
    moodValence: clamp(src.moodValence ?? base.moodValence, -1, 1),
    discrete: Object.fromEntries(DISCRETE.map((key) => [key, clamp(src.discrete?.[key] ?? 0, 0, 1)])),
    version: Math.max(1, Number(src.version) || 1),
  }
}

function decayValue(value, baseline, elapsedMs, halfLifeMin) {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return value
  const tau = Math.max(1, Number(halfLifeMin) || 1) * 60 * 1000
  return baseline + (value - baseline) * Math.exp(-elapsedMs / tau)
}

/** 纯函数：按半衰期衰减到 now。 */
export function decayEmotion(emotion, now, config = {}) {
  const e = sanitizeEmotion(emotion)
  const updated = Number(e.updatedAt)
  const elapsed = Number.isFinite(updated) && updated > 0 ? Math.max(0, now - updated) : 0
  if (!elapsed) return e
  const cfg = config.emotion || {}
  const next = {
    ...e,
    valence: round(decayValue(e.valence, 0, elapsed, cfg.valenceHalfLifeMin), 4),
    arousal: round(decayValue(e.arousal, 0.3, elapsed, cfg.arousalHalfLifeMin), 4),
    dominance: round(decayValue(e.dominance, 0.55, elapsed, 180), 4),
    stress: round(decayValue(e.stress, 0.2, elapsed, cfg.stressHalfLifeMin), 4),
    moodValence: round(decayValue(e.moodValence, 0.1, elapsed, cfg.moodHalfLifeMin), 4),
    fatigue: round(decayValue(e.fatigue, 0.1, elapsed, 240), 4),
    updatedAt: now,
  }
  for (const key of DISCRETE) next.discrete[key] = round(decayValue(e.discrete[key], 0, elapsed, Math.max(cfg.valenceHalfLifeMin || 120, 30)), 4)
  return next
}

/** appraisal: { desirability, likelihood, agency, control, novelty, norm, relevance, intensity }，均 [-1,1] 或 [0,1]。 */
export function appraiseEmotion(emotion, appraisal = {}, { now = Date.now(), config = {}, source = 'turn' } = {}) {
  const cfg = config.emotion || {}
  const e = decayEmotion(emotion, now, config)
  const sensitivity = clamp(Number(cfg.sensitivity ?? 0.55), 0, 1)
  const desirability = clamp(appraisal.desirability ?? 0, -1, 1)
  const relevance = clamp(appraisal.relevance ?? 0.5, 0, 1)
  const intensity = clamp(appraisal.intensity ?? 0.5, 0, 1)
  const control = clamp(appraisal.control ?? 0.5, 0, 1)
  const norm = clamp(appraisal.norm ?? 0, -1, 1)
  const novelty = clamp(appraisal.novelty ?? 0, 0, 1)
  const deltaV = desirability * relevance * intensity * sensitivity * 0.55
  const deltaA = (novelty * 0.4 + Math.abs(desirability) * 0.35 + intensity * 0.25) * sensitivity * 0.5
  const deltaD = (control - 0.5) * 0.25 * sensitivity
  const deltaStress = (Math.abs(desirability) < 0 ? Math.abs(desirability) : 0) * relevance * sensitivity * 0.35 + (norm < 0 ? Math.abs(norm) * 0.15 : 0)
  const next = deepClone(e)
  next.valence = round(clamp(e.valence + deltaV, -1, 1), 4)
  next.arousal = round(clamp(e.arousal + deltaA, 0, 1), 4)
  next.dominance = round(clamp(e.dominance + deltaD, 0, 1), 4)
  next.stress = round(clamp(e.stress + deltaStress, 0, 1), 4)
  next.moodValence = round(clamp(e.moodValence * 0.82 + next.valence * 0.18, -1, 1), 4)
  const discrete = {}
  for (const key of DISCRETE) discrete[key] = 0
  if (desirability > 0.15) {
    discrete.joy = desirability * relevance
    if (appraisal.agency === 'other') discrete.gratitude = desirability * relevance * 0.9
    if (appraisal.agency === 'self') discrete.pride = desirability * relevance * 0.8
  }
  if (desirability < -0.15) {
    discrete.sadness = Math.abs(desirability) * relevance
    if (appraisal.agency === 'other') discrete.anger = Math.abs(desirability) * relevance * (1 - control) * 0.8
    if (appraisal.agency === 'self') discrete.shame = Math.abs(desirability) * relevance * 0.7
    if (appraisal.likelihood != null && appraisal.likelihood < 0.5) discrete.disappointment = Math.abs(desirability) * relevance * 0.7
  }
  if (novelty > 0.55 && Math.abs(desirability) < 0.35) discrete.surprise = novelty * 0.6
  if (appraisal.threat) { discrete.fear = clamp(appraisal.threat, 0, 1) * relevance; discrete.anxiety = clamp(appraisal.threat, 0, 1) * relevance * 0.8 }
  if (Math.abs(desirability) < 0.1) discrete.calm = 0.4 + (1 - e.arousal) * 0.3
  next.discrete = discrete
  next.appraisal = { ...appraisal, source, at: now }
  next.updatedAt = now
  next.version = (e.version || 1) + 1
  return next
}

/** 可见表达强度：调节会压低外显但不改变内部状态。 */
export function visibleEmotion(emotion, config = {}) {
  const regulation = clamp(Number(config.emotion?.regulation ?? 0.4), 0, 1)
  const intensity = Math.abs(emotion.valence) * 0.7 + emotion.arousal * 0.3
  return {
    valence: round(emotion.valence * (1 - regulation * 0.45), 4),
    arousal: round(emotion.arousal * (1 - regulation * 0.4), 4),
    stress: round(emotion.stress * (1 - regulation * 0.25), 4),
    intensity: round(intensity, 4),
    suppressed: regulation > 0.5,
  }
}

export function emotionPrompt(emotion) {
  const visible = visibleEmotion(emotion)
  const top = DISCRETE
    .map((key) => ({ key, value: emotion.discrete?.[key] || 0 }))
    .sort((a, b) => b.value - a.value)
    .filter((item) => item.value > 0.15)
    .slice(0, 3)
  return {
    valence: visible.valence,
    arousal: visible.arousal,
    stress: visible.stress,
    mood: emotion.moodValence,
    top: top.map((item) => ({ emotion: item.key, intensity: round(item.value, 2) })),
  }
}

export function createEmotionService({ store, getConfig, clock }) {
  function ensure() {
    const existing = store.get('emotion', 'self')
    if (existing) return sanitizeEmotion(existing)
    const emotion = { ...defaultEmotion(), updatedAt: clock.now() }
    store.put('emotion', 'self', emotion)
    return emotion
  }
  function get() {
    const current = decayEmotion(ensure(), clock.now(), getConfig()?.cognition || {})
    if (current.updatedAt !== ensure().updatedAt) store.put('emotion', 'self', current)
    return current
  }
  function appraise(appraisal, opts = {}) {
    const cfg = getConfig()?.cognition || {}
    const next = appraiseEmotion(ensure(), appraisal, { now: clock.now(), config: cfg, source: opts.source || 'turn' })
    store.tx(() => {
      store.put('emotion', 'self', next)
      store.put('emotion_event', `evt_${clock.now()}_${Math.random().toString(36).slice(2, 7)}`, {
        delta: { ...appraisal },
        appraisal,
        source: opts.source || 'turn',
        at: clock.now(),
        text: opts.text ? String(opts.text).slice(0, 500) : '',
      })
    })
    return next
  }
  function adjust({ valence, arousal, stress, fatigue }, reason = 'user') {
    const next = sanitizeEmotion({ ...ensure(), ...(valence != null ? { valence } : {}), ...(arousal != null ? { arousal } : {}), ...(stress != null ? { stress } : {}), ...(fatigue != null ? { fatigue } : {}) })
    next.updatedAt = clock.now()
    store.put('emotion', 'self', next)
    store.put('emotion_event', `evt_${clock.now()}_${Math.random().toString(36).slice(2, 7)}`, { source: 'manual', reason, at: clock.now() })
    return next
  }
  function reset() {
    const emotion = { ...defaultEmotion(), updatedAt: clock.now() }
    store.put('emotion', 'self', emotion)
    return emotion
  }
  return { ensure, get, appraise, adjust, reset, visible: () => visibleEmotion(get(), getConfig()?.cognition || {}), prompt: () => emotionPrompt(get()) }
}
