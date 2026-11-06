// Local owner reminders: fixed text only; every send uses the outbound gates.
import { isOwner } from '../core/access.js'
import { createScheduler, hashText, uid } from './util.js'

export const REMINDER_DEFAULTS = Object.freeze({
  enabled: false, maxActive: 50, minIntervalSeconds: 60,
  maxIntervalSeconds: 2592000, tickMs: 30000,
})

export function createReminderService({ store, getConfig = () => ({}), access = null,
  clock = { now: Date.now }, scheduler = createScheduler(), outbound, logger = null } = {}) {
  let running = false
  let started = false
  let disposed = false
  let timer = null
  const bounded = (value, fallback, min, max) => Number.isFinite(Number(value))
    ? Math.max(min, Math.min(max, Math.floor(Number(value)))) : fallback
  const config = () => {
    const raw = getConfig()?.cognition?.reminders || {}
    const minIntervalSeconds = bounded(raw.minIntervalSeconds, 60, 60, 2592000)
    return {
      enabled: raw.enabled === true,
      maxActive: bounded(raw.maxActive, 50, 1, 1000),
      minIntervalSeconds,
      maxIntervalSeconds: bounded(raw.maxIntervalSeconds, 2592000, minIntervalSeconds, 2592000),
      tickMs: bounded(raw.tickMs, 30000, 1000, 3600000),
    }
  }
  const fail = (code) => { throw new Error(code) }
  const owner = (id) => {
    const cfg = getConfig() || {}
    if (!(access?.isOwner ? access.isOwner(cfg, id) : isOwner(cfg, id))) fail('OWNER_ONLY')
  }
  const scope = (chatType, chatId) => {
    const id = String(chatId ?? '')
    if (!['private', 'group'].includes(chatType) || !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) fail('INVALID_TARGET')
    return { scopeType: chatType, scopeId: id }
  }
  const matches = (row, target) => row.scopeType === target.scopeType && row.scopeId === target.scopeId
  const publicRecord = (row) => {
    const { id, scopeType, scopeId, text, at, everySeconds, nextAt, status, createdBy, createdAt, sentCount, lastError } = row
    return { id, scopeType, scopeId, text, at, everySeconds, nextAt, status, createdBy, createdAt, sentCount, lastError }
  }
  function add({ chatType, chatId, text, at, everySeconds, createdBy } = {}) {
    const cfg = config()
    if (!cfg.enabled || disposed) fail('REMINDERS_DISABLED')
    owner(createdBy)
    const target = scope(chatType, chatId)
    if (typeof text !== 'string' || !text.trim() || Array.from(text).length > 500) fail('INVALID_TEXT')
    const once = at !== undefined && at !== null
    const recurring = everySeconds !== undefined && everySeconds !== null
    if (once === recurring) fail('INVALID_SCHEDULE')
    const now = clock.now()
    const due = once ? (typeof at === 'number' ? at : typeof at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(at) ? Date.parse(at) : NaN) : now + everySeconds * 1000
    if (once && (!Number.isFinite(due) || due <= now || !Number.isFinite(new Date(due).getTime()))) fail('INVALID_AT')
    if (recurring && (!Number.isInteger(everySeconds) || everySeconds < cfg.minIntervalSeconds || everySeconds > cfg.maxIntervalSeconds)) fail('INVALID_INTERVAL')
    return store.tx(() => {
      const active = store.list('reminder', { where: (row) => row.status === 'active', limit: 1000000 })
      if (active.some((row) => matches(row, target) && row.text === text && (once ? row.at === due : row.everySeconds === everySeconds))) fail('REMINDER_DUPLICATE')
      if (active.length >= cfg.maxActive) fail('MAX_ACTIVE')
      const id = `rem_${hashText(uid('reminder'), 24)}`
      return publicRecord(store.put('reminder', id, {
        ...target, text, at: once ? due : null, everySeconds: recurring ? everySeconds : null,
        nextAt: due, status: 'active', createdBy: String(createdBy), createdAt: now, sentCount: 0, lastError: '',
      }, { createdAt: now }))
    })
  }
  function list({ chatType, chatId, status = 'active', limit = 50 } = {}) {
    const target = scope(chatType, chatId)
    return store.list('reminder', { where: (row) => matches(row, target) && row.status === status,
      limit: bounded(limit, 50, 1, 50) }).map(publicRecord)
  }
  function cancel(id, { chatType, chatId, operatorId } = {}) {
    owner(operatorId)
    const target = scope(chatType, chatId)
    const row = store.get('reminder', id)
    if (!row || !matches(row, target) || row.status !== 'active') fail('REMINDER_NOT_FOUND')
    return publicRecord(store.put('reminder', id, { ...row, status: 'cancelled' }))
  }
  async function tick() {
    if (disposed || running || !config().enabled) return
    running = true
    // The active persona can change during an outbound await. Pin all writes.
    const kind = store.scopedKind?.('reminder') || 'reminder'
    const targetStore = store.base || store
    try {
      const due = targetStore.list(kind, { where: (row) => row.status === 'active' && row.nextAt <= clock.now(), limit: 1000000 })
        .sort((a, b) => a.nextAt - b.nextAt).slice(0, 20)
      for (const item of due) {
        if (disposed || !config().enabled || (store.scopedKind && store.scopedKind('reminder') !== kind)) break
        const row = targetStore.get(kind, item.id)
        if (!row || row.status !== 'active') continue
        let result
        try {
          result = await outbound?.deliver({ chatType: row.scopeType, chatId: row.scopeId,
            segments: [{ type: 'text', data: { text: row.text } }], source: 'reminder' })
        } catch { result = { ok: false } }
        if (disposed) break
        const current = targetStore.get(kind, row.id)
        if (!current || current.status !== 'active') continue
        const now = clock.now()
        const patch = result?.ok === true
          ? { status: row.everySeconds ? 'active' : 'sent', nextAt: row.everySeconds ? now + row.everySeconds * 1000 : row.nextAt,
              sentCount: row.sentCount + 1, lastError: '' }
          : { lastError: ['ACCESS_DENIED', 'RATE_LIMITED', 'LEAK_BLOCKED', 'GATEWAY_UNAVAILABLE', 'SEND_FAILED'].includes(result?.error) ? result.error : 'SEND_FAILED',
              nextAt: now + Math.max(60, config().minIntervalSeconds) * 1000 }
        targetStore.put(kind, row.id, { ...current, ...patch })
      }
    } finally { running = false }
  }
  function schedule() {
    if (!started || disposed) return
    timer = scheduler.setTimeout(async () => {
      timer = null
      try { await tick() } catch { logger?.warn?.('提醒调度失败：REMINDER_TICK_FAILED') }
      finally { schedule() }
    }, config().tickMs)
  }
  function start() {
    if (started || disposed) return
    started = true
    schedule()
  }
  function dispose() {
    disposed = true
    started = false
    if (timer !== null) scheduler.clearTimeout(timer)
    timer = null
  }
  return { add, list, cancel, tick, start, dispose }
}
