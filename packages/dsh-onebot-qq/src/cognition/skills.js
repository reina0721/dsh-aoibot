// 技能系统：独立于人格/情绪/关系/策略的熟练度状态。
//
// 技能真实影响策略权重与表达约束；成功/失败/不用/压力都会改变有效值，
// 但安全能力不受影响。恢复比初学更快（savings）。

import { clamp, round, uid } from './util.js'

export const SKILL_DEFS = [
  { name: 'humor', label: '幽默表达', base: 0.5, tauDays: 60 },
  { name: 'teasing', label: '调侃尺度', base: 0.45, tauDays: 45 },
  { name: 'sarcasm', label: '反讽理解', base: 0.4, tauDays: 90 },
  { name: 'implication', label: '言外之意', base: 0.4, tauDays: 90 },
  { name: 'emotion_recognition', label: '情绪识别', base: 0.5, tauDays: 60 },
  { name: 'empathy', label: '共情回应', base: 0.45, tauDays: 60 },
  { name: 'group_participation', label: '群聊介入', base: 0.4, tauDays: 45 },
  { name: 'topic_continuity', label: '话题延续', base: 0.45, tauDays: 60 },
  { name: 'conflict_repair', label: '冲突修复', base: 0.35, tauDays: 90 },
  { name: 'retrieval', label: '知识检索', base: 0.5, tauDays: 60 },
  { name: 'source_verification', label: '来源验证', base: 0.45, tauDays: 90 },
  { name: 'situational_reasoning', label: '情境推理', base: 0.45, tauDays: 90 },
  { name: 'social_risk', label: '社交风险判断', base: 0.5, tauDays: 90 },
]

const TRANSFER = {
  humor: { teasing: 0.3 },
  teasing: { humor: 0.2, social_risk: 0.1 },
  empathy: { emotion_recognition: 0.2 },
  retrieval: { source_verification: 0.2 },
}

export function createSkillService({ store, getConfig, clock, log } = {}) {
  const cfg = () => getConfig()?.cognition || {}

  function ensureAll() {
    for (const def of SKILL_DEFS) {
      const id = `skill:${def.name}`
      if (store.get('skill', id)) continue
      store.put('skill', id, {
        id,
        name: def.name,
        label: def.label,
        baseMastery: def.base,
        effectiveMastery: def.base,
        confidence: 0.5,
        uses: 0,
        successes: 0,
        failures: 0,
        lastUsed: 0,
        decayTauDays: def.tauDays,
        transfer: TRANSFER[def.name] || {},
        updatedAt: clock.now(),
        version: 1,
      })
    }
  }
  ensureAll()

  function decayValue(skill, now) {
    const tau = Math.max(1, Number(skill.decayTauDays || 60)) * 24 * 60 * 60 * 1000
    const elapsed = Math.max(0, now - Number(skill.lastUsed || skill.updatedAt || now))
    if (!elapsed) return skill
    const decayed = skill.baseMastery + (skill.effectiveMastery - skill.baseMastery) * Math.exp(-elapsed / tau)
    return { ...skill, effectiveMastery: round(clamp(decayed, 0.05, 1), 4), updatedAt: now }
  }

  function list() {
    ensureAll()
    const now = clock.now()
    const stress = Number(store.get('emotion', 'self')?.stress || 0)
    return store.list('skill', { limit: 100 }).map((skill) => {
      const decayed = decayValue(skill, now)
      const stressPenalty = 1 - clamp(stress, 0, 1) * 0.2
      return {
        ...decayed,
        effectiveMastery: round(clamp(decayed.effectiveMastery * stressPenalty, 0.05, 1), 3),
        mastery: round(decayed.effectiveMastery, 3),
      }
    })
  }

  function get(name) {
    ensureAll()
    return list().find((item) => item.name === name) || null
  }

  function use(name, { success = null, reason = 'action' } = {}) {
    ensureAll()
    const id = `skill:${name}`
    const existing = store.get('skill', id)
    if (!existing) return null
    const now = clock.now()
    const decayed = decayValue(existing, now)
    const mastery = Number(decayed.effectiveMastery)
    const delta = success === true ? 0.04 * (1 - mastery) : success === false ? -0.05 * mastery : 0.01 * (1 - mastery)
    const next = decayed
    next.effectiveMastery = round(clamp(mastery + delta, 0.05, 1), 4)
    next.uses = (decayed.uses || 0) + 1
    next.successes = (decayed.successes || 0) + (success === true ? 1 : 0)
    next.failures = (decayed.failures || 0) + (success === false ? 1 : 0)
    next.lastUsed = now
    next.updatedAt = now
    next.version = (decayed.version || 1) + 1
    store.put('skill', id, next)
    for (const [related, weight] of Object.entries(decayed.transfer || {})) {
      const relatedId = `skill:${related}`
      const relatedRecord = store.get('skill', relatedId)
      if (!relatedRecord) continue
      const relatedNext = decayValue(relatedRecord, now)
      relatedNext.effectiveMastery = round(clamp(relatedNext.effectiveMastery + delta * weight, 0.05, 1), 4)
      relatedNext.updatedAt = now
      store.put('skill', relatedId, relatedNext)
    }
    store.put('skill_event', uid('skill_evt'), { skill: name, success, delta: round(delta, 4), reason, at: now })
    return next
  }

  function applyOutcome(decision, won = null) {
    if (!decision?.action) return
    const mapping = {
      tease: 'teasing', reply: 'topic_continuity', reply_short: 'topic_continuity',
      clarify: 'situational_reasoning', comfort: 'empathy', serious: 'emotion_recognition',
      recall_tease: 'teasing', recall_concern: 'empathy', recall_probe: 'social_risk',
      recall_silence: 'social_risk', silence: 'social_risk', wait: 'social_risk',
    }
    const skill = mapping[decision.action]
    if (skill) use(skill, { success: won, reason: `decision:${decision.action}` })
  }

  function summary() {
    const rows = list()
    return {
      average: round(rows.reduce((sum, item) => sum + item.effectiveMastery, 0) / Math.max(1, rows.length), 3),
      top: rows.slice().sort((a, b) => b.effectiveMastery - a.effectiveMastery).slice(0, 5),
      decayed: rows.filter((item) => item.effectiveMastery < item.baseMastery - 0.02).length,
    }
  }

  return { ensureAll, list, get, use, applyOutcome, summary }
}
