// 认知核心纯算法/服务测试：turn/persona/emotion/relationship/memory/policy。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../src/cognition/store.js'
import { createClock, createFakeScheduler, createRng } from '../src/cognition/util.js'
import { scoreCompleteness, waitWindowMs, isCommandText, createTurnAggregator } from '../src/cognition/turn.js'
import { defaultPersona, evolvePersona, applyPersonaEdit } from '../src/cognition/persona.js'
import { defaultEmotion, appraiseEmotion, decayEmotion, visibleEmotion } from '../src/cognition/emotion.js'
import { updateRelationship, defaultRelationship, relationshipSummary } from '../src/cognition/relationships.js'
import { importanceOf, relevanceScore, recencyScore } from '../src/cognition/memory.js'
import { buildCandidates, chooseAction, inferReward, contextBucket } from '../src/cognition/policy.js'

const CONFIG = {
  persona: { traits: {}, style: {}, values: [], evolutionEnabled: true, evolutionPerDay: 0.005 },
  emotion: { sensitivity: 0.55, regulation: 0.4, valenceHalfLifeMin: 120, arousalHalfLifeMin: 30, stressHalfLifeMin: 360, moodHalfLifeMin: 480 },
  relationship: { learningRate: 0.15, trustRate: 0.07, intimacyRate: 0.05, conflictRise: 0.2, conflictDecay: 0.03, inertia: 0.85 },
  turn: { privateBaseMs: 1800, privateMaxMs: 10000, groupMaxMs: 9000, fastPathMs: 300, shortMsgMs: 1200, incompleteFactorMs: 4500, habitAdjMaxMs: 1500, maxAggregateMessages: 20 },
  policy: { replyThreshold: 0.52, waitThreshold: 0.38, silenceThreshold: 0.3, addressedBoost: 0.15, groupPenalty: 0.1, epsilon: 0 },
  memory: {},
}

test('turn：完整度特征/等待上限/命令识别', () => {
  assert.ok(scoreCompleteness('我在想') < 0.5)
  assert.ok(scoreCompleteness('我在想', { priorGapMs: 300 }) < scoreCompleteness('我在想。'))
  assert.ok(isCommandText('/status'))
  assert.ok(isCommandText('帮助'))
  assert.equal(isCommandText('你好'), false)
  const w = waitWindowMs({ text: '你好', completeness: 0.3, chatType: 'private', config: CONFIG })
  assert.ok(w.soft >= 1200 && w.soft <= 8000)
  assert.ok(w.hard >= 3000 && w.hard <= CONFIG.turn.privateMaxMs)
  const g = waitWindowMs({ text: '你好', completeness: 0.3, chatType: 'group', config: CONFIG })
  assert.ok(g.hard <= CONFIG.turn.groupMaxMs)
})

test('turn aggregator：同一发送者碎片聚合为一个 turn，A/B 不混合', () => {
  const clock = createClock({ now: () => 1000 })
  const scheduler = createFakeScheduler(0)
  const ready = []
  const agg = createTurnAggregator({ getConfig: () => ({ cognition: CONFIG }), clock, scheduler, onTurn: (turn) => ready.push(turn) })
  const make = (id, userId, text) => ({
    seq: Number(id), kind: 'message', selfId: '999', time: 1000,
    message: { id, chatType: 'group', chatId: 'g1', sender: { userId, nickname: `U${userId}` }, text, segments: [{ type: 'text', data: { text } }], mentions: [], images: [], replyId: '' },
  })
  agg.ingest(make(1, 'A', '我想说'))
  agg.ingest(make(2, 'B', '哈哈哈'))
  agg.ingest(make(3, 'A', '昨天那个事情。'))
  scheduler.advance(20000)
  assert.equal(ready.length, 2, 'A/B 各自一个 turn')
  const a = ready.find((turn) => turn.senderId === 'A')
  const b = ready.find((turn) => turn.senderId === 'B')
  assert.match(a.text, /我想说/)
  assert.match(a.text, /昨天那个事情/)
  assert.equal(b.text, '哈哈哈')
  assert.equal(a.addressed, false)
  agg.dispose()
})

