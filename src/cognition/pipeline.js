// 认知管线：turn → 人物/关系/情绪 → 记忆检索 → 分析 → 策略 → 回复 → 结果。
//
// 每一步都有 trace；LLM 不可用/失败时进入 degraded，不伪造回复。
// dryRun 会完整决策但不发送，供验证/演练。

import { clamp, deepClone, round, truncate, uid, scopeAllows } from './util.js'
import { analyzeTurn, composeReply } from './analysis.js'
import { defaultScope } from './memory.js'

export function createPipeline({
  store, getConfig, clock, logger,
  person, relationships, emotion, persona, memory, policy, llm,
  knowledge = null, skills = null, gateway = null, turnAggregator = null,
  beliefs = null, dryRun = null, outbound = null, runtime = null, commands = null,
} = {}) {
  const log = logger?.child?.('pipeline') || logger || { debug() {}, warn() {}, info() {} }
  let turnAggregatorRef = turnAggregator
  const pending = new Map() // chatKey -> { decisionId, sentAt, action }
  const groupReplyAt = new Map() // chatKey -> last reply timestamp
  const groupReplyTimes = [] // sliding minute window
  const cfg = () => getConfig()?.cognition || {}
  const isDry = () => (dryRun == null ? Boolean(cfg().dryRun) : Boolean(dryRun))
  const stats = {
    turns: 0, decisions: 0, sent: 0, dryRun: 0, degraded: 0, errors: 0, silenced: 0,
    groupSkipped: 0, groupSkippedByReason: {}, lastTurn: null,
  }

  function trace(turnId, stage, summary = {}, extra = {}) {
    if (!cfg().debug?.trace) return
    try {
      store.put('trace', uid('trace'), {
        turnId: turnId || '',
        stage,
        summary: String(summary?.text || ''),
        data: summary?.data || {},
        tokens: Number(extra.tokens || 0),
        latencyMs: Number(extra.latencyMs || 0),
        error: String(extra.error || ''),
        createdAt: clock.now(),
      })
    } catch (error) {}
  }

  function metric(name, value = 1, labels = {}) {
    try { store.put('metric', uid('metric'), { name, value, labels, at: clock.now() }) } catch (error) {}
  }

  function chatKey(turn) {
    return `${turn?.chatType || 'unknown'}:${turn?.chatId || ''}`
  }

  function effectiveGroupMode() {
    const t = cfg().turn || {}
    if (['addressed', 'probability', 'all'].includes(t.groupReplyMode)) return t.groupReplyMode
    if (t.addressedOnlyGroups === false || cfg().policy?.groupAmbient) return 'all'
    return 'addressed'
  }

  function groupReplyAllowed(turn) {
    const now = clock.now()
    while (groupReplyTimes.length && now - groupReplyTimes[0] > 60000) groupReplyTimes.shift()
    const max = Math.max(1, Number(cfg().turn?.groupMaxRepliesPerMinute) || 6)
    if (groupReplyTimes.length >= max) return { ok: false, reason: 'rate_limited' }
    if (!turn.addressed) {
      const cooldown = Math.max(0, Number(cfg().turn?.groupCooldownMs) || 0)
      const last = Number(groupReplyAt.get(chatKey(turn)) || 0)
      if (cooldown && last && now - last < cooldown) return { ok: false, reason: 'cooldown' }
    }
    return { ok: true }
  }

  function noteGroupReply(turn) {
    if (turn?.chatType !== 'group') return
    const now = clock.now()
    groupReplyAt.set(chatKey(turn), now)
    groupReplyTimes.push(now)
  }

  function markLast(turn, outcome, reason = '', extra = {}) {
    stats.lastTurn = {
      at: clock.now(),
      chatType: turn?.chatType || '',
      chatId: String(turn?.chatId || ''),
      addressed: Boolean(turn?.addressed),
      mode: turn?.chatType === 'group' ? effectiveGroupMode() : 'private',
      outcome,
      reason,
      ...extra,
    }
  }

  function skipGroup(turn, personRecord, emotionState, scope, reason) {
    memory.encodeTurn(turn, { personId: personRecord?.person?.id || '', emotion: emotionState, scope, source: 'ambient' })
    stats.groupSkipped += 1
    stats.groupSkippedByReason[reason] = (stats.groupSkippedByReason[reason] || 0) + 1
    markLast(turn, 'skipped', reason)
    trace(turn.id, 'group_skipped', {
      text: reason,
      data: { mode: effectiveGroupMode(), addressed: Boolean(turn.addressed), reason },
    })
    return buildResult({ ok: true, decision: null, reply: '', degraded: false, error: `group_${reason}` })
  }

  function scopeOf(turn) {
    return defaultScope(turn?.chatType, turn?.chatId)
  }

  function boundScope(turn) {
    return { scopeType: scopeOf(turn).scopeType, scopeId: scopeOf(turn).scopeId }
  }

  function personFromTurn(turn) {
    try {
      const result = person.ensurePerson({
        platform: 'onebot11',
        platformUserId: turn.senderId,
        nickname: turn.messages?.[0]?.sender?.nickname || turn.messages?.[0]?.nickname || '',
        card: turn.messages?.[0]?.sender?.card || '',
        scopeType: scopeOf(turn).scopeType,
        scopeId: scopeOf(turn).scopeId,
      })
      return result
    } catch (error) {
      log.warn?.('人物识别失败：', error.message)
      return null
    }
  }

  function relationshipFor(turn, personRecord) {
    if (!personRecord?.person?.id) return null
    const scope = boundScope(turn)
    const rel = relationships.getMerged(personRecord.person.id, scope)
    return rel
  }

  function updatePersonFacets(turn, personRecord, analysis) {
    if (!personRecord?.person?.id) return
    const scope = scopeOf(turn)
    try {
      const text = String(turn.text || '')
      if (text.length >= 4) {
        person.addFacet({
          personId: personRecord.person.id,
          facet: 'language_style',
          value: `${text.length <= 30 ? '短句/碎片' : '长句'}；${/[？?]/.test(text) ? '常用提问' : /[！!]/.test(text) ? '常用感叹' : '陈述为主'}`,
          evidenceKind: 'observation',
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
          confidence: 0.35,
          sourceKind: 'turn',
          sourceRef: turn.id,
        })
      }
      const intent = analysis?.intent
      if (intent && ['question', 'emotional', 'greeting'].includes(intent)) {
        person.addFacet({
          personId: personRecord.person.id,
          facet: 'interaction_pattern',
          value: `常出现「${intent}」类互动`,
          evidenceKind: 'observation',
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
          confidence: 0.3,
          sourceKind: 'analysis',
          sourceRef: turn.id,
        })
      }
      const hour = new Date(clock.now()).getHours()
      person.addFacet({
        personId: personRecord.person.id,
        facet: 'activity_pattern',
        value: `${hour < 6 ? '深夜' : hour < 12 ? '上午' : hour < 18 ? '下午' : '晚间'}活跃`,
        evidenceKind: 'observation',
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        confidence: 0.25,
        sourceKind: 'turn',
        sourceRef: turn.id,
      })
    } catch (error) {
      log.debug?.('画像更新跳过：', error.message)
    }
  }

  function appraisalFor(analysis, turn, relationship, emotionState) {
    const a = analysis?.appraisal || {}
    return {
      desirability: clamp(Number(a.desirability ?? (turn.addressed ? 0.15 : 0)), -1, 1),
      relevance: clamp(Number(a.relevance ?? (turn.addressed ? 0.8 : 0.4)), 0, 1),
      intensity: clamp(Number(a.intensity ?? 0.45), 0, 1),
      novelty: clamp(Number(a.novelty ?? 0.2), 0, 1),
      control: clamp(Number(a.control ?? 0.5), 0, 1),
      agency: ['self', 'other', 'none'].includes(a.agency) ? a.agency : 'other',
      norm: clamp(Number(a.norm ?? 0), -1, 1),
      threat: a.threat,
      intent: analysis?.intent || 'chat',
      source: 'analysis',
      relationshipTrust: relationship?.trust,
      currentValence: emotionState?.valence,
    }
  }

  function relationshipEvidence(analysis, turn, emotionState) {
    const a = analysis?.appraisal || {}
    const desirability = Number(a.desirability ?? 0)
    const addressed = turn?.addressed
    return {
      affinity: clamp(0.5 + desirability * 0.5, 0, 1),
      trust: clamp(0.5 + desirability * 0.35, 0, 1),
      familiarity: addressed ? 1 : 0.5,
      intimacy: addressed ? 0.35 : 0.15,
      comfort: clamp(0.55 + (Number(emotionState?.valence || 0) > 0 ? 0.08 : -0.04), 0, 1),
      conflict: clamp(Math.max(0, -desirability) * 0.6, 0, 1),
      wariness: clamp(Math.max(0, -desirability) * 0.35, 0, 1),
      confidence: addressed ? 0.65 : 0.4,
      contextFactor: turn?.chatType === 'private' ? 1 : 0.8,
    }
  }

  function buildResult({ ok, decision, reply, analysis, degraded, error, command = false }) {
    return {
      ok: Boolean(ok),
      decision: decision || null,
      reply: reply || '',
      analysis: analysis || null,
      degraded: Boolean(degraded),
      error: error || '',
      command: Boolean(command),
      at: clock.now(),
    }
  }

  async function composeFor(decision, context) {
    const c = cfg()
    if (decision.action === 'silence' || decision.action === 'wait' || decision.action === 'recall_silence' || decision.action === 'recall_ignore') {
      return { ok: true, text: '', skipped: true }
    }
    if (!llm) return { ok: false, degraded: true, error: 'LLM_UNAVAILABLE' }
    return composeReply({
      turn: context.turn,
      person: context.personRecord?.person,
      relationship: context.relationship,
      emotion: context.emotionState,
      persona: context.personaState,
      memories: context.memories,
      decision,
      analysis: context.analysis,
      llm,
      config: c,
      runtime,
    })
  }

  async function sendDirect(decision, segments, turn) {
    if (!gateway?.actions?.sendMessage) return { ok: false, error: 'GATEWAY_UNAVAILABLE' }
    if (isDry()) {
      policy.markSent(decision.id, { dryRun: true })
      return { ok: true, dryRun: true, messageId: '' }
    }
    try {
      const result = await gateway.actions.sendMessage({ chatType: turn.chatType, chatId: turn.chatId, message: segments })
      const messageId = String(result?.message_id ?? result?.data?.message_id ?? result?.id ?? '')
      policy.markSent(decision.id, { messageId })
      return { ok: true, messageId, result }
    } catch (error) {
      policy.markFailed(decision.id, error.message)
      return { ok: false, error: error.message }
    }
  }

  async function sendDecision(decision, text, turn, opts = {}) {
    if (!text) {
      policy.markSent(decision.id, { dryRun: isDry() })
      if (isDry()) stats.dryRun += 1
      return { ok: true, dryRun: isDry(), messageId: '' }
    }
    const segments = []
    const replyTo = turn.messages?.at(-1)?.messageId
    if (replyTo && !opts.noReplySegment) segments.push({ type: 'reply', data: { id: replyTo } })
    segments.push({ type: 'text', data: { text } })
    const delivered = outbound && typeof outbound.deliver === 'function'
      ? await outbound.deliver({
          chatType: turn.chatType,
          chatId: turn.chatId,
          segments,
          decisionId: decision.id,
          source: 'pipeline',
          dryRun: isDry() ? true : null,
        })
      : await sendDirect(decision, segments, turn)
    if (!delivered?.ok) {
      log.warn?.('发送认知回复失败：', delivered?.message || delivered?.error || 'unknown')
      return { ok: false, error: delivered?.error || 'SEND_FAILED', blocked: Boolean(delivered?.blocked), reason: delivered?.reason || '' }
    }
    if (delivered.dryRun) {
      stats.dryRun += 1
      return { ok: true, dryRun: true, messageId: '' }
    }
    const messageId = String(delivered.messageId || '')
    turnAggregatorRef?.noteBotMessage?.(messageId)
    stats.sent += 1
    noteGroupReply(turn)
    pending.set(chatKey(turn), { decisionId: decision.id, sentAt: clock.now(), action: decision.action, text })
    try { ctxEmit('onebot-qq/cognition-sent', { decisionId: decision.id, messageId, chatType: turn.chatType, chatId: turn.chatId, action: decision.action }) } catch (error) {}
    return { ok: true, messageId, result: delivered.result }
  }

  function ctxEmit() {}

  function outcomeForIncoming(turn) {
    const key = chatKey(turn)
    const item = pending.get(key)
    if (!item) return null
    if (clock.now() - item.sentAt > 10 * 60 * 1000) { pending.delete(key); return null }
    pending.delete(key)
    const text = String(turn.text || '')
    const observation = {
      userContinued: Boolean(text),
      explicitCorrection: /(不对|错了|不是|你理解错|别这么说|别乱说)/.test(text),
      sentiment: /(谢谢|哈哈|好|喜欢|厉害)/.test(text) ? 0.4 : /(烦|滚|讨厌|闭嘴)/.test(text) ? -0.5 : 0,
      positiveReaction: /(哈哈|笑死|好耶|喜欢)/.test(text) || undefined,
      userIgnored: false,
      attributionConfidence: 0.5,
    }
    try { policy.recordOutcome(item.decisionId, observation) } catch (error) { log.debug?.('outcome 记录失败：', error.message) }
    try {
      const decision = store.get('decision', item.decisionId)
      skills?.applyOutcome?.(decision, observation.positiveReaction || observation.sentiment > 0 ? true : observation.explicitCorrection ? false : null)
    } catch (error) {}
    return observation
  }

  async function handleRecall(event = {}) {
    const c = cfg()
    if (!c.enabled || c.paused) return buildResult({ ok: false, error: 'cognition_paused' })
    const notice = event.notice || {}
    const personResult = person.ensurePerson({ platform: 'onebot11', platformUserId: String(notice.userId || ''), scopeType: notice.groupId ? 'group' : 'private', scopeId: String(notice.groupId || notice.userId || '') })
    const personRecord = personResult
    const chatType = notice.groupId ? 'group' : 'private'
    const chatId = String(notice.groupId || notice.userId || '')
    const scope = { scopeType: chatType, scopeId: chatId }
    const rel = personRecord?.person?.id ? relationships.getMerged(personRecord.person.id, scope) : null
    const emotionState = emotion.get()
    const personaState = persona.get()
    const sawContent = Boolean(event.sawContent)
    const pseudoTurn = {
      id: uid('turn'),
      chatType,
      chatId,
      senderId: String(notice.userId || ''),
      text: '[撤回了一条消息]',
      messages: [],
      messageIds: [String(notice.messageId || '')],
      addressed: chatType === 'private',
      completeness: 1,
      closeReason: 'recall',
      status: 'recall',
    }
    const decision = policy.decide({ turn: pseudoTurn, relationship: rel, emotion: emotionState, appraisal: { desirability: -0.1, relevance: 0.8, intensity: 0.5, intent: 'recall' }, persona: personaState, memories: [], recall: { messageId: String(notice.messageId || ''), sawContent } })
    stats.decisions += 1
    trace(pseudoTurn.id, 'recall_decision', { text: `${decision.action} saw=${sawContent}`, data: { action: decision.action } })
    const composed = await composeFor(decision, { turn: pseudoTurn, personRecord, relationship: rel, emotionState, personaState, memories: [], analysis: { intent: 'recall', replyGoal: '处理撤回' }, sawContent })
    if (!composed.ok) {
      stats.degraded += 1
      return buildResult({ ok: false, decision, degraded: true, error: composed.error })
    }
    if (composed.skipped || !composed.text) {
      policy.markSent(decision.id, { dryRun: isDry() })
      if (isDry()) stats.dryRun += 1
      return buildResult({ ok: true, decision, reply: '', degraded: false })
    }
    const sent = await sendDecision(decision, composed.text, pseudoTurn)
    return buildResult({ ok: sent.ok, decision, reply: composed.text, degraded: false, error: sent.error })
  }

  async function handleTurn(turn) {
    if (!turn) return buildResult({ ok: false, error: 'no_turn' })
    const c = cfg()
    if (!c.enabled) return buildResult({ ok: false, error: 'cognition_disabled' })
    if (c.paused) return buildResult({ ok: false, error: 'cognition_paused' })
    // 绝不把机器人自己的消息当成用户输入；否则会形成回复循环。
    if (turn.senderId && (turn.senderId === turn.selfId || turn.senderId === String(getConfig()?.botQQ || ''))) {
      return buildResult({ ok: false, error: 'self_message' })
    }
    if (commands && typeof commands.handle === 'function') {
      try {
        const handled = await commands.handle(turn)
        if (handled && handled.handled) {
          stats.turns += 1
          markLast(turn, handled.reply ? 'sent' : 'silenced')
          trace(turn.id, 'command', { text: truncate(turn.text, 120), data: { replied: handled.reply ? 1 : 0 } })
          return buildResult({ ok: true, decision: null, reply: handled.reply || '', command: true })
        }
      } catch (error) {
        log.warn?.('命令处理失败：', error.message)
      }
    }
    const started = clock.now()
    stats.turns += 1
    markLast(turn, 'processing')
    trace(turn.id, 'turn_start', { text: truncate(turn.text, 200), data: { chatType: turn.chatType, addressed: turn.addressed, completeness: turn.completeness } })
    const record = personFromTurn(turn)
    const personRecord = record
    const rel = relationshipFor(turn, personRecord)
    const emotionState = emotion.get()
    const personaState = persona.get()
    const scope = boundScope(turn)
    const memories = memory.retrieve({ query: turn.text, personId: personRecord?.person?.id || '', scope, emotion: emotionState, relationship: rel })
    trace(turn.id, 'retrieved', { text: `${memories.length} memories`, data: { memoryIds: memories.map((item) => item.memory.id) } })
    // 群聊 gate：默认仅点名；可配置为概率参与或所有消息。所有模式仍写记忆。
    if (turn.chatType === 'group') {
      const mode = effectiveGroupMode()
      if (mode === 'addressed' && !turn.addressed) {
        return skipGroup(turn, personRecord, emotionState, scope, 'addressed_only')
      }
      if (mode === 'probability' && !turn.addressed) {
        const probability = clamp(Number(cfg().turn?.groupReplyProbability ?? 0.2), 0, 1)
        if (Math.random() >= probability) {
          return skipGroup(turn, personRecord, emotionState, scope, 'probability_miss')
        }
      }
      const allowed = groupReplyAllowed(turn)
      if (!allowed.ok) return skipGroup(turn, personRecord, emotionState, scope, allowed.reason)
    }
    const analysis = await analyzeTurn({
      turn, person: personRecord?.person, relationship: rel, emotion: emotionState, memories, persona: personaState,
      llm, config: c, logger: log,
    })
    trace(turn.id, 'analysis', {
      text: `${analysis.intent} conf=${analysis.confidence}`,
      data: { degraded: Boolean(analysis.degraded), source: analysis.source || '', llmError: analysis.llmError || '', route: analysis.llmRoute || null },
    }, { tokens: analysis.tokens || 0 })
    if (analysis.degraded) stats.degraded += 1
    const appraisal = appraisalFor(analysis, turn, rel, emotionState)
    emotion.appraise(appraisal, { source: 'turn', text: turn.text })
    const evidence = relationshipEvidence(analysis, turn, emotionState)
    relationships.update(personRecord?.person?.id, evidence, { scopeType: scope.scopeType, scopeId: scope.scopeId, reason: 'turn', source: 'analysis' })
    updatePersonFacets(turn, personRecord, analysis)
    const episodic = memory.encodeTurn(turn, { personId: personRecord?.person?.id || '', emotion: emotion.get(), scope, source: 'turn' })
    trace(turn.id, 'memory_encoded', { text: episodic?.id || 'none' })
    if (analysis.beliefCandidates?.length) {
      for (const belief of analysis.beliefCandidates) {
        try {
          beliefs?.upsert?.({
            subject: belief.subject || (personRecord?.person?.displayName || ''),
            proposition: belief.proposition,
            probability: Number.isFinite(belief.probability) ? belief.probability : 0.5,
            evidenceWeight: turn.addressed ? 0.2 : 0.08,
            evidence: { text: truncate(turn.text, 200), turnId: turn.id, messageIds: turn.messageIds },
            status: ['fact', 'hypothesis', 'disputed', 'outdated'].includes(belief.status) ? belief.status : 'hypothesis',
            scopeType: scope.scopeType,
            scopeId: scope.scopeId,
            source: 'analysis',
          })
        } catch (error) { log.debug?.('belief 写入失败：', error.message) }
      }
    }
    let gaps = []
    if (knowledge) {
      try { gaps = knowledge.detectFromTurn({ turn, analysis, personId: personRecord?.person?.id || '', scope, config: c }) } catch (error) { log.debug?.('unknown 检测失败：', error.message) }
    }
    const skillMap = {}
    for (const skill of skills?.list?.() || []) skillMap[skill.name] = skill.effectiveMastery
    const groupEngaged = turn.chatType === 'group' && !turn.addressed && effectiveGroupMode() !== 'addressed'
    const policyTurn = groupEngaged ? { ...turn, groupEngaged: true } : turn
    const decision = policy.decide({ turn: policyTurn, relationship: rel, emotion: emotion.get(), appraisal, unknown: gaps[0] || null, memories, persona: personaState, skills: skillMap })
    stats.decisions += 1
    trace(turn.id, 'decision', { text: decision.action, data: { candidates: decision.candidates?.slice(0, 5), utilities: decision.candidates?.slice(0, 5) } })
    if (decision.action === 'silence' || decision.action === 'wait' || decision.action === 'recall_silence' || decision.action === 'recall_ignore') {
      stats.silenced += 1
      markLast(turn, 'silenced', decision.action)
      if (!isDry()) policy.markSent(decision.id, { dryRun: false })
      trimWorking(turn, personRecord, analysis, decision)
      metric('decision', 1, { action: decision.action })
      return buildResult({ ok: true, decision, reply: '', degraded: analysis.degraded })
    }
    if (decision.action === 'learn') {
      markLast(turn, 'learned', decision.action)
      if (!isDry()) policy.markSent(decision.id, { dryRun: false })
      return buildResult({ ok: true, decision, reply: '', degraded: false })
    }
    const composed = await composeFor(decision, { turn, personRecord, relationship: rel, emotionState: emotion.get(), personaState, memories, analysis })
    if (!composed.ok) {
      stats.degraded += 1
      markLast(turn, 'degraded', composed.error || 'compose_failed')
      policy.markFailed(decision.id, composed.error)
      trace(turn.id, 'compose_failed', { text: composed.error || 'compose failed', data: { message: composed.message || '', route: composed.route || null } })
      log.warn?.('回复生成失败：', composed.error || composed.message || 'unknown')
      return buildResult({ ok: false, decision, degraded: true, error: composed.error })
    }
    if (composed.skipped) {
      markLast(turn, 'composed_empty', composed.error || 'skipped')
      if (!isDry()) policy.markSent(decision.id, { dryRun: false })
      else { policy.markSent(decision.id, { dryRun: true }); stats.dryRun += 1 }
      trimWorking(turn, personRecord, analysis, decision)
      return buildResult({ ok: true, decision, reply: '', degraded: analysis.degraded })
    }
    const sent = await sendDecision(decision, composed.text, turn)
    markLast(turn, sent.ok ? 'sent' : 'send_failed', sent.error || decision.action)
    trace(turn.id, 'sent', { text: truncate(composed.text, 120) }, { latencyMs: clock.now() - started })
    trimWorking(turn, personRecord, analysis, decision)
    metric('decision', 1, { action: decision.action })
    return buildResult({ ok: sent.ok, decision, reply: composed.text, degraded: analysis.degraded, error: sent.error })
  }

  function trimWorking(turn, personRecord, analysis, decision) {
    memory.workingSet(chatKey(turn), {
      turnId: turn.id,
      personId: personRecord?.person?.id || '',
      chatType: turn.chatType,
      chatId: turn.chatId,
      lastIntent: analysis?.intent || '',
      lastDecision: decision?.action || '',
      updatedAt: clock.now(),
    })
    maybeEvolvePersona()
  }

  /** 人格慢演化：最多每 24h 一次，依据近期结果，不因单次事件剧变。 */
  function maybeEvolvePersona() {
    try {
      const last = store.get('state', 'persona.lastEvolvedAt')
      const lastAt = Number(last?.at || 0)
      const elapsed = lastAt ? clock.now() - lastAt : Infinity
      if (elapsed < 24 * 60 * 60 * 1000) return
      const decisions = policy.history({ limit: 40 }).filter((item) => Number.isFinite(item.reward))
      if (decisions.length < 5) return
      const average = decisions.reduce((sum, item) => sum + Number(item.reward || 0), 0) / decisions.length
      const unknowns = store.list('unknown', { limit: 100, where: (item) => item.status === 'open' }).length
      const evidence = {
        socialInitiative: average * 0.35,
        extraversion: average * 0.18,
        caution: -average * 0.3,
        humor: average * 0.2,
        openness: unknowns > 3 ? 0.25 : 0.02,
      }
      persona.maybeEvolve(evidence, Math.min(30, Math.max(1, elapsed / (24 * 60 * 60 * 1000))))
      store.put('state', 'persona.lastEvolvedAt', { at: clock.now(), average, sample: decisions.length })
      trace('', 'persona_evolved', { text: `avg=${average.toFixed(2)}`, data: evidence })
    } catch (error) {
      log.debug?.('人格演化跳过：', error.message)
    }
  }

  /** 每次新的真人 turn 到达时，先观察上一条决策的结果。 */
  function observeIncoming(turn) {
    if (!turn) return null
    return outcomeForIncoming(turn)
  }

  function statsSnapshot() {
    return { ...stats, pending: pending.size }
  }

  function setTurnAggregator(aggregator) {
    turnAggregatorRef = aggregator
  }

  return {
    handleTurn, handleRecall, observeIncoming, stats: statsSnapshot, trace, setTurnAggregator,
    groupMode: effectiveGroupMode, _pending: pending,
  }
}
