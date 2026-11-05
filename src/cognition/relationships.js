// 多维、有向、情境化关系。
//
// 不是单一好感度。全局/群/私聊作用域各自保存；变化有惯性，冲突升快降慢，
// 修复需要重复反向证据。每次关键变化写 relationship_event 以支持追溯。

import { clamp, round, uid } from './util.js'

export const DIMENSIONS = ['affinity', 'familiarity', 'trust', 'intimacy', 'respect', 'wariness', 'conflict', 'comfort', 'initiative', 'stability']
export const REL_DEFAULTS = {
  affinity: 0.05,
  familiarity: 0.05,
  trust: 0.3,
  intimacy: 0.05,
  respect: 0.4,
  wariness: 0.1,
  conflict: 0.05,
  comfort: 0.5,
  initiative: 0.3,
  stability: 0.5,
}

export function relKey(personId, scopeType = 'global', scopeId = '') {
  return `${personId}:${scopeType}:${scopeId || ''}`
}

export function defaultRelationship(personId, scopeType = 'global', scopeId = '') {
  return {
    id: relKey(personId, scopeType, scopeId),
    personId,
    scopeType,
    scopeId: String(scopeId || ''),
    ...REL_DEFAULTS,
    interactions: 0,
    lastInteractionAt: 0,
    createdAt: 0,
    updatedAt: 0,
    version: 1,
  }
}

export function sanitizeRelationship(input, personId, scopeType = 'global', scopeId = '') {
  const base = defaultRelationship(personId, scopeType, scopeId)
  const src = input && typeof input === 'object' ? input : {}
  const out = { ...base, ...src, id: base.id, personId, scopeType, scopeId: String(scopeId || '') }
  for (const dimension of DIMENSIONS) out[dimension] = round(clamp(src[dimension] ?? base[dimension], -1, 1), 4)
  return out
}

/**
 * evidence 每维目标方向：affinity/trust/respect/comfort/initiative 用 [-1,1] 变动，
 * conflict/wariness 用 [0,1] 增减，familiarity/intimacy/stability 用 [0,1] 目标增量。
 */
export function updateRelationship(rel, evidence = {}, { config = {}, now = Date.now(), reason = 'interaction', source = '' } = {}) {
  const cfg = config.relationship || {}
  const baseLr = clamp(Number(cfg.learningRate ?? 0.15), 0.01, 0.5)
  const inertia = clamp(Number(cfg.inertia ?? 0.85), 0.1, 0.99)
  const next = { ...rel }
  const before = { ...rel }
  const changes = []
  const sourceWeight = clamp(Number(evidence.confidence ?? 1), 0, 1)
  const contextFactor = clamp(Number(evidence.contextFactor ?? 1), 0, 1)
  const delta = (key, target, rate = baseLr) => {
    const current = Number(next[key])
    const desired = Number(target)
    if (!Number.isFinite(desired)) return
    const step = clamp((desired - current) * rate * sourceWeight * contextFactor * (1 - inertia * 0.25), -0.2, 0.2)
    next[key] = round(clamp(current + step, -1, 1), 4)
    if (Math.abs(next[key] - current) > 0.0005) changes.push({ field: key, before: current, after: next[key] })
  }
  if (evidence.affinity != null) delta('affinity', evidence.affinity)
  if (evidence.trust != null) delta('trust', evidence.trust, Number(cfg.trustRate ?? 0.07))
  if (evidence.respect != null) delta('respect', evidence.respect, 0.1)
  if (evidence.comfort != null) delta('comfort', evidence.comfort, 0.1)
  if (evidence.initiative != null) delta('initiative', evidence.initiative, 0.08)
  if (evidence.familiarity != null) {
    const current = Number(next.familiarity)
    const step = clamp(Number(evidence.familiarity) * baseLr * 0.5 * sourceWeight, 0, 0.08)
    next.familiarity = round(clamp(current + step, 0, 1), 4)
    if (next.familiarity !== current) changes.push({ field: 'familiarity', before: current, after: next.familiarity })
  }
  if (evidence.intimacy != null) {
    const current = Number(next.intimacy)
    const step = clamp(Number(evidence.intimacy) * baseLr * 0.25 * sourceWeight * contextFactor, -0.08, 0.08)
    next.intimacy = round(clamp(current + step, 0, 1), 4)
    if (next.intimacy !== current) changes.push({ field: 'intimacy', before: current, after: next.intimacy })
  }
  if (evidence.conflict != null) {
    const current = Number(next.conflict)
    const desired = clamp(Number(evidence.conflict), 0, 1)
    const rate = desired > current ? Number(cfg.conflictRise ?? 0.2) : Number(cfg.conflictDecay ?? 0.03)
    next.conflict = round(clamp(current + (desired - current) * rate * sourceWeight, 0, 1), 4)
    if (next.conflict !== current) changes.push({ field: 'conflict', before: current, after: next.conflict })
  }
  if (evidence.wariness != null) {
    const current = Number(next.wariness)
    const desired = clamp(Number(evidence.wariness), 0, 1)
    next.wariness = round(clamp(current + (desired - current) * 0.12 * sourceWeight, 0, 1), 4)
    if (next.wariness !== current) changes.push({ field: 'wariness', before: current, after: next.wariness })
  }
  if (evidence.stability != null) {
    const current = Number(next.stability)
    next.stability = round(clamp(current + Number(evidence.stability) * 0.08, 0, 1), 4)
    if (next.stability !== current) changes.push({ field: 'stability', before: current, after: next.stability })
  }
  // 冲突高会压低 comfort/trust；信任提升会轻微降低 wariness。
  if (next.conflict > 0.55) {
    const beforeComfort = next.comfort
    next.comfort = round(clamp(next.comfort - 0.02 * sourceWeight, 0, 1), 4)
    if (next.comfort !== beforeComfort) changes.push({ field: 'comfort', before: beforeComfort, after: next.comfort })
  }
  if (evidence.repair) {
    next.wariness = round(clamp(next.wariness - 0.03 * clamp(Number(evidence.repair), 0, 1), 0, 1), 4)
    next.conflict = round(clamp(next.conflict - 0.04 * clamp(Number(evidence.repair), 0, 1), 0, 1), 4)
    changes.push({ field: 'repair', before: before.conflict, after: next.conflict })
  }
  next.interactions = (rel.interactions || 0) + 1
  next.lastInteractionAt = now
  next.updatedAt = now
  next.version = (rel.version || 1) + 1
  return { relationship: next, changes, reason, source, before }
}

