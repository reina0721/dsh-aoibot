// 文本人设 profile：默认合并、清洗/长度上限、编辑历史、prompt 注入。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PROFILE_PROMPT_MAX_CHARS,
  applyPersonaEdit,
  defaultPersona,
  personaProfileText,
  personaSummary,
  sanitizePersona,
  sanitizeProfile,
} from '../src/cognition/persona.js'
import { composeReply } from '../src/cognition/analysis.js'

const CONFIG = {
  persona: {
    traits: {},
    style: {},
    values: [],
    profile: { displayName: '默认名字' },
    evolutionEnabled: true,
    evolutionPerDay: 0.005,
  },
}

test('profile：旧 persona 补默认，非法文本/数组被清洗与限长', () => {
  const legacy = sanitizePersona({ traits: {}, style: {}, values: [] }, CONFIG)
  assert.equal(legacy.profile.displayName, '默认名字')
  assert.deepEqual(legacy.profile.likes, [])

  const dirty = sanitizeProfile({
    displayName: '  小 \u0000Q  ',
    tagline: 'a'.repeat(300),
    boundary: 'not-a-field',
    likes: [' 猫 ', '猫', '', '狗', 'x'.repeat(200)],
    boundaries: ['不要说谎', 123],
  }, CONFIG)
  assert.equal(dirty.displayName, '小 Q')
  assert.equal([...dirty.tagline].length, 120)
  assert.deepEqual(dirty.likes, ['猫', '狗', 'x'.repeat(80)])
  assert.deepEqual(dirty.boundaries, ['不要说谎', '123'])
  assert.equal('boundary' in dirty, false)

  const longList = sanitizeProfile({ likes: Array.from({ length: 30 }, (_, index) => `item-${index}`) }, CONFIG)
  assert.equal(longList.likes.length, 20)
})

test('profile：编辑记录 changes/version/history；重复保存不涨版本', () => {
  const base = defaultPersona(CONFIG)
  assert.equal(base.profile.displayName, '默认名字')
  const result = applyPersonaEdit(base, {
    profile: { displayName: '小Q', personality: '温柔但直接', likes: ['音乐', '音乐', '咖啡'] },
    reason: 'user_edit',
  }, { now: 123 })
  assert.equal(result.persona.profile.displayName, '小Q')
  assert.equal(result.persona.profile.personality, '温柔但直接')
  assert.deepEqual(result.persona.profile.likes, ['音乐', '咖啡'])
  assert.ok(result.changes.some((change) => change.key === 'profile.displayName'))
  assert.equal(result.persona.version, 2)
  assert.equal(result.persona.history.at(-1).reason, 'user_edit')
  assert.equal(result.persona.history.at(-1).at, 123)

  const again = applyPersonaEdit(result.persona, { profile: { displayName: '小Q' } }, { now: 124 })
  assert.equal(again.persona.version, 2)
  assert.equal(again.changes.length, 0)
  assert.equal(again.persona.history.length, result.persona.history.length)
})

test('profile：prompt 只输出非空字段，包含边界并有总长度上限', () => {
  assert.equal(personaProfileText({}), '')
  const text = personaProfileText({
    displayName: '小Q',
    identity: '群友',
    personality: '温和',
    likes: ['猫', '音乐'],
    boundaries: ['不编造事实'],
    examples: '',
  })
  assert.match(text, /名字\/自称：小Q/)
  assert.match(text, /边界\/禁忌：不编造事实/)
  assert.match(text, /喜欢：猫、音乐/)
  assert.doesNotMatch(text, /示例对话/)

  const long = personaProfileText({ personality: '很长的性格'.repeat(500) })
  assert.ok([...long].length <= PROFILE_PROMPT_MAX_CHARS)
  assert.ok(long.endsWith('…'))
})

test('personaSummary：概览可拿到显示名/介绍与 hasProfile', () => {
  const persona = defaultPersona(CONFIG)
  persona.profile.displayName = '小Q'
  persona.profile.tagline = '在听'
  const summary = personaSummary(persona)
  assert.equal(summary.profile.displayName, '小Q')
  assert.equal(summary.profile.tagline, '在听')
  assert.equal(summary.hasProfile, true)
  assert.equal(personaSummary(defaultPersona({ persona: { traits: {}, style: {}, values: [] } })).hasProfile, false)
})

test('composeReply：文本人设进入 system prompt；空人设不注入', async () => {
  let captured = null
  const llm = {
    async complete(options) {
      captured = options
      return { ok: true, text: '嗯，我在。', tokens: { total: 3 } }
    },
  }
  const base = {
    turn: { chatType: 'private', text: '你好' },
    person: { displayName: '小明' },
    persona: { profile: { displayName: '小Q', personality: '温和', boundaries: ['不编造事实'] }, style: {}, traits: {} },
    decision: { action: 'reply', reason: '回应' },
    analysis: { intent: 'greeting', replyGoal: '回应' },
    llm,
    config: { cognition: {} },
  }
  const result = await composeReply(base)
  assert.equal(result.ok, true)
  assert.match(captured.system, /名字\/自称：小Q/)
  assert.match(captured.system, /边界\/禁忌：不编造事实/)

  const empty = await composeReply({ ...base, persona: { profile: {}, style: {}, traits: {} } })
  assert.equal(empty.ok, true)
  assert.doesNotMatch(captured.system, /你的固定人设/)
})
