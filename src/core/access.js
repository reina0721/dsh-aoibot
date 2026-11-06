// 访问控制：谁能触发回复、谁能收到自动消息。
//
// 设计原则：
//   1. 纯函数判定（decideInbound/canSend）可单独测试，不依赖 DSH/网关；
//   2. createAccess 负责把配置、审计环形缓冲与计数粘起来，供 host/routes/outbound 共用；
//   3. 默认 open：升级后行为不变；allowlist 才启用主人 + 白名单规则；
//   4. 审计只存元数据（会话/发送者/原因/时间），不存消息正文，重启清空。

export const ACCESS_MODES = ['open', 'allowlist']

const REASONS = {
  mode_open: '访问控制未启用（open）',
  owner: '主人',
  private_allowlist: '私聊白名单',
  group_allowlist: '群白名单',
  self: '机器人自己',
  private_not_allowed: '不在私聊白名单',
  group_not_allowed: '不在群白名单',
  not_message: '非消息事件',
  unknown_chat: '未知会话类型',
  rate_limited: '发送频率上限',
  gateway_unavailable: 'QQ 网关不可用',
  send_failed: '发送失败',
}

/** 中文原因，供面板/审计/测试使用。 */
export function reasonText(reason) {
  return REASONS[reason] || String(reason || '未知原因')
}

function asList(value, issues, label) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    issues?.push?.(`${label} 不是数组，已忽略`)
    return []
  }
  const out = []
  for (const item of value) {
    const text = String(item ?? '').trim()
    if (!text) continue
    const normalized = text.replace(/\s+/g, '').slice(0, 32)
    if (!normalized) continue
    if (!out.includes(normalized)) out.push(normalized)
    if (out.length >= 500) break
  }
  return out
}

/**
 * 规范化 access 配置；非法值回退默认并写入 issues。
 * 不 import config.js，避免循环依赖。
 */
export function normalizeAccess(raw, issues = []) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const mode = ACCESS_MODES.includes(src.mode) ? src.mode : 'open'
  if (src.mode !== undefined && mode !== src.mode) issues.push('access.mode 非法，已回退 open')

  const rawOwner = String(src.ownerQQ ?? '').trim()
  const ownerQQ = rawOwner.replace(/\D/g, '').slice(0, 20)
  if (rawOwner && !ownerQQ) issues.push('access.ownerQQ 不是有效 QQ 号，已忽略')

  const ownerName = typeof src.ownerName === 'string' && src.ownerName.trim()
    ? src.ownerName.trim().slice(0, 32)
    : '主人'

  const priv = asList(src.private, issues, 'access.private')
  const groups = asList(src.groups, issues, 'access.groups')

  const rawSize = Number(src.auditSize)
  const auditSize = Number.isFinite(rawSize) ? Math.max(0, Math.min(1000, Math.round(rawSize))) : 100
  if (src.auditSize !== undefined && !Number.isFinite(rawSize)) issues.push('access.auditSize 非法，已回退 100')

  if (mode === 'allowlist' && !ownerQQ) {
    issues.push('access.mode=allowlist 但未填写主人 QQ：私聊只按白名单放行，没有主人特权')
  }

  return { mode, ownerQQ, ownerName, private: priv, groups, auditSize }
}

function accessOf(cfg) {
  return cfg && typeof cfg === 'object' && cfg.access && typeof cfg.access === 'object' ? cfg.access : {}
}

export function isOwner(cfg, userId) {
  const owner = String(accessOf(cfg).ownerQQ || '')
  const id = String(userId ?? '').trim()
  return Boolean(owner && id && owner === id)
}

/**
 * 入站判定。
 * @param {object} cfg 完整插件配置（读取 cfg.access / cfg.botQQ）
 * @param {{kind?:string,chatType?:string,chatId?:string|number,senderId?:string|number,selfId?:string|number,reason?:string}} msg
 * @returns {{allowed:boolean,reason:string}}
 */
export function decideInbound(cfg, msg = {}) {
  const access = accessOf(cfg)
  const kind = String(msg.kind || 'message')
  if (kind !== 'message') return { allowed: true, reason: 'not_message' }
  if (access.mode !== 'allowlist') return { allowed: true, reason: 'mode_open' }

  const chatType = String(msg.chatType || '')
  const chatId = String(msg.chatId ?? '').trim()
  const senderId = String(msg.senderId ?? '').trim()
  const selfId = String(msg.selfId ?? '').trim()
  const botQQ = String(cfg?.botQQ ?? '').trim()

  if (senderId && (senderId === selfId || (botQQ && senderId === botQQ))) {
    return { allowed: true, reason: 'self' }
  }
  if (chatType === 'group') {
    if (chatId && (access.groups || []).includes(chatId)) return { allowed: true, reason: 'group_allowlist' }
    return { allowed: false, reason: 'group_not_allowed' }
  }
  if (chatType === 'private') {
    if (senderId && isOwner(cfg, senderId)) return { allowed: true, reason: 'owner' }
    if (senderId && (access.private || []).includes(senderId)) return { allowed: true, reason: 'private_allowlist' }
    return { allowed: false, reason: 'private_not_allowed' }
  }
  return { allowed: true, reason: 'unknown_chat' }
}

