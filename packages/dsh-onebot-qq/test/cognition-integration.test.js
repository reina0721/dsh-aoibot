// 认知端到端集成测试：轮次聚合→人物/情绪/关系/记忆→策略→发送；撤回与隐私。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeConfig } from '../src/core/config.js'
import { createCognition } from '../src/cognition/index.js'
import { createFakeScheduler, createClock, createRng } from '../src/cognition/util.js'

function fakeLlm() {
  return {
    async *stream(options) {
      const system = options.messages?.find((message) => message.role === 'system')?.content?.[0]?.text || ''
      const text = system.includes('认知分析器')
        ? JSON.stringify({ intent: 'chat', confidence: 0.8, novelty: 0.2, risk: 0, serious: false, appraisal: { desirability: 0.3, relevance: 0.7, intensity: 0.5, novelty: 0.2, control: 0.5, agency: 'other', norm: 0 }, unknownCandidates: [], replyGoal: '自然回应', rationale: 'test' })
        : '测试回复：我在听。'
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    async listProviders() { return [{ id: 'fake' }] },
    async listModels() { return [{ id: 'fake' }] },
  }
}

function makeCog({ dir, gateway, scheduler, configOverride = {} }) {
  const cfg = normalizeConfig({
    cognition: {
      enabled: true,
      dryRun: false,
      turn: { privateBaseMs: 300, privateMaxMs: 1200, groupMaxMs: 1200, fastPathMs: 80, shortMsgMs: 0, incompleteFactorMs: 200, habitAdjMaxMs: 0 },
      llm: { mode: 'auto', dailyTokenBudget: 100000 },
      ...configOverride,
    },
  }).config
  const ctx = {
    get(key) {
      if (key === 'llm') return fakeLlm()
      if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake' }) }
      return undefined
    },
    emit() {},
  }
  return createCognition({ ctx, getConfig: () => cfg, gateway, scheduler, clock: createClock(), rng: createRng(1), dataRoot: dir })
}

function privateEvent(id, text, userId = '10001') {
  return {
    seq: id, kind: 'message', selfId: '999', time: Math.floor(Date.now() / 1000),
    message: { id, chatType: 'private', chatId: userId, sender: { userId, nickname: '小明' }, text, segments: [{ type: 'text', data: { text } }], mentions: [], images: [], replyId: '' },
  }
}

async function flush(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

test('集成：连发碎片聚合只形成一次决策/发送，并持久化人物/关系/记忆', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cog-it-'))
  const scheduler = createFakeScheduler()
  const sent = []
  const gateway = { actions: { sendMessage: async (payload) => { sent.push(payload); return { message_id: 4242 } } } }
  const cog = makeCog({ dir, gateway, scheduler })
  try {
    cog.observe(privateEvent(1, '我想问'), { accepted: true })
    cog.observe(privateEvent(2, '你一个问题。'), { accepted: true })
    scheduler.advance(1500)
    await flush(40)
    assert.equal(sent.length, 1, 'burst 只发送一次')
    assert.ok(sent[0].message.some((segment) => segment.type === 'text' && segment.data.text.length > 0))
    assert.equal(cog.services.person.listPersons({}).length, 1)
    assert.ok(cog.services.relationships.list().length >= 1, '关系至少包含全局/私聊作用域')
    assert.ok(cog.services.relationships.list().some((item) => item.scopeType === 'private'))
    assert.ok(cog.services.memory.stats().total >= 1)
    assert.equal(cog.services.policy.history({ limit: 5 })[0].status, 'sent')
    const before = sent.length
    scheduler.advance(30000)
    await flush()
    assert.equal(sent.length, before, '不会为同一 turn 重复发送')
  } finally {
    cog.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('集成：群聊默认只回应点名；机器人自己的消息不触发回复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cog-group-'))
  const scheduler = createFakeScheduler()
  const sent = []
  const gateway = { actions: { sendMessage: async (payload) => { sent.push(payload); return { message_id: 77 } } } }
  const cog = makeCog({ dir, gateway, scheduler })
  try {
    cog.observe({
      seq: 1, kind: 'message', selfId: '999', time: 1,
      message: { id: 1, chatType: 'group', chatId: 'g1', sender: { userId: '10001', nickname: 'A' }, text: '大家好。', segments: [{ type: 'text', data: { text: '大家好。' } }], mentions: [], images: [], replyId: '' },
    }, { accepted: true })
    scheduler.advance(4000)
    await flush(40)
    assert.equal(sent.length, 0, '群聊未点名默认不回复')
    assert.equal(cog.services.policy.history({ limit: 5 }).length, 0, '不产生回复决策')

    // 机器人自己的消息（sender == selfId）必须跳过，避免回复循环。
    cog.observe({
      seq: 2, kind: 'message', selfId: '999', time: 2,
      message: { id: 2, chatType: 'private', chatId: '10001', sender: { userId: '999', nickname: '机器人' }, text: '我自己发的。', segments: [{ type: 'text', data: { text: '我自己发的。' } }], mentions: [], images: [], replyId: '' },
    }, { accepted: true })
    scheduler.advance(4000)
    await flush(40)
    assert.equal(sent.length, 0, '自己的消息不应触发认知回复')
  } finally {
    cog.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('集成：私聊记忆不会在群聊检索中出现；遗忘≠删除', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cog-privacy-'))
  const scheduler = createFakeScheduler()
  const cog = makeCog({ dir, gateway: { actions: { sendMessage: async () => ({ message_id: 1 }) } }, scheduler })
  try {
    const person = cog.services.person.ensurePerson({ platformUserId: '10001', nickname: '小明' })
    const mem = cog.services.memory.encodeTurn({ id: 't1', chatType: 'private', chatId: '10001', text: '我的秘密是喜欢猫', messages: [], messageIds: [] }, { personId: person.person.id, scope: { scopeType: 'private', scopeId: '10001' } })
    assert.ok(mem)
    const group = cog.services.memory.retrieve({ query: '秘密 猫', scope: { scopeType: 'group', scopeId: 'g1' } })
    assert.equal(group.length, 0, '群聊不能检索私聊记忆')
    const own = cog.services.memory.retrieve({ query: '秘密 猫', scope: { scopeType: 'private', scopeId: '10001' } })
    assert.ok(own.length >= 1)
    cog.services.memory.forget(mem.id)
    assert.equal(cog.services.memory.get(mem.id).memory.status, 'inactive')
    assert.ok(cog.services.memory.list({ query: '猫' }).length === 0)
    cog.services.memory.activate(mem.id)
    assert.equal(cog.services.memory.get(mem.id).memory.status, 'active')
  } finally {
    cog.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('集成：撤回在无原文时不假装看见；有原文时 sawContent=true', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cog-recall-'))
  const scheduler = createFakeScheduler()
  const sent = []
  const gateway = { actions: { sendMessage: async (payload) => { sent.push(payload); return { message_id: 9 } } } }
  const cog = makeCog({ dir, gateway, scheduler })
  try {
    // 无原始消息：sawContent 必须 false
    cog.observe({ seq: 1, kind: 'notice', selfId: '999', time: 1, notice: { type: 'group_recall', userId: '10001', groupId: 'g1', messageId: 'm1' } }, { accepted: true })
    await flush(50)
    const decision = cog.services.policy.history({ limit: 1 })[0]
    assert.ok(decision, '应形成撤回决策')
    assert.equal(decision.features.recall.sawContent, false)
    assert.ok(['recall_concern', 'recall_probe', 'recall_silence', 'recall_ignore'].includes(decision.action))
    assert.notEqual(decision.action, 'recall_tease', '没看见内容不能调侃')

    // 有原始消息：sawContent=true
    cog.ingestRaw({ post_type: 'message', message_type: 'group', self_id: 999, group_id: 'g1', user_id: 10002, message_id: 88, message: '我刚刚说了什么', sender: { user_id: 10002, nickname: 'A' }, time: 1 })
    cog.observe({ seq: 2, kind: 'notice', selfId: '999', time: 2, notice: { type: 'group_recall', userId: '10002', groupId: 'g1', messageId: '88' } }, { accepted: true })
    await flush(50)
    const latest = cog.services.policy.history({ limit: 3 }).find((item) => item.features?.recall?.sawContent === true)
    assert.ok(latest, '有原文时应记录 sawContent=true')
  } finally {
    cog.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
