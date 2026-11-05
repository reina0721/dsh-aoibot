// OneBot v11 连接生命周期管理：端点解析 → WS 连接/重连 → 登录账号核验 → 事件交付 → 状态快照。
//
// 契约见 docs/ARCHITECTURE.md §3.2/§3.4。要点：
//   - 所有策略参数来自配置（reconnect.* / timeouts.* / verification.* / accountCheck / botQQ），没有写死常量；
//   - 账号核验期间的事件先缓冲（上限 verification.bufferSize），核验通过/警告后按序补发，enforce 失败则丢弃；
//   - 热应用配置：端点/开关/核验相关变化时内部重启；重连/超时/过滤变化由各模块现取配置，无需动作；
//   - snapshot() 只暴露脱敏后的地址，token 不进入状态快照。

import { createOneBotClient } from '../onebot/client.js'
import { createActions } from './actions.js'
import { detectGateway as detectSnowLumaGateway, resolveEndpoint, safeUrl } from './snowluma.js'
import { registerSecret } from '../core/redact.js'

const HTTP_AUTH_MODES = ['bearer', 'header-token', 'query']

const noop = () => {}
const noopLog = { debug: noop, info: noop, warn: noop, error: noop }

function normalizeQQ(value) {
  return String(value ?? '').trim().replace(/\s+/g, '')
}

/** 决定「改这些配置需要重建连接」的键。 */
function restartKey(cfg) {
  const onebot = cfg?.onebot || {}
  const snowluma = cfg?.snowluma || {}
  return JSON.stringify({
    enabled: cfg?.enabled !== false,
    gateway: cfg?.gateway === 'snowluma' ? 'snowluma' : 'onebot',
    botQQ: normalizeQQ(cfg?.botQQ),
    accountCheck: cfg?.accountCheck || 'warn',
    verificationEnabled: Boolean(cfg?.verification?.enabled),
    onebot: {
      wsUrl: String(onebot.wsUrl || ''),
      httpUrl: String(onebot.httpUrl || ''),
      wsToken: String(onebot.wsToken || ''),
      httpToken: String(onebot.httpToken || ''),
      httpAuth: HTTP_AUTH_MODES.includes(onebot.httpAuth) ? onebot.httpAuth : 'bearer',
    },
    snowluma: {
      autoDetect: snowluma.autoDetect !== false,
      dir: String(snowluma.dir || ''),
      uin: String(snowluma.uin || ''),
    },
  })
}

/**
 * 创建网关管理器。
 * @param {object} o
 * @param {() => object} o.getConfig 读取当前配置
 * @param {object} [o.log] 日志器（child 形式的 debug/info/warn/error）
 * @param {(raw: object) => void} [o.onEvent] WS 收到 OneBot 原始事件（已通过核验门禁）
 * @param {(snapshot: object) => void} [o.onState] 状态变化回调
 */
