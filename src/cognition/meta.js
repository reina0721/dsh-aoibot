// 元认知/自评：校准、策略趋势、来源可靠性、能力缺口、周期反思。
// 反思只写 bounded insight，不改代码/权限/安全策略。

import { clamp, round, truncate, uid } from './util.js'

export function brierScore(pairs) {
  if (!Array.isArray(pairs) || !pairs.length) return null
  const valid = pairs.filter((item) => Number.isFinite(Number(item.confidence)) && Number.isFinite(Number(item.outcome)))
  if (!valid.length) return null
  return round(valid.reduce((sum, item) => sum + (Number(item.confidence) - Number(item.outcome)) ** 2, 0) / valid.length, 4)
}

export function createMetaService({ store, getConfig, clock, log, skills = null, knowledge = null } = {}) {
  function metrics() {
    const decisions = store.list('decision', { limit: 5000 })
    const outcomes = store.list('outcome', { limit: 5000 })
    const sent = decisions.filter((item) => ['sent', 'dry_run', 'observed'].includes(item.status))
    const rewardPairs = decisions.filter((item) => Number.isFinite(item.reward)).map((item) => ({ confidence: item.confidence, outcome: item.reward > 0 ? 1 : item.reward < 0 ? 0 : 0.5 }))
    const byAction = decisions.reduce((acc, item) => {
      const entry = acc[item.action] || { count: 0, reward: 0, observed: 0 }
      entry.count += 1
      if (Number.isFinite(item.reward)) { entry.reward += item.reward; entry.observed += 1 }
      acc[item.action] = entry
      return acc
    }, {})
    const relationCount = store.count('relationship')
    const memoryRows = store.list('memory', { limit: 100000 })
    const unknownRows = store.list('unknown', { limit: 1000 })
    return {
      decisions: decisions.length,
      sent: sent.length,
      silenceRate: round(decisions.filter((item) => item.action === 'silence').length / Math.max(1, decisions.length), 3),
      observed: outcomes.length,
      averageReward: round(decisions.filter((item) => Number.isFinite(item.reward)).reduce((sum, item) => sum + item.reward, 0) / Math.max(1, decisions.filter((item) => Number.isFinite(item.reward)).length), 3),
      brier: brierScore(rewardPairs),
      byAction: Object.fromEntries(Object.entries(byAction).map(([action, entry]) => [action, { ...entry, avgReward: entry.observed ? round(entry.reward / entry.observed, 3) : null }])),
      relations: relationCount,
      memories: { total: memoryRows.length, active: memoryRows.filter((item) => item.status === 'active').length },
      unknowns: { open: unknownRows.filter((item) => item.status === 'open').length, resolved: unknownRows.filter((item) => item.status === 'resolved').length },
      skills: skills?.summary?.() || null,
      learning: knowledge?.stats?.() || null,
    }
  }

  function capabilityGaps() {
    const unknowns = store.list('unknown', { limit: 200, where: (item) => ['open', 'failed'].includes(item.status) })
    const byType = unknowns.reduce((acc, item) => { acc[item.unknownType] = (acc[item.unknownType] || 0) + 1; return acc }, {})
    return Object.entries(byType).map(([type, count]) => ({ type, count, suggestion: type === 'multimodal' ? '接入视觉/语音能力' : type === 'capability' ? '评估新增工具/插件' : '补充知识源或澄清' }))
  }

  function generateInsight() {
    const m = metrics()
    const insights = []
    if (m.observed >= 5 && m.averageReward < -0.05) insights.push('近期策略平均结果为负，应提高澄清/沉默阈值并降低主动调侃。')
    if (m.brier != null && m.brier > 0.3) insights.push('置信度校准偏差较大，低置信时更应澄清而非直接回复。')
    if (m.unknowns.open >= 5) insights.push('未解决知识缺口较多，建议检查学习预算/来源可用性。')
    if (m.silenceRate < 0.05 && m.decisions > 20) insights.push('沉默率极低，检查是否过度回应；确认群聊门槛与频率限制。')
    if (m.skills?.decayed > 0) insights.push('存在技能生疏，可通过实际使用恢复，不需要伪造能力。')
    const record = { id: uid('insight'), insights, metrics: m, createdAt: clock.now() }
    store.put('meta_insight', record.id, record)
    return record
  }

  function listInsights({ limit = 20 } = {}) {
    return store.list('meta_insight', { limit: Number(limit) || 20 })
  }

  return { metrics, capabilityGaps, generateInsight, listInsights }
}
