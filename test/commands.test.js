import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createCommandService, parseCommand } from '../src/cognition/commands.js'
import { normalizeAccess } from '../src/core/access.js'

function harness(overrides = {}, services = {}) {
  let config = {
    botQQ: '999999',
    access: normalizeAccess({ mode: 'allowlist', ownerQQ: '10001', groups: ['20001'] }),
    cognition: {
      turn: { groupReplyMode: 'addressed' },
      proactivity: { enabled: false },
      modelRouting: { privateDefault: '', groupDefault: '', routes: [] },
    },
    media: { enabled: true, images: { enabled: true }, audio: { ttsEnabled: true }, stickers: { enabled: true }, tts: { maxChars: 300 } },
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
  const purposeItems = [{ id: 'goal_abc12345', type: 'goal', title: '学会做面包', status: 'active', progress: 0.2 }]
  const purpose = {
    list(args = {}) { return purposeItems.filter((item) => !args.status || item.status === args.status) },
    create(input) { const item = { id: 'goal_new00001', type: 'goal', status: 'active', progress: 0, ...input }; purposeItems.push(item); return item },
    update(id, patch) { const item = purposeItems.find((row) => row.id === id); Object.assign(item, patch); return item },
    complete(id) { const item = purposeItems.find((row) => row.id === id); item.status = 'done'; return item },
    abandon(id) { const item = purposeItems.find((row) => row.id === id); item.status = 'abandoned'; return item },
    pause(id) { const item = purposeItems.find((row) => row.id === id); item.status = 'paused'; return item },
    resume(id) { const item = purposeItems.find((row) => row.id === id); item.status = 'active'; return item },
  }
  const qqActions = {
    async like(args) { return { ok: true, target: args.userId, times: args.times || 1 } },
    async poke() { return { ok: true } },
    async groupInfo(args) { if (args.chatType !== 'group') return { ok: false, error: 'GROUP_ONLY' }; return { ok: true, groupId: 'g1', groupName: '测试群', memberCount: 3, maxMemberCount: 200, ownerId: '10001' } },
    async memberInfo(args) { if (args.chatType !== 'group') return { ok: false, error: 'GROUP_ONLY' }; return { ok: true, userId: args.userId || '10001', nickname: '小明', card: '小明卡', role: 'owner' } },
  }
  const access = {
    isOwner: (cfg, id) => String(id) === '10001',
    summary: () => ({ mode: 'allowlist' }),
    canSend: () => ({ allowed: services.allowSend !== false }),
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
    qqActions: services.qqActions || qqActions,
    purpose,
    requests: services.requests,
    reminders: services.reminders,
    media: services.media,
    stickers: services.stickers,
    bilibili: services.bilibili,
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

test('commands：外部命令分发、帮助、重复检查与 dispose', async () => {
  const { service } = harness()
  let received = null
  const dispose = service.registerCommand('echo', ({ turn: value, parsed, args }) => {
    received = { value, parsed, args }
    return { reply: 'echo:' + args }
  })
  assert.throws(() => service.registerCommand('echo', () => ''), /已注册/)
  assert.throws(() => service.registerCommand('status', () => ''), /已注册/)
  assert.throws(() => service.registerCommand('Bad.Name', () => ''), /命令名/)
  const result = await service.handle(turn('/echo hello'))
  assert.equal(result.reply, 'echo:hello')
  assert.equal(received.args, 'hello')
  assert.equal(received.parsed.name, 'echo')
  assert.match((await service.handle(turn('/help'))).reply, /模块命令：\/echo/)
  dispose()
  assert.doesNotThrow(() => service.registerCommand('echo', () => 'again'))
})

test('commands：外部命令 ownerOnly 默认开启，可显式开放，异常变短回复', async () => {
  const { service, sent } = harness()
  service.registerCommand('privatecmd', () => 'secret')
  service.registerCommand('publiccmd', ({ args }) => args || 'public', { ownerOnly: false })
  service.registerCommand('broken', () => { throw new Error('sensitive detail') }, { ownerOnly: false })
  assert.deepEqual(await service.handle(turn('/privatecmd', { senderId: '10002' })), { handled: true, reply: '' })
  assert.equal((await service.handle(turn('/publiccmd hi', { senderId: '10002' }))).reply, 'hi')
  assert.match((await service.handle(turn('/broken', { senderId: '10002' }))).reply, /执行失败/)
  assert.doesNotMatch(sent.at(-1).segments[0].data.text, /sensitive/)
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

test('commands：/bili 支持关闭、热门、搜索、BV 与短错误', async () => {
  const disabled = harness({ content: { bilibili: { enabled: false } } }, { bilibili: { hot: async () => { throw new Error('不应调用') } } })
  assert.equal((await disabled.service.handle(turn('/bili hot'))).reply, 'B站内容未启用')

  const calls = []
  const bilibili = {
    async hot() { calls.push(['hot']); return { ok: true, items: [{ title: '热门', author: 'UP', play: 12, duration: '01:02', url: 'https://www.bilibili.com/video/BVhot' }] } },
    async search(value) { calls.push(['search', value]); return { ok: true, items: [] } },
    async video(value) { calls.push(['video', value]); return { ok: true, items: [{ title: '视频', author: 'UP', play: 1, duration: '00:03', url: 'https://www.bilibili.com/video/' + value }] } },
  }
  const enabled = harness({ content: { bilibili: { enabled: true } } }, { bilibili })
  assert.match((await enabled.service.handle(turn('/bili hot'))).reply, /热门/)
  assert.match((await enabled.service.handle(turn('/bili 猫猫'))).reply, /没有找到/)
  assert.match((await enabled.service.handle(turn('/bili BV1abcdef'))).reply, /视频/)
  assert.deepEqual(calls, [['hot'], ['search', '猫猫'], ['video', 'BV1abcdef']])
  bilibili.hot = async () => { throw new Error('upstream detail') }
  assert.match((await enabled.service.handle(turn('/bili hot'))).reply, /B站请求失败：upstream detail/)
})

test('commands：/bili comments|share 支持结果、空评论、用法、帮助与短错误', async () => {
  const calls = []
  const bilibili = {
    async comments(bvid) { calls.push(['comments', bvid]); return { ok: true, items: [{ author: '评论者', content: '公开正文', like: 7 }] } },
    share(bvid) { calls.push(['share', bvid]); return { url: 'https://www.bilibili.com/video/' + bvid, bvid } },
  }
  const { service } = harness({ content: { bilibili: { enabled: true } } }, { bilibili })
  const bvid = 'BV1xx411c7mD'
  assert.equal((await service.handle(turn('/bili comments ' + bvid))).reply, '1. 评论者 · 赞 7\n公开正文')
  assert.equal((await service.handle(turn('/bili share ' + bvid))).reply, 'https://www.bilibili.com/video/' + bvid)
  assert.deepEqual(calls, [['comments', bvid], ['share', bvid]])
  for (const kind of ['comments', 'share']) assert.match((await service.handle(turn('/bili ' + kind))).reply, /用法/)
  assert.equal(calls.length, 2)
  assert.match((await service.handle(turn('/help'))).reply, /bili comments BV号.*bili share BV号/)
  assert.match((await service.handle(turn('/bili'))).reply, /bili comments BV号.*bili share BV号/)
  bilibili.comments = async () => ({ ok: true, items: [] })
  assert.equal((await service.handle(turn('/bili comments ' + bvid))).reply, '没有可显示的 B站公开评论。')
  bilibili.comments = async () => { throw new Error('B站公开接口要求登录；不使用 Cookie/WBI') }
  assert.match((await service.handle(turn('/bili comments ' + bvid))).reply, /B站请求失败：.*不使用 Cookie\/WBI/)
  bilibili.share = () => { throw new Error('无效的 BV 号') }
  assert.match((await service.handle(turn('/bili share bad'))).reply, /B站请求失败：无效的 BV 号/)
})

test('commands：/bili comments|share 关闭与非主人不调用服务', async () => {
  let calls = 0
  const bilibili = { comments() { calls++; throw new Error('不应调用') }, share() { calls++; throw new Error('不应调用') } }
  for (const enabled of [false, true]) {
    const { service } = harness({ content: { bilibili: { enabled } } }, { bilibili })
    for (const kind of ['comments', 'share']) {
      if (!enabled) assert.equal((await service.handle(turn('/bili ' + kind + ' BV1xx411c7mD'))).reply, 'B站内容未启用')
      await service.handle(turn('/bili ' + kind + ' BV1xx411c7mD', { senderId: '99999' }))
    }
  }
  assert.equal(calls, 0)
})

test('commands：/tts 合成并向当前聊天发送语音，失败时短回复', async () => {
  const calls = []
  const media = {
    async synthesize(text) { calls.push(['synthesize', text]); return '/media/out.mp3' },
    async sendMedia(payload) { calls.push(['send', payload]) },
  }
  const { service, sent } = harness({}, { media })
  const result = await service.handle(turn('/tts 你好', { chatType: 'group', chatId: '20001' }))
  assert.deepEqual(result, { handled: true, reply: '' })
  assert.equal(sent.length, 0)
  assert.equal(calls[1][1].kind, 'record')
  assert.equal(calls[1][1].chatId, '20001')

  media.synthesize = async () => { throw new Error('provider down') }
  const failed = await service.handle(turn('/tts 失败'))
  assert.match(failed.reply, /TTS 失败：provider down/)
})

test('commands：/say 只通过 outbound 发送一次且不返回重复文本', async () => {
  const { service, sent } = harness()
  const result = await service.handle(turn('/say 只发一次'))
  assert.equal(result.reply, '')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].source, 'command')
  assert.equal(sent[0].segments[0].data.text, '只发一次')
})

test('commands：/sticker 发送图片；空库提示上传', async () => {
  const mediaCalls = []
  const media = { async sendMedia(payload) { mediaCalls.push(payload) } }
  const stickers = {
    async pick({ tag }) { return tag === '空' ? null : { id: 's1', name: 'cat.png' } },
    async fileFor() { return { path: '/media/stickers/s1.png', mime: 'image/png', size: 3 } },
  }
  const { service, sent } = harness({}, { media, stickers })
  const success = await service.handle(turn('/sticker 猫'))
  assert.equal(success.reply, '')
  assert.equal(mediaCalls[0].kind, 'image')
  const empty = await service.handle(turn('/sticker 空'))
  assert.match(empty.reply, /还没有表情包/)
  assert.equal(sent.length, 1)
})

test('commands：媒体命令发送前检查 access.canSend', async () => {
  let calls = 0
  const media = { async synthesize() { calls += 1 }, async sendMedia() { calls += 1 } }
  const stickers = { async pick() { calls += 1 } }
  const { service, sent } = harness({}, { media, stickers, allowSend: false })
  assert.equal((await service.handle(turn('/tts 不应发送'))).error, 'ACCESS_DENIED')
  assert.equal((await service.handle(turn('/sticker'))).error, 'ACCESS_DENIED')
  assert.equal((await service.handle(turn('/say 不应发送'))).error, 'ACCESS_DENIED')
  assert.equal(calls, 0)
  assert.equal(sent.length, 0)
})


test('commands：/like /poke /groupinfo /memberinfo 走 QQ 动作服务', async () => {
  const { service, sent } = harness()
  const like = await service.handle(turn('/like 3'))
  assert.match(like.reply, /已点赞 3 次/)

  const poke = await service.handle(turn('/poke', { chatType: 'group', chatId: '20001', senderId: '10001' }))
  assert.match(poke.reply, /已拍回去/)

  const info = await service.handle(turn('/groupinfo', { chatType: 'group', chatId: '20001', senderId: '10001' }))
  assert.match(info.reply, /测试群/)
  assert.match(info.reply, /3\/200 人/)

  const member = await service.handle(turn('/memberinfo 20002', { chatType: 'group', chatId: '20001', senderId: '10001' }))
  assert.match(member.reply, /成员：小明卡（20002）/)
  assert.equal(sent.length, 4)

  const privateInfo = await service.handle(turn('/groupinfo'))
  assert.match(privateInfo.reply, /只能在群里用/)
})


test('commands：/purpose 列表/新建/完成/进度', async () => {
  const { service, sent } = harness()
  const list = await service.handle(turn('/purpose'))
  assert.match(list.reply, /活跃目的/)
  assert.match(list.reply, /abc12345/)
  assert.match(list.reply, /学会做面包/)

  const add = await service.handle(turn('/purpose add 学会做蛋糕'))
  assert.match(add.reply, /已新建目的 new00001/)
  assert.match(add.reply, /学会做蛋糕/)

  const progress = await service.handle(turn('/purpose progress abc12345 50'))
  assert.match(progress.reply, /50%/)

  const done = await service.handle(turn('/purpose done abc12345'))
  assert.match(done.reply, /已完成/)
  assert.equal(sent.length, 4)
})

const adminEnabled = { cognition: { qqAdmin: { enabled: true, requireConfirm: true, maxText: 100 } } }
function adminCommands(overrides = {}, services = {}) {
  const calls = []
  const qqActions = Object.fromEntries(['setProfile', 'setGroupCard', 'setGroupName', 'setGroupAdmin', 'setGroupBan', 'setGroupWholeBan', 'setGroupKick', 'setEssence', 'deleteMsg'].map((method) => [method, async (args) => { calls.push([method, args]); return { ok: true } }]))
  return { ...harness({ ...adminEnabled, ...overrides }, { qqActions, ...services }), calls }
}

test('commands admin: every fixed command dispatches validated args in current conversation', async () => {
  const { service, calls } = adminCommands()
  const group = { chatType: 'group', chatId: '20001' }
  const cases = [
    ['/card 10002 名片 含空格', 'setGroupCard', { userId: '10002', card: '名片 含空格' }],
    ['/groupname 新群名', 'setGroupName', { name: '新群名' }],
    ['/admin 10002 off', 'setGroupAdmin', { userId: '10002', enable: false }],
    ['/mute 10002 2', 'setGroupBan', { userId: '10002', durationSeconds: 120 }],
    ['/mute 10002 0', 'setGroupBan', { userId: '10002', durationSeconds: 0 }],
    ['/wholemute on', 'setGroupWholeBan', { enable: true }],
    ['/kick 10002 confirm', 'setGroupKick', { userId: '10002', confirmed: 'confirm' }],
    ['/essence -12', 'setEssence', { messageId: '-12', confirmed: undefined }],
    ['/recall 12 confirm', 'deleteMsg', { messageId: '12', confirmed: 'confirm' }],
  ]
  for (const [command, method, expected] of cases) {
    await service.handle(turn(command, group))
    assert.deepEqual(calls.at(-1), [method, { operatorId: '10001', ...group, ...expected }])
  }
  await service.handle(turn('/profile 新昵称'))
  assert.deepEqual(calls.at(-1), ['setProfile', { operatorId: '10001', chatType: 'private', chatId: '10001', nickname: '新昵称' }])
  await service.handle(turn('/recall 12 confirm'))
  assert.equal(calls.at(-1)[1].chatType, 'private')
  assert.match((await service.handle(turn('/help'))).reply, /\/file 相对路径/)
})

test('commands admin: owner, opt-in, chat and access guards prevent replies and actions as appropriate', async () => {
  const names = ['profile 名', 'card 10002 卡', 'groupname 群', 'admin 10002 on', 'mute 10002 0', 'wholemute off', 'kick 10002 confirm', 'essence 12', 'recall 12 confirm', 'file a.txt']
  let mediaCalls = 0
  const denied = adminCommands({}, { allowSend: false, media: { async sendMedia() { mediaCalls++ } } })
  const disabled = adminCommands({ cognition: {} })
  const nonOwner = adminCommands()
  for (const name of names) {
    assert.equal((await denied.service.handle(turn('/' + name))).reply, '')
    assert.match((await disabled.service.handle(turn('/' + name))).reply, /未启用/)
    assert.equal((await nonOwner.service.handle(turn('/' + name, { senderId: '10002' }))).reply, '')
  }
  for (const h of [denied, disabled, nonOwner]) assert.equal(h.calls.length, 0)
  assert.equal(mediaCalls, 0)
  assert.equal(denied.sent.length, 0)
  const h = adminCommands()
  assert.match((await h.service.handle(turn('/profile 名', { chatType: 'group', chatId: '20001' }))).reply, /主人私聊/)
  for (const name of names.slice(1, 8)) assert.match((await h.service.handle(turn('/' + name))).reply, /当前群/)
  assert.equal(h.calls.length, 0)
})

test('commands admin: malformed args, extra tokens, invalid IDs, limits and confirmation never dispatch', async () => {
  const { service, calls } = adminCommands()
  const group = { chatType: 'group', chatId: '20001' }
  const invalid = ['/profile', '/card abc 卡', '/card 10002', '/groupname', '/groupname ' + '长'.repeat(101), '/admin 10002 yes', '/admin 10002 on extra', '/mute 10002 -1', '/mute 10002 1.5', '/mute 10002 43201', '/mute 10002 0 extra', '/wholemute on extra', '/kick 10002', '/kick 10002 CONFIRM', '/kick 10002 confirm extra', '/essence abc', '/essence 12 extra', '/recall 12', '/recall 12 yes', '/recall 12 confirm extra', '/recall 2147483648 confirm']
  for (const command of invalid) {
    const result = await service.handle(turn(command, command.startsWith('/profile') ? {} : group))
    assert.match(result.reply, /用法|确认/, command)
  }
  assert.equal(calls.length, 0)
  const optional = adminCommands({ cognition: { qqAdmin: { enabled: true, requireConfirm: false } } })
  await optional.service.handle(turn('/recall 12', group))
  assert.equal(optional.calls.at(-1)[0], 'deleteMsg')
  await optional.service.handle(turn('/kick 10002', group))
  assert.equal(optional.calls.length, 1)
})

test('commands admin: /file only passes relative media paths; rejects absolute and traversal', async () => {
  const mediaCalls = []
  const { service } = adminCommands({}, { media: { async sendMedia(payload) { mediaCalls.push(payload) } } })
  await service.handle(turn('/file inbound/report notes.pdf'))
  assert.deepEqual(mediaCalls, [{ chatType: 'private', chatId: '10001', kind: 'file', relativePath: 'inbound/report notes.pdf' }])
  for (const path of ['', '/etc/passwd', '../out.txt', 'inbound/../../out.txt', 'C:/out.txt', 'C:\\out.txt', '\\\\server\\file']) assert.match((await service.handle(turn('/file ' + path))).reply, /用法/)
  assert.equal(mediaCalls.length, 1)
  const failing = adminCommands({}, { media: { async sendMedia() { throw new Error('secret') } } })
  assert.doesNotMatch((await failing.service.handle(turn('/file a.txt'))).reply, /secret/)
})

test('image commands: draw/redraw/image send once to current chat without confirmation text', async () => {
  const calls = []
  const media = {
    async generateImage(prompt) { calls.push(['generate', prompt]); return { ok: true, path: 'generated/cat.png' } },
    async editImage(prompt, path) { calls.push(['edit', prompt, path]); return { ok: true, path: 'generated/edited.png' } },
    async sendMedia(payload) { calls.push(['send', payload]) },
  }
  const h = harness({ media: { enabled: true, images: { enabled: true, generateEnabled: true, editEnabled: true } } }, { media })
  for (const command of ['/draw 一只猫', '/redraw inbound/cat.png 蓝色背景', '/image inbound/ordinary.png']) {
    assert.deepEqual(await h.service.handle(turn(command, { chatType: 'group', chatId: '20001' })), { handled: true, reply: '' })
  }
  assert.deepEqual(calls, [
    ['generate', '一只猫'], ['send', { chatType: 'group', chatId: '20001', kind: 'image', relativePath: 'generated/cat.png' }],
    ['edit', '蓝色背景', 'inbound/cat.png'], ['send', { chatType: 'group', chatId: '20001', kind: 'image', relativePath: 'generated/edited.png' }],
    ['send', { chatType: 'group', chatId: '20001', kind: 'image', relativePath: 'inbound/ordinary.png' }],
  ])
  assert.equal(h.sent.length, 0)
  const help = await h.service.handle(turn('/help'))
  for (const name of ['/draw', '/redraw', '/image']) assert.ok(help.reply.includes(name))
})

test('image commands: disabled, owner/access denied and invalid inputs produce no media side effects', async () => {
  const calls = []
  const media = Object.fromEntries(['generateImage', 'editImage', 'sendMedia'].map((name) => [name, async (...args) => { calls.push([name, args]) }]))
  const enabled = { enabled: true, images: { enabled: true, generateEnabled: true, editEnabled: true } }
  const disabled = harness({}, { media })
  assert.ok((await disabled.service.handle(turn('/draw cat'))).reply.includes('未启用'))
  assert.ok((await disabled.service.handle(turn('/redraw source.png cat'))).reply.includes('未启用'))
  assert.ok((await harness({ media: { enabled: true } }, { media }).service.handle(turn('/image source.png'))).reply.includes('未启用'))
  const blocked = harness({ media: enabled }, { media, allowSend: false })
  const h = harness({ media: enabled }, { media })
  for (const cmd of ['/draw cat', '/redraw source.png cat', '/image source.png']) {
    assert.equal((await blocked.service.handle(turn(cmd))).error, 'ACCESS_DENIED')
    assert.deepEqual(await h.service.handle(turn(cmd, { senderId: '20002' })), { handled: true, reply: '' })
  }
  assert.equal(blocked.sent.length, 0)
  for (const path of ['../cat.png', '/etc/cat.png', 'C:/cat.png', 'C:cat.png', 'a' + String.fromCharCode(92) + 'cat.png', 'x' + String.fromCharCode(0) + '.png']) {
    assert.ok((await h.service.handle(turn('/redraw ' + path + ' cat'))).reply.includes('相对路径'))
    assert.ok((await h.service.handle(turn('/image ' + path))).reply.includes('相对路径'))
  }
  for (const cmd of ['/draw', '/draw ' + 'x'.repeat(1001), '/redraw source.png', '/redraw source.png ' + 'x'.repeat(1001), '/image']) assert.ok((await h.service.handle(turn(cmd))).reply)
  assert.deepEqual(calls, [])
})

test('image commands: provider/send failures return a short safe error', async () => {
  const media = { async generateImage() { throw new Error('provider-secret') }, async editImage() { throw new Error('provider-secret') }, async sendMedia() { throw new Error('raw gateway error') } }
  const h = harness({ media: { enabled: true, images: { enabled: true, generateEnabled: true, editEnabled: true } } }, { media })
  for (const cmd of ['/draw cat', '/redraw source.png cat', '/image source.png']) {
    const result = await h.service.handle(turn(cmd))
    assert.ok(result.reply.includes('图片操作失败'))
    assert.ok(!result.reply.includes('secret') && !result.reply.includes('raw gateway'))
  }
})

test('request commands: owner lists at most ten pending public summaries and confirms approve/reject', async () => {
  const calls = []
  const id = 'req_' + 'a'.repeat(32)
  const requests = {
    list(options) {
      calls.push(['list', options])
      return Array.from({ length: 12 }, (_, i) => ({ id, type: 'group', subType: 'invite', userId: '10002', groupId: '20001', comment: `comment-${i}\nline ` + 'sk-' + 's'.repeat(30), flag: 'private-flag' }))
    },
    async resolve(requestId, options) { calls.push(['resolve', requestId, options]); return { status: options.approve ? 'approved' : 'rejected', flag: 'private-flag', comment: 'raw-comment' } },
  }
  const { service } = harness({}, { requests })
  const result = await service.handle(turn('/requests'))
  assert.deepEqual(calls[0], ['list', { status: 'pending', limit: 10 }])
  assert.match(result.reply, /group\/invite.*QQ 10002.*群 20001.*comment-0 line/)
  assert.doesNotMatch(result.reply, /comment-10|comment-11|sk-ssss|private-flag/)
  assert.equal(result.reply.split('\n').length, 11)
  assert.match((await service.handle(turn(`/approve ${id} confirm`))).reply, /已批准/)
  assert.deepEqual(calls.at(-1), ['resolve', id, { approve: true, operatorId: '10001' }])
  assert.match((await service.handle(turn(`/reject ${id} confirm`))).reply, /已拒绝/)
  assert.deepEqual(calls.at(-1), ['resolve', id, { approve: false, operatorId: '10001' }])
  const help = (await service.handle(turn('/help'))).reply
  for (const name of ['/requests', '/approve', '/reject']) assert.ok(help.includes(name))
})

test('request commands: owner/access/enabled checks and exact confirm guard every side effect', async () => {
  const calls = []
  const requests = { list: (...args) => { calls.push(args); return [] }, resolve: async (...args) => { calls.push(args) } }
  const id = 'req_' + 'b'.repeat(32)
  const commands = ['/requests', `/approve ${id} confirm`, `/reject ${id} confirm`]
  for (const command of commands) {
    const nonOwner = harness({}, { requests })
    assert.deepEqual(await nonOwner.service.handle(turn(command, { senderId: '10002' })), { handled: true, reply: '' })
    assert.equal(nonOwner.sent.length, 0)
    const denied = harness({}, { requests, allowSend: false })
    assert.equal((await denied.service.handle(turn(command))).error, 'ACCESS_DENIED')
    assert.equal(denied.sent.length, 0)
    assert.match((await harness({ cognition: { requests: { enabled: false } } }, { requests }).service.handle(turn(command))).reply, /未启用/)
  }
  const { service } = harness({}, { requests })
  for (const name of ['approve', 'reject']) {
    for (const args of ['', id, `${id} CONFIRM`, `${id} yes`, `${id} confirm extra`, 'bad-id confirm', 'x'.repeat(101) + ' confirm']) assert.match((await service.handle(turn(`/${name} ${args}`))).reply, /用法|确认/)
  }
  assert.match((await service.handle(turn('/requests extra'))).reply, /用法/)
  assert.equal(calls.length, 0)
})

test('request commands: empty/missing services and failures return safe replies without raw comments or flags', async () => {
  assert.match((await harness({}, { requests: { list: () => [] } }).service.handle(turn('/requests'))).reply, /暂无/)
  assert.match((await harness().service.handle(turn('/requests'))).reply, /不可用/)
  const fail = () => { throw new Error('private-flag raw-comment secret') }
  const { service } = harness({}, { requests: { list: fail, resolve: fail } })
  for (const command of ['/requests', '/approve req_' + 'a'.repeat(32) + ' confirm', '/reject req_' + 'a'.repeat(32) + ' confirm']) {
    const { reply } = await service.handle(turn(command))
    assert.match(reply, /失败/)
    assert.doesNotMatch(reply, /private-flag|raw-comment|secret/)
  }
})

test('reminder commands owner, enable, usage and access gates precede service calls', async () => {
  let calls = 0
  const reminders = { add() { calls++; throw new Error('raw secret') }, list() { calls++; return [] }, cancel() { calls++ } }
  for (const command of ['/remind 60 hello', '/reminders', '/forgetreminder rem_abc']) {
    const h = harness({}, { reminders })
    assert.equal((await h.service.handle(turn(command, { senderId: '20002' }))).reply, '')
    assert.match((await h.service.handle(turn(command))).reply, /未启用/)
    const denied = harness({ cognition: { reminders: { enabled: true } } }, { reminders, allowSend: false })
    assert.equal((await denied.service.handle(turn(command))).error, 'ACCESS_DENIED')
  }
  const h = harness({ cognition: { reminders: { enabled: true } } }, { reminders })
  for (const command of ['/remind', '/remind 60', '/remind tomorrow hello', '/remind 1.5 hello', '/reminders extra', '/forgetreminder', '/forgetreminder rem_abc extra']) {
    assert.match((await h.service.handle(turn(command))).reply, /用法/)
  }
  assert.equal(calls, 0)
  assert.match((await h.service.handle(turn('/remind 60 hello'))).reply, /提醒操作失败/)
  assert.match(h.service.help, /\/remind/)
})

test('reminder commands add repeat/ISO, list at most ten and cancel with current owner scope', async () => {
  const calls = []
  const nextAt = Date.parse('2099-01-01T00:00:00Z')
  const reminders = {
    add(input) { calls.push(['add', input]); return { id: 'rem_abc', nextAt } },
    list(input) { calls.push(['list', input]); return [{ id: 'rem_abc', nextAt, text: 'hello' }] },
    cancel(id, input) { calls.push(['cancel', id, input]) },
  }
  const h = harness({ cognition: { reminders: { enabled: true } } }, { reminders })
  const context = { chatType: 'group', chatId: '20001' }
  assert.match((await h.service.handle(turn('/remind 60 hello', context))).reply, /rem_abc.*2099/)
  assert.deepEqual(calls[0], ['add', { ...context, text: 'hello', everySeconds: 60, createdBy: '10001' }])
  await h.service.handle(turn('/remind 2099-01-01T00:00:00Z once', context))
  assert.equal(calls[1][1].at, '2099-01-01T00:00:00Z')
  assert.match((await h.service.handle(turn('/reminders', context))).reply, /rem_abc.*hello/)
  assert.deepEqual(calls[2], ['list', { ...context, status: 'active', limit: 10 }])
  assert.match((await h.service.handle(turn('/forgetreminder rem_abc', context))).reply, /已取消/)
  assert.deepEqual(calls[3], ['cancel', 'rem_abc', { ...context, operatorId: '10001' }])
  assert.ok(h.sent.every((p) => p.source === 'command'))
})
