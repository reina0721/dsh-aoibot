// 会话轮次聚合：消息 ≠ 完整发言。
//
// 纯本地启发式，不调用 LLM。每个 (chatType, chatId, senderId) 独立缓冲；
// 群聊按发送者隔离，绝不把 A/B 的话拼成一句。软截止随新消息重置，硬截止固定，
// 永远有上限；open turn 写入 store 以支持重启恢复。

import { clamp, uid } from './util.js'

const INCOMPLETE_TAIL = [
  '然后', '但是', '因为', '所以', '而且', '还有', '就是', '我觉得', '我想',
  '比如', '等一下', '你知道吗', '我想说', '还有就是', '所以说', '那个', '这',
  '我跟你', '对了', '话说',
]
const TERMINAL_RE = /[。！？!?…]$/
const SOFT_END_RE = /[，,、；;：:—\-]$/
const COMMAND_RE = /^[\/!#.](?=\S)/
const COMMAND_WORDS = /^(帮助|状态|连接|断开|重连|发送|配置|设置|暂停|恢复|ping|help)(?:\s|$)/i

export function isCommandText(text) {
  const s = String(text || '').trim()
  if (!s) return false
  return COMMAND_RE.test(s) || COMMAND_WORDS.test(s)
}

export function hasMedia(segments = []) {
  return (Array.isArray(segments) ? segments : []).some((segment) => ['image', 'record', 'video', 'file', 'forward'].includes(segment?.type))
}

export function scoreCompleteness(text, { priorGapMs = Infinity, addressed = false, segments = [], mentionOnly = false } = {}) {
  const s = String(text || '').trim()
  const len = [...s].length
  let c = 0.5
  if (TERMINAL_RE.test(s)) c += 0.2
  if (SOFT_END_RE.test(s)) c -= 0.15
  if (INCOMPLETE_TAIL.some((tail) => s.endsWith(tail))) c -= 0.3
  if (len > 0 && len < 6) c -= 0.15
  if (mentionOnly || (len <= 4 && /^[@＠]?[\w\u4e00-\u9fff]{0,4}$/.test(s) && !TERMINAL_RE.test(s))) c -= 0.2
  if (addressed) c += 0.2
  if (/[？?]$/.test(s)) c += 0.1
  if (hasMedia(segments)) c += 0.1
  if (priorGapMs < 1200) c -= 0.2
  return clamp(c, 0, 1)
}

export function waitWindowMs({ text, completeness, addressed = false, chatType = 'private', config = {}, priorGapMs = Infinity } = {}) {
  const turn = config.turn || {}
  const len = [...String(text || '').trim()].length
  const shuffled = {}
  const base = chatType === 'group' ? Math.max(1200, Number(turn.privateBaseMs ?? 1800) * 0.9) : Number(turn.privateBaseMs ?? 1800)
  const incomplete = Number(turn.incompleteFactorMs ?? 4500)
  const short = len < 8 ? Number(turn.shortMsgMs ?? 1200) : 0
  const habitMax = Number(turn.habitAdjMaxMs ?? 1500)
  const habit = Number.isFinite(priorGapMs) ? clamp(priorGapMs * 0.35, 0, habitMax) : 0
  const soft = clamp(base + (1 - completeness) * incomplete + short + (addressed ? 600 : 0) + habit, 1200, 8000)
  const hardMax = Number(chatType === 'group' ? turn.groupMaxMs ?? 9000 : turn.privateMaxMs ?? 10000)
  const hard = clamp(Math.max(soft + 2000, 8000), 3000, hardMax)
  return { soft, hard, base, short, habit, shuffled }
}

export function createTurnAggregator({ getConfig, clock, scheduler, store, log, onTurn, onRecall, getWakeWords } = {}) {
  const cfg = () => {
    try { return getConfig()?.cognition || {} } catch (error) { return {} }
  }
  const state = new Map()
  const botMessageIds = new Set()
  const seenMessageIds = new Set()
  let disposed = false
  const stats = { received: 0, buffered: 0, turns: 0, cancelled: 0, recalled: 0, forced: 0 }

  function keyOf(chatType, chatId, senderId) {
    return `${chatType}:${chatId}:${senderId}`
  }

  function addressedFor(record) {
    const c = cfg()
    const message = record?.message || {}
    if (message.chatType === 'private') return true
    const selfId = String(record.selfId || '')
    const botQQ = String(c.botQQ || getConfig()?.botQQ || '')
    if (Array.isArray(message.mentions) && message.mentions.some((mention) => {
      const id = String(mention?.userId || '')
      return id && (id === selfId || id === botQQ || id === 'all')
    })) return true
    if (message.replyId && botMessageIds.has(String(message.replyId))) return true
    let extra = []
    try { extra = getWakeWords?.() || [] } catch (error) {}
    const words = [...(c.turn?.wakeWords || []), ...extra].filter(Boolean)
    return words.some((word) => String(message.text || '').includes(String(word)))
  }

  function close(key, reason, record = null) {
    const buf = state.get(key)
    if (!buf) return null
    state.delete(key)
    if (buf.softTimer) scheduler?.clearTimeout?.(buf.softTimer)
    if (buf.hardTimer) scheduler?.clearTimeout?.(buf.hardTimer)
    if (buf.messages.length === 0) {
      stats.cancelled += 1
      if (store && buf.storeId) store.put('turn', buf.storeId, { ...buf.record, status: 'cancelled', closeReason: reason, closedAt: clock.now() })
      return null
    }
    const now = clock.now()
    const turn = {
      id: buf.id,
      turnId: buf.id,
      key,
      chatType: buf.chatType,
      chatId: buf.chatId,
      senderId: buf.senderId,
      selfId: buf.selfId || '',
      text: buf.messages.map((message) => message.text).filter(Boolean).join('\n'),
      messages: buf.messages.slice(),
      messageIds: buf.messages.map((message) => message.messageId).filter(Boolean),
      firstAt: buf.firstAt,
      lastAt: buf.lastAt,
      closedAt: now,
      addressed: buf.addressed,
      completeness: buf.completeness,
      closeReason: reason,
      status: 'ready',
    }
    stats.turns += 1
    if (record) stats.forced += reason === 'hard_deadline' ? 1 : 0
    if (store && buf.storeId) {
      store.put('turn', buf.storeId, {
        ...buf.record,
        ...turn,
        storeId: buf.storeId,
        status: 'ready',
        closeReason: reason,
        updatedAt: now,
      })
    }
    try {
      const result = onTurn?.(turn)
      if (result && typeof result.catch === 'function') result.catch((error) => log?.warn?.('onTurn 失败：', error.message))
    } catch (error) {
      log?.warn?.('onTurn 同步失败：', error.message)
    }
    return turn
  }

  function schedule(buf) {
    if (disposed) return
    if (buf.softTimer) scheduler?.clearTimeout?.(buf.softTimer)
    if (buf.hardTimer) scheduler?.clearTimeout?.(buf.hardTimer)
    const now = clock.now()
    const softAt = Math.max(now + 20, buf.lastAt + buf.softMs)
    const hardAt = Math.max(now + 40, buf.firstAt + buf.hardMs)
    buf.softTimer = scheduler?.setTimeout?.(() => {
      if (state.get(buf.key) !== buf) return
      close(buf.key, 'soft_deadline')
    }, softAt - now)
    buf.hardTimer = scheduler?.setTimeout?.(() => {
      if (state.get(buf.key) !== buf) return
      close(buf.key, 'hard_deadline', true)
    }, hardAt - now)
  }

  function ingest(record) {
    if (disposed || !record || record.kind !== 'message') return null
    const message = record.message || {}
    const chatType = message.chatType === 'group' ? 'group' : message.chatType === 'private' ? 'private' : ''
    if (!chatType) return null
    const chatId = String(message.chatId || '')
    const senderId = String(message.sender?.userId || '')
    if (!chatId || !senderId) return null
    const messageId = String(message.id || `${record.seq || 0}`)
    stats.received += 1
    if (seenMessageIds.has(messageId)) return null
    seenMessageIds.add(messageId)
    if (seenMessageIds.size > 5000) seenMessageIds.delete(seenMessageIds.values().next().value)
    const key = keyOf(chatType, chatId, senderId)
    let buf = state.get(key)
    const now = clock.now()
    if (!buf) {
      buf = {
        id: uid('turn'),
        key,
        chatType,
        chatId,
        senderId,
        selfId: String(record.selfId || ''),
        messages: [],
        messageIds: new Set(),
        firstAt: now,
        lastAt: now,
        addressed: false,
        completeness: 0.5,
        softMs: 1800,
        hardMs: 10000,
        record: { chatType, chatId, senderId, selfId: String(record.selfId || ''), status: 'open', startedAt: now },
      }
      state.set(key, buf)
      if (store) {
        buf.storeId = buf.id
        store.put('turn', buf.storeId, { ...buf.record, messages: [], messageIds: [] })
      }
    }
    if (buf.messageIds.has(messageId)) return null
    const addressed = addressedFor(record)
    const priorGap = buf.messages.length ? now - buf.lastAt : Infinity
    const text = String(message.text || '')
    const completeness = scoreCompleteness(text, {
      priorGapMs: priorGap,
      addressed,
      segments: message.segments,
      mentionOnly: Array.isArray(message.mentions) && message.mentions.length > 0 && !text.trim(),
    })
    const window = waitWindowMs({ text, completeness, addressed, chatType, config: cfg(), priorGapMs: priorGap })
    buf.messages.push({
      messageId,
      text,
      at: now,
      time: record.time,
      sender: message.sender || {},
      segments: message.segments || [],
      mentions: message.mentions || [],
      images: message.images || [],
      replyId: message.replyId || '',
      rawSeq: record.seq || 0,
    })
    buf.messageIds.add(messageId)
    buf.lastAt = now
    buf.addressed = buf.addressed || addressed
    buf.completeness = completeness
    buf.softMs = window.soft
    buf.hardMs = window.hard
    stats.buffered += 1
    if (store && buf.storeId) {
      store.put('turn', buf.storeId, {
        ...buf.record,
        messages: buf.messages,
        messageIds: [...buf.messageIds],
        addressed: buf.addressed,
        completeness,
        softMs: window.soft,
        hardMs: window.hard,
        lastAt: now,
        updatedAt: now,
      })
    }
    const fast = isCommandText(text) && (chatType === 'private' || addressed)
    if (buf.messages.length >= Number(cfg().turn?.maxAggregateMessages || 20)) {
      return close(key, 'max_messages')
    }
    if (fast) {
      if (buf.softTimer) scheduler?.clearTimeout?.(buf.softTimer)
      const ms = Number(cfg().turn?.fastPathMs || 300)
      buf.softTimer = scheduler?.setTimeout?.(() => close(key, 'command'), Math.max(0, ms))
      return null
    }
    schedule(buf)
    return null
  }

  /** 撤回通知：从正在聚合的轮次中移除被撤回消息；已形成轮次的记录 recalled。 */
  function handleRecall(notice) {
    if (!notice || notice.type !== 'notice' || notice.subType !== 'recall') return false
    const messageId = String(notice.messageId || '')
    if (!messageId) return false
    stats.recalled += 1
    for (const [key, buf] of state) {
      const index = buf.messages.findIndex((message) => message.messageId === messageId)
      if (index >= 0) {
        buf.messages.splice(index, 1)
        buf.messageIds.delete(messageId)
        if (buf.messages.length === 0) close(key, 'recall')
        else schedule(buf)
        onRecall?.({ messageId, notice, turn: null, status: 'removed_from_open' })
        return true
      }
    }
    // 已关闭轮次：只在 store 里标记，不改变已发送事实。
    if (store) {
      const turn = store.list('turn', { where: (item) => Array.isArray(item.messageIds) && item.messageIds.includes(messageId), limit: 1 })[0]
      if (turn) {
        store.put('turn', turn.id, { ...turn, recalledMessageIds: [...new Set([...(turn.recalledMessageIds || []), messageId])] })
        onRecall?.({ messageId, notice, turn, status: 'closed_turn' })
        return true
      }
    }
    return false
  }

  function restore() {
    if (!store) return 0
    const open = store.list('turn', { where: (item) => item.status === 'open', limit: 200 })
    const now = clock.now()
    for (const item of open) {
      const key = item.key || keyOf(item.chatType, item.chatId, item.senderId)
      if (state.has(key)) continue
      const elapsed = now - Number(item.lastAt || item.startedAt || now)
      const hardMs = Number(item.hardMs || 10000)
      if (elapsed >= hardMs) {
        store.put('turn', item.id, { ...item, status: 'ready', closeReason: 'restart', closedAt: now })
        try { onTurn?.({ ...item, closedAt: now, closeReason: 'restart', addressed: Boolean(item.addressed) }) } catch (error) {}
      } else {
        const buf = {
          ...item,
          key,
          storeId: item.id,
          id: item.id,
          messages: Array.isArray(item.messages) ? item.messages : [],
          messageIds: new Set(item.messageIds || []),
          firstAt: Number(item.startedAt || item.firstAt || now),
          lastAt: Number(item.lastAt || now),
          addressed: Boolean(item.addressed),
          completeness: Number(item.completeness || 0.5),
          softMs: Number(item.softMs || 1800),
          hardMs,
          record: item,
        }
        state.set(key, buf)
        schedule(buf)
      }
    }
    return open.length
  }

  function noteBotMessage(messageId) {
    if (!messageId) return
    botMessageIds.add(String(messageId))
    if (botMessageIds.size > 500) botMessageIds.delete(botMessageIds.values().next().value)
  }

  function cancelAll(reason = 'dispose') {
    for (const key of [...state.keys()]) close(key, reason)
  }

  function dispose() {
    disposed = true
    cancelAll('dispose')
    scheduler?.clearTimeout?.()
  }

  return {
    ingest,
    handleRecall,
    restore,
    noteBotMessage,
    cancelAll,
    dispose,
    get stats() { return { ...stats, open: state.size } },
    get _state() { return state },
  }
}
