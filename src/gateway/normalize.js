// OneBot v11 原始事件 → 插件内部规范化事件。
//
// 设计原则（见 docs/ARCHITECTURE.md §3.3）：
//   1. 平台给什么就存什么：字段缺失就留空/省略，绝不推断、绝不伪造；
//   2. 过滤规则不在这里做（由 core/events.js 在 push 前统一执行），这里只做形状转换；
//   3. 原始事件按配置截断（events.rawMaxBytes），防止超大消息撑爆缓冲。
//
// 规范化后的形状（kind 决定其余字段）：
//   { seqless:true, kind:'message'|'notice'|'request'|'meta_event'|'unknown',
//     time, selfId, postType, subType,
//     message?:{ id, chatType, chatId, sender, text, segments, mentions, images,
//                replyId, rawMessage, messageFormat },
//     notice?:{ type, subType, userId, groupId, operatorId, targetId, messageId, duration, file },
//     request?:{ type, subType, userId, groupId, comment, flag },
//     meta?:{ type, subType, interval, status, online, good },
//     raw }

const CQ_RE = /\[CQ:([A-Za-z0-9_.-]+)((?:,[^\]]*)?)\]/g

/** CQ 码字符串里的转义还原（onebot-11 规范 §6.1）。 */
export function unescapeCq(text) {
  return String(text ?? '')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&')
}

/** `key=value,key2=value2` → { key: value, … }；值做 CQ 转义还原。 */
function parseCqParams(rawParams) {
  const data = {}
  const text = String(rawParams || '')
  if (!text) return data
  for (const pair of text.replace(/^,/, '').split(',')) {
    if (!pair) continue
    const index = pair.indexOf('=')
    const key = index < 0 ? pair : pair.slice(0, index)
    const value = index < 0 ? '' : pair.slice(index + 1)
    if (!key || key === '__proto__') continue
    data[key] = unescapeCq(value)
  }
  return data
}

/**
 * 把 message 字段（CQ 码字符串或消息段数组）解析成统一的消息段数组。
 * @param {string|Array|undefined|null} message
 * @param {string} [format] 'string' | 'array'
 * @returns {Array<{type:string, data:object}>}
 */
export function parseMessage(message, format) {
  if (Array.isArray(message)) {
    const out = []
    for (const segment of message) {
      if (!segment || typeof segment !== 'object') continue
      const type = String(segment.type || '')
      if (!type) continue
      const data = {}
      if (segment.data && typeof segment.data === 'object') {
        for (const [key, value] of Object.entries(segment.data)) {
          if (key === '__proto__') continue
          if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) data[key] = value
          else data[key] = value
        }
      }
      out.push({ type, data })
    }
    return out
  }
  if (format === 'array') return []
  const text = typeof message === 'string' ? message : ''
  if (!text) return []
  const segments = []
  let last = 0
  CQ_RE.lastIndex = 0
  let match
  while ((match = CQ_RE.exec(text))) {
    if (match.index > last) {
      const chunk = unescapeCq(text.slice(last, match.index))
      if (chunk) segments.push({ type: 'text', data: { text: chunk } })
    }
    segments.push({ type: String(match[1]), data: parseCqParams(match[2]) })
    last = CQ_RE.lastIndex
  }
  if (last < text.length) {
    const chunk = unescapeCq(text.slice(last))
    if (chunk) segments.push({ type: 'text', data: { text: chunk } })
  }
  return segments
}

function str(value) {
  if (value === undefined || value === null) return ''
  return String(value)
}

function put(target, key, value) {
  if (value === undefined || value === null || value === '') return
  target[key] = value
}

