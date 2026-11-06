// 记忆网络：工作记忆 + 情景/语义/情绪/人物/程序记忆 + 关联检索 + 巩固/遗忘。
//
// 检索是多种信号的加权组合，不是单一向量相似度；默认词法+FTS+关联图。
// 遗忘只降低检索权重/状态，不删除行；显式删除才真正清理。

import { clamp, deepClone, estimateTokens, round, scopeAllows, tokenize, uid, hashText } from './util.js'

export const MEMORY_TYPES = ['episodic', 'semantic', 'emotional', 'social', 'procedural', 'self']

export function memoryText(memory) {
  return String(memory?.summary || memory?.content || '')
}

export function defaultScope(chatType, chatId) {
  if (chatType === 'private') return { scopeType: 'private', scopeId: String(chatId || '') }
  if (chatType === 'group') return { scopeType: 'group', scopeId: String(chatId || '') }
  return { scopeType: 'global', scopeId: '' }
}

export function importanceOf(turn, emotion = {}, config = {}) {
  const text = String(turn?.text || '')
  let score = 0.25
  if (turn?.addressed) score += 0.12
  if (text.length > 40) score += 0.08
  if (text.length > 160) score += 0.06
  if (Array.isArray(turn?.messages) && turn.messages.some((message) => (message.images || []).length)) score += 0.08
  if (text.includes('记住') || text.includes('重要') || text.includes('别忘')) score += 0.2
  if (/[？?]/.test(text)) score += 0.05
  score += Math.abs(Number(emotion.valence) || 0) * 0.15
  score += (Number(emotion.arousal) || 0) * 0.1
  score += (Number(emotion.stress) || 0) * 0.05
  return round(clamp(score, 0.05, 1), 3)
}

export function salienceOf(turn, emotion = {}) {
  const text = String(turn?.text || '')
  let score = 0.2 + Math.min(0.3, [...text].length / 300)
  if (turn?.addressed) score += 0.1
  if (Math.abs(emotion.valence || 0) > 0.4) score += 0.1
  return round(clamp(score, 0, 1), 3)
}

export function recencyScore(createdAt, now, halfLifeDays = 30) {
  const age = Math.max(0, now - Number(createdAt || now))
  const tau = Math.max(1, Number(halfLifeDays) || 30) * 24 * 60 * 60 * 1000
  return Math.exp(-age / tau)
}

export function relevanceScore(query, text) {
  const q = [...new Set(tokenize(query).filter((token) => token.length > 0))]
  if (!q.length) return 0
  const t = new Set(tokenize(text))
  let hits = 0
  for (const token of q) if (t.has(token)) hits += 1
  return hits / q.length
}

export function emotionCongruence(memory, emotion) {
  const v = Number(memory?.valence || 0)
  const target = Number(emotion?.valence || 0)
  return clamp(1 - Math.abs(v - target) / 2, 0, 1)
}

