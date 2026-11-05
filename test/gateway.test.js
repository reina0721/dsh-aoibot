// gateway manager 集成测试：用内存 OneBot 假网关验证连接、账号核验、事件缓冲、动作与探测。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { startMockOneBot } from './helpers/mock-onebot.js'
import { createGatewayManager } from '../src/gateway/manager.js'
import { DEFAULTS } from '../src/core/config.js'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : clone(patch)
  const out = clone(base && typeof base === 'object' && !Array.isArray(base) ? base : {})
  for (const [key, value] of Object.entries(patch)) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value) ? deepMerge(out[key] || {}, value) : clone(value)
  }
  return out
}

function makeConfig(mock, overrides = {}) {
  const base = clone(DEFAULTS)
  base.enabled = true
  base.gateway = 'onebot'
  base.botQQ = String(mock.selfId)
  base.accountCheck = 'warn'
  base.reconnect.enabled = false
  base.onebot.wsUrl = mock.wsUrl
  base.onebot.httpUrl = mock.httpUrl
  base.onebot.wsToken = mock.token
  base.onebot.httpToken = mock.token
  base.onebot.httpAuth = 'bearer'
  return deepMerge(base, overrides)
}

async function waitFor(fn, { timeoutMs = 6000, intervalMs = 25, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await fn()
      if (last) return last
    } catch (error) {
      last = error
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`超时等待：${label}`)
}

async function setup(t, overrides = {}) {
  const mock = await startMockOneBot({ selfId: '20000002', token: 'mock-token-abcdef' })
  const cfg = makeConfig(mock, overrides)
  const events = []
  const states = []
  const manager = createGatewayManager({
    getConfig: () => cfg,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    onEvent: (raw) => events.push(raw),
    onState: (snapshot) => states.push(snapshot),
  })
  t.after(async () => {
    try { manager.dispose() } catch (error) {}
    try { await mock.close() } catch (error) {}
  })
  return { mock, cfg, events, states, manager }
}

test('未配置地址：start() 后状态为 unconfigured', async (t) => {
  const mock = await startMockOneBot({ token: '' })
  const cfg = makeConfig(mock, { onebot: { wsUrl: '', httpUrl: '', wsToken: '', httpToken: '' } })
  const manager = createGatewayManager({ getConfig: () => cfg, log: { debug() {}, info() {}, warn() {}, error() {} } })
  t.after(async () => { manager.dispose(); await mock.close() })
  await manager.start()
  const snapshot = manager.snapshot()
  assert.equal(snapshot.state, 'unconfigured')
  assert.equal(snapshot.configured, false)
  assert.match(snapshot.lastError, /还没配置/)
})

test('连接 + 账号核验通过：loginCheck=ok 且拿到登录账号', async (t) => {
  const { mock, manager } = await setup(t)
  await manager.start()
  const ready = await waitFor(() => {
    const snapshot = manager.snapshot()
    return snapshot.loginCheck === 'ok' ? snapshot : null
  }, { label: 'loginCheck=ok' })
  assert.equal(ready.state, 'connected')
  assert.equal(ready.login.userId, '20000002')
  assert.equal(ready.login.nickname, '测试机器人')
  assert.equal(ready.loginAttempts, 1)
  assert.equal(ready.expectedBotQQ, '20000002')
  assert.ok(ready.connectedAt > 0)
  assert.equal(mock.connected(), 1)
  const infoCalls = mock.sent('get_login_info')
  assert.ok(infoCalls.length >= 1)
  assert.equal(infoCalls[0].transport, 'http')
})

test('核验期间事件先缓冲，核验通过后按序补发（不丢消息）', async (t) => {
  const { mock, manager, events } = await setup(t, { verification: { bufferSize: 10 } })
  mock.state.loginDelayMs = 400
  await manager.start()
  await mock.waitForConnection()
  // 核验还没返回时推消息：此刻 loginCheck 应为 pending
  const pending = await waitFor(() => manager.snapshot().loginCheck === 'pending' ? manager.snapshot() : null, { label: 'loginCheck=pending' })
  assert.equal(pending.verification.buffered >= 0, true)
  mock.pushPrivateMessage({ userId: 10001, message: '核验期间的消息' })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(events.length, 0, '核验未完成前不应交付事件')
  await waitFor(() => manager.snapshot().loginCheck === 'ok', { label: '核验完成' })
  await waitFor(() => events.length === 1, { label: '缓冲事件补发' })
  assert.equal(events[0].post_type, 'message')
  assert.equal(events[0].message[0].data.text, '核验期间的消息')
  assert.equal(manager.snapshot().verification.buffered, 0)
})

test('账号不一致 + warn：保持连接并告警；enforce：断开并进入 paused', async (t) => {
  const warn = await setup(t, { accountCheck: 'warn' })
  warn.mock.state.loginUserId = '99999999'
  await warn.manager.start()
  const warned = await waitFor(() => warn.manager.snapshot().loginCheck === 'mismatch' ? warn.manager.snapshot() : null, { label: 'mismatch(warn)' })
  assert.equal(warned.state, 'connected')
  assert.equal(warned.login.userId, '99999999')
  assert.match(warned.lastError, /warn 模式/)
  assert.equal(warn.mock.connected(), 1)

  const enforce = await setup(t, { accountCheck: 'enforce' })
  enforce.mock.state.loginUserId = '99999999'
  await enforce.manager.start()
  const paused = await waitFor(() => enforce.manager.snapshot().state === 'paused' ? enforce.manager.snapshot() : null, { label: 'paused(enforce)' })
  assert.equal(paused.loginCheck, 'mismatch')
  assert.equal(paused.paused, true)
  await waitFor(() => enforce.mock.connected() === 0, { label: 'enforce 断开 WS' })
  assert.match(paused.lastError, /账号核验失败/)
})

