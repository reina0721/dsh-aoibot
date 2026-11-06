// 认知端到端集成测试：轮次聚合→人物/情绪/关系/记忆→策略→发送；撤回与隐私。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeConfig } from '../src/core/config.js'
import { createCognition } from '../src/cognition/index.js'
import { createFakeScheduler, createClock, createRng } from '../src/cognition/util.js'

function fakeLlm(capture = null, composeText = '测试回复：我在听。') {
  return {
    async *stream(options) {
      const system = options.system || options.messages?.find((message) => message.role === 'system')?.content?.[0]?.text || ''
      if (Array.isArray(capture)) capture.push(system)
      const text = system.includes('认知分析器')
        ? JSON.stringify({ intent: 'chat', confidence: 0.8, novelty: 0.2, risk: 0, serious: false, appraisal: { desirability: 0.3, relevance: 0.7, intensity: 0.5, novelty: 0.2, control: 0.5, agency: 'other', norm: 0 }, unknownCandidates: [], replyGoal: '自然回应', rationale: 'test' })
        : composeText
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    async listProviders() { return [{ id: 'fake' }] },
    async listModels() { return [{ id: 'fake' }] },
  }
}

function makeCog({ dir, gateway, scheduler, configOverride = {}, llm = fakeLlm() }) {
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
      if (key === 'llm') return llm
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

function groupEvent(id, text, { chatId = 'g1', mentions = [], senderId = '10001' } = {}) {
  return {
    seq: id, kind: 'message', selfId: '999', time: Math.floor(Date.now() / 1000),
    message: { id, chatType: 'group', chatId, sender: { userId: senderId, nickname: 'A' }, text, segments: [{ type: 'text', data: { text } }], mentions, images: [], replyId: '' },
  }
}

function groupTurnConfig(extra = {}) {
  return {
    privateBaseMs: 300,
    privateMaxMs: 1200,
    groupMaxMs: 1200,
    fastPathMs: 80,
    shortMsgMs: 0,
    incompleteFactorMs: 200,
    habitAdjMaxMs: 0,
    groupReplyMode: 'addressed',
    groupCooldownMs: 0,
    groupMaxRepliesPerMinute: 60,
    ...extra,
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

test('集成：群聊 all 模式未点名会分析并产生决策；诊断保留 lastTurn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cog-group-all-'))
  const scheduler = createFakeScheduler()
  const sent = []
  const gateway = { actions: { sendMessage: async (payload) => { sent.push(payload); return { message_id: 78 } } } }
  const cog = makeCog({ dir, gateway, scheduler, configOverride: { turn: groupTurnConfig({ groupReplyMode: 'all' }) } })
  try {
    cog.observe(groupEvent(1, '大家好。'), { accepted: true })
    scheduler.advance(4000)
    await flush(60)
    const overview = await cog.overview()
    assert.equal(overview.pipeline.groupMode, 'all')
    assert.equal(overview.pipeline.lastTurn.chatType, 'group')
    assert.equal(overview.pipeline.lastTurn.addressed, false)
    assert.ok(overview.pipeline.decisions >= 1, '未点名也应进入决策')
    assert.equal(overview.pipeline.groupSkipped, 0)
    assert.ok(sent.length >= 1, '策略选择回复时应发送')
  } finally {
    cog.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('集成：群聊 probability=0 跳过并记录原因；人设名可充当唤醒词', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cog-group-prob-'))
  const scheduler = createFakeScheduler()
  const sent = []
  const gateway = { actions: { sendMessage: async (payload) => { sent.push(payload); return { message_id: 79 } } } }
  const cog = makeCog({
    dir, gateway, scheduler,
    configOverride: { turn: groupTurnConfig({ groupReplyMode: 'probability', groupReplyProbability: 0 }) },
  })
  try {
    cog.observe(groupEvent(1, '没人叫我。'), { accepted: true })
    scheduler.advance(4000)
    await flush(50)
    const skipped = await cog.overview()
    assert.equal(skipped.pipeline.groupSkipped, 1)
    assert.equal(skipped.pipeline.groupSkippedByReason.probability_miss, 1)
    assert.equal(skipped.pipeline.lastTurn.reason, 'probability_miss')
    assert.equal(sent.length, 0)

    cog.services.persona.edit({ profile: { displayName: '小Q' } })
    cog.observe(groupEvent(2, '小Q你在吗？'), { accepted: true })
    scheduler.advance(4000)
    await flush(60)
    const after = await cog.overview()
    assert.ok(after.pipeline.decisions >= 1, '名字唤醒后应进入决策')
    assert.ok(sent.length >= 1, '名字唤醒后策略回复应发送')
  } finally {
    cog.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('集成：群聊冷却跳过后不产生第二个决策，仍写入记忆', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cog-group-cool-'))
  const scheduler = createFakeScheduler()
  const sent = []
  const gateway = { actions: { sendMessage: async (payload) => { sent.push(payload); return { message_id: 80 } } } }
  const cog = makeCog({
    dir, gateway, scheduler,
    configOverride: { turn: groupTurnConfig({ groupReplyMode: 'all', groupCooldownMs: 60000 }) },
  })
  try {
    cog.observe(groupEvent(1, '第一句。'), { accepted: true })
    scheduler.advance(4000)
    await flush(60)
    const firstSent = sent.length
    cog.observe(groupEvent(2, '第二句。'), { accepted: true })
    scheduler.advance(4000)
    await flush(40)
    const overview = await cog.overview()
    assert.ok(firstSent >= 1)
    assert.equal(sent.length, firstSent, '冷却期内不发送')
    assert.ok(overview.pipeline.groupSkipped >= 1)
    assert.equal(overview.pipeline.lastTurn.reason, 'cooldown')
    assert.ok(cog.services.memory.stats().total >= 2, '跳过时仍写入情景记忆')
  } finally {
    cog.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
test('集成：切换 active 人格后，下一轮 compose prompt 使用新 profile', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cog-persona-switch-'))
  const scheduler = createFakeScheduler()
  const capture = []
  const sent = []
  const gateway = { actions: { sendMessage: async (payload) => { sent.push(payload); return { message_id: 81 } } } }
  const cog = makeCog({ dir, gateway, scheduler, llm: fakeLlm(capture) })
  try {
    cog.services.persona.ensure()
    const created = cog.services.persona.create({ name: '切换后人格' })
    cog.services.persona.edit({ profile: { personality: '切换后的性格', speakingStyle: '切换后的风格' } })
    assert.equal(cog.services.persona.get().id, created.persona.id)
    cog.observe(privateEvent(1, '你好'), { accepted: true })
    scheduler.advance(1500)
    await flush(50)
    assert.ok(sent.length >= 1)
    assert.ok(capture.some((system) => system.includes('名字/自称：切换后人格')), 'compose system 应包含当前人格')
    assert.ok(capture.some((system) => system.includes('切换后的性格')))
    assert.ok(capture.some((system) => system.includes('切换后的风格')))
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


test('M2-a：长回复按配置分条，首条引用原消息，内容不丢', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cog-split-'))
  const scheduler = createFakeScheduler()
  const sent = []
  const gateway = { actions: { sendMessage: async (payload) => { sent.push(payload); return { message_id: 500 + sent.length } } } }
  const longReply = '这是一段比较长的回复。'.repeat(30)
  const cog = makeCog({ dir, gateway, scheduler, llm: fakeLlm(null, longReply), configOverride: { reply: { split: true, maxChars: 100, maxParts: 3, delayMs: 0, quote: true } } })
  try {
    cog.observe(privateEvent(1, '请详细说说'), { accepted: true })
    scheduler.advance(1500)
    await flush(60)
    assert.ok(sent.length >= 2 && sent.length <= 3, `应分 2-3 条，实际 ${sent.length}`)
    assert.equal(sent[0].message[0].type, 'reply')
    const text = sent.map((item) => item.message.filter((segment) => segment.type === 'text').map((segment) => segment.data.text).join('')).join('')
    assert.equal(text.replace(/\s+/g, ''), longReply.replace(/\s+/g, ''))
  } finally {
    cog.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('M2-a：群聊回复可引用 + @ 发送者', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cog-at-'))
  const scheduler = createFakeScheduler()
  const sent = []
  const gateway = { actions: { sendMessage: async (payload) => { sent.push(payload); return { message_id: 601 } } } }
  const cog = makeCog({
    dir, gateway, scheduler,
    configOverride: { turn: groupTurnConfig(), reply: { split: false, quote: true, atSender: true } },
  })
  try {
    cog.observe(groupEvent(1, '你好', { chatId: 'g1', senderId: '10001', mentions: [{ userId: '999', name: '机器人' }] }), { accepted: true })
    scheduler.advance(4000)
    await flush(60)
    assert.equal(sent.length, 1)
    const types = sent[0].message.map((segment) => segment.type)
    assert.deepEqual(types, ['reply', 'at', 'text'])
    assert.equal(sent[0].message[1].data.qq, '10001')
  } finally {
    cog.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('M2-a：连续未点名接话达到上限后暂停主动接话，点名仍回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cog-flood-'))
  const scheduler = createFakeScheduler()
  const sent = []
  const gateway = { actions: { sendMessage: async (payload) => { sent.push(payload); return { message_id: 700 + sent.length } } } }
  const cog = makeCog({
    dir, gateway, scheduler,
    configOverride: {
      turn: groupTurnConfig({ groupReplyMode: 'all', groupCooldownMs: 0, groupMaxRepliesPerMinute: 60, maxConsecutiveGroupReplies: 2 }),
      reply: { split: false },
    },
  })
  try {
    for (let index = 1; index <= 4; index += 1) {
      cog.observe(groupEvent(index, `群友 ${index} 在聊天`), { accepted: true })
      scheduler.advance(4000)
      await flush(40)
    }
    assert.equal(sent.length, 2, '未点名接话达到上限后不再接')
    const stats = cog.snapshot().pipeline
    assert.ok(stats.groupSkippedByReason.consecutive_limit >= 1)

    cog.observe(groupEvent(5, '机器人你出来', { mentions: [{ userId: '999', name: '机器人' }] }), { accepted: true })
    scheduler.advance(4000)
    await flush(40)
    assert.equal(sent.length, 3, '点名仍要回复')
  } finally {
    cog.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('M2-b：合并转发展开进入轮次文本与记忆', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cog-forward-'))
  const scheduler = createFakeScheduler()
  const sent = []
  let forwardCalls = 0
  const gateway = {
    actions: {
      sendMessage: async (payload) => { sent.push(payload); return { message_id: 811 } },
      getForwardMsg: async (id) => {
        forwardCalls += 1
        assert.equal(id, 'f1')
        return { messages: [{ sender: { nickname: '转发者' }, content: [{ type: 'text', data: { text: '转发正文：今天下午三点开会' } }] }] }
      },
    },
  }
  const cog = makeCog({ dir, gateway, scheduler })
  try {
    cog.observe({
      seq: 1, kind: 'message', selfId: '999', time: Math.floor(Date.now() / 1000),
      message: {
        id: 1, chatType: 'private', chatId: '10001', sender: { userId: '10001', nickname: '小明' },
        text: '看看这个', segments: [{ type: 'text', data: { text: '看看这个' } }, { type: 'forward', data: { id: 'f1' } }],
        mentions: [], images: [], forwards: [{ id: 'f1' }], replyId: '',
      },
    }, { accepted: true })
    scheduler.advance(4000)
    await flush(80)
    assert.equal(forwardCalls, 1, '应展开一次合并转发')
    assert.equal(sent.length, 1)
    const rows = cog.services.memory.list({ limit: 20 })
    assert.ok(rows.some((item) => String(item.content || item.memory?.content || '').includes('转发正文')), '展开文本应进入记忆/轮次')
  } finally {
    cog.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('M2-b：拍一拍回应、冷却与只回应拍机器人', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cog-poke-'))
  const scheduler = createFakeScheduler()
  const sent = []
  const gateway = { actions: { sendMessage: async (payload) => { sent.push(payload); return { message_id: 901 } } } }
  const cog = makeCog({ dir, gateway, scheduler })
  try {
    const base = { seq: 2, kind: 'notice', time: Math.floor(Date.now() / 1000) }
    cog.observe({ ...base, notice: { type: 'notify', subType: 'poke', userId: '10001', targetId: '999', groupId: 'g1' } }, { accepted: true })
    await flush(40)
    assert.equal(sent.length, 1)
    assert.ok(sent[0].message.some((segment) => segment.type === 'text' && segment.data.text.length > 0))
    assert.equal(cog.snapshot().pipeline.pokes, 1)
    assert.equal(cog.snapshot().pipeline.pokeReplies, 1)

    cog.observe({ ...base, notice: { type: 'notify', subType: 'poke', userId: '10001', targetId: '999', groupId: 'g1' } }, { accepted: true })
    await flush(40)
    assert.equal(sent.length, 1, '冷却内不重复回应')

    cog.observe({ ...base, notice: { type: 'notify', subType: 'poke', userId: '10001', targetId: '888', groupId: 'g1' } }, { accepted: true })
    await flush(40)
    assert.equal(sent.length, 1, '不是拍机器人不回应')
    assert.equal(cog.snapshot().pipeline.pokes, 3)
  } finally {
    cog.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('M2-b：表情回应把机器人消息标记为正向 outcome', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cog-reaction-'))
  const scheduler = createFakeScheduler()
  const sent = []
  const gateway = { actions: { sendMessage: async (payload) => { sent.push(payload); return { message_id: 777 } } } }
  const cog = makeCog({ dir, gateway, scheduler })
  try {
    cog.observe(privateEvent(1, '你好'), { accepted: true })
    scheduler.advance(1500)
    await flush(60)
    assert.equal(sent.length, 1)
    cog.observe({
      seq: 2, kind: 'notice', time: Math.floor(Date.now() / 1000),
      notice: { type: 'group_msg_emoji_like', subType: 'emoji_like', userId: '10001', groupId: 'g1', messageId: '777' },
    }, { accepted: true })
    await flush(20)
    assert.equal(cog.snapshot().pipeline.reactions, 1)
    const latest = cog.services.policy.history({ limit: 1 })[0]
    assert.equal(latest.status, 'observed')
    assert.ok(latest.reward > 0)
  } finally {
    cog.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
