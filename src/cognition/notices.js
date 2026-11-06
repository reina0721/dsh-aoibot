// Accepted QQ notices become timeline records; requests wait for an explicit owner command.
import { createHash } from 'node:crypto'
import { redactText } from '../core/leak-guard.js'

const NOTICE_TITLES = {
  group_increase: '群成员加入', group_decrease: '群成员退出', group_admin: '群管理员变更',
  group_ban: '群禁言变更', group_card: '群名片变更', group_name: '群名变更',
  group_title: '群头衔变更', essence: '群精华变更', friend_add: '好友添加', offline_file: '离线文件',
}
const SUB_TYPES = {
  group_increase: ['approve', 'invite'], group_decrease: ['leave', 'kick', 'kick_me'],
  group_admin: ['set', 'unset'], group_ban: ['ban', 'lift_ban'], essence: ['add', 'delete'],
}
const CONTROLS = /[\x00-\x1f\x7f-\x9f]/
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32)
const validId = (value) => /^(?:[1-9]\d{0,19})$/.test(String(value ?? ''))
const safeText = (value, max) => Array.from(redactText(typeof value === 'string' ? value : '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim()).slice(0, max).join('')
const validFlag = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !CONTROLS.test(value)

function publicRequest(row) {
  const { id, type, subType, userId, groupId, comment, at, status, resolvedAt, resolvedBy } = row
  return { id, type, subType, userId, groupId, comment: safeText(comment, 500), at, status,
    ...(resolvedAt === undefined ? {} : { resolvedAt, resolvedBy }) }
}

export function createNoticeService({ store, getConfig = () => ({}), clock = { now: Date.now }, logger, gateway } = {}) {
  const inFlight = new Set()
  const log = logger?.child?.('notices') || logger
  const enabled = (kind) => getConfig()?.cognition?.[kind]?.enabled !== false

  function handle(notice) {
    if (!enabled('notices') || !notice || !Object.hasOwn(NOTICE_TITLES, notice.type)) return null
    const type = notice.type
    const group = type.startsWith('group_') || type === 'essence'
    if (group && !validId(notice.groupId)) return null
    if (!group && !validId(notice.userId)) return null
    if (group && !['group_name', 'essence'].includes(type) && !(type === 'group_ban' && String(notice.userId) === '0') && !validId(notice.userId)) return null
    if (SUB_TYPES[type] && !SUB_TYPES[type].includes(notice.subType)) return null
    if (type === 'essence' && !/^-?[1-9]\d*$/.test(String(notice.messageId ?? ''))) return null
    if (type === 'group_ban' && (!Number.isSafeInteger(notice.duration) || notice.duration < 0)) return null
    if (type === 'offline_file' && (typeof notice.file?.name !== 'string' || !notice.file.name.trim())) return null
    const fields = { type, subType: SUB_TYPES[type] ? notice.subType : '' }
    for (const key of ['groupId', 'userId', 'operatorId', 'targetId']) {
      if (notice[key] === undefined || notice[key] === '') continue
      if (!validId(notice[key]) && !(key === 'userId' && type === 'group_ban' && String(notice[key]) === '0')) return null
      fields[key] = String(notice[key])
    }
    if (type === 'essence') fields.messageId = String(notice.messageId)
    if (type === 'group_ban') fields.duration = notice.duration
    for (const key of ({ group_card: ['cardOld', 'cardNew'], group_name: ['name'], group_title: ['title'] }[type] || [])) {
      fields[key] = safeText(notice[key], 200)
    }
    if (type === 'offline_file') fields.fileName = safeText(notice.file.name, 200)
    // Only selected fields enter identity/detail. URLs, flags, comments and raw payloads never do.
    const id = 'nte_' + hash([notice.selfId || '', Number(notice.time) || 0, fields])
    if (store.get('timeline_event', id)) return null
    const detail = safeText(Object.entries(fields).filter(([, value]) => value !== '').map(([key, value]) => `${key}=${value}`).join(' · '), 500)
    const row = { id, at: clock.now(), scopeType: fields.groupId ? 'group' : fields.userId ? 'private' : 'global',
      scopeId: fields.groupId || fields.userId || '', title: safeText(NOTICE_TITLES[type], 200), detail, text: detail, source: 'notice', status: 'active' }
    store.put('timeline_event', id, row)
    return row
  }

  function handleRequest(request) {
    if (!enabled('requests') || !request || !['friend', 'group'].includes(request.type)) return null
    const subType = request.subType || (request.type === 'friend' ? 'add' : '')
    if (!['add', 'invite'].includes(subType) || (request.type === 'friend' && subType !== 'add')) return null
    if (!validFlag(request.flag) || !validId(request.userId)) return null
    if (request.type === 'group' && !validId(request.groupId)) return null
    if (request.groupId && !validId(request.groupId)) return null
    const id = 'req_' + hash(request.flag)
    if (store.get('qq_request', id)) return null
    const row = { id, type: request.type, subType, flag: request.flag, userId: String(request.userId),
      groupId: request.groupId ? String(request.groupId) : '', comment: safeText(typeof request.comment === 'string' ? request.comment.split(request.flag).join('[REDACTED]') : '', 500),
      at: clock.now(), status: 'pending', source: 'request' }
    store.put('qq_request', id, row)
    return publicRequest(row)
  }

  function list({ status = 'pending', limit = 20 } = {}) {
    if (!enabled('requests') || !['pending', 'approved', 'rejected'].includes(status)) return []
    const max = Math.max(1, Math.min(100, Math.floor(Number(limit) || 20)))
    return store.list('qq_request', { where: (row) => row.status === status, limit: max }).map(publicRequest)
  }

  async function resolve(id, { approve, reason = '', operatorId } = {}) {
    const owner = String(getConfig()?.access?.ownerQQ || '')
    if (!owner || owner !== String(operatorId || '')) throw new Error('仅主人可处理请求')
    if (!enabled('requests')) throw new Error('请求处理未启用')
    if (typeof id !== 'string' || !/^req_[a-f0-9]{32}$/.test(id) || id.length > 100 || typeof approve !== 'boolean' || typeof reason !== 'string' || Array.from(reason).length > 100 || CONTROLS.test(reason)) throw new Error('请求参数无效')
    // Pin the persona namespace across the asynchronous gateway call.
    const target = store.base && store.scopedKind ? store.base : store
    const kind = store.scopedKind ? store.scopedKind('qq_request') : 'qq_request'
    const row = target.get(kind, id)
    if (!row || row.status !== 'pending') throw new Error('请求不存在或已处理')
    if (inFlight.has(id)) throw new Error('请求正在处理')
    if (!validFlag(row.flag) || !['friend', 'group'].includes(row.type) || !['add', 'invite'].includes(row.subType)) throw new Error('请求记录无效')
    const method = row.type === 'friend' ? 'setFriendAddRequest' : 'setGroupAddRequest'
    if (typeof gateway?.actions?.[method] !== 'function') throw new Error('请求网关不可用')
    inFlight.add(id)
    try {
      try {
        if (row.type === 'friend') await gateway.actions.setFriendAddRequest(row.flag, approve, reason)
        else await gateway.actions.setGroupAddRequest(row.flag, row.subType, approve, reason)
      } catch {
        log?.warn?.('QQ 请求处理失败')
        throw new Error('QQ 请求处理失败，请检查网关状态与权限')
      }
      const resolved = { ...row, status: approve ? 'approved' : 'rejected', resolvedAt: clock.now(), resolvedBy: String(operatorId) }
      target.put(kind, id, resolved)
      return publicRequest(resolved)
    } finally { inFlight.delete(id) }
  }

  function status() {
    return { pending: store.count('qq_request', (row) => row.status === 'pending') }
  }

  return { handle, handleRequest, list, resolve, status }
}
