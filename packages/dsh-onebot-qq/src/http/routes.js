// 宿主半边 REST 接口：/onebot-qq/api/*，面板只通过这些接口读写状态与配置。
// 路由全部注册在 apply 内，随插件卸载一起清理（ctx.effect）。

import { redact } from '../core/redact.js'
import { publicConfig, defaultConfig, CONFIG_GROUPS } from '../core/config.js'

export const API_PREFIX = '/onebot-qq/api'
export const API_VERSION = 1

const MAX_BODY_BYTES = 1024 * 1024

/** 统一 JSON 响应。 */
export function send(res, status, body) {
  const text = JSON.stringify(body)
  try {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(text)
  } catch (error) {}
}

async function readBody(req) {
  const chunks = []
  let size = 0
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
      chunks.push(buffer)
    }
  } catch (error) {
    throw new Error(`读取请求体失败：${error.message}`)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error('请求体不是合法 JSON')
  }
}

function queryOf(req) {
  try {
    return Object.fromEntries(new URL(req.url, 'http://dsh.local').searchParams)
  } catch (error) {
    return {}
  }
}

function toInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

/**
 * @param {object} o
 * @param {import('@deepseek-ai/cordis').Context} o.ctx
 * @param {() => object} o.getConfig
 * @param {(next: object) => { config: object, issues: string[] }} o.setConfig
 * @param {() => { config: object, issues: string[] }} o.resetConfig
 * @param {object} o.gateway gateway manager（见 src/gateway/manager.js）
 * @param {object} o.events 事件缓冲
 * @param {object} o.logger 日志器
 * @param {string} o.version
 * @param {string} o.dataDir
 */
