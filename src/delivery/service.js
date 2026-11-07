import { executeDeliveryPlan } from './executor.js'
import { validateDeliveryPlan } from './plan.js'

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Single-part automatic intents share the executor and outbound guards. */
export function createDeliveryService({ outbound, sleep = defaultSleep } = {}) {
  async function deliver({ chatType, chatId, segments, text = '', source = 'pipeline', decisionId = '', dryRun = null } = {}) {
    if (!['private', 'group'].includes(chatType) || !String(chatId ?? '').trim()) return { ok: false, error: 'INVALID_TARGET' }
    const body = segments !== undefined ? segments
      : typeof text === 'string' && text.trim() ? [{ type: 'text', data: { text } }] : []
    const plan = {
      target: { chatType, chatId }, source, decisionId,
      parts: [{ segments: body, delayAfterMs: 0 }],
    }
    if (!validateDeliveryPlan(plan)) return { ok: false, error: 'EMPTY_MESSAGE' }
    if (typeof outbound?.deliver !== 'function') return { ok: false, error: 'OUTBOUND_UNAVAILABLE' }

    let outboundResult
    const result = await executeDeliveryPlan({
      plan, sleep, dryRun,
      deliver: async (intent) => {
        outboundResult = await outbound.deliver(intent)
        return outboundResult
      },
    })
    return { ...outboundResult, ...result, parts: 1 }
  }

  return { deliver }
}