export function createMemoryService({ store, getConfig, clock, log, embedder = null } = {}) {
  const cfg = () => getConfig()?.cognition || {}
  const working = new Map() // chatKey -> { turn, personId, scope, goal, candidates, updatedAt }

  function workingSet(chatKey, patch) {
    const prev = working.get(chatKey) || {}
    const next = { ...prev, ...patch, updatedAt: clock.now() }
    working.set(chatKey, next)
    if (working.size > 100) working.delete(working.keys().next().value)
    return next
  }
  function workingGet(chatKey) { return working.get(chatKey) || null }

  function encodeTurn(turn, { personId = '', emotion = {}, scope = null, source = 'turn' } = {}) {
    if (!turn?.text && !(turn?.messages || []).length) return null
    const memoryScope = scope || defaultScope(turn.chatType, turn.chatId)
    const content = String(turn.text || '').trim()
    if (!content) return null
    const importance = importanceOf(turn, emotion, cfg())
    const salience = salienceOf(turn, emotion)
    const id = uid('mem')
    const memory = {
      id,
      type: 'episodic',
      scopeType: memoryScope.scopeType,
      scopeId: memoryScope.scopeId,
      personId: personId || '',
      chatType: turn.chatType,
      chatId: String(turn.chatId || ''),
      content,
      summary: content.slice(0, 500),
      text: content,
      salience,
      importance,
      confidence: 1,
      valence: Number(emotion.valence || 0),
      arousal: Number(emotion.arousal || 0),
      sourceEventIds: turn.messageIds || [],
      sourceTurnId: turn.id || '',
      source,
      stability: 0.5,
      accessCount: 0,
      lastAccessed: 0,
      status: 'active',
      createdAt: clock.now(),
      updatedAt: clock.now(),
      version: 1,
    }
    store.put('memory', id, memory)
    linkRelated(memory, turn)
    maybeConsolidate(personId, memoryScope)
    return memory
  }

  function linkRelated(memory, turn) {
    const candidates = store.list('memory', {
      limit: 30,
      where: (item) => item.id !== memory.id
        && item.status === 'active'
        && (item.scopeType === memory.scopeType && String(item.scopeId || '') === String(memory.scopeId || ''))
        && (item.personId === memory.personId || !memory.personId),
    })
    const tokens = new Set(tokenize(memory.content))
    const scored = candidates.map((item) => {
      const other = new Set(tokenize(item.content))
      let overlap = 0
      for (const token of tokens) if (other.has(token)) overlap += 1
      return { item, score: overlap + (item.personId && item.personId === memory.personId ? 2 : 0) + (item.sourceTurnId === memory.sourceTurnId ? 2 : 0) }
    }).filter((entry) => entry.score > 1).sort((a, b) => b.score - a.score).slice(0, 5)
    for (const { item, score } of scored) {
      const id = `${memory.id}>${item.id}`
      store.put('memory_link', id, {
        id,
        fromId: memory.id,
        toId: item.id,
        relation: item.personId && item.personId === memory.personId ? 'same_person' : 'same_topic',
        weight: round(clamp(score / 10, 0.1, 1), 3),
        confidence: 0.6,
        source: 'cooccurrence',
        createdAt: clock.now(),
      })
    }
  }

  function activatedIds(seedIds, depth = 2) {
    const activated = new Map()
    let frontier = [...seedIds]
    for (let d = 0; d < depth; d += 1) {
      const next = []
      for (const id of frontier) {
        const links = store.list('memory_link', { limit: 50, where: (item) => item.fromId === id || item.toId === id })
        for (const link of links) {
          const other = link.fromId === id ? link.toId : link.fromId
          const weight = Number(link.weight) * 0.5 ** d
          if (!activated.has(other) || activated.get(other) < weight) {
            activated.set(other, weight)
            next.push(other)
          }
        }
      }
      frontier = next
    }
    return activated
  }

  /**
   * 检索：query + person/scope/emotion/relationship；返回带来源与分数的记忆。
   */
  function retrieve({ query = '', personId = '', scope = { scopeType: 'global', scopeId: '' }, emotion = {}, relationship = null, now = clock.now(), limit = null, maxChars = null } = {}, recordAccess = true) {
    const c = cfg()
    const topK = Number(limit || c.memory?.retrievalTopK || 8)
    const budgetChars = Number(maxChars || c.memory?.maxContextChars || 4000)
    const weights = {
      recency: Number(c.memory?.recencyWeight ?? 0.3),
      importance: Number(c.memory?.importanceWeight ?? 0.25),
      relevance: Number(c.memory?.relevanceWeight ?? 0.25),
      emotion: Number(c.memory?.emotionWeight ?? 0.1),
      relationship: Number(c.memory?.relationshipWeight ?? 0.05),
      association: Number(c.memory?.associationWeight ?? 0.05),
    }
    const searchHits = query ? store.search('memory', query, Math.max(topK * 3, 20)) : []
    const hitMap = new Map(searchHits.map((hit) => [hit.id, hit.score]))
    let candidates = store.list('memory', {
      limit: 300,
      where: (item) => item.status === 'active' && scopeVisible(item, scope, c),
    })
    if (!candidates.length) return []
    if (personId) {
      const personal = candidates.filter((item) => !item.personId || item.personId === personId)
      if (personal.length) candidates = personal
    }
    const seeds = searchHits.map((hit) => hit.id)
    const activated = activatedIds(seeds, 2)
    const scored = candidates.map((memory) => {
      const relevance = hitMap.get(memory.id) ?? relevanceScore(query, memoryText(memory))
      const recency = recencyScore(memory.createdAt || memory.updatedAt, now, c.memory?.recencyHalfLifeDays || 30)
      const congruence = emotionCongruence(memory, emotion)
      const relationBoost = relationship ? clamp(Number(relationship.trust || 0) * 0.5 + Number(relationship.affinity || 0) * 0.5, 0, 1) : 0.5
      const association = activated.get(memory.id) || 0
      const score = weights.recency * recency
        + weights.importance * Number(memory.importance || 0.3)
        + weights.relevance * relevance
        + weights.emotion * congruence
        + weights.relationship * relationBoost
        + weights.association * association
      return { memory, score: round(score, 4), signals: { relevance: round(relevance, 3), recency: round(recency, 3), congruence: round(congruence, 3), association: round(association, 3) } }
    }).filter((item) => item.score > 0.02 || item.signals.relevance > 0)
      .sort((a, b) => b.score - a.score)
    const selected = []
    let chars = 0
    for (const item of scored) {
      const text = memoryText(item.memory)
      if (selected.length >= topK) break
      if (chars + text.length > budgetChars && selected.length > 0) continue
      selected.push(item)
      chars += text.length
      if (chars >= budgetChars) break
    }
    if (recordAccess) reinforce(selected, now)
    return selected
  }

  function reinforce(selected, now) {
    if (selected.length) {
      store.tx(() => {
        for (const item of selected) {
          const memory = item.memory
          const next = {
            ...memory,
            accessCount: (memory.accessCount || 0) + 1,
            lastAccessed: now,
            stability: round(clamp(Number(memory.stability || 0.5) + 0.04, 0, 1), 3),
            updatedAt: now,
            version: (memory.version || 1) + 1,
          }
          store.put('memory', memory.id, next)
        }
      })
    }
  }

  async function retrieveAsync(params = {}) {
    if (!embedder || !String(params.query || '').trim()) return retrieve(params)
    try {
      if (!embedder.enabled()) return retrieve(params)
    } catch {
      log?.debug?.('记忆 embedding 回退词法检索')
      return retrieve(params)
    }
    const c = cfg()
    const requestedLimit = Math.max(1, Math.floor(Number(params.limit || c.memory?.retrievalTopK || 8)))
    const budgetChars = Number(params.maxChars || c.memory?.maxContextChars || 4000)
    const now = params.now ?? clock.now()
    const personaId = store.currentPersonaId?.()
    // 候选阶段只读；成功或回退仅强化最终选中的记忆一次。
    const candidates = retrieve({ ...params, now, limit: Math.max(3 * requestedLimit, 24) }, false)
    if (!candidates.length) return []
    let ranked
    try {
      const similarities = []
      // 每次最多 32 条（query + 31 个候选），大候选集分批。
      for (let i = 0; i < candidates.length; i += 31) {
        const batch = candidates.slice(i, i + 31)
        const scores = await embedder.similarity(params.query, batch.map((item) => memoryText(item.memory)))
        if (!Array.isArray(scores) || scores.length !== batch.length || scores.some((score) => !Number.isFinite(score) || score < -1 || score > 1)) throw new Error('invalid similarity')
        similarities.push(...scores)
      }
      const rawWeight = Number(c.memory?.embedding?.weight ?? 0.35)
      const weight = Number.isFinite(rawWeight) ? clamp(rawWeight, 0, 1) : 0.35
      ranked = candidates.map((item, i) => ({
        ...item,
        score: (1 - weight) * item.score + weight * similarities[i],
        signals: { ...item.signals, embedding: similarities[i] },
      })).sort((a, b) => b.score - a.score)
    } catch {
      log?.debug?.('记忆 embedding 回退词法检索')
      return retrieve(params)
    }
    // 等待期间切换人格、删除/编辑/强化记忆时，重新词法检索，避免旧快照覆盖新状态。
    if (store.currentPersonaId?.() !== personaId || candidates.some(({ memory }) => {
      const current = store.get('memory', memory.id)
      return !current || current.version !== memory.version || current.status !== memory.status
        || memoryText(current) !== memoryText(memory)
    })) return retrieve(params)
    const selected = []
    let chars = 0
    for (const item of ranked) {
      const length = memoryText(item.memory).length
      if (selected.length >= requestedLimit) break
      if (chars + length > budgetChars) continue
      selected.push(item)
      chars += length
    }
    reinforce(selected, now)
    return selected
  }

  function scopeVisible(memory, scope, config) {
    if (!memory) return false
    if (memory.status !== 'active') return false
    if (memory.scopeType === 'global') return true
    if (config?.privacy?.privateIsolation !== false) {
      return memory.scopeType === scope.scopeType && String(memory.scopeId || '') === String(scope.scopeId || '')
    }
    return scopeAllows({ scopeType: memory.scopeType, scopeId: memory.scopeId }, scope) || memory.scopeType === 'global'
  }

  function maybeConsolidate(personId, scope, { force = false } = {}) {
    const threshold = force ? 1 : Math.max(5, Number(cfg().memory?.consolidateEvery || 25))
    const episodes = store.list('memory', {
      limit: threshold + 10,
      where: (item) => item.type === 'episodic' && item.status === 'active'
        && (personId ? item.personId === personId : !item.personId)
        && item.scopeType === scope.scopeType && String(item.scopeId || '') === String(scope.scopeId || ''),
    })
    if (episodes.length < threshold) return null
    const existing = store.list('memory', { limit: 5, where: (item) => item.type === 'semantic' && item.personId === (personId || '') && item.scopeType === scope.scopeType && String(item.scopeId || '') === String(scope.scopeId || '') })[0]
    const recent = episodes.slice(0, Math.min(12, episodes.length))
    const summary = recent.map((item) => memoryText(item)).join('；').slice(0, 900)
    const id = existing?.id || uid('mem')
    const semantic = {
      id,
      type: 'semantic',
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      personId: personId || '',
      chatType: recent[0]?.chatType || '',
      chatId: recent[0]?.chatId || '',
      content: summary,
      summary,
      text: summary,
      importance: Math.max(0.4, ...recent.map((item) => Number(item.importance || 0.3))),
      salience: 0.5,
      confidence: 0.6,
      sourceEventIds: [...new Set(recent.flatMap((item) => item.sourceEventIds || []))].slice(0, 50),
      sourceTurnIds: recent.map((item) => item.sourceTurnId).filter(Boolean),
      status: 'active',
      createdAt: existing?.createdAt || clock.now(),
      updatedAt: clock.now(),
      version: (existing?.version || 0) + 1,
      consolidatedFrom: recent.map((item) => item.id),
    }
    store.tx(() => {
      store.put('memory', id, semantic)
      for (const episode of recent) {
        store.put('memory', episode.id, { ...episode, stability: round(clamp(Number(episode.stability || 0.5) - 0.05, 0, 1), 3), consolidatedAt: clock.now(), version: (episode.version || 1) + 1 })
      }
      for (const episode of recent) {
        const linkId = `${episode.id}>${id}:consolidated`
        store.put('memory_link', linkId, { id: linkId, fromId: episode.id, toId: id, relation: 'consolidated_into', weight: 0.7, confidence: 0.7, source: 'consolidation', createdAt: clock.now() })
      }
    })
    log?.debug?.('记忆巩固完成', personId || '(anonymous)', summary.length)
    return semantic
  }

  /** 扫描所有作用域，按阈值巩固；force 用于面板手动整理。 */
  function consolidateAll({ force = false, limit = 200 } = {}) {
    const episodes = store.list('memory', {
      limit: Math.max(50, Math.min(500, Number(limit) || 200)),
      where: (item) => item.type === 'episodic' && item.status === 'active',
    })
    const groups = new Map()
    for (const item of episodes) {
      const key = `${item.scopeType || 'global'}:${item.scopeId || ''}:${item.personId || ''}`
      const group = groups.get(key) || { personId: item.personId || '', scope: { scopeType: item.scopeType || 'global', scopeId: item.scopeId || '' }, count: 0 }
      group.count += 1
      groups.set(key, group)
    }
    const results = []
    for (const group of groups.values()) {
      const result = maybeConsolidate(group.personId, group.scope, { force })
      if (result) results.push(result)
    }
    return results
  }

  function get(id) {
    const memory = store.get('memory', id)
    if (!memory) return null
    const links = store.list('memory_link', { limit: 50, where: (item) => item.fromId === id || item.toId === id })
    return { memory, links }
  }

  function list({ query = '', type = '', personId = '', scopeType, scopeId, status = 'active', limit = 50 } = {}) {
    let rows = store.list('memory', {
      limit: 500,
      where: (item) => (!status || item.status === status)
        && (!type || item.type === type)
        && (!personId || item.personId === personId)
        && (!scopeType || (item.scopeType === scopeType && String(item.scopeId || '') === String(scopeId || ''))),
    })
    if (query) {
      const hits = store.search('memory', query, 100)
      const map = new Map(hits.map((hit) => [hit.id, hit.score]))
      rows = rows.map((row) => ({ ...row, _score: map.get(row.id) || 0 })).filter((row) => row._score > 0).sort((a, b) => b._score - a._score)
    }
    return rows.slice(0, Math.max(1, Math.min(200, Number(limit) || 50)))
  }

  function activate(id) {
    const memory = store.get('memory', id)
    if (!memory) return null
    const next = { ...memory, status: 'active', lastAccessed: clock.now(), accessCount: (memory.accessCount || 0) + 1, stability: round(clamp(Number(memory.stability || 0.5) + 0.08, 0, 1), 3), updatedAt: clock.now(), version: (memory.version || 1) + 1 }
    store.put('memory', id, next)
    return next
  }

  function forget(id) {
    const memory = store.get('memory', id)
    if (!memory) return null
    const next = { ...memory, status: 'inactive', forgottenAt: clock.now(), stability: 0.05, updatedAt: clock.now(), version: (memory.version || 1) + 1 }
    store.put('memory', id, next)
    return next
  }

  function remove(id) {
    store.remove('memory', id)
    for (const link of store.list('memory_link', { limit: 500, where: (item) => item.fromId === id || item.toId === id })) store.remove('memory_link', link.id)
  }

  function contextFor(prompt) {
    const selected = Array.isArray(prompt) ? prompt : []
    const lines = []
    let chars = 0
    for (const entry of selected) {
      const memory = entry.memory || entry
      const text = memoryText(memory)
      if (!text) continue
      const line = `- [${memory.type || 'memory'}${memory.createdAt ? ' ' + new Date(memory.createdAt).toISOString().slice(0, 10) : ''}] ${text}`
      if (chars + line.length > Number(cfg().memory?.maxContextChars || 4000)) break
      lines.push(line)
      chars += line.length
    }
    return lines.join('\n')
  }

  /** 显式记住一条内容（/remember、面板导入、后续整理任务共用）。 */
  function remember(text, { scope = null, personId = '', source = 'command', importance = 0.8, type = 'episodic' } = {}) {
    const content = String(text || '').trim()
    if (!content) return null
    const memoryScope = scope || { scopeType: 'global', scopeId: '' }
    const id = uid('mem')
    const memory = {
      id,
      type: MEMORY_TYPES.includes(type) ? type : 'episodic',
      scopeType: String(memoryScope.scopeType || 'global'),
      scopeId: String(memoryScope.scopeId || ''),
      personId: String(personId || ''),
      chatType: memoryScope.scopeType === 'group' ? 'group' : memoryScope.scopeType === 'private' ? 'private' : '',
      chatId: String(memoryScope.scopeId || ''),
      content,
      summary: content.slice(0, 500),
      text: content,
      salience: 0.75,
      importance: round(clamp(Number(importance) || 0.8, 0, 1), 3),
      confidence: 1,
      valence: 0,
      arousal: 0,
      sourceEventIds: [],
      sourceTurnId: '',
      source: String(source || 'command'),
      stability: 0.55,
      accessCount: 0,
      lastAccessed: 0,
      status: 'active',
      createdAt: clock.now(),
      updatedAt: clock.now(),
      version: 1,
    }
    store.put('memory', id, memory)
    try { linkRelated(memory, { messageIds: [] }) } catch (error) {}
    return memory
  }

  /** 按关键词遗忘（标记 inactive，不删除）；只在给定 scope 内匹配。 */
  function forgetMatching(query, { scope = null, limit = 5 } = {}) {
    const text = String(query || '').trim()
    if (!text) return []
    let rows = []
    try {
      rows = store.search('memory', text, 100)
    } catch (error) {
      rows = []
    }
    const wanted = scope ? rows.filter((row) => String(row.scopeType || '') === String(scope.scopeType || '') && String(row.scopeId || '') === String(scope.scopeId || '')) : rows
    const out = []
    for (const row of wanted.slice(0, Math.max(1, Math.min(20, Number(limit) || 5)))) {
      const next = forget(row.id)
      if (next) out.push(next)
    }
    return out
  }

  function stats() {
    const rows = store.list('memory', { limit: 100000 })
    return { total: rows.length, active: rows.filter((item) => item.status === 'active').length, byType: rows.reduce((acc, item) => { acc[item.type] = (acc[item.type] || 0) + 1; return acc }, {}) }
  }

  return {
    workingSet, workingGet, encodeTurn, remember, forgetMatching, retrieve, retrieveAsync, get, list, activate, forget, remove, contextFor, stats, consolidateAll,
    maybeConsolidate, scopeVisible,
  }
}
