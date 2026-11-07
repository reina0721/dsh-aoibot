// Local owner reminders: fixed text only; every send uses the outbound gates.
import { isOwner } from '../core/access.js'
import { createScheduler } from './util.js'
import { createReminderEngine } from '../reminders/service.js'

export const REMINDER_DEFAULTS = Object.freeze({
  enabled: false, maxActive: 50, minIntervalSeconds: 60,
  maxIntervalSeconds: 2592000, tickMs: 30000,
})

export function createReminderService({ store, getConfig = () => ({}), access = null,
  clock = { now: Date.now }, scheduler = createScheduler(), outbound, logger = null } = {}) {
  const project = row => {
    if (!row) return null
    const { id, scopeType, scopeId, text, at, everySeconds, nextAt, status, createdBy, createdAt, sentCount, lastError } = row
    return { id, scopeType, scopeId, text, at, everySeconds, nextAt, status, createdBy, createdAt, sentCount, lastError }
  }
  const bind = (target, kind, isCurrent) => ({
    get: id => project(target.get(kind, id)),
    put: row => project(target.put(kind, row.id, row, { createdAt: row.createdAt })),
    all: status => target.list(kind, { where: row => row.status === status, limit: 1000000 }).map(project),
    findDue: (now, limit) => target.list(kind, { where: row => row.status === 'active' && row.nextAt <= now, limit: 1000000 })
      .sort((a, b) => a.nextAt - b.nextAt || a.id.localeCompare(b.id)).slice(0, limit).map(project),
    isCurrent,
  })
  const repository = bind(store, 'reminder', () => true)
  repository.capture = () => {
    const kind = store.scopedKind?.('reminder') || 'reminder'
    return bind(store.base || store, kind, () => !store.scopedKind || store.scopedKind('reminder') === kind)
  }
  return createReminderEngine({ repository, getConfig: () => getConfig()?.cognition?.reminders,
    owner(id) {
      const cfg = getConfig() || {}
      if (!(access?.isOwner ? access.isOwner(cfg, id) : isOwner(cfg, id))) throw new Error('OWNER_ONLY')
    }, clock, scheduler, logger,
    deliver: ({ text, ...target }) => outbound?.deliver({ ...target, segments: [{ type: 'text', data: { text } }] }),
  })
}