/**
 * 出站判定：不需要发送者，只看目标会话是否在允许范围。
 * @returns {{allowed:boolean,reason:string}}
 */
export function canSend(cfg, { chatType, chatId } = {}) {
  const access = accessOf(cfg)
  if (access.mode !== 'allowlist') return { allowed: true, reason: 'mode_open' }
  const type = String(chatType || '')
  const id = String(chatId ?? '').trim()
  if (type === 'group') {
    if (id && (access.groups || []).includes(id)) return { allowed: true, reason: 'group_allowlist' }
    return { allowed: false, reason: 'group_not_allowed' }
  }
  if (type === 'private') {
    if (id && isOwner(cfg, id)) return { allowed: true, reason: 'owner' }
    if (id && (access.private || []).includes(id)) return { allowed: true, reason: 'private_allowlist' }
    return { allowed: false, reason: 'private_not_allowed' }
  }
  return { allowed: true, reason: 'unknown_chat' }
}

/** 从 OneBot 原始事件里尽力提取会话/发送者；无法判断时返回非消息事件。 */
export function parseRawForAccess(raw) {
  if (!raw || typeof raw !== 'object' || raw.post_type !== 'message') {
    return { kind: 'other', chatType: '', chatId: '', senderId: '', selfId: '' }
  }
  const messageType = String(raw.message_type || '')
  const chatType = messageType === 'group' ? 'group' : messageType === 'private' ? 'private' : ''
  const chatId = String(raw.group_id ?? raw.user_id ?? '')
  const senderId = String(raw.user_id ?? raw.sender?.user_id ?? '')
  const selfId = String(raw.self_id ?? '')
  return { kind: chatType ? 'message' : 'other', chatType, chatId, senderId, selfId }
}

function emptyCounters() {
  return {
    inbound: 0,
    inboundAllowed: 0,
    inboundBlocked: 0,
    outbound: 0,
    outboundBlocked: 0,
    outboundFailed: 0,
    sent: 0,
    dryRuns: 0,
  }
}

/**
 * 把判定、审计与计数粘起来。host 用它写入站；outbound 用它写出站。
 */
export function createAccess({ getConfig, clock = () => Date.now(), logger = null, size = null } = {}) {
  const now = () => (typeof clock === 'function' ? Number(clock()) : typeof clock?.now === 'function' ? Number(clock.now()) : Date.now())
  const state = { counters: emptyCounters(), recent: [], lastAt: 0 }
  const cfg = () => {
    try {
      return (getConfig && getConfig()) || {}
    } catch (error) {
      return {}
    }
  }
  const capacity = () => {
    const configured = Number(size ?? cfg()?.access?.auditSize ?? 100)
    if (!Number.isFinite(configured)) return 100
    return Math.max(0, Math.min(1000, Math.round(configured)))
  }

  function record(direction, info = {}) {
    const entry = {
      at: now(),
      direction: direction === 'out' ? 'out' : 'in',
      chatType: String(info.chatType || ''),
      chatId: String(info.chatId || ''),
      senderId: String(info.senderId || ''),
      reason: String(info.reason || ''),
    }
    state.lastAt = entry.at
    const cap = capacity()
    if (cap <= 0) return entry
    state.recent.push(entry)
    while (state.recent.length > cap) state.recent.shift()
    return entry
  }

  function decideRaw(raw) {
    const parsed = parseRawForAccess(raw)
    const decision = decideInbound(cfg(), parsed)
    state.counters.inbound += 1
    if (decision.allowed) state.counters.inboundAllowed += 1
    else {
      state.counters.inboundBlocked += 1
      record('in', { ...parsed, reason: decision.reason })
      logger?.debug?.('访问拒绝：', `${parsed.chatType}:${parsed.chatId}/${parsed.senderId} ${decision.reason}`)
    }
    return { ...parsed, ...decision }
  }

  function check(chat = {}) {
    const decision = decideInbound(cfg(), { kind: 'message', ...chat })
    return { ...decision, reasonText: reasonText(decision.reason) }
  }

  function canSendOut(chat = {}) {
    const decision = canSend(cfg(), chat)
    state.counters.outbound += 1
    if (!decision.allowed) {
      state.counters.outboundBlocked += 1
      record('out', { ...chat, reason: decision.reason })
    }
    return decision
  }

  function noteSent() {
    state.counters.sent += 1
  }
  function noteDryRun() {
    state.counters.dryRuns += 1
  }
  function noteFailed(info = {}) {
    state.counters.outboundFailed += 1
    record('out', { ...info, reason: info.reason || 'send_failed' })
  }

  function summary() {
    const access = accessOf(cfg())
    return {
      mode: access.mode || 'open',
      configured: access.mode === 'allowlist',
      ownerQQ: String(access.ownerQQ || ''),
      ownerName: String(access.ownerName || '主人'),
      allow: { private: (access.private || []).length, groups: (access.groups || []).length },
      counters: { ...state.counters },
      recent: state.recent.slice(-20),
      lastAt: state.lastAt,
    }
  }

  return {
    decideRaw,
    check,
    canSend: canSendOut,
    record,
    noteSent,
    noteDryRun,
    noteFailed,
    counters: () => ({ ...state.counters }),
    recent: () => state.recent.slice(),
    summary,
    reasonText,
  }
}