test('重复 start()（已连接时再点「连接」）不会把状态打回 connecting', async (t) => {
  const { manager } = await setup(t)
  await manager.start()
  await waitFor(() => manager.snapshot().loginCheck === 'ok', { label: '首次核验' })
  const connectedAt = manager.snapshot().connectedAt
  const again = await manager.start()
  assert.equal(again.state, 'connected')
  await new Promise((resolve) => setTimeout(resolve, 150))
  const snapshot = manager.snapshot()
  assert.equal(snapshot.state, 'connected')
  assert.equal(snapshot.loginCheck, 'ok')
  assert.equal(snapshot.connectedAt, connectedAt, '不应重建连接')
})

test('账号一致时不误报 mismatch；toggle stop() 后连接关闭', async (t) => {
  const { mock, manager } = await setup(t, { botQQ: '20000002' })
  await manager.start()
  await waitFor(() => manager.snapshot().loginCheck === 'ok', { label: 'loginCheck=ok' })
  manager.stop()
  assert.equal(manager.snapshot().state, 'stopped')
  await waitFor(() => mock.connected() === 0, { label: 'stop 关闭 WS' })
})

test('probe：HTTP 探测 get_login_info 成功/失败都可读，且不改连接状态', async (t) => {
  const { manager } = await setup(t)
  assert.equal(manager.snapshot().state, 'stopped')
  const ok = await manager.probe()
  assert.equal(ok.ok, true)
  assert.equal(ok.login.userId, '20000002')
  assert.match(ok.url, /get_login_info/)
  // 错误 token：bearer 方式应被假网关拒绝
  const bad = await manager.probe({ httpToken: 'wrong-token' })
  assert.equal(bad.ok, false)
  assert.ok(String(bad.message || '').length > 0)
  // 改一个不存在的 HTTP 地址：可读错误而不是抛异常
  const unreachable = await manager.probe({ httpUrl: 'http://127.0.0.1:1' })
  assert.equal(unreachable.ok, false)
  assert.match(unreachable.message, /连不上|超时|失败/)
  assert.equal(manager.snapshot().state, 'stopped')
})

test('actions.sendGroup/sendPrivate 通过 mgr 透传；snapshot 与 detectGateway 脱敏', async (t) => {
  const { mock, manager } = await setup(t)
  const groupResult = await manager.actions.sendGroup('30001', '群消息')
  assert.equal(groupResult.message_id > 0, true)
  const groupCall = mock.sent('send_group_msg').at(-1)
  assert.deepEqual(groupCall.params.message, [{ type: 'text', data: { text: '群消息' } }])
  assert.equal(groupCall.params.group_id, 30001)

  await manager.actions.sendPrivate('10001', [{ type: 'text', data: { text: '私聊' } }])
  assert.equal(mock.sent('send_private_msg').length, 1)

  const snapshot = manager.snapshot()
  assert.equal(snapshot.endpoint.httpConfigured, true)
  assert.equal(snapshot.endpoint.wsConfigured, true)
  assert.equal(JSON.stringify(snapshot).includes('mock-token-abcdef'), false)

  const detected = await manager.detectGateway()
  assert.equal(detected.mode, 'onebot')
  assert.equal(detected.source, 'onebot')
  assert.equal(detected.endpoint.wsConfigured, true)
})

test('enabled:false 起步时，保存 enabled:true 会自动建立连接（与「启用并自动连接」语义一致）', async (t) => {
  const { manager, cfg } = await setup(t, { enabled: false })
  manager.stop() // 模拟 host 启动时 enabled=false 的处理
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(manager.snapshot().state, 'stopped')

  const prev = JSON.parse(JSON.stringify(cfg))
  const next = JSON.parse(JSON.stringify(cfg))
  next.enabled = true
  Object.assign(cfg, next) // host.setConfig 会先更新配置，再调 applyConfig(prev, next)
  manager.applyConfig(prev, next)
  await waitFor(() => manager.snapshot().state === 'connected', { label: '从禁用切到启用后自动连接' })
  await waitFor(() => manager.snapshot().loginCheck === 'ok', { label: '自动连接后账号核验' })
})

test('断线：state=disconnected 且 lastError 有原因（reconnect 关闭时不无限重连）', async (t) => {
  const { mock, manager } = await setup(t)
  await manager.start()
  await waitFor(() => manager.snapshot().state === 'connected', { label: 'connected' })
  await mock.close()
  const snapshot = await waitFor(() => {
    const current = manager.snapshot()
    return current.state === 'disconnected' ? current : null
  }, { label: 'disconnected' })
  assert.equal(snapshot.login, null)
  assert.equal(snapshot.loginCheck, 'off')
})