export function createGatewayManager({ getConfig, log = noopLog, onEvent, onState } = {}) {
  if (typeof getConfig !== 'function') throw new Error('createGatewayManager 需要 getConfig')

  let resolved = null
  let state = 'stopped'
  let desiredRunning = false
  let paused = false
  let connectedAt = 0
  let lastDisconnectAt = 0
  let lastError = ''
  let login = null
  let loginCheck = 'off'
  let loginAttempts = 0
  let verifyToken = 0
  let pendingRaw = []
  let pendingDropped = 0

  const emitState = () => {
    try {
      onState?.(snapshot())
    } catch (error) {}
  }

  function refreshEndpoint() {
    try {
      resolved = resolveEndpoint(getConfig())
    } catch (error) {
      const cfg = getConfig() || {}
      resolved = {
        endpoint: {
          httpUrl: String(cfg?.onebot?.httpUrl || ''),
          wsUrl: String(cfg?.onebot?.wsUrl || ''),
          httpToken: String(cfg?.onebot?.httpToken || ''),
          wsToken: String(cfg?.onebot?.wsToken || ''),
          httpAuth: 'bearer',
        },
        safe: { mode: 'onebot', httpConfigured: Boolean(cfg?.onebot?.httpUrl), wsConfigured: Boolean(cfg?.onebot?.wsUrl), wsUrlSafe: '', httpUrlSafe: '', source: 'onebot' },
        mode: 'onebot',
        source: 'onebot',
        snowluma: null,
        reason: `解析端点失败：${error.message}`,
      }
    }
    const endpoint = resolved.endpoint
    try {
      registerSecret(endpoint.wsToken)
      registerSecret(endpoint.httpToken)
    } catch (error) {}
    return resolved
  }

  refreshEndpoint()

  // ---- 事件交付与核验缓冲 ---------------------------------------------------

  function shouldVerify() {
    const cfg = getConfig() || {}
    return Boolean(cfg?.verification?.enabled) && normalizeQQ(cfg?.botQQ) !== '' && cfg?.accountCheck !== 'off'
  }

  function deliver(raw) {
    try {
      onEvent?.(raw)
    } catch (error) {
      log.warn?.('交付 OneBot 事件失败：', error.message)
    }
  }

  function flushPending(reason = '') {
    if (!pendingRaw.length && !pendingDropped) return
    const list = pendingRaw
    pendingRaw = []
    if (pendingDropped > 0) log.warn?.(`账号核验期间事件缓冲溢出，丢弃 ${pendingDropped} 条${reason ? `（${reason}）` : ''}`)
    pendingDropped = 0
    for (const raw of list) deliver(raw)
  }

  function dropPending(reason = '') {
    if (pendingRaw.length || pendingDropped) {
      log.warn?.(`账号核验未通过，丢弃核验期间缓冲的 ${pendingRaw.length} 条事件${reason ? `（${reason}）` : ''}`)
    }
    pendingRaw = []
    pendingDropped = 0
  }

  function handleRawEvent(raw) {
    if (state === 'connected' && loginCheck === 'pending' && shouldVerify()) {
      const cfg = getConfig() || {}
      const capacity = Math.max(10, Math.min(1000, Number(cfg?.verification?.bufferSize) || 100))
      pendingRaw.push(raw)
      while (pendingRaw.length > capacity) {
        pendingRaw.shift()
        pendingDropped += 1
      }
      return
    }
    deliver(raw)
  }

  // ---- 登录账号展示/核验 ----------------------------------------------------

  async function refreshLoginInfo() {
    const cfg = getConfig() || {}
    const token = verifyToken
    try {
      const info = await client.call('get_login_info', {}, { timeoutMs: Number(cfg?.timeouts?.verifyMs) || 10000, retries: 0 })
      if (token !== verifyToken) return
      login = { userId: String(info?.user_id ?? ''), nickname: String(info?.nickname || '') }
      emitState()
    } catch (error) {
      if (token !== verifyToken) return
      log.debug?.('读取登录信息失败：', error.message)
    }
  }

  async function runVerification() {
    const cfg = getConfig() || {}
    const expected = normalizeQQ(cfg?.botQQ)
    const token = ++verifyToken
    loginAttempts += 1
    const timeoutMs = Number(cfg?.timeouts?.verifyMs) || 10000
    log.info?.(`开始核验登录账号（期望 ${expected}）`)
    try {
      const info = await client.call('get_login_info', {}, { timeoutMs, retries: 0 })
      if (token !== verifyToken) return
      login = { userId: String(info?.user_id ?? ''), nickname: String(info?.nickname || '') }
      const matched = normalizeQQ(login.userId) !== '' && normalizeQQ(login.userId) === expected
      if (matched) {
        loginCheck = 'ok'
        lastError = ''
        log.info?.(`账号核验通过：${login.nickname || '(无昵称)'} (${login.userId})`)
        flushPending('核验通过')
      } else if (cfg?.accountCheck === 'enforce') {
        loginCheck = 'mismatch'
        lastError = `账号核验失败：网关登录的是 ${login.userId || '未知'}，配置要求 ${expected}`
        log.error?.(lastError)
        dropPending('账号不一致')
        paused = true
        desiredRunning = false
        verifyToken += 1
        client.stop()
        state = 'paused'
      } else {
        loginCheck = 'mismatch'
        lastError = `账号核验警告：网关登录的是 ${login.userId || '未知'}，配置期望 ${expected}（warn 模式继续使用）`
        log.warn?.(lastError)
        flushPending('核验警告')
      }
    } catch (error) {
      if (token !== verifyToken) return
      loginCheck = 'error'
      lastError = `账号核验失败：${error.message}`
      log.warn?.(lastError)
      flushPending('核验出错')
    }
    emitState()
  }

  // ---- 客户端状态回调 -------------------------------------------------------

  function handleClientState(next, detail) {
    if (next === 'connected') {
      state = 'connected'
      connectedAt = Date.now()
      lastError = ''
      loginAttempts = 0
      pendingRaw = []
      pendingDropped = 0
      if (shouldVerify()) {
        loginCheck = 'pending'
        void runVerification()
      } else {
        loginCheck = 'off'
        void refreshLoginInfo()
      }
      log.info?.('QQ 网关已连接')
      emitState()
      return
    }
    if (next === 'connecting') {
      if (state !== 'paused' && desiredRunning) state = 'connecting'
      emitState()
      return
    }
    if (next === 'disconnected') {
      state = 'disconnected'
      lastDisconnectAt = Date.now()
      lastError = String(detail || lastError || '')
      login = null
      loginCheck = 'off'
      // 核验期间缓冲的事件不因断线丢失：按序补发
      flushPending('断线')
      log.warn?.(`QQ 网关断开${lastError ? `：${lastError}` : ''}`)
      emitState()
      return
    }
    if (next === 'unconfigured') {
      state = 'unconfigured'
      lastError = String(detail || '')
      emitState()
      return
    }
    if (next === 'stopped') {
      if (!paused) state = 'stopped'
      emitState()
    }
  }

  // ---- 客户端与动作 ---------------------------------------------------------

  const client = createOneBotClient({
    endpoint: () => (resolved || refreshEndpoint()).endpoint,
    onEvent: handleRawEvent,
    onState: handleClientState,
    log,
    options: () => {
      const cfg = getConfig() || {}
      return { reconnect: cfg.reconnect, timeouts: cfg.timeouts }
    },
  })

  /** 底座：已经把端点解析好之后的启动逻辑。 */
  function startWithResolved() {
    const endpoint = resolved.endpoint
    const hasWs = Boolean(endpoint.wsUrl)
    const hasHttp = Boolean(endpoint.httpUrl)
    if (!hasWs && !hasHttp) {
      state = 'unconfigured'
      lastError = '还没配置 OneBot WebSocket / HTTP 地址'
      login = null
      loginCheck = 'off'
      emitState()
      return snapshot()
    }
    if (!hasWs) {
      // 只有 HTTP：不能实时收事件，但接口调用可用；状态明确提示，不做轮询。
      state = 'disconnected'
      lastError = '只配置了 HTTP 地址：无法实时接收事件（HTTP 调用仍可用）'
      loginCheck = 'off'
      void refreshLoginInfo()
      emitState()
      return snapshot()
    }
    // 已经处于连接状态时再次调用 start()（例如面板连点「连接」）不能把状态打回 connecting：
    // WS 的 onopen 已经发生过，不会再来一次，状态会永远卡住。此时只补做缺失的账号核验。
    if (state === 'connected' && client.stats().wsState === 1) {
      if (shouldVerify() && loginCheck !== 'ok') {
        loginCheck = 'pending'
        void runVerification()
      } else if (loginCheck === 'off') {
        void refreshLoginInfo()
      }
      emitState()
      return snapshot()
    }
    paused = false
    verifyToken += 1
    login = null
    loginCheck = 'off'
    pendingRaw = []
    pendingDropped = 0
    client.start()
    // 同步给出 connecting，避免面板在 WS 打开前短暂显示旧状态
    if (state !== 'paused') state = 'connecting'
    emitState()
    return snapshot()
  }

  async function start() {
    desiredRunning = true
    refreshEndpoint()
    return startWithResolved()
  }

  function stop() {
    desiredRunning = false
    paused = false
    verifyToken += 1
    client.stop()
    state = 'stopped'
    login = null
    loginCheck = 'off'
    pendingRaw = []
    pendingDropped = 0
    emitState()
    return snapshot()
  }

  async function restart() {
    desiredRunning = true
    paused = false
    verifyToken += 1
    client.stop()
    pendingRaw = []
    pendingDropped = 0
    refreshEndpoint()
    return startWithResolved()
  }

  /**
   * 热应用配置。端点/开关/核验相关变化会内部重启；其余（重连、超时、过滤规则）由各模块现取配置。
   * @param {object} prev 旧配置
   * @param {object} next 新配置
   */
  function applyConfig(prev, next) {
    refreshEndpoint()
    if (next?.enabled === false) {
      if (desiredRunning || state !== 'stopped') stop()
      emitState()
      return
    }
    // 「启用并自动连接」：从禁用状态改回启用时自动建立连接（与字段语义一致）。
    if (prev && prev.enabled === false) {
      log.info?.('配置已启用，正在连接…')
      restart()
      return
    }
    const changed = !prev || restartKey(prev) !== restartKey(next)
    if (!changed) {
      emitState()
      return
    }
    if (!desiredRunning) {
      emitState()
      return
    }
    log.info?.('连接相关配置已变更，正在重连…')
    restart()
  }

  // ---- 对外能力 -------------------------------------------------------------

  /** 调用 OneBot action（失败抛 OneBotError）。 */
  async function call(action, params = {}, opts = {}) {
    if (!resolved) refreshEndpoint()
    return client.call(action, params, opts)
  }

  const actions = createActions({ call })

  function mergeProbeOverride(override, cfg) {
    const base = resolved ? resolved.endpoint : refreshEndpoint().endpoint
    const onebot = cfg?.onebot || {}
    const pick = (key) => (override && override[key] !== undefined ? String(override[key] || '') : undefined)
    const httpUrl = pick('httpUrl') ?? base.httpUrl ?? onebot.httpUrl ?? ''
    const wsUrl = pick('wsUrl') ?? base.wsUrl ?? onebot.wsUrl ?? ''
    const httpToken = pick('httpToken') ?? base.httpToken ?? onebot.httpToken ?? ''
    const wsToken = pick('wsToken') ?? base.wsToken ?? onebot.wsToken ?? ''
    const httpAuthRaw = override?.httpAuth ?? base.httpAuth ?? onebot.httpAuth
    return {
      endpoint: {
        httpUrl: String(httpUrl || '').trim(),
        wsUrl: String(wsUrl || '').trim(),
        httpToken: String(httpToken || ''),
        wsToken: String(wsToken || ''),
        httpAuth: HTTP_AUTH_MODES.includes(httpAuthRaw) ? httpAuthRaw : 'bearer',
      },
    }
  }

  /**
   * 只走 HTTP 探测 get_login_info，不改连接状态（面板「探测」按钮）。
   * @param {object} [override] 可覆盖 httpUrl / httpToken / httpAuth / wsUrl / wsToken
   */
  async function probe(override) {
    const cfg = getConfig() || {}
    const target = mergeProbeOverride(override, cfg).endpoint
    const url = String(target.httpUrl || '').trim()
    if (!url) {
      return {
        ok: false,
        message: '没有可探测的 HTTP 地址：探测需要 OneBot HTTP 服务端；只配 WS 时请直接点「连接」',
        httpConfigured: false,
      }
    }
    const timeoutMs = Math.max(1000, Number(cfg?.timeouts?.probeMs) || 8000)
    const started = Date.now()
    const headers = { 'content-type': 'application/json' }
    let requestUrl = `${url.replace(/\/+$/, '')}/get_login_info`
    if (target.httpToken) {
      if (target.httpAuth === 'query') requestUrl += `${requestUrl.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(target.httpToken)}`
      else if (target.httpAuth === 'header-token') headers['x-access-token'] = target.httpToken
      else headers.authorization = `Bearer ${target.httpToken}`
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(requestUrl, { method: 'POST', headers, body: '{}', signal: controller.signal })
      const body = await response.json().catch(() => ({ status: 'failed', retcode: response.status, message: `HTTP ${response.status}` }))
      const elapsedMs = Date.now() - started
      if (body && (body.status === 'ok' || body.retcode === 0)) {
        const data = body.data || {}
        return {
          ok: true,
          url: safeUrl(requestUrl),
          httpStatus: response.status,
          elapsedMs,
          login: { userId: String(data.user_id ?? ''), nickname: String(data.nickname || '') },
        }
      }
      return {
        ok: false,
        url: safeUrl(requestUrl),
        httpStatus: response.status,
        elapsedMs,
        message: `网关返回失败：${body?.message || body?.wording || `retcode ${body?.retcode}`}`,
      }
    } catch (error) {
      const why = error?.cause?.code || error?.cause?.message || error?.message || String(error)
      return {
        ok: false,
        url: safeUrl(requestUrl),
        elapsedMs: Date.now() - started,
        message: error?.name === 'AbortError' ? `探测超时（${timeoutMs}ms）` : `连不上网关：${why}`,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** SnowLuma 检测 + 端点解析（只读，不改连接状态）。 */
  async function detectGateway() {
    const cfg = getConfig() || {}
    refreshEndpoint()
    return detectSnowLumaGateway(cfg)
  }

  /** 同步状态快照（GET /status 的主体，见 ARCHITECTURE §3.4）。 */
  function snapshot() {
    const cfg = getConfig() || {}
    const safe = resolved?.safe || {}
    const stats = client.stats()
    return {
      state,
      configured: Boolean(safe.wsConfigured || safe.httpConfigured),
      paused,
      desiredRunning,
      endpoint: {
        mode: resolved?.mode || 'onebot',
        wsConfigured: Boolean(safe.wsConfigured),
        httpConfigured: Boolean(safe.httpConfigured),
        wsUrlSafe: safe.wsUrlSafe || '',
        httpUrlSafe: safe.httpUrlSafe || '',
        source: resolved?.source || 'onebot',
      },
      connectedAt,
      lastDisconnectAt,
      lastError,
      reconnects: Number(stats.reconnects) || 0,
      loginAttempts,
      login,
      loginCheck,
      expectedBotQQ: normalizeQQ(cfg?.botQQ),
      accountCheck: String(cfg?.accountCheck || 'warn'),
      verification: {
        enabled: Boolean(cfg?.verification?.enabled),
        buffered: pendingRaw.length,
        dropped: pendingDropped,
      },
      snowluma: resolved?.snowluma
        ? {
            installed: Boolean(resolved.snowluma.installed),
            dir: resolved.snowluma.dir || '',
            version: resolved.snowluma.version || '',
            reason: resolved.snowluma.reason || '',
          }
        : null,
      stats: {
        connects: Number(stats.connects) || 0,
        disconnects: Number(stats.disconnects) || 0,
        calls: Number(stats.calls) || 0,
        failures: Number(stats.failures) || 0,
        pending: Number(stats.pending) || 0,
        wsState: Number(stats.wsState) || 3,
      },
    }
  }

  function dispose() {
    desiredRunning = false
    verifyToken += 1
    pendingRaw = []
    pendingDropped = 0
    try {
      client.stop()
    } catch (error) {}
  }

  return {
    ready: Promise.resolve(),
    start,
    stop,
    restart,
    applyConfig,
    call,
    probe,
    detectGateway,
    snapshot,
    actions,
    dispose,
  }
}
