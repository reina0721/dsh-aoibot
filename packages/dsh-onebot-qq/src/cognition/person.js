// 人物实体、平台身份与分层画像（facet）。
//
// 原则：平台账号 ≠ 真实人物；昵称/群名片只是身份证据。画像每项都带来源、
// 置信度、作用域、状态与版本；不把推测写成事实，不跨作用域泄漏。

import { clamp, round, uid } from './util.js'

export const FACET_KINDS = ['fact', 'self_report', 'observation', 'inference', 'hypothesis']
export const FACET_STATUS = ['active', 'outdated', 'disputed', 'deleted']

const DEFAULT_FACETS = [
  'language_style', 'interests', 'topics', 'activity_pattern', 'humor',
  'social_preference', 'important_experience', 'interaction_pattern', 'notes',
]

export function identityKey(platform, platformUserId) {
  return `${platform}:${platformUserId}`
}

export function createPersonService({ store, getConfig, clock }) {
  const cfg = () => getConfig()?.cognition || {}
  function findIdentity(platform, platformUserId) {
    return store.list('identity', { limit: 20, where: (item) => item.platform === platform && String(item.platformUserId) === String(platformUserId) })[0] || null
  }

  function ensurePerson({ platform = 'onebot11', platformUserId, nickname = '', card = '', scopeType = 'global', scopeId = '' } = {}) {
    if (!platformUserId) throw new Error('人物需要 platformUserId')
    const identity = findIdentity(platform, platformUserId)
    let person = identity ? store.get('person', identity.personId) : null
    if (!person) {
      const personId = uid('person')
      person = {
        id: personId,
        displayName: nickname || String(platformUserId),
        aliases: nickname ? [nickname] : [],
        status: 'active',
        firstSeen: clock.now(),
        lastSeen: clock.now(),
        version: 1,
      }
      store.put('person', personId, person)
      const id = uid('identity')
      store.put('identity', id, {
        id,
        personId,
        platform,
        platformUserId: String(platformUserId),
        scopeType,
        scopeId,
        nickname,
        card,
        confidence: 1,
        evidenceKind: 'fact',
        status: 'active',
        firstSeen: clock.now(),
        lastSeen: clock.now(),
        version: 1,
      })
      return { person, identity: store.get('identity', id), created: true }
    }
    const identities = store.list('identity', { where: (item) => item.personId === person.id, limit: 50 })
    const matched = identities.find((item) => item.platform === platform && String(item.platformUserId) === String(platformUserId))
    if (matched) {
      const next = { ...matched, nickname: nickname || matched.nickname, card: card || matched.card, lastSeen: clock.now(), version: (matched.version || 1) + 1 }
      store.put('identity', matched.id, next)
      person = store.put('person', person.id, { ...person, displayName: person.displayName || nickname || person.displayName, aliases: [...new Set([...(person.aliases || []), ...(nickname ? [nickname] : [])])].slice(0, 20), lastSeen: clock.now(), version: (person.version || 1) + 1 })
    }
    return { person, identity: matched, created: false }
  }

  function addFacet({ personId, facet, value, evidenceKind = 'observation', scopeType = 'global', scopeId = '', confidence = 0.5, sourceKind = 'turn', sourceRef = '', note = '' } = {}) {
    if (!personId || !facet) throw new Error('facet 需要 personId/facet')
    const valueText = String(value ?? '').trim().slice(0, 2000)
    if (!valueText) return null
    const kind = FACET_KINDS.includes(evidenceKind) ? evidenceKind : 'observation'
    const conf = clamp(Number(confidence) || 0.5, 0, 1)
    const existing = store.list('person_facet', {
      limit: 50,
      where: (item) => item.personId === personId
        && item.facet === facet
        && item.status !== 'deleted'
        && item.scopeType === scopeType
        && String(item.scopeId || '') === String(scopeId || ''),
    })
    const same = existing.find((item) => item.value === valueText)
    if (same) {
      const next = { ...same, confidence: round(clamp(Math.max(same.confidence || conf, conf) + 0.05, 0, 1), 3), lastSeen: clock.now(), sourceRef: sourceRef || same.sourceRef, version: (same.version || 1) + 1 }
      store.put('person_facet', same.id, next)
      return { facet: next, action: 'reinforced' }
    }
    const stronger = existing.find((item) => item.status === 'active' && (item.confidence || 0) > conf + 0.15)
    let action = 'added'
    let conflict = null
    if (stronger && kind !== 'fact' && kind !== 'self_report') {
      conflict = 'existing_higher_confidence'
      action = 'disputed'
    } else {
      for (const item of existing.filter((entry) => entry.status === 'active')) {
        store.put('person_facet', item.id, { ...item, status: 'outdated', outdatedAt: clock.now(), version: (item.version || 1) + 1 })
      }
      action = existing.length ? 'replaced' : 'added'
    }
    const id = uid('facet')
    const facetRecord = {
      id,
      personId,
      facet,
      value: valueText,
      evidenceKind: kind,
      scopeType,
      scopeId: String(scopeId || ''),
      confidence: conf,
      sourceKind,
      sourceRef: String(sourceRef || ''),
      note: String(note || ''),
      status: action === 'disputed' ? 'disputed' : 'active',
      firstSeen: clock.now(),
      lastSeen: clock.now(),
      version: 1,
    }
    store.put('person_facet', id, facetRecord)
    return { facet: facetRecord, action, conflict }
  }

  function facets(personId, { scopeType, scopeId, includeDeleted = false } = {}) {
    return store.list('person_facet', {
      limit: 500,
      where: (item) => item.personId === personId
        && (includeDeleted || item.status !== 'deleted')
        && (!scopeType || item.scopeType === scopeType)
        && (scopeType !== 'group' || String(item.scopeId || '') === String(scopeId || '')),
    })
  }

  function correctFacet(id, patch = {}) {
    const existing = store.get('person_facet', id)
    if (!existing) return null
    const next = {
      ...existing,
      ...(patch.value != null ? { value: String(patch.value).slice(0, 2000) } : {}),
      ...(patch.status && FACET_STATUS.includes(patch.status) ? { status: patch.status } : {}),
      confidence: patch.confidence != null ? clamp(Number(patch.confidence), 0, 1) : existing.confidence,
      correctedAt: clock.now(),
      correctedBy: patch.actor || 'ui',
      version: (existing.version || 1) + 1,
    }
    store.put('person_facet', id, next)
    return next
  }

  function deleteFacet(id) {
    return correctFacet(id, { status: 'deleted', confidence: 0 })
  }

  function findPersonByPlatform(platform, platformUserId) {
    const identity = findIdentity(platform, platformUserId)
    return identity ? store.get('person', identity.personId) : null
  }

  function listPersons({ query = '', limit = 50, scopeType, scopeId } = {}) {
    const q = String(query || '').trim().toLowerCase()
    const persons = store.list('person', { limit: 500, where: (item) => item.status !== 'deleted' })
    const filtered = q ? persons.filter((item) => String(item.displayName || '').toLowerCase().includes(q) || (item.aliases || []).some((alias) => String(alias).toLowerCase().includes(q))) : persons
    return filtered.slice(0, Math.max(1, Math.min(200, Number(limit) || 50))).map((person) => {
      const identities = store.list('identity', { limit: 20, where: (item) => item.personId === person.id })
      const facetCount = store.list('person_facet', { limit: 500, where: (item) => item.personId === person.id && item.status === 'active' }).length
      return {
        ...person,
        identities: identities.map((item) => ({ id: item.id, platform: item.platform, platformUserId: item.platformUserId, nickname: item.nickname, card: item.card, confidence: item.confidence })),
        facetCount,
      }
    })
  }

  function detail(personId) {
    const person = store.get('person', personId)
    if (!person) return null
    return {
      person,
      identities: store.list('identity', { limit: 50, where: (item) => item.personId === personId }),
      facets: facets(personId, { includeDeleted: false }),
      recentFacets: facets(personId, { includeDeleted: true }).slice(-20),
    }
  }

  return { ensurePerson, findPersonByPlatform, addFacet, facets, correctFacet, deleteFacet, listPersons, detail, DEFAULT_FACETS }
}
