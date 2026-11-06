// Persisted QQ admin intents only; execution stays in the owner command handler.
import { randomBytes } from 'node:crypto'
import { scanText } from './leak-guard.js'

export const ADMIN_APPROVAL_ACTIONS = Object.freeze(['profile', 'card', 'groupname', 'admin', 'mute', 'wholemute', 'kick', 'essence', 'recall', 'file'])
const KIND = 'qq_admin_approval'
const ID = /^apr_[a-f0-9]{32}$/
const validId = (value) => (typeof value === 'string' || typeof value === 'number') && /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value))

export function createApprovalService({ store, clock = { now: Date.now }, logger } = {}) {
  const log = logger?.child?.('approvals') || logger
  const save = (row) => store.put(KIND, row.id, row, { createdAt: row.createdAt })
  function expire(row) {
    return row?.status === 'pending' && row.expiresAt <= clock.now()
      ? save({ ...row, status: 'expired' }) : row
  }
  function pending() {
    return store.list(KIND, { where: (row) => row.status === 'pending', limit: 1000000 })
      .map(expire).filter((row) => row.status === 'pending')
  }
  function create({ action, args, chatType, chatId, senderId } = {}) {
    if (!ADMIN_APPROVAL_ACTIONS.includes(action) || typeof args !== 'string' || Array.from(args).length > 300 || /[\x00-\x1f\x7f-\x9f]/.test(args)
      || !['private', 'group'].includes(chatType) || !validId(chatId) || !validId(senderId)) throw new Error('APPROVAL_INVALID_INPUT')
    // Reject known secrets instead of persisting or silently changing the command to replay.
    if (scanText(args).matched) throw new Error('APPROVAL_SECRET')
    if (pending().length >= 50) throw new Error('APPROVAL_FULL')
    const createdAt = clock.now()
    const row = save({ id: 'apr_' + randomBytes(16).toString('hex'), action, args, chatType,
      chatId: String(chatId), senderId: String(senderId), status: 'pending', createdAt, expiresAt: createdAt + 10 * 60 * 1000 })
    log?.debug?.('QQ admin approval created', row.id)
    return row
  }
  function list({ status = 'pending', limit = 10 } = {}) {
    pending() // Persist expiry even when listing another status.
    return store.list(KIND, { where: (row) => row.status === status, order: 'desc', limit: Math.max(1, Math.min(50, Number(limit) || 10)) })
      .sort((a, b) => b.createdAt - a.createdAt)
  }
  function get(id) {
    return typeof id === 'string' && ID.test(id) ? expire(store.get(KIND, id)) : null
  }
  function resolve(id, { approve, operatorId } = {}) {
    if (typeof approve !== 'boolean' || !validId(operatorId)) throw new Error('APPROVAL_INVALID_INPUT')
    const row = get(id)
    if (!row || row.status !== 'pending') throw new Error('APPROVAL_NOT_PENDING')
    return save({ ...row, status: approve ? 'approved' : 'rejected', resolvedAt: clock.now(), resolvedBy: String(operatorId) })
  }
  function complete(id, { ok } = {}) {
    if (typeof ok !== 'boolean') throw new Error('APPROVAL_INVALID_INPUT')
    const row = get(id)
    if (!row || row.status !== 'approved') throw new Error('APPROVAL_NOT_APPROVED')
    return save({ ...row, status: ok ? 'executed' : 'failed', completedAt: clock.now() })
  }
  return { create, list, get, resolve, complete }
}
