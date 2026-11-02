// 宿主插件端到端测试：用假 DSH 宿主（test/helpers/fake-dsh.js）挂载 src/host.js，
// 用内存 OneBot v11 假网关（test/helpers/mock-onebot.js）模拟 NapCat / SnowLuma。
//
// 覆盖：
//   1. 启动即注册 REST 路由：/health、/status、/config 的形状与默认值；
//   2. 配置保存热应用、恢复默认、非法值回退 + issues；
//   3. POST /connect → WS 连接 + get_login_info 账号核验（loginCheck='ok'）；
//   4. 账号不一致：warn 只告警不断线；enforce 断开并 paused；
//   5. 核验期间事件缓冲不丢，核验后按序补发到 /events；
//   6. 事件过滤器：ignoreUsers / ignoreGroups / kinds 生效；
//   7. POST /send → send_group_msg / send_private_msg 参数正确；
//   8. POST /disconnect、GET /logs、POST /logs/clear。
//
// 隔离：每个用例独立临时数据目录（DSH_ONEBOT_QQ_DATA_DIR）+ 独立 mock 网关；
// 等待一律用 waitFor 轮询（默认 5s 超时），不用固定 sleep。

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createFakeDsh, waitFor, sleep } from './helpers/fake-dsh.js'
import { startMockOneBot } from './helpers/mock-onebot.js'
import { DEFAULTS, CONFIG_GROUPS } from '../src/core/config.js'

const HOST_URL = new URL('../src/host.js', import.meta.url).href
const API = '/onebot-qq/api'
const MOCK_SELF_ID = '20000002'
const MOCK_NICKNAME = '测试机器人'

// ---------------------------------------------------------------------------
// 通用辅助
// ---------------------------------------------------------------------------

