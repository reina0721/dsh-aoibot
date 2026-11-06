// 主动行为：默认关闭；开启后受安静时段、日预算、关系门槛、退避与 LLM 可用性限制。
// 主动消息也作为 decision 记录，便于观察结果与关闭。

import { clamp, round, truncate, uid } from './util.js'

export function isQuietHour(hour, start, end) {
  const s = Number(start)
  const e = Number(end)
  if (!Number.isFinite(s) || !Number.isFinite(e) || s === e) return false
  return s < e ? hour >= s && hour < e : hour >= s || hour < e
}

export function createProactivityService({
  store, getConfig, clock, person, relationships, memory, persona, emotion, llm, gateway, policy, logger, outbound = null,
} = {}) {
  const log = logger?.child?.('proactivity') || logger || { debug() {}, warn() {} }
  const cfg = () => getConfig()?.cognition || {}
  const state = { lastTickAt: 0, lastError: '', sent: 0, skipped: 0 }

  function dailyCount() {
    const from = clock.now() - 24 * 60 * 60 * 1000
    return store.list('decision', { limit: 5000, where: (item) => item.action === 'proactive' && item.createdAt >= from }).length
  }

  async function tick() {
    const c = cfg()
    const p = c.proactivity || {}
    if (!p.enabled || !c.enabled || c.paused) return { ok: false, reason: 'disabled' }
    if (isQuietHour(new Date(clock.now()).getHours(), p.quietStart, p.quietEnd)) return { ok: false, reason: 'quiet_hours' }
    const maxDay = Number(p.maxPrivatePerDay ?? 1)
    if (dailyCount() >= maxDay) return { ok: false, reason: 'daily_budget' }
    const candidates = relationships.list({ scopeType: 'private' })
      .filter((item) => Number(item.dimensions?.familiarity || 0) >= Number(p.minFamiliarity ?? 0.5))
      .sort((a, b) => (Number(b.dimensions?.initiative || 0) + Number(b.dimensions?.affinity || 0)) - (Number(a.dimensions?.initiative || 0) + Number(a.dimensions?.affinity || 0)))
    if (!candidates.length) {
      state.skipped += 1
      return { ok: false, reason: 'no_candidate' }
    }
    const rel = candidates[0]
    const lastAt = Number(rel.lastInteractionAt || 0)
    const backoff = Number(p.backoffHours ?? 24) * 60 * 60 * 1000
    if (lastAt && clock.now() - lastAt < backoff) {
      state.skipped += 1
      return { ok: false, reason: 'backoff' }
    }
    const personRecord = person.detail(rel.personId)
    if (!personRecord) return { ok: false, reason: 'no_person' }
    const memories = await memory.retrieveAsync({ query: '', personId: rel.personId, scope: { scopeType: 'private', scopeId: rel.scopeId || '' }, emotion: emotion.get(), relationship: rel, limit: 4 })
    const personaState = persona.get()
    const promptSystem = [
      '你在为一段持续的私聊主动发起一句话。',
      '只输出一条可直接发送的短文本，不要解释、不要提 AI/系统/记忆库。',
      '自然、短、具体；不质问对方为什么没回；不制造压力；不编造未提供的事实。',
      '如果最近记忆不足，就只做轻量问候/关心。',
    ].join('\n')
    const promptUser = [
      `对方：${personRecord.person.displayName || '对方'}`,
      `关系：熟悉 ${rel.familiarity}, 好感 ${rel.affinity}, 信任 ${rel.trust}, 亲密 ${rel.intimacy}`,
      `最近记忆：${memories.map((item) => truncate(item.memory.summary || item.memory.content, 160)).join('；') || '(无)'}`,
      `当前人格风格：正式度 ${personaState.style?.formality}, 温暖 ${personaState.style?.warmth}, 话痨 ${personaState.style?.verbosity}`,
    ].join('\n')
    let text = ''
    if (llm) {
      const result = await llm.complete({ system: promptSystem, user: promptUser, maxTokens: 220, temperature: 0.8, purpose: 'proactive', chat: { chatType: 'private', chatId: String(rel.scopeId || '') } })
      if (result.ok) text = String(result.text || '').trim()
      else state.lastError = result.message || result.error || 'llm_failed'
    }
    if (!text) {
      state.skipped += 1
      return { ok: false, reason: state.lastError || 'no_text' }
    }
    const decision = {
      id: uid('decision'),
      turnId: '',
      chatType: 'private',
      chatId: String(rel.scopeId || ''),
      personId: rel.personId,
      action: 'proactive',
      contextKey: 'proactive:private',
      candidates: [],
      features: { familiarity: rel.familiarity, affinity: rel.affinity, initiative: rel.initiative },
      expectedUtility: 0.5,
      confidence: 0.5,
      reason: '主动发起：关系允许且无近期互动',
      status: 'pending',
      createdAt: clock.now(),
      updatedAt: clock.now(),
      atHour: Math.floor(clock.now() / (60 * 60 * 1000)),
    }
    store.put('decision', decision.id, decision)
    const dry = Boolean(cfg().dryRun)
    const chatId = String(rel.scopeId || '')
    try {
      let delivered
      if (outbound && typeof outbound.deliver === 'function') {
        delivered = await outbound.deliver({
          chatType: 'private',
          chatId,
          segments: [{ type: 'text', data: { text } }],
          decisionId: decision.id,
          source: 'proactivity',
          dryRun: dry ? true : null,
        })
      } else {
        let messageId = ''
        const isDry = dry || !gateway?.actions?.sendMessage
        if (!isDry) {
          const result = await gateway.actions.sendMessage({ chatType: 'private', chatId, message: [{ type: 'text', data: { text } }] })
          messageId = String(result?.message_id ?? result?.data?.message_id ?? '')
        }
        policy?.markSent?.(decision.id, { messageId, dryRun: isDry })
        delivered = { ok: true, messageId, dryRun: isDry }
      }
      if (!delivered?.ok) {
        const reason = delivered?.reason || delivered?.error || 'send_failed'
        state.lastError = reason
        return { ok: false, reason, blocked: Boolean(delivered?.blocked) }
      }
      const messageId = String(delivered.messageId || '')
      const isDry = Boolean(delivered.dryRun)
      store.put('proactive_intent', uid('proactive'), { personId: rel.personId, chatId, decisionId: decision.id, text, messageId, dryRun: isDry, at: clock.now() })
      state.sent += 1
      state.lastError = ''
      log.info?.('主动行为已发送', rel.personId, text.slice(0, 80))
      return { ok: true, decisionId: decision.id, text, dryRun: isDry }
    } catch (error) {
      state.lastError = error.message
      policy?.markFailed?.(decision.id, error.message)
      return { ok: false, reason: error.message }
    }
  }

  function start(scheduler) {
    const loop = async () => {
      try { await tick() } catch (error) { log.debug?.('主动行为 tick 失败：', error.message) }
      scheduler?.setTimeout?.(loop, 10 * 60 * 1000)
    }
    scheduler?.setTimeout?.(loop, 5 * 60 * 1000)
  }

  return { tick, start, stats: () => ({ ...state, dailyCount: dailyCount() }) }
}
