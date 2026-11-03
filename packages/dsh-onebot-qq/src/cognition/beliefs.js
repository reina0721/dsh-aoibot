// 信念：事实/推测/未知/冲突分离的概率化表示。
// 与记忆不同：belief 是「当前认为某命题为真的程度」，带证据与历史版本。

import { clamp, hashText, round, uid } from './util.js'

export function createBeliefService({ store, getConfig, clock } = {}) {
  function keyOf(subject, proposition, scopeType = 'global', scopeId = '') {
    return `belief:${hashText(`${subject}|${proposition}|${scopeType}|${scopeId}`, 20)}`
  }

  function list({ scopeType, scopeId, limit = 100, status } = {}) {
    return store.list('belief', {
      limit: Number(limit) || 100,
      where: (item) => (!status || item.status === status)
        && (!scopeType || (item.scopeType === scopeType && String(item.scopeId || '') === String(scopeId || ''))),
    })
  }

  /** evidenceWeight ∈ [-1,1]；logit 更新并保留历史。 */
  function upsert({ subject = '', proposition = '', probability = 0.5, evidenceWeight = 0, evidence = {}, status = 'hypothesis', scopeType = 'global', scopeId = '', source = '' } = {}) {
    if (!proposition) return null
    const id = keyOf(subject, proposition, scopeType, scopeId)
    const existing = store.get('belief', id)
    const prior = existing ? Number(existing.probability) : clamp(Number(probability), 0.02, 0.98)
    const logit = Math.log(prior / (1 - prior)) + clamp(Number(evidenceWeight) || 0, -2, 2)
    const nextProbability = round(clamp(1 / (1 + Math.exp(-logit)), 0.02, 0.98), 4)
    const record = {
      id,
      subject: String(subject).slice(0, 120),
      proposition: String(proposition).slice(0, 500),
      probability: nextProbability,
      previousProbability: existing ? existing.probability : null,
      evidence: [
        ...(Array.isArray(existing?.evidence) ? existing.evidence.slice(-8) : []),
        { ...evidence, weight: round(Number(evidenceWeight) || 0, 3), at: clock.now(), source: String(source).slice(0, 80) },
      ],
      status: ['fact', 'hypothesis', 'disputed', 'outdated'].includes(status) ? status : 'hypothesis',
      scopeType,
      scopeId: String(scopeId || ''),
      source: String(source).slice(0, 80),
      createdAt: existing?.createdAt || clock.now(),
      updatedAt: clock.now(),
      version: (existing?.version || 0) + 1,
    }
    store.put('belief', id, record)
    return record
  }

  function correct(id, { probability, status, reason = 'user' } = {}) {
    const existing = store.get('belief', id)
    if (!existing) return null
    const next = {
      ...existing,
      ...(probability != null ? { probability: clamp(Number(probability), 0.02, 0.98) } : {}),
      ...(status ? { status } : {}),
      correctedBy: reason,
      updatedAt: clock.now(),
      version: (existing.version || 1) + 1,
    }
    next.evidence = [...(existing.evidence || []).slice(-8), { type: 'correction', reason, at: clock.now(), weight: 0 }]
    store.put('belief', id, next)
    return next
  }

  return { list, upsert, correct, keyOf }
}
