// 时间轴：把轮次、记忆、决策、导入事件按时间合并成一条可读的「回忆日志」。
//
// 只读聚合，不改状态；scope 过滤遵循「global 对所有可见，私聊/群只与同 scope 匹配」。

function atOf(item) {
  return Number(item?.at || item?.createdAt || item?.updatedAt || item?.closedAt || item?.startedAt || 0)
}

function scopeOf(item) {
  if (item.scopeType) return { scopeType: item.scopeType, scopeId: String(item.scopeId || '') }
  if (item.chatType) return { scopeType: item.chatType, scopeId: String(item.chatId || '') }
  return { scopeType: 'global', scopeId: '' }
}

function matchesScope(item, { scopeType = '', scopeId = '' } = {}) {
  if (!scopeType) return true
  const scope = scopeOf(item)
  if (scope.scopeType === 'global') return true
  return scope.scopeType === scopeType && String(scope.scopeId || '') === String(scopeId || '')
}

export function createTimelineService({ store, scopedStore, clock, limit = 400 } = {}) {
  function rowsOf(kind, list) {
    const out = []
    for (const item of list) {
      const at = atOf(item)
      if (!at) continue
      const scope = scopeOf(item)
      if (kind === 'turn') {
        out.push({
          id: `turn:${item.id}`,
          type: 'turn',
          at,
          ...scope,
          title: item.chatType === 'group' ? '群聊轮次' : '私聊轮次',
          detail: String(item.text || '').slice(0, 240),
          status: String(item.status || item.closeReason || ''),
        })
      } else if (kind === 'memory') {
        out.push({
          id: `memory:${item.id}`,
          type: 'memory',
          at,
          ...scope,
          title: `记忆 · ${String(item.type || 'episodic')}`,
          detail: String(item.summary || item.content || '').slice(0, 240),
          status: String(item.status || ''),
        })
      } else if (kind === 'event') {
        out.push({
          id: `event:${item.id}`, type: 'event', at, ...scope,
          title: String(item.title || '回忆事件'),
          detail: String(item.text || item.summary || ''),
          status: String(item.status || ''),
        })
      } else if (kind === 'decision') {
        out.push({
          id: `decision:${item.id}`,
          type: 'decision',
          at,
          ...scope,
          title: `决策 · ${String(item.action || '')}`,
          detail: String(item.reason || '').slice(0, 240),
          status: String(item.status || ''),
        })
      }
    }
    return out
  }

  function timeline({ limit: pageSize = 100, before = 0, scopeType = '', scopeId = '', types = [] } = {}) {
    const kinds = new Set((Array.isArray(types) && types.length ? types : ['turn', 'memory', 'decision', 'event']).filter((type) => ['turn', 'memory', 'decision', 'event'].includes(type)))
    const listLimit = Math.max(20, Math.min(800, Number(limit) || 400))
    const rows = []
    try {
      if (kinds.has('turn') && store?.list) rows.push(...rowsOf('turn', store.list('turn', { limit: listLimit })))
    } catch (error) {}
    try {
      if (kinds.has('memory') && scopedStore?.list) rows.push(...rowsOf('memory', scopedStore.list('memory', { limit: listLimit })))
    } catch (error) {}
    try {
      if (kinds.has('decision') && scopedStore?.list) rows.push(...rowsOf('decision', scopedStore.list('decision', { limit: listLimit })))
    } catch (error) {}
    try {
      if (kinds.has('event') && scopedStore?.list) rows.push(...rowsOf('event', scopedStore.list('timeline_event', { limit: listLimit })))
    } catch (error) {}
    const cutoff = Number(before) || 0
    const max = Math.max(1, Math.min(200, Number(pageSize) || 100))
    return rows
      .filter((row) => !cutoff || row.at < cutoff)
      .filter((row) => matchesScope(row, { scopeType, scopeId }))
      .sort((a, b) => b.at - a.at)
      .slice(0, max)
  }

  function stats() {
    const rows = timeline({ limit: 200 })
    const byType = {}
    for (const row of rows) byType[row.type] = (byType[row.type] || 0) + 1
    return { total: rows.length, byType, latestAt: rows[0]?.at || 0 }
  }

  return { timeline, stats, clock }
}
