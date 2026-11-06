// 目的引擎：长期目标 / 计划 / 近期意图。
//
// 边界：
//   - 只保存「想做什么」和进度，不执行工具、不发消息；执行仍由 pipeline/proactivity/agent 决定。
//   - 按 persona 作用域存储；私聊/群目的可以隔离，global 目的跨会话。
//   - promptContext 只给少量高优先级目的，避免把目标清单变成新的系统噪声。

import { clamp, round, uid } from './util.js'

const TYPES = ['goal', 'plan', 'intent']
const STATUSES = ['active', 'paused', 'done', 'abandoned']

function cleanScope(scope = {}) {
  const type = ['global', 'private', 'group'].includes(scope.scopeType) ? scope.scopeType : 'global'
  return { scopeType: type, scopeId: type === 'global' ? '' : String(scope.scopeId || '') }
}

function cleanSteps(steps) {
  if (!Array.isArray(steps)) return []
  return steps.slice(0, 20).map((step, index) => {
    if (typeof step === 'string') return { id: `s${index + 1}`, text: step.trim().slice(0, 200), done: false }
    return {
      id: String(step?.id || `s${index + 1}`),
      text: String(step?.text || '').trim().slice(0, 200),
      done: Boolean(step?.done),
    }
  }).filter((step) => step.text)
}

function progressOf(steps) {
  if (!steps.length) return 0
  return round(steps.filter((step) => step.done).length / steps.length, 3)
}