export function createRoutes({ ctx, getConfig, setConfig, resetConfig, gateway, events, logger, version, dataDir }) {
  const registered = []

  const answer = async (res, work, { allowRaw = false } = {}) => {
    try {
      const result = await work()
      if (result === undefined) return
      if (allowRaw && result && result.__raw === true) {
        res.statusCode = result.status || 200
        res.setHeader('content-type', result.type || 'application/octet-stream')
        res.end(result.body)
        return
      }
      send(res, 200, result)
    } catch (error) {
      send(res, 200, { ok: false, message: redact(String(error?.message || error)) })
    }
  }

  const route = (method, path, handler) => {
    const register = () => ctx.webServer.register({
      kind: 'exact',
      path: API_PREFIX + path,
      handler: (req, res) => {
        if (method && String(req.method || '').toUpperCase() !== method) {
          send(res, 405, { ok: false, message: `只支持 ${method}` })
          return
        }
        answer(res, () => handler(req, res))
      },
    })
    try {
      registered.push(ctx.effect(register, `onebot-qq: 路由 ${method} ${path}`))
    } catch (error) {
      // ctx.effect 不可用（测试替身）时直接注册；dispose 由调用方处理
      register()
    }
  }

  const statusPayload = () => {
    const cfg = getConfig()
    return {
      ok: true,
      apiVersion: API_VERSION,
      version,
      dataDir,
      config: publicConfig(cfg),
      gateway: gateway.snapshot(),
      events: events.stats(),
      logs: logger.stats(),
      recentEvents: events.recent(20),
    }
  }

  // ---- 状态与配置 ----
  route('GET', '/status', async () => statusPayload())

  route('GET', '/config', async () => ({
    ok: true,
    version,
    apiVersion: API_VERSION,
    dataDir,
    config: publicConfig(getConfig()),
    defaults: defaultConfig(),
    groups: CONFIG_GROUPS,
  }))

  // 注意：DSH webserver 的 exact 路由按 path 去重（不区分 method），同 path 的 GET/POST
  // 不能分别注册，因此保存动作用独立子路径。
  route('POST', '/config/save', async (req) => {
    const body = await readBody(req)
    const next = body && body.config !== undefined ? body.config : body
    if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error('缺少 config 对象')
    const result = setConfig(next)
    return { ok: true, config: publicConfig(result.config), issues: result.issues || [] }
  })

  route('POST', '/config/reset', async () => {
    const result = resetConfig()
    return { ok: true, config: publicConfig(result.config), issues: result.issues || [] }
  })

  // ---- 连接控制 ----
  route('POST', '/connect', async () => {
    await gateway.start()
    return { ok: true, gateway: gateway.snapshot() }
  })

  route('POST', '/disconnect', async () => {
    gateway.stop()
    return { ok: true, gateway: gateway.snapshot() }
  })

  route('POST', '/reconnect', async () => {
    await gateway.restart()
    return { ok: true, gateway: gateway.snapshot() }
  })

  route('POST', '/probe', async (req) => {
    const body = await readBody(req)
    const result = await gateway.probe(body?.endpoint)
    return { ok: true, probe: result }
  })

  route('GET', '/gateway/detect', async () => ({ ok: true, ...(await gateway.detectGateway()) }))

  // ---- 账号与列表 ----
  route('GET', '/login-info', async () => {
    const info = await gateway.call('get_login_info', {}, { timeoutMs: 15000 })
    return { ok: true, login: { userId: String(info?.user_id ?? ''), nickname: info?.nickname || '' } }
  })

  route('GET', '/friends', async () => {
    const list = await gateway.call('get_friend_list', {}, { timeoutMs: 20000 })
    return { ok: true, friends: Array.isArray(list) ? list : [] }
  })

  route('GET', '/groups', async () => {
    const list = await gateway.call('get_group_list', {}, { timeoutMs: 20000 })
    return { ok: true, groups: Array.isArray(list) ? list : [] }
  })

  // ---- 消息发送 ----
  route('POST', '/send', async (req) => {
    const body = await readBody(req)
    const chatType = body?.chatType === 'group' ? 'group' : body?.chatType === 'private' ? 'private' : ''
    if (!chatType) throw new Error('chatType 必须是 private 或 group')
    const chatId = String(body?.chatId ?? '').trim()
    if (!chatId) throw new Error('缺少 chatId')
    const result = await gateway.actions.sendMessage({ chatType, chatId, message: body?.message })
    return { ok: true, result }
  })

  // ---- 原始 action 透传（受 security.allowRawAction 限制）----
  route('POST', '/action', async (req) => {
    if (!getConfig()?.security?.allowRawAction) throw new Error('未开启「允许面板透传任意 OneBot action」（配置 → 安全）')
    const body = await readBody(req)
    const action = String(body?.action || '').trim()
    if (!action) throw new Error('缺少 action')
    const params = body?.params && typeof body.params === 'object' ? body.params : {}
    const result = await gateway.call(action, params)
    return { ok: true, result }
  })

  // ---- 事件 / 日志 ----
  route('GET', '/events', async (req) => {
    const q = queryOf(req)
    const pageSize = Number(getConfig()?.ui?.eventPageSize) || 50
    return { ok: true, ...events.list({ since: toInt(q.since, 0, 0, Number.MAX_SAFE_INTEGER), limit: toInt(q.limit, pageSize, 1, 2000) }) }
  })

  route('POST', '/events/clear', async () => ({ ok: true, events: events.clear() }))

  route('GET', '/logs', async (req) => {
    const q = queryOf(req)
    const pageSize = Number(getConfig()?.ui?.logPageSize) || 100
    const result = logger.recent({
      since: toInt(q.since, 0, 0, Number.MAX_SAFE_INTEGER),
      limit: toInt(q.limit, pageSize, 1, 2000),
      minLevel: String(q.level || ''),
    })
    return { ok: true, ...result }
  })

  route('POST', '/logs/clear', async () => ({ ok: true, logs: logger.clear() }))

  route('GET', '/health', async () => ({
    ok: true,
    version,
    apiVersion: API_VERSION,
    state: gateway.snapshot().state,
    uptimeMs: Math.round(process.uptime() * 1000),
  }))

  return {
    prefix: API_PREFIX,
    apiVersion: API_VERSION,
    statusPayload,
    dispose() {
      for (const item of registered) {
        try {
          if (typeof item === 'function') item()
        } catch (error) {}
      }
      registered.length = 0
    },
  }
}