function withTimeout(promise, timeoutMs, label) {
  let timer = null
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${timeoutMs}ms）`)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function getJson(fake, path) {
  const res = await fake.call(API + path, undefined, { method: 'GET' })
  assert.equal(res.status, 200, `GET ${path} 期望 HTTP 200，实际 ${res.status}：${res.text}`)
  assert.ok(res.json, `GET ${path} 返回不是 JSON：${res.text}`)
  assert.equal(res.json.ok, true, `GET ${path} 返回 ok=false：${res.text}`)
  return res.json
}

async function postJson(fake, path, body) {
  const res = await fake.call(API + path, body, { method: 'POST' })
  assert.equal(res.status, 200, `POST ${path} 期望 HTTP 200，实际 ${res.status}：${res.text}`)
  assert.ok(res.json, `POST ${path} 返回不是 JSON：${res.text}`)
  assert.equal(res.json.ok, true, `POST ${path} 返回 ok=false：${res.text}`)
  return res.json
}

function deepMerge(base, patch) {
  if (Array.isArray(base)) return Array.isArray(patch) ? [...patch] : base
  if (base === null || typeof base !== 'object') return patch === undefined ? base : patch
  const out = { ...base }
  if (patch && typeof patch === 'object') {
    for (const [key, value] of Object.entries(patch)) {
      out[key] = key in out && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])
        ? deepMerge(out[key], value)
        : value
    }
  }
  return out
}

/** 用当前配置 + patch 保存（模拟面板改几项后点保存）。 */
async function patchConfig(fake, patch) {
  const { config } = await getJson(fake, '/config')
  const next = deepMerge(config, patch)
  const result = await postJson(fake, '/config/save', { config: next })
  return result
}

/** 等状态快照里的 loginCheck 变成期望值；返回当时的完整 status。 */
async function waitForLoginCheck(fake, expected, timeoutMs = 8000) {
  return waitFor(async () => {
    const status = await getJson(fake, '/status')
    return status.gateway.loginCheck === expected ? status : null
  }, { timeoutMs, label: `loginCheck=${expected}` })
}

/** 等状态快照里的 state 变成期望值；返回当时的完整 status。 */
async function waitForGatewayState(fake, expected, timeoutMs = 8000) {
  return waitFor(async () => {
    const status = await getJson(fake, '/status')
    return status.gateway.state === expected ? status : null
  }, { timeoutMs, label: `gateway.state=${expected}` })
}

/** 连接配置：默认已启用 + 指向 mock 的 WS/HTTP 地址与 token。 */
function endpointConfig(mock, extra = {}) {
  return {
    enabled: true,
    botQQ: mock.selfId,
    accountCheck: 'warn',
    onebot: {
      wsUrl: mock.wsUrl,
      httpUrl: mock.httpUrl,
      wsToken: mock.token,
      httpToken: mock.token,
    },
    ...extra,
  }
}

/**
 * 启动一个隔离的测试环境：临时数据目录 + mock 网关 + fake DSH + 插件实例。
 * @param {import('node:test').TestContext} t
 * @param {object} [options]
 * @param {object} [options.mockOptions] 传给 startMockOneBot
 * @param {(mock: object) => void|Promise<void>} [options.prepareMock] 在 apply 前修改 mock 状态（如 loginUserId）
 * @param {object|((mock: object) => object)} [options.rowConfig] 首次生成 config.json 的初始配置
 */
async function boot(t, { mockOptions = {}, prepareMock, rowConfig } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'onebot-qq-e2e-'))
  const previousDataDir = process.env.DSH_ONEBOT_QQ_DATA_DIR
  process.env.DSH_ONEBOT_QQ_DATA_DIR = dir

  let mock = null
  let fake = null
  let disposed = false

  const cleanup = async () => {
    if (disposed) return
    disposed = true
    try {
      fake?.dispose()
    } catch (error) {}
    try {
      await mock?.close()
    } catch (error) {}
    if (previousDataDir === undefined) delete process.env.DSH_ONEBOT_QQ_DATA_DIR
    else process.env.DSH_ONEBOT_QQ_DATA_DIR = previousDataDir
    try {
      await rm(dir, { recursive: true, force: true })
    } catch (error) {}
  }
  t.after(cleanup)

  try {
    mock = await startMockOneBot({ selfId: MOCK_SELF_ID, nickname: MOCK_NICKNAME, ...mockOptions })
    if (prepareMock) await prepareMock(mock)
    fake = createFakeDsh()
    const host = await import(HOST_URL)
    const resolvedRowConfig = typeof rowConfig === 'function' ? rowConfig(mock) : (rowConfig || {})
    const handle = host.apply(fake.ctx, resolvedRowConfig)
    await withTimeout(handle.ready, 5000, 'host.ready')
    return { dir, mock, fake, handle }
  } catch (error) {
    await cleanup()
    throw error
  }
}

const configFileOf = (dir) => join(dir, 'config.json')

// ---------------------------------------------------------------------------
// 1. 启动即注册的接口形状
// ---------------------------------------------------------------------------

test('启动即提供 health / status / config，配置默认值与字段表完整', { timeout: 20000 }, async (t) => {
  const { dir, fake } = await boot(t, { rowConfig: {} })

  // /health：轻量探活
  const health = await getJson(fake, '/health')
  assert.equal(health.ok, true)
  assert.equal(health.apiVersion, 1)
  assert.equal(typeof health.version, 'string')
  assert.equal(typeof health.state, 'string')

  // /status：状态快照 + 统计 + 最近事件
  const status = await getJson(fake, '/status')
  assert.equal(status.apiVersion, 1)
  assert.equal(status.dataDir, dir)
  assert.equal(status.gateway.state, health.state)
  assert.equal(typeof status.gateway.state, 'string')
  assert.equal(typeof status.gateway.configured, 'boolean')
  assert.ok(status.events && typeof status.events.received === 'number')
  assert.ok(status.logs && typeof status.logs.total === 'number')
  assert.ok(Array.isArray(status.recentEvents))
  assert.equal(status.config.version, 1)

  // /config：config / defaults / groups 三件套，面板据此数据驱动渲染
  const configPayload = await getJson(fake, '/config')
  assert.equal(configPayload.dataDir, dir)
  assert.deepEqual(configPayload.config, status.config)
  assert.deepEqual(configPayload.defaults, DEFAULTS)
  assert.deepEqual(configPayload.groups, CONFIG_GROUPS)
  assert.ok(Array.isArray(configPayload.groups) && configPayload.groups.length > 0)
  const firstGroup = configPayload.groups[0]
  assert.equal(typeof firstGroup.id, 'string')
  assert.equal(typeof firstGroup.title, 'string')
  assert.ok(Array.isArray(firstGroup.fields) && firstGroup.fields.length > 0)
  for (const field of firstGroup.fields) {
    assert.equal(typeof field.path, 'string', '字段缺少 path')
    assert.equal(typeof field.type, 'string', `字段 ${field.path} 缺少 type`)
    assert.ok('default' in field, `字段 ${field.path} 缺少 default`)
  }
  // 默认配置已落盘到临时数据目录，用户能找到配置文件
  const saved = JSON.parse(await readFile(configFileOf(dir), 'utf8'))
  assert.deepEqual(saved, DEFAULTS)

  // 未配置端点时的初态：不是 connected（具体是 unconfigured/stopped 由 manager 决定）
  assert.notEqual(status.gateway.state, 'connected')
  assert.equal(status.gateway.configured, false)
})

// ---------------------------------------------------------------------------
// 2. 配置保存热应用 / 恢复默认 / 非法值回退
// ---------------------------------------------------------------------------

test('POST /config/save 热应用端点并自动连接；/config/reset 恢复默认；非法值回退且 issues 非空', { timeout: 30000 }, async (t) => {
  const { dir, fake, mock } = await boot(t, { rowConfig: {} })

  // 初始：未配置端点
  const initial = await getJson(fake, '/status')
  assert.equal(initial.gateway.configured, false)

  // 保存端点 + 账号 → 热应用后自动连上 mock（gateway.ready 时 enabled=true 已 start）
  const saved = await postJson(fake, '/config/save', {
    config: {
      enabled: true,
      botQQ: mock.selfId,
      accountCheck: 'warn',
      onebot: { wsUrl: mock.wsUrl, httpUrl: mock.httpUrl, wsToken: mock.token, httpToken: mock.token },
      ui: { refreshMs: 3000 },
    },
  })
  assert.deepEqual(saved.issues, [])
  assert.equal(saved.config.onebot.wsUrl, mock.wsUrl)
  assert.equal(saved.config.onebot.httpUrl, mock.httpUrl)
  assert.equal(saved.config.botQQ, mock.selfId)
  assert.equal(saved.config.ui.refreshMs, 3000)

  await mock.waitForConnection({ timeoutMs: 5000 })
  const connected = await waitForLoginCheck(fake, 'ok')

  // GET /status 反映新配置与端点（保存即热应用）
  assert.equal(connected.config.onebot.wsUrl, mock.wsUrl)
  assert.equal(connected.config.onebot.httpUrl, mock.httpUrl)
  assert.equal(connected.config.botQQ, mock.selfId)
  assert.equal(connected.gateway.endpoint.wsConfigured, true)
  assert.equal(connected.gateway.endpoint.httpConfigured, true)
  assert.match(connected.gateway.endpoint.wsUrlSafe, new RegExp(`127\\.0\\.0\\.1:${mock.port}`))
  assert.match(connected.gateway.endpoint.httpUrlSafe, new RegExp(`127\\.0\\.0\\.1:${mock.port}`))
  assert.equal(connected.gateway.state, 'connected')

  // 配置文件确实写到 DSH_ONEBOT_QQ_DATA_DIR，且 token 不被改写
  const onDisk = JSON.parse(await readFile(configFileOf(dir), 'utf8'))
  assert.equal(onDisk.onebot.wsUrl, mock.wsUrl)
  assert.equal(onDisk.onebot.wsToken, mock.token)

  // 恢复默认：端点/账号清空，连接关闭，磁盘恢复 DEFAULTS
  const reset = await postJson(fake, '/config/reset', {})
  assert.equal(reset.config.onebot.wsUrl, '')
  assert.equal(reset.config.onebot.httpUrl, '')
  assert.equal(reset.config.botQQ, '')
  await waitForGatewayState(fake, 'unconfigured')
  await waitFor(() => mock.connected() === 0, { label: '重置后 WS 连接关闭' })
  const afterReset = await getJson(fake, '/status')
  assert.equal(afterReset.config.onebot.wsUrl, '')
  assert.equal(afterReset.gateway.configured, false)
  assert.deepEqual(JSON.parse(await readFile(configFileOf(dir), 'utf8')), DEFAULTS)

  // 非法 wsUrl：回退为空 + issues 非空
  const invalidWs = await postJson(fake, '/config/save', { config: { onebot: { wsUrl: 'ftp://x' } } })
  assert.equal(invalidWs.config.onebot.wsUrl, '')
  assert.ok(invalidWs.issues.length > 0, '非法 wsUrl 应给出 issues（至少提示未配置地址）')

  // 非法 httpUrl：回退为空 + issues 里说明协议不受支持
  const invalidHttp = await postJson(fake, '/config/save', { config: { onebot: { httpUrl: 'ftp://x' } } })
  assert.equal(invalidHttp.config.onebot.httpUrl, '')
  assert.ok(
    invalidHttp.issues.some((issue) => /ftp:|不受支持/.test(issue)),
    `非法 httpUrl 的 issues 应说明协议问题，实际：${JSON.stringify(invalidHttp.issues)}`,
  )
  const finalStatus = await getJson(fake, '/status')
  assert.equal(finalStatus.config.onebot.httpUrl, '')
})

// ---------------------------------------------------------------------------
// 3. 连接 + 账号核验成功
// ---------------------------------------------------------------------------

test('POST /connect 建立 WS 连接并核验登录账号（loginCheck=ok）', { timeout: 20000 }, async (t) => {
  const { fake, mock } = await boot(t, {
    rowConfig: (m) => endpointConfig(m, { enabled: false }),
  })

  // 未连接前：状态是 stopped，loginCheck 是 off
  const before = await getJson(fake, '/status')
  assert.equal(before.gateway.state, 'stopped')
  assert.equal(before.gateway.loginCheck, 'off')
  assert.equal(before.gateway.login, null)

  await postJson(fake, '/connect', {})
  await mock.waitForConnection({ timeoutMs: 5000 })

  // 网关侧应收到 get_login_info
  const call = await mock.waitForCall('get_login_info', { timeoutMs: 5000 })
  assert.equal(call.action, 'get_login_info')
  assert.equal(typeof call.params, 'object')

  const status = await waitForLoginCheck(fake, 'ok')
  assert.equal(status.gateway.state, 'connected')
  assert.equal(status.gateway.configured, true)
  assert.ok(status.gateway.connectedAt > 0)
  assert.equal(status.gateway.expectedBotQQ, mock.selfId)
  assert.equal(status.gateway.accountCheck, 'warn')
  assert.deepEqual(status.gateway.login, { userId: mock.selfId, nickname: MOCK_NICKNAME })
  assert.ok(status.gateway.stats.connects >= 1)
  assert.equal(mock.connected(), 1)
})

// ---------------------------------------------------------------------------
// 4. 账号不一致的两种策略
// ---------------------------------------------------------------------------

test('账号不一致 + accountCheck=warn：loginCheck=mismatch 但保持 connected', { timeout: 20000 }, async (t) => {
  const { fake, mock } = await boot(t, {
    rowConfig: (m) => endpointConfig(m, { botQQ: m.selfId, accountCheck: 'warn' }),
    prepareMock: (m) => {
      m.state.loginUserId = '99999999'
    },
  })

  const status = await waitForLoginCheck(fake, 'mismatch')
  assert.equal(status.gateway.state, 'connected')
  assert.equal(status.gateway.paused, false)
  assert.deepEqual(status.gateway.login, { userId: '99999999', nickname: MOCK_NICKNAME })
  assert.match(status.gateway.lastError, /账号核验警告/)

  // 告警模式不断线：等一小段时间后仍然连着
  await sleep(150)
  assert.equal(mock.connected(), 1)
  assert.equal((await getJson(fake, '/status')).gateway.state, 'connected')
})

test('账号不一致 + accountCheck=enforce：WS 断开并 paused', { timeout: 20000 }, async (t) => {
  const { fake, mock } = await boot(t, {
    rowConfig: (m) => endpointConfig(m, { botQQ: m.selfId, accountCheck: 'enforce' }),
    prepareMock: (m) => {
      m.state.loginUserId = '99999999'
    },
  })

  const status = await waitForLoginCheck(fake, 'mismatch')
  assert.equal(status.gateway.state, 'paused')
  assert.equal(status.gateway.paused, true)
  assert.equal(status.gateway.desiredRunning, false)
  assert.match(status.gateway.lastError, /账号核验失败/)
  await waitFor(() => mock.connected() === 0, { label: 'enforce 后 WS 断开' })

  // paused 后不应自动重连
  await sleep(300)
  assert.equal(mock.connected(), 0)
  assert.equal((await getJson(fake, '/status')).gateway.state, 'paused')
})

// ---------------------------------------------------------------------------
// 5. 核验期间事件缓冲
// ---------------------------------------------------------------------------

test('核验期间的私聊事件先缓冲，核验成功后出现在 /events', { timeout: 20000 }, async (t) => {
  const { fake, mock } = await boot(t, {
    mockOptions: { loginDelayMs: 600 },
    rowConfig: (m) => endpointConfig(m),
  })

  await mock.waitForConnection({ timeoutMs: 5000 })
  // WS 已连上、get_login_info 还没回来 → 此刻推送的消息应进核验缓冲
  await waitFor(async () => {
    const status = await getJson(fake, '/status')
    return status.gateway.loginCheck === 'pending' ? status : null
  }, { label: 'loginCheck=pending' })
  mock.pushPrivateMessage({ userId: 10000, nickname: '缓冲用户', message: '缓冲消息-你好' })
  await waitFor(async () => {
    const status = await getJson(fake, '/status')
    return status.gateway.verification.buffered >= 1 ? status : null
  }, { label: '核验缓冲 >= 1 条事件' })

  const status = await waitForLoginCheck(fake, 'ok')
  assert.equal(status.gateway.verification.buffered, 0)

  const events = await getJson(fake, '/events?since=0&limit=50')
  assert.ok(Array.isArray(events.items) && events.items.length >= 1)
  const item = events.items.find((entry) => entry.kind === 'message' && entry.message?.text === '缓冲消息-你好')
  assert.ok(item, `核验后应能通过 /events 看到缓冲的消息，实际：${JSON.stringify(events.items)}`)
  assert.equal(item.kind, 'message')
  assert.equal(item.seqless, true)
  assert.equal(item.postType, 'message')
  assert.equal(item.message.chatType, 'private')
  assert.equal(item.message.chatId, '10000')
  assert.equal(item.message.sender.userId, '10000')
  assert.equal(item.message.sender.nickname, '缓冲用户')
  assert.equal(item.message.text, '缓冲消息-你好')
  assert.ok(item.seq > 0 && item.receivedAt > 0)
  assert.ok(events.nextSince >= item.seq)
})

// ---------------------------------------------------------------------------
// 6. 事件过滤器
// ---------------------------------------------------------------------------

test('过滤器：ignoreUsers / ignoreGroups / kinds.notice 生效，/events 不含被丢弃事件', { timeout: 25000 }, async (t) => {
  const { fake, mock } = await boot(t, {
    rowConfig: (m) => endpointConfig(m),
  })
  await waitForLoginCheck(fake, 'ok')

  // 面板保存过滤规则 → 热应用（不重连）
  const saved = await patchConfig(fake, {
    events: {
      ignoreUsers: ['10001'],
      ignoreGroups: ['30002'],
      kinds: { notice: false },
    },
  })
  assert.deepEqual(saved.config.events.ignoreUsers, ['10001'])
  assert.deepEqual(saved.config.events.ignoreGroups, ['30002'])
  assert.equal(saved.config.events.kinds.notice, false)
  // 过滤规则变化只更新配置，不重连
  assert.equal((await getJson(fake, '/status')).gateway.state, 'connected')

  const before = await getJson(fake, '/events')
  const since = before.nextSince

  // 会被丢弃的 3 条：忽略用户、忽略群、关闭的 notice
  mock.pushPrivateMessage({ userId: 10001, message: '应被 ignoreUsers 丢弃' })
  mock.pushGroupMessage({ groupId: 30002, userId: 10002, message: '应被 ignoreGroups 丢弃' })
  mock.pushNotice({ noticeType: 'friend_recall', userId: 10002, messageId: 1 })
  // 会被接受的 2 条
  mock.pushPrivateMessage({ userId: 10002, message: '正常私聊' })
  mock.pushGroupMessage({ groupId: 30001, userId: 10002, message: '正常群聊' })

  const events = await waitFor(async () => {
    const payload = await getJson(fake, `/events?since=${since}&limit=100`)
    const texts = payload.items.filter((item) => item.kind === 'message').map((item) => item.message.text)
    return texts.includes('正常私聊') && texts.includes('正常群聊') ? payload : null
  }, { label: '被接受的事件进入 /events' })

  const allTexts = events.items.map((item) => item.message?.text).filter(Boolean)
  assert.ok(!allTexts.includes('应被 ignoreUsers 丢弃'), 'ignoreUsers 应过滤 10001 的消息')
  assert.ok(!allTexts.includes('应被 ignoreGroups 丢弃'), 'ignoreGroups 应过滤 30002 的消息')
  assert.equal(events.items.some((item) => item.kind === 'notice'), false, 'kinds.notice=false 应丢弃通知事件')
  const kept = events.items.find((item) => item.message?.text === '正常群聊')
  assert.equal(kept.message.chatType, 'group')
  assert.equal(kept.message.chatId, '30001')

  // 统计里能看到丢弃原因
  const status = await getJson(fake, '/status')
  assert.ok(status.events.dropped >= 3)
  assert.ok(status.events.droppedReasons.ignoreUser >= 1)
  assert.ok(status.events.droppedReasons.ignoreGroup >= 1)
  assert.ok(status.events.droppedReasons.kind >= 1)

  // 清空事件缓冲
  await postJson(fake, '/events/clear', {})
  const cleared = await getJson(fake, '/events')
  assert.equal(cleared.items.length, 0)
})

// ---------------------------------------------------------------------------
// 7. 发送消息
// ---------------------------------------------------------------------------

test('POST /send 群聊/私聊：mock 收到 send_group_msg / send_private_msg 与文本消息段', { timeout: 20000 }, async (t) => {
  const { fake, mock } = await boot(t, {
    rowConfig: (m) => endpointConfig(m),
  })
  await waitForLoginCheck(fake, 'ok')
  mock.clearCalls()

  const groupResult = await postJson(fake, '/send', { chatType: 'group', chatId: '30001', message: 'hi' })
  assert.ok(groupResult.result && groupResult.result.message_id > 0)
  const groupCall = await mock.waitForCall('send_group_msg', { timeoutMs: 5000 })
  assert.equal(groupCall.params.group_id, 30001)
  assert.deepEqual(groupCall.params.message, [{ type: 'text', data: { text: 'hi' } }])

  const privateResult = await postJson(fake, '/send', { chatType: 'private', chatId: '10001', message: [{ type: 'text', data: { text: '你好' } }] })
  assert.ok(privateResult.result && privateResult.result.message_id > 0)
  const privateCall = await mock.waitForCall('send_private_msg', { timeoutMs: 5000 })
  assert.equal(privateCall.params.user_id, 10001)
  assert.deepEqual(privateCall.params.message, [{ type: 'text', data: { text: '你好' } }])

  // mock 侧的发送记录（state.sentMessages）也可查
  assert.equal(mock.state.sentMessages.filter((item) => item.action === 'send_group_msg').length, 1)
  assert.equal(mock.sent('send_group_msg')[0].params.message[0].data.text, 'hi')
})

// ---------------------------------------------------------------------------
// 8. 断开连接 / 日志
// ---------------------------------------------------------------------------

test('POST /disconnect 关闭连接；GET /logs 可拉取、POST /logs/clear 可清空', { timeout: 20000 }, async (t) => {
  const { fake, mock } = await boot(t, {
    rowConfig: (m) => endpointConfig(m),
  })
  await waitForLoginCheck(fake, 'ok')

  // 日志：插件加载/连接过程已产生日志
  const logs = await getJson(fake, '/logs?since=0&limit=50')
  assert.ok(Array.isArray(logs.items))
  assert.ok(logs.items.length >= 1, '插件启动后日志环形缓冲不应为空')
  assert.equal(typeof logs.nextSince, 'number')
  for (const entry of logs.items) {
    assert.equal(typeof entry.seq, 'number')
    assert.equal(typeof entry.level, 'string')
    assert.equal(typeof entry.text, 'string')
  }
  // 增量拉取：since=nextSince 时应为空
  const incremental = await getJson(fake, `/logs?since=${logs.nextSince}&limit=50`)
  assert.equal(incremental.items.length, 0)

  // 断开：WS 关闭、状态 stopped、loginCheck 归位
  await postJson(fake, '/disconnect', {})
  await waitFor(() => mock.connected() === 0, { label: '断开后 WS 连接关闭' })
  const stopped = await waitForGatewayState(fake, 'stopped')
  assert.equal(stopped.gateway.loginCheck, 'off')
  assert.equal(stopped.gateway.login, null)

  // 清空日志
  await postJson(fake, '/logs/clear', {})
  const cleared = await waitFor(async () => {
    const payload = await getJson(fake, '/logs?since=0&limit=10')
    return payload.items.length === 0 ? payload : null
  }, { label: '日志清空' })
  assert.equal(cleared.items.length, 0)
})