export function createPurposeService({ store, getConfig, clock, log = null } = {}) {
  const cfg = () => {
    try { return getConfig()?.cognition?.purpose || {} } catch (error) { return {} }
  }

  function get(id) {
    const row = store.get('purpose', String(id || ''))
    return row || null
  }

  function list({ status = 'active', type = '', scopeType = '', scopeId = '', personId = '', limit = 50 } = {}) {
    const rows = store.list('purpose', {
      limit: 500,
      where: (item) => (!status || item.status === status)
        && (!type || item.type === type)
        && (!scopeType || (item.scopeType === scopeType && (scopeType === 'global' || !scopeId || String(item.scopeId || '') === String(scopeId))))
        && (!personId || item.personId === personId),
    })
    return rows
      .sort((a, b) => (Number(b.priority) - Number(a.priority)) || (Number(a.dueAt || Infinity) - Number(b.dueAt || Infinity)) || (a.createdAt - b.createdAt))
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)))
  }

  function create({ title, description = '', type = 'goal', priority = 0.5, scope = null, personId = '', dueAt = 0, steps = [], source = 'manual' } = {}) {
    const name = String(title || '').trim().slice(0, 120)
    if (!name) return null
    const now = clock.now()
    const stepList = cleanSteps(steps)
    const record = {
      id: uid('goal'),
      type: TYPES.includes(type) ? type : 'goal',
      title: name,
      description: String(description || '').trim().slice(0, 2000),
      status: 'active',
      priority: round(clamp(Number(priority) || 0.5, 0, 1), 3),
      progress: progressOf(stepList),
      steps: stepList,
      ...cleanScope(scope || {}),
      personId: String(personId || ''),
      dueAt: Number(dueAt) || 0,
      source: String(source || 'manual'),
      createdAt: now,
      updatedAt: now,
      completedAt: 0,
      lastActedAt: 0,
    }
    store.put('purpose', record.id, record)
    log?.debug?.('目的已创建', record.id, record.title)
    return record
  }

  function update(id, patch = {}) {
    const current = get(id)
    if (!current) return null
    const next = { ...current }
    let progressChanged = false
    if (patch.title !== undefined) {
      const title = String(patch.title || '').trim().slice(0, 120)
      if (title) next.title = title
    }
    if (patch.description !== undefined) next.description = String(patch.description || '').trim().slice(0, 2000)
    if (patch.type !== undefined && TYPES.includes(patch.type)) next.type = patch.type
    if (patch.status !== undefined && STATUSES.includes(patch.status)) {
      next.status = patch.status
      next.completedAt = patch.status === 'done' ? clock.now() : 0
    }
    if (patch.priority !== undefined) next.priority = round(clamp(Number(patch.priority) || 0, 0, 1), 3)
    if (patch.dueAt !== undefined) next.dueAt = Number(patch.dueAt) || 0
    if (patch.steps !== undefined) {
      next.steps = cleanSteps(patch.steps)
      next.progress = progressOf(next.steps)
      progressChanged = true
    }
    if (patch.progress !== undefined) {
      next.progress = round(clamp(Number(patch.progress) || 0, 0, 1), 3)
      progressChanged = true
    }
    if (progressChanged && next.progress >= 1 && next.status === 'active') {
      next.status = 'done'
      next.completedAt = clock.now()
    }
    next.updatedAt = clock.now()
    store.put('purpose', next.id, next)
    return next
  }

  function complete(id) { return update(id, { status: 'done' }) }
  function abandon(id) { return update(id, { status: 'abandoned' }) }
  function pause(id) { return update(id, { status: 'paused' }) }
  function resume(id) { return update(id, { status: 'active', completedAt: 0 }) }
  function remove(id) {
    const current = get(id)
    if (!current) return false
    store.remove('purpose', current.id)
    return true
  }

  function scopeMatches(item, { scopeType = '', scopeId = '' } = {}) {
    if (!scopeType || item.scopeType === 'global') return true
    return item.scopeType === scopeType && String(item.scopeId || '') === String(scopeId || '')
  }

  function activeFor({ scopeType = '', scopeId = '', personId = '', limit = 3 } = {}) {
    return list({ status: 'active', limit: 50 })
      .filter((item) => scopeMatches(item, { scopeType, scopeId }))
      .filter((item) => !personId || !item.personId || item.personId === personId)
      .slice(0, Math.max(1, Math.min(20, Number(limit) || 3)))
  }

  function promptContext({ scopeType = '', scopeId = '', personId = '', limit = null } = {}) {
    if (cfg().enabled === false || cfg().injectPrompt === false) return []
    const count = Number(limit || cfg().promptLimit || 3)
    return activeFor({ scopeType, scopeId, personId, limit: count }).map((item) => {
      const progress = Math.round((Number(item.progress) || 0) * 100)
      const due = item.dueAt ? new Date(item.dueAt).toISOString().slice(0, 10) : ''
      return `- [${item.type}] ${item.title}（进度 ${progress}%${due ? `，截止 ${due}` : ''}）`
    })
  }

  /** 选一个当前最该推进的目的；只给建议，不执行。 */
  function tick({ scopeType = '', scopeId = '', personId = '', now = clock.now() } = {}) {
    const candidates = activeFor({ scopeType, scopeId, personId, limit: 20 })
    if (!candidates.length) return null
    const stale = (item) => Math.min(1, Math.max(0, (now - Number(item.lastActedAt || item.createdAt || 0)) / (7 * 86400000)))
    const urgency = (item) => {
      if (!item.dueAt) return 0.2
      const left = Number(item.dueAt) - now
      if (left <= 0) return 1
      return clamp(1 - left / (7 * 86400000), 0.1, 1)
    }
    const scored = candidates.map((item) => ({
      item,
      score: round(Number(item.priority || 0) * 0.55 + urgency(item) * 0.3 + stale(item) * 0.15, 3),
    })).sort((a, b) => b.score - a.score)
    const top = scored[0]
    return { purpose: top.item, score: top.score, reason: 'priority+urgency+staleness', candidates: scored.slice(0, 5) }
  }

  function stats() {
    const all = store.list('purpose', { limit: 500 })
    const byStatus = {}
    const byType = {}
    for (const item of all) {
      byStatus[item.status] = (byStatus[item.status] || 0) + 1
      byType[item.type] = (byType[item.type] || 0) + 1
    }
    const active = all.filter((item) => item.status === 'active')
    return {
      total: all.length,
      active: active.length,
      byStatus,
      byType,
      averageProgress: active.length ? round(active.reduce((sum, item) => sum + (Number(item.progress) || 0), 0) / active.length, 3) : 0,
      top: active.sort((a, b) => Number(b.priority) - Number(a.priority)).slice(0, 5).map((item) => ({ id: item.id, title: item.title, progress: item.progress })),
    }
  }

  return { get, list, create, update, complete, abandon, pause, resume, remove, activeFor, promptContext, tick, stats }
}