test('persona：单次/短期证据不剧变；长期慢演化有上限与锁定', () => {
  const persona = defaultPersona(CONFIG)
  const one = evolvePersona(persona, { openness: 1 }, { config: CONFIG, elapsedDays: 1 })
  assert.ok(Math.abs(one.traits.openness - persona.traits.openness) <= 0.005 + 1e-9)
  const edited = applyPersonaEdit(persona, { traits: { openness: 0.95 }, locked: ['openness'] })
  assert.equal(edited.persona.traits.openness, 0.9)
  const locked = evolvePersona(edited.persona, { openness: -1 }, { config: CONFIG, elapsedDays: 30 })
  assert.equal(locked.traits.openness, 0.9)
})

test('emotion：评价产生方向、衰减回基线、调节压低外显', () => {
  const base = { ...defaultEmotion(), updatedAt: 0 }
  const happy = appraiseEmotion(base, { desirability: 0.8, relevance: 0.9, intensity: 0.8, novelty: 0.5, agency: 'other' }, { now: 1000, config: { emotion: CONFIG.emotion } })
  assert.ok(happy.valence > base.valence)
  assert.ok(happy.discrete.joy > 0)
  const later = decayEmotion(happy, happy.updatedAt + 10 * 60 * 60 * 1000, { emotion: CONFIG.emotion })
  assert.ok(later.valence < happy.valence)
  assert.ok(Math.abs(later.valence) <= 1)
  const visible = visibleEmotion(happy, { emotion: { ...CONFIG.emotion, regulation: 0.8 } })
  assert.ok(Math.abs(visible.valence) <= Math.abs(happy.valence))
})

test('relationship：多维方向性/冲突升快降慢/单次不越界', () => {
  const rel = defaultRelationship('p1', 'private', '10001')
  const up = updateRelationship(rel, { trust: 0.9, familiarity: 1, intimacy: 0.8, conflict: 0.6 }, { config: CONFIG, now: 2000 })
  assert.ok(up.relationship.trust > rel.trust)
  assert.ok(up.relationship.conflict > rel.conflict)
  assert.ok(up.relationship.familiarity <= 1 && up.relationship.intimacy <= 1)
  const down = updateRelationship(up.relationship, { trust: 0.1, conflict: 0.9 }, { config: CONFIG, now: 3000 })
  assert.ok(down.relationship.trust < up.relationship.trust)
  assert.ok(down.relationship.conflict >= up.relationship.conflict)
  assert.ok(relationshipSummary(up.relationship).length > 0)
})

test('memory 纯函数：重要性/相关性/新近性', () => {
  assert.ok(importanceOf({ text: '请记住这个重要的事', addressed: true }, { valence: 0.6, arousal: 0.5 }) > 0.4)
  assert.ok(relevanceScore('猫 咖啡', '我喜欢猫和咖啡') > relevanceScore('猫 咖啡', '今天下雨'))
  assert.ok(recencyScore(0, 30 * 24 * 60 * 60 * 1000, 30) > 0.3)
})

test('policy：候选/沉默/撤回分支/奖励归因', () => {
  const persona = defaultPersona(CONFIG)
  const relationship = defaultRelationship('p1')
  const candidates = buildCandidates({ turn: { chatType: 'private', addressed: true, completeness: 0.8 }, relationship, emotion: defaultEmotion(), persona, config: CONFIG })
  assert.ok(candidates.some((item) => item.action === 'reply'))
  assert.ok(candidates.some((item) => item.action === 'silence'))
  const recall = buildCandidates({ turn: { chatType: 'private', addressed: true }, relationship, emotion: defaultEmotion(), persona, config: CONFIG, recall: { sawContent: false } })
  assert.ok(recall.some((item) => item.action === 'recall_concern'))
  assert.equal(recall.some((item) => item.action === 'recall_tease'), false, '没看见内容不能调侃看过')
  const choice = chooseAction(candidates, { config: CONFIG, rng: createRng(1), addressed: true })
  assert.ok(['reply', 'reply_short', 'clarify', 'comfort', 'tease', 'silence', 'wait'].includes(choice.action))
  assert.equal(inferReward({ explicitCorrection: true }) < 0, true)
  assert.equal(inferReward({ positiveReaction: true }) > 0, true)
  assert.ok(typeof contextBucket({ turn: { chatType: 'private', addressed: true } }) === 'string')
})
