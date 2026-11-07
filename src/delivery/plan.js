// Internal egress policy. Keep the existing splitter in cognition until a later phase.
import { splitReply } from '../cognition/reply-split.js'

/** Pure reply layout; no configuration reads, policy checks or delivery I/O. */
export function buildReplyPlan({ text, turn, decision, replyCfg = {}, replyTo = '', source = 'pipeline', decisionId = '' }) {
  const texts = !text ? [] : replyCfg.split === false
    ? [String(text)]
    : splitReply(text, { maxChars: replyCfg.maxChars, maxParts: replyCfg.maxParts })
  const quoteId = replyTo || turn?.messages?.at(-1)?.messageId
  const delayMs = Math.max(0, Number(replyCfg.delayMs) || 0)
  return {
    source,
    decisionId: decisionId || decision?.id || '',
    target: { chatType: turn?.chatType, chatId: turn?.chatId },
    parts: texts.map((value, index) => {
      const segments = []
      if (index === 0 && replyCfg.quote !== false && quoteId) segments.push({ type: 'reply', data: { id: quoteId } })
      if (index === 0 && turn?.chatType === 'group' && replyCfg.atSender === true && turn.senderId) segments.push({ type: 'at', data: { qq: String(turn.senderId) } })
      segments.push({ type: 'text', data: { text: value } })
      return { segments, delayAfterMs: index < texts.length - 1 ? delayMs : 0 }
    }),
    meta: { planner: 'core', fallback: false },
  }
}

/** Boolean validation deliberately contains no payloads or diagnostic secrets. */
export function validateDeliveryPlan(plan) {
  if (!plan || !['private', 'group'].includes(plan.target?.chatType)) return false
  const id = plan.target.chatId
  if (!['string', 'number'].includes(typeof id) || !String(id).trim() || (typeof id === 'number' && !Number.isFinite(id))) return false
  if (!Array.isArray(plan.parts) || !plan.parts.length || plan.parts.length > 10) return false
  return plan.parts.every((part) => part && Array.isArray(part.segments) && part.segments.length > 0
    && part.segments.every((segment) => segment && typeof segment.type === 'string' && segment.type.length > 0
      && segment.data && typeof segment.data === 'object' && !Array.isArray(segment.data)
      && (segment.type !== 'text' || (typeof segment.data.text === 'string' && segment.data.text.length > 0)))
    && typeof part.delayAfterMs === 'number' && Number.isFinite(part.delayAfterMs) && part.delayAfterMs >= 0)
}

/** Recovery is one text-only message, through the same outbound guards. */
export function buildFallbackPlan({ text, turn, decision, source = 'pipeline', decisionId = '' }) {
  return {
    source,
    decisionId: decisionId || decision?.id || '',
    target: { chatType: turn?.chatType, chatId: turn?.chatId },
    parts: text && String(text).trim() ? [{ segments: [{ type: 'text', data: { text: String(text) } }], delayAfterMs: 0 }] : [],
    meta: { planner: 'core', fallback: true },
  }
}