function numberOr(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** 把任意值截断成可安全放进事件缓冲的 raw 字段。 */
export function truncateRaw(raw, maxBytes = 16384) {
  const limit = Math.max(256, Number(maxBytes) || 16384)
  let text
  try {
    text = JSON.stringify(raw)
  } catch (error) {
    return { __truncated: true, bytes: 0 }
  }
  const size = Buffer.byteLength(text)
  if (size <= limit) return raw
  return {
    __truncated: true,
    bytes: size,
    preview: text.slice(0, Math.max(128, Math.floor(limit / 2))),
  }
}

/** 消息事件：chatType / chatId / sender / 文本 / 消息段 / @ / 图片 / 引用。 */
function normalizeMessage(raw) {
  const chatType = raw.message_type === 'group' ? 'group' : raw.message_type === 'private' ? 'private' : 'other'
  const chatId = str(chatType === 'group' ? raw.group_id : raw.user_id)
  const messageFormat = raw.message_format === 'array'
    ? 'array'
    : raw.message_format === 'string'
      ? 'string'
      : Array.isArray(raw.message)
        ? 'array'
        : 'string'
  const segments = parseMessage(raw.message, messageFormat)

  const mentions = []
  const images = []
  const texts = []
  const forwards = []
  let replyId = ''
  for (const segment of segments) {
    const data = segment.data || {}
    if (segment.type === 'text') texts.push(str(data.text))
    else if (segment.type === 'at') mentions.push({ userId: str(data.qq), name: str(data.name) })
    else if (segment.type === 'image') {
      images.push({ url: str(data.url), file: str(data.file), summary: str(data.summary) })
    } else if (segment.type === 'reply') {
      replyId = str(data.id)
    } else if (segment.type === 'forward') {
      forwards.push({ id: str(data.id), title: str(data.title), summary: str(data.content) })
    }
  }

  const sender = raw.sender && typeof raw.sender === 'object' ? raw.sender : {}
  const message = {
    id: raw.message_id ?? '',
    chatType,
    chatId,
    sender: {
      userId: str(sender.user_id),
      nickname: str(sender.nickname),
      card: str(sender.card),
      role: str(sender.role),
    },
    text: texts.join(''),
    segments,
    mentions,
    images,
    forwards,
    replyId,
    rawMessage: raw.message ?? '',
    messageFormat,
  }
  put(message, 'messageSeq', raw.message_seq)
  put(message, 'font', raw.font)
  return message
}

/** 通知事件（撤回 / 戳一戳 / 群成员变化 / 好友添加 / 群公告 …）。 */
function normalizeNotice(raw) {
  const notice = {
    type: str(raw.notice_type),
    subType: str(raw.sub_type),
  }
  put(notice, 'userId', raw.user_id === undefined ? undefined : str(raw.user_id))
  put(notice, 'groupId', raw.group_id === undefined ? undefined : str(raw.group_id))
  put(notice, 'operatorId', raw.operator_id === undefined ? undefined : str(raw.operator_id))
  put(notice, 'targetId', raw.target_id === undefined ? undefined : str(raw.target_id))
  put(notice, 'messageId', raw.message_id === undefined ? undefined : str(raw.message_id))
  put(notice, 'duration', raw.duration === undefined ? undefined : numberOr(raw.duration))
  put(notice, 'file', raw.file && typeof raw.file === 'object' ? raw.file : undefined)
  put(notice, 'comment', raw.comment)
  put(notice, 'flag', raw.flag)
  return notice
}

/** 请求事件（加好友 / 邀请入群）。 */
function normalizeRequest(raw) {
  return {
    type: str(raw.request_type),
    subType: str(raw.sub_type),
    userId: str(raw.user_id),
    groupId: str(raw.group_id),
    comment: str(raw.comment),
    flag: str(raw.flag),
  }
}

/** 元事件（心跳 / 生命周期）。 */
function normalizeMeta(raw) {
  const meta = {
    type: str(raw.meta_event_type),
    subType: str(raw.sub_type),
  }
  put(meta, 'interval', raw.interval === undefined ? undefined : numberOr(raw.interval))
  put(meta, 'status', raw.status && typeof raw.status === 'object' ? raw.status : undefined)
  put(meta, 'online', typeof raw.online === 'boolean' ? raw.online : undefined)
  put(meta, 'good', typeof raw.good === 'boolean' ? raw.good : undefined)
  return meta
}

const KIND_BY_POST_TYPE = {
  message: 'message',
  message_sent: 'message',
  notice: 'notice',
  request: 'request',
  meta_event: 'meta_event',
}

/**
 * 规范化一条原始 OneBot v11 事件。
 * @param {object} raw 网关推送的原始事件
 * @param {object} [cfg] 插件配置（只读 events.rawMaxBytes）
 * @returns {object|null} 规范化事件；无法识别时返回 null
 */
export function normalizeEvent(raw, cfg) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const postType = str(raw.post_type)
  const kind = KIND_BY_POST_TYPE[postType]
  if (!kind) return null

  const subType = str(
    raw.sub_type
    || raw.message_type
    || raw.notice_type
    || raw.request_type
    || raw.meta_event_type,
  )
  const event = {
    seqless: true,
    kind,
    time: numberOr(raw.time),
    selfId: str(raw.self_id),
    postType,
    subType,
  }
  if (kind === 'message') event.message = normalizeMessage(raw)
  else if (kind === 'notice') event.notice = normalizeNotice(raw)
  else if (kind === 'request') event.request = normalizeRequest(raw)
  else if (kind === 'meta_event') event.meta = normalizeMeta(raw)

  event.raw = truncateRaw(raw, cfg?.events?.rawMaxBytes)
  return event
}
