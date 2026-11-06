import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createCommandService, parseCommand } from '../src/cognition/commands.js'
import { normalizeAccess } from '../src/core/access.js'

function harness(overrides = {}) {
  let config = {
    botQQ: '999999',
    access: normalizeAccess({ mode: 'allowlist', ownerQQ: '10001', groups: ['20001'] }),
    cognition: {
      turn: { groupReplyMode: 'addressed' },
      proactivity: { enabled: false },
      modelRouting: { privateDefault: '', groupDefault: '', routes: [] },
    },
    ...overrides,
  }
  const sent = []
  const outbound = {
    async deliver(payload) {
      sent.push(payload)
      return { ok: true, messageId: 'm1' }
    },
  }
  const memory = {
    remembered: [],
    forgotten: [],
    remember(text, opts) { this.remembered.push([text, opts]); return { id: 'mem-1' } },
    forgetMatching(query, opts) { this.forgotten.push([query, opts]); return [{ id: 'mem-1' }] },
  }
  const llm = {
    async currentRoute(chat) {
      const routes = config.cognition.modelRouting.routes
      const entry = routes.find((item) => item.startsWith(`${chat.chatId}=`))
      if (entry) return { provider: entry.split('=')[1].split('/')[0], model: entry.split('=')[1].split('/')[1], source: 'chat' }
      return { provider: 'p', model: 'm', source: 'dsh' }
    },
  }
  const runtime = { summary: () => ({ active: true, sessions: 2 }) }
  const access = {
    isOwner: (cfg, id) => String(id) === '10001',
    summary: () => ({ mode: 'allowlist' }),
  }
  const setConfig = (next) => {
    config = next
    return { config: next, issues: [] }
  }
  const service = createCommandService({
    getConfig: () => config,
    setConfig,
    access,
    outbound,
    llm,
    memory,
    runtime,
    logger: null,
  })
  return { service, sent, memory, getConfig: () => config, setConfig }
}

function turn(text, { chatType = 'private', chatId = '10001', senderId = '10001' } = {}) {
  return { chatType, chatId, senderId, text }
}

test('parseCommand：识别 /name 与参数，非命令返回 null', () => {
  assert.deepEqual(parseCommand('/status'), { name: 'status', args: '', raw: '/status' })
  assert.deepEqual(parseCommand('  /model  p/m  '), { name: 'model', args: 'p/m', raw: '/model  p/m' })
  assert.equal(parseCommand('你好'), null)
  assert.equal(parseCommand('/'), null)
})

test('commands：非主人静默忽略，不发送', async () => {
  const { service, sent } = harness()
  const result = await service.handle(turn('/status', { senderId: '10002' }))
  assert.deepEqual(result, { handled: true, reply: '' })
  assert.equal(sent.length, 0)
})

test('commands：/help 与 /status 回复', async () => {
  const { service, sent } = harness()
  const help = await service.handle(turn('/help'))
  assert.equal(help.handled, true)
  assert.match(help.reply, /\/status/)
  assert.equal(sent.length, 1)

  const status = await service.handle(turn('/status'))
  assert.match(status.reply, /运行时：agent/)
  assert.match(status.reply, /会话：2/)
  assert.match(status.reply, /当前模型：p\/m/)
  assert.equal(sent.length, 2)
})

test('commands：/quiet 与 /active 持久化群聊模式与主动开关', async () => {
  const { service, getConfig } = harness()
  const quiet = await service.handle(turn('/quiet'))
  assert.match(quiet.reply, /安静模式/)
  assert.equal(getConfig().cognition.turn.groupReplyMode, 'addressed')
  assert.equal(getConfig().cognition.proactivity.enabled, false)

  const active = await service.handle(turn('/active'))
  assert.match(active.reply, /活跃模式/)
  assert.equal(getConfig().cognition.turn.groupReplyMode, 'probability')
  assert.equal(getConfig().cognition.proactivity.enabled, true)
})

test('commands：/model 查看、设置、清除当前会话覆盖', async () => {
  const { service, getConfig, sent } = harness()
  const shown = await service.handle(turn('/model'))
  assert.match(shown.reply, /当前会话模型：p\/m/)

  const set = await service.handle(turn('/model opencode-go/deepseek-v4.1-flash'))
  assert.match(set.reply, /已设为 opencode-go\/deepseek-v4.1-flash/)
  assert.deepEqual(getConfig().cognition.modelRouting.routes, ['10001=opencode-go/deepseek-v4.1-flash'])

  const shownAgain = await service.handle(turn('/model'))
  assert.match(shownAgain.reply, /opencode-go\/deepseek-v4.1-flash/)

  const bad = await service.handle(turn('/model nope'))
  assert.match(bad.reply, /格式应为 provider\/model/)

  const cleared = await service.handle(turn('/model clear'))
  assert.match(cleared.reply, /已清除/)
  assert.deepEqual(getConfig().cognition.modelRouting.routes, [])
  assert.equal(sent.length, 5)
})

test('commands：/remember 与 /forget 走记忆服务并带作用域', async () => {
  const { service, memory, sent } = harness()
  const remembered = await service.handle(turn('/remember 主人喜欢面食'))
  assert.match(remembered.reply, /已记住/)
  assert.deepEqual(memory.remembered[0][0], '主人喜欢面食')
  assert.deepEqual(memory.remembered[0][1].scope, { scopeType: 'private', scopeId: '10001' })

  const forgotten = await service.handle(turn('/forget 面食'))
  assert.match(forgotten.reply, /已遗忘 1 条/)
  assert.deepEqual(memory.forgotten[0][1].scope, { scopeType: 'private', scopeId: '10001' })
  assert.equal(sent.length, 2)
})

test('commands：群聊命令回复受 access/outbound 拒绝时返回空回复', async () => {
  let config = { cognition: { turn: { groupReplyMode: 'addressed' }, proactivity: { enabled: false }, modelRouting: { routes: [] } } }
  const sent = []
  const service = createCommandService({
    getConfig: () => config,
    setConfig: (next) => { config = next; return { config: next } },
    access: { isOwner: () => true, summary: () => ({ mode: 'allowlist' }) },
    outbound: { async deliver(payload) { sent.push(payload); return { ok: false, blocked: true, error: 'ACCESS_DENIED' } } },
    llm: { currentRoute: async () => null },
    memory: null,
    runtime: { summary: () => ({ active: false, sessions: 0 }) },
  })
  const result = await service.handle(turn('/status', { chatType: 'group', chatId: '20002', senderId: '10001' }))
  assert.equal(result.handled, true)
  assert.equal(result.reply, '')
  assert.equal(sent.length, 1)
})

test('commands：未知命令给提示，非命令交给认知管线', async () => {
  const { service, sent } = harness()
  const unknown = await service.handle(turn('/nope'))
  assert.match(unknown.reply, /未知命令/)
  assert.equal(sent.length, 1)
  const normal = await service.handle(turn('你好'))
  assert.deepEqual(normal, { handled: false })
})