export function describeRelationship(rel) {
  if (!rel) return null
  return {
    id: rel.id,
    personId: rel.personId,
    scopeType: rel.scopeType,
    scopeId: rel.scopeId,
    dimensions: Object.fromEntries(DIMENSIONS.map((key) => [key, rel[key]])),
    summary: relationshipSummary(rel),
    interactions: rel.interactions || 0,
    lastInteractionAt: rel.lastInteractionAt || 0,
    version: rel.version || 1,
  }
}

export function relationshipSummary(rel) {
  const tags = []
  if ((rel.interactions || 0) <= 1) tags.push('初识')
  if (rel.familiarity > 0.06) tags.push('初步熟悉')
  if (rel.trust > 0.65) tags.push('信任')
  if (rel.familiarity > 0.6) tags.push('熟悉')
  if (rel.intimacy > 0.55) tags.push('亲近')
  if (rel.wariness > 0.5) tags.push('戒备')
  if (rel.conflict > 0.4) tags.push('有摩擦')
  if (rel.affinity > 0.55) tags.push('好感')
  if (rel.affinity < -0.2) tags.push('疏远')
  return tags
}

export function createRelationshipService({ store, getConfig, clock }) {
  const cfg = () => getConfig()?.cognition || {}
  function ensure(personId, scopeType = 'global', scopeId = '') {
    const id = relKey(personId, scopeType, scopeId)
    const existing = store.get('relationship', id)
    if (existing) return sanitizeRelationship(existing, personId, scopeType, scopeId)
    const rel = { ...defaultRelationship(personId, scopeType, scopeId), createdAt: clock.now(), updatedAt: clock.now() }
    store.put('relationship', id, rel)
    return rel
  }

  function getMerged(personId, { scopeType = 'global', scopeId = '' } = {}) {
    const global = ensure(personId, 'global', '')
    if (scopeType === 'global') return global
    return ensure(personId, scopeType, scopeId) || global
  }

  function update(personId, evidence, { scopeType = 'global', scopeId = '', reason = 'interaction', source = '' } = {}) {
    const current = ensure(personId, scopeType, scopeId)
    const { relationship, changes } = updateRelationship(current, evidence, { config: cfg(), now: clock.now(), reason, source })
    if (!changes.length) return { relationship: current, changes: [] }
    store.tx(() => {
      store.put('relationship', relationship.id, relationship)
      store.put('relationship_event', uid('rel_evt'), {
        personId,
        relationshipId: relationship.id,
        scopeType,
        scopeId: String(scopeId || ''),
        changes,
        reason,
        source,
        at: clock.now(),
        before: Object.fromEntries(changes.map((item) => [item.field, item.before])),
        after: Object.fromEntries(changes.map((item) => [item.field, item.after])),
      })
    })
    return { relationship, changes }
  }

  function history(personId, { limit = 50 } = {}) {
    return store.list('relationship_event', { limit: Number(limit) || 50, where: (item) => item.personId === personId })
  }

  function list({ scopeType, scopeId } = {}) {
    const rows = store.list('relationship', { limit: 1000, where: (item) => !scopeType || (item.scopeType === scopeType && String(item.scopeId || '') === String(scopeId || '')) })
    return rows.map(describeRelationship)
  }

  function adjust(personId, patch, reason = 'manual') {
    const current = ensure(personId, patch.scopeType || 'global', patch.scopeId || '')
    const next = sanitizeRelationship({ ...current, ...patch }, personId, current.scopeType, current.scopeId)
    next.updatedAt = clock.now()
    next.version = (current.version || 1) + 1
    store.put('relationship', next.id, next)
    store.put('relationship_event', uid('rel_evt'), { personId, relationshipId: next.id, changes: [{ field: 'manual', before: current, after: next }], reason, at: clock.now(), source: 'ui' })
    return next
  }

  return { ensure, getMerged, update, history, list, adjust, describe: describeRelationship }
}
