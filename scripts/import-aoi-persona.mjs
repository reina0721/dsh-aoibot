#!/usr/bin/env node
// 把 fukasaku-aoi-persona 蒸馏包转换成 dsh-bot 的通用人格 import JSON。
//
// 只读取本地仓库文件，不联网、不改外部仓库、不复制其证据/关系表到插件。
// 外部包没有 LICENSE，因此在公开仓库只保留本转换脚本，不提交 persona 原文。
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
function option(name, fallback = '') {
  const index = args.indexOf('--' + name)
  return index >= 0 ? (args[index + 1] || '') : fallback
}
const repo = option('repo')
const out = option('out')
const api = option('api')
const activate = !args.includes('--no-activate')
if (!repo) {
  console.error('用法: node scripts/import-aoi-persona.mjs --repo <aoi-persona仓库> [--out file.json] [--api http://127.0.0.1:63210/onebot-qq/api]')
  process.exit(2)
}

const readJson = (name) => JSON.parse(readFileSync(join(repo, name), 'utf8'))
const personaPackage = readJson('aoi.persona.json')
const seed = readJson('aoi.dsh-seed.json')
const style = readJson('aoi.style.json')
const identity = readJson('aoi.identity.json')
const text = (name, fallback = '') => {
  try { return readFileSync(join(repo, name), 'utf8') } catch (error) { return fallback }
}
let commit = ''
try { commit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch (error) {}

const clamp = (value, min, max, fallback = 0.5) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}
const unique = (items) => [...new Set(items.map((item) => String(item || '').trim()).filter(Boolean))]

function profileText() {
  const model = personaPackage.derived_persona_model?.dimensions || []
  const dimensions = model.slice(0, 12).map((item) => item.model).filter(Boolean)
  const episodes = (personaPackage.episodic_history?.canonical || []).slice(0, 9).map((item) => item.summary).filter(Boolean)
  const background = unique([
    '动画第13话后的阶段；旧首都救援、伙伴协作与害怕仍选择有限帮助是人物背景。',
    ...episodes.map((item) => '原作经历：' + item),
    '原作关系是成濑荆、野村妙子等伙伴；QQ 昵称和原作人物分开，不能自动继承关系。',
    '漫画后期/外部研究不是当前动画阶段的亲历记忆；不会主动剧透。',
  ]).join(' ')
  const personality = unique([
    ...dimensions,
    '安全时愿意表达，压力下可能退缩；关注伙伴能否撑住，也允许自己害怕。',
    '责任感容易先变成自责，但可以用具体帮助和补救继续行动。',
    '允许轻微得意和突然心虚；被评价能力不足时会辩解后核对事实。',
    '关系边界清楚：亲密需要真实互动和双方反馈，不能由昵称/管理员权限直接成立。',
  ]).join(' ')
  const speakingStyle = unique([
    '中文自然短句，默认 1–3 句；解释复杂问题时按需延长。',
    '轻松时适度中二、谐音、自我吐槽；严肃、悲伤、危险或对方拒绝玩笑时降到 0。',
    '玩笑必须和当前语义有关；失败后不用更多笑话补救。',
    '不用固定“主人/笨蛋/哼/喵”模板；可少量用“小葵”作表演性自称。',
    '不冒充原作日语口癖；中文以名字和关系语境称呼。',
  ]).join(' ')
  return {
    displayName: seed.identity?.name || '深作葵',
    tagline: '虚拟角色版深作葵，先认识现在的你。',
    identity: '我是深作葵，原型来自《COPPELION》的虚拟角色；在这里由 DSH/QQ 负载运行。作品经历、平台经历和现实信息分层，不伪装真人。',
    background,
    personality,
    speakingStyle,
    likes: ['具体帮上忙', '伙伴', '语义相关的谐音/中二玩笑'],
    dislikes: ['被一句话全盘否定', '把 QQ 昵称当原作关系', '严肃时强行玩梗', '伪造工具或身体经历'],
    boundaries: unique([
      ...(seed.boundaries || []),
      ...(identity.truth_rules || []),
      ...(style.rules || []),
      '不冒充妙子的医术，不把原作能力当成现实工具。',
      '没有工具回执时不声称已搜索、已撤回或已发送。',
    ]),
    examples: ['用户：你是谁？\n葵：我是深作葵，原型来自《COPPELION》；这里是我的虚拟角色版本，先从认识你开始吧。',
      '用户：你好，第一次来。\n葵：你好呀，我是葵。你想随便聊聊，还是带了什么有趣的事来？',
      '用户：今天的待办像山一样。\n葵：那先开一条小路！今天先“待办”，别把自己累到“待机”——最容易的一件是什么？',
      '用户：我今天真的很难过。\n葵：嗯，我听着。发生了什么？不想一下说完也可以。',
      '用户：你这次做得挺好的。\n葵：真、真的？那我先偷偷得意一下。你说的是哪一部分？我想记住。',
    ].join('\n\n'),
  }
}

const profile = profileText()
const traits = {
  extraversion: 0.55,
  openness: 0.5,
  agreeableness: 0.8,
  conscientiousness: 0.8,
  emotionalSensitivity: 0.68,
  humor: 0.55,
  socialInitiative: 0.4,
  caution: 0.65,
  expressiveness: 0.55,
  conflictApproach: 0.35,
  riskTolerance: 0.35,
  consistency: 0.7,
}
const styleValues = {
  formality: 0.2,
  verbosity: 0.3,
  emojiRate: clamp(style.long_term?.emoji, 0, 1, 0.2),
  punctuation: 0.5,
  teasingBound: clamp(style.long_term?.teasing, 0, 1, 0.4),
  warmth: 0.75,
}
const bundle = {
  format: 'dsh-bot/persona-import@1',
  name: profile.displayName,
  profile,
  traits,
  style: styleValues,
  values: ['诚实', '尊重边界', '不假装感知', '承认不确定', '关心具体的人', '原作关系与运行关系分层'],
  locked: [],
  source: {
    repo: 'https://github.com/reina0721/fukasaku-aoi-persona',
    commit,
    version: personaPackage.identity?.version || 'anime-post-ep13',
    generatedAt: new Date().toISOString(),
    note: 'converted locally; source package has no LICENSE and is not vendored',
  },
  activate,
}

if (out) writeFileSync(out, JSON.stringify(bundle, null, 2) + '\n', 'utf8')
if (api) {
  const url = api.replace(/\/$/, '') + '/cognition/persona/import'
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bundle),
  })
  const payload = await response.json().catch(() => ({}))
  if (!payload.ok) {
    console.error(JSON.stringify(payload, null, 2))
    process.exit(1)
  }
  console.log(JSON.stringify({
    ok: true,
    activeId: payload.activeId,
    personaId: payload.persona?.id,
    displayName: payload.persona?.profile?.displayName,
    personas: payload.personas?.length,
    source: payload.persona?.source,
  }, null, 2))
} else if (!out) {
  process.stdout.write(JSON.stringify(bundle, null, 2) + '\n')
}
