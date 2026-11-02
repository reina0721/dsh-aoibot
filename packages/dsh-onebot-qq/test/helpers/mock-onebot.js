// 测试用的内存 OneBot v11 假网关：HTTP action + WebSocket（Universal）+ 主动推事件。
//
// 改写自 aureth-labs/dsh-aurabot-qq 的 test/helpers/mock-onebot.js（MIT，见 THIRD_PARTY_NOTICES.md）：
//   - 只保留 OneBot v11 通用 action（去掉 aurabot 特有的空间/收藏/上传等接口）；
//   - token 校验支持 Authorization Bearer / X-Access-Token / ?access_token= 三种方式，可配置只接受其中一种；
//   - calls 记录带 transport（http/ws）与 echo，便于断言「走的是哪条链路」；
//   - 增加延迟/失败注入（state.delays / state.failures）、_mock 控制端点、等待辅助函数；
//   - 同时供 node:test（test/e2e.test.js）与 scripts/mock-gateway.mjs（人工联调）使用。
//
// 用法：
//   const mock = await startMockOneBot({ selfId: '20000002', token: 'mock-token' })
//   mock.httpUrl / mock.wsUrl / mock.token / mock.calls / mock.state
//   mock.pushPrivateMessage({ userId: 10001, message: '你好' })
//   await mock.close()
//
// 只依赖 Node 内置模块（http / crypto），不引入 ws 等第三方库：WS 帧编解码是本文件自己实现的。

import http from 'node:http'
import { createHash } from 'node:crypto'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const AUTH_MODES = ['bearer', 'header-token', 'query']
const MAX_HTTP_BODY = 4 * 1024 * 1024

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function toNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function deepClone(value) {
  try {
    return structuredClone(value)
  } catch (error) {
    try {
      return JSON.parse(JSON.stringify(value))
    } catch (inner) {
      return value
    }
  }
}

// ---------------------------------------------------------------------------
// WebSocket 帧编解码（RFC 6455 的最小实现：文本帧 + ping/pong/close）
// ---------------------------------------------------------------------------

function wsAccept(key) {
  return createHash('sha1').update(key + WS_GUID).digest('base64')
}

/** 服务端 → 客户端的帧必须不 mask。opcode 默认 0x1（文本）。 */
function encodeFrame(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  const len = body.length
  let head
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len])
  } else if (len < 65536) {
    head = Buffer.alloc(4)
    head[0] = 0x80 | opcode
    head[1] = 126
    head.writeUInt16BE(len, 2)
  } else {
    head = Buffer.alloc(10)
    head[0] = 0x80 | opcode
    head[1] = 127
    head.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([head, body])
}

/** 解析缓冲区里的帧；返回已解析帧与未消费的剩余字节（允许半包）。 */
function decodeFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset]
    const b1 = buffer[offset + 1]
    const fin = (b0 & 0x80) !== 0
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let length = b1 & 0x7f
    let p = offset + 2
    if (length === 126) {
      if (p + 2 > buffer.length) break
      length = buffer.readUInt16BE(p)
      p += 2
    } else if (length === 127) {
      if (p + 8 > buffer.length) break
      length = Number(buffer.readBigUInt64BE(p))
      p += 8
    }
    let mask = null
    if (masked) {
      if (p + 4 > buffer.length) break
      mask = buffer.subarray(p, p + 4)
      p += 4
    }
    if (p + length > buffer.length) break
    const payload = Buffer.from(buffer.subarray(p, p + length))
    if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]
    frames.push({ fin, opcode, payload })
    offset = p + length
  }
  return { frames, rest: buffer.subarray(offset) }
}

/** 把 undefined 的字段清掉，避免 JSON 序列化出现 null/丢字段的歧义。 */
function clean(value) {
  if (value === undefined) return undefined
  return value
}

// ---------------------------------------------------------------------------
// 假网关主体
// ---------------------------------------------------------------------------

/**
 * 启动一个内存版 OneBot v11 网关。
 *
 * @param {object} [options]
 * @param {string|number} [options.selfId='20000002']    机器人 QQ 号（self_id / get_login_info 默认值）
 * @param {string} [options.nickname='测试机器人']        get_login_info.nickname 默认值
 * @param {string} [options.token='mock-token-abcdef']   访问 token；传 '' / null 表示不校验
 * @param {number} [options.loginDelayMs=0]              get_login_info 延迟（模拟核验慢）
 * @param {number} [options.port=0]                      监听端口，0 = 随机
 * @param {string} [options.host='127.0.0.1']            监听地址
 * @param {string[]} [options.authModes]                 HTTP 只接受哪些 token 方式（默认三种都接受）
 * @param {string[]} [options.wsAuthModes]               WS 只接受哪些 token 方式（默认三种都接受）
 * @param {object[]} [options.friends]                   好友列表初始值
 * @param {object[]} [options.groups]                    群列表初始值
 * @param {object} [options.members]                     群成员初始值：{ [groupId]: member }
 */
export async function startMockOneBot(options = {}) {
  const {
    selfId = '20000002',
    nickname = '测试机器人',
    token = 'mock-token-abcdef',
    loginDelayMs = 0,
    port = 0,
    host = '127.0.0.1',
    authModes,
    wsAuthModes,
    friends,
    groups,
    members,
  } = options

  const httpAuthModes = normalizeAuthModes(authModes, AUTH_MODES)
  const wsAllowedModes = normalizeAuthModes(wsAuthModes, AUTH_MODES)

  /** 所有收到的 action 调用：{ action, params, transport: 'http'|'ws', echo?, t } */
  const calls = []
  /** 所有被网关主动推出的事件：{ seq, at, event, sentTo } */
  const pushed = []
  /** 已连接的 WS 客户端（{ socket, buffer, fragments }） */
  const connections = new Set()
  const callListeners = new Set()
  const connectionListeners = new Set()

  let msgSeq = 1000
  let eventSeq = 0
  let httpUrl = ''
  let wsUrl = ''
  let closed = false

  /** 可变状态：测试可随时改（改动立即生效）。 */
  const state = {
    selfId: String(selfId),
    nickname,
    /** 覆盖 get_login_info 返回的 QQ 号（测「账号不一致」）；空 = 用 selfId */
    loginUserId: '',
    loginDelayMs: Number(loginDelayMs) || 0,
    /** 单个 action 的延迟：{ get_login_info: 500 } */
    delays: Object.create(null),
    /** 失败注入：{ send_private_msg: '发送失败' } 或 { retcode, message } 或 (params) => … */
    failures: Object.create(null),
    /** false = 收到 WS action 后不回包（测超时） */
    autoReply: true,
    friends: friends || [
      { user_id: 10001, nickname: '测试好友', remark: '' },
      { user_id: 10002, nickname: '另一个好友', remark: '' },
    ],
    groups: groups || [
      { group_id: 30001, group_name: '测试群', member_count: 5 },
      { group_id: 30002, group_name: '另一个测试群', member_count: 3 },
    ],
    members: members || {
      30001: { user_id: 10001, nickname: '测试群友', card: '', role: 'member' },
      30002: { user_id: 10001, nickname: '测试群友', card: '', role: 'member' },
    },
    /** get_msg 的可查消息：{ [messageId]: 完整消息对象 } */
    messages: Object.create(null),
    /** send_private_msg / send_group_msg 实际收到的内容 */
    sentMessages: [],
  }

  // ---- 鉴权 ---------------------------------------------------------------

  function normalizeAuthModes(value, fallback) {
    if (value === undefined || value === null) return [...fallback]
    const list = (Array.isArray(value) ? value : [value])
      .map((item) => String(item).toLowerCase())
      .filter((item) => AUTH_MODES.includes(item))
    return list.length ? list : [...fallback]
  }

  /** 依次检查三种 token 携带方式；token 为空时不校验。 */
  function checkToken(req, url, modes) {
    if (!token) return true
    const authorization = String(req.headers.authorization || '').trim()
    if (modes.includes('bearer') && authorization.toLowerCase().startsWith('bearer ')) {
      if (authorization.slice(7).trim() === String(token)) return true
    }
    if (modes.includes('header-token') && String(req.headers['x-access-token'] || '') === String(token)) {
      return true
    }
    if (modes.includes('query') && url.searchParams.get('access_token') === String(token)) {
      return true
    }
    return false
  }

  // ---- action 处理 --------------------------------------------------------

  function currentSelfId() {
    return String(state.selfId)
  }

  /** get_login_info 返回的 QQ 号：loginUserId 优先，否则 selfId。 */
  function loginUserId() {
    return String(state.loginUserId || state.selfId)
  }

  function delayFor(action) {
    const specific = Number(state.delays[action])
    if (Number.isFinite(specific) && specific > 0) return specific
    if (action === 'get_login_info') return Math.max(0, Number(state.loginDelayMs) || 0)
    return 0
  }

  function failureFor(action, params) {
    const raw = state.failures[action]
    if (!raw) return null
    try {
      const value = typeof raw === 'function' ? raw(params) : raw
      if (!value) return null
      if (typeof value === 'string') return { status: 'failed', retcode: 100, message: value }
      return { status: 'failed', retcode: toNumber(value.retcode, 100), message: value.message || 'mock 失败', ...value }
    } catch (error) {
      return { status: 'failed', retcode: 100, message: `mock 失败：${error.message}` }
    }
  }

  /** OneBot v11 action → data；未知 action 返回 null（和真实网关的「无事可做」保持一致）。 */
  function handleAction(action, params = {}) {
    switch (action) {
      case 'get_login_info':
        return { user_id: toNumber(loginUserId(), 0), nickname: state.nickname }
      case 'get_friend_list':
        return state.friends.map((item) => deepClone(item))
      case 'get_group_list':
        return state.groups.map((item) => deepClone(item))
      case 'get_group_member_info': {
        const groupId = String(params.group_id ?? '')
        const found = state.members[groupId] || {}
        return {
          group_id: toNumber(params.group_id, 0),
          user_id: toNumber(params.user_id, 0),
          nickname: '群成员',
          card: '',
          role: 'member',
          ...deepClone(found),
        }
      }
      case 'send_private_msg':
      case 'send_group_msg': {
        const messageId = ++msgSeq
        state.sentMessages.push({ action, params: deepClone(params), message_id: messageId, at: Date.now() })
        return { message_id: messageId }
      }
      case 'delete_msg':
        return null
      case 'get_msg': {
        const key = String(params.message_id ?? '')
        if (state.messages[key]) return deepClone(state.messages[key])
        return { message_id: toNumber(params.message_id, 0), message: [], sender: { user_id: 0 } }
      }
      default:
        return null
    }
  }

  // ---- 调用记录 / 事件推送 -------------------------------------------------

  function recordCall(entry) {
    calls.push(entry)
    for (const fn of callListeners) {
      try {
        fn(entry)
      } catch (error) {}
    }
  }

  function notifyConnections() {
    for (const fn of connectionListeners) {
      try {
        fn(connections.size)
      } catch (error) {}
    }
  }

  function sendJsonTo(connection, payload) {
    if (!connection || connection.socket.destroyed) return false
    try {
      connection.socket.write(encodeFrame(JSON.stringify(payload)))
      return true
    } catch (error) {
      return false
    }
  }

  /** 向所有已连接的 WS 客户端广播一条事件；返回送达的客户端数。 */
  function broadcast(event) {
    let sent = 0
    for (const connection of connections) {
      if (sendJsonTo(connection, event)) sent += 1
    }
    return sent
  }

  /**
   * 主动推一条原始 OneBot 事件（自动补 time / self_id）。
   * 没有 WS 客户端时也记录在 pushed 里，返回 0。
   */
  function pushEvent(raw) {
    const event = {
      time: Math.floor(Date.now() / 1000),
      self_id: toNumber(currentSelfId(), 0),
      ...(raw || {}),
    }
    const sentTo = broadcast(event)
    pushed.push({ seq: ++eventSeq, at: Date.now(), event, sentTo })
    return sentTo
  }

  function messageSegments(message) {
    if (Array.isArray(message)) return deepClone(message)
    return [{ type: 'text', data: { text: String(message ?? '') } }]
  }

  function rawMessageOf(message) {
    if (Array.isArray(message)) {
      return message
        .map((segment) => (segment && segment.type === 'text' ? String(segment.data?.text ?? '') : `[${segment?.type || 'unknown'}]`))
        .join('')
    }
    return String(message ?? '')
  }

  /** 推一条私聊消息事件（message_type=private）。 */
  function pushPrivateMessage({
    userId = 10001,
    nickname: userNickname = '测试用户',
    message = '',
    messageId,
    subType = 'friend',
    sender,
    ...rest
  } = {}) {
    const uid = toNumber(userId, 10001)
    return pushEvent({
      post_type: 'message',
      message_type: 'private',
      sub_type: subType,
      message_id: messageId === undefined ? ++msgSeq : messageId,
      user_id: uid,
      message: messageSegments(message),
      raw_message: rawMessageOf(message),
      font: 0,
      sender: { user_id: uid, nickname: userNickname, sex: 'unknown', age: 0, ...(sender || {}) },
      ...rest,
    })
  }

  /** 推一条群聊消息事件（message_type=group）。 */
  function pushGroupMessage({
    groupId = 30001,
    userId = 10001,
    nickname: userNickname = '测试群友',
    card = '',
    role = 'member',
    message = '',
    messageId,
    subType = 'normal',
    sender,
    ...rest
  } = {}) {
    const uid = toNumber(userId, 10001)
    return pushEvent({
      post_type: 'message',
      message_type: 'group',
      sub_type: subType,
      message_id: messageId === undefined ? ++msgSeq : messageId,
      group_id: toNumber(groupId, 30001),
      user_id: uid,
      message: messageSegments(message),
      raw_message: rawMessageOf(message),
      font: 0,
      sender: { user_id: uid, nickname: userNickname, card, role, ...(sender || {}) },
      ...rest,
    })
  }

  /** 推一条通知事件；例如 pushNotice({ noticeType: 'friend_recall', userId: 10001, messageId: 1 })。 */
  function pushNotice({ noticeType = 'friend_recall', notice_type, userId, user_id, groupId, group_id, messageId, message_id, ...rest } = {}) {
    return pushEvent({
      post_type: 'notice',
      notice_type: notice_type || noticeType,
      ...(userId !== undefined || user_id !== undefined ? { user_id: toNumber(userId ?? user_id, 0) } : {}),
      ...(groupId !== undefined || group_id !== undefined ? { group_id: toNumber(groupId ?? group_id, 0) } : {}),
      ...(messageId !== undefined || message_id !== undefined ? { message_id: toNumber(messageId ?? message_id, 0) } : {}),
      ...rest,
    })
  }

  /** 推一条请求事件（加好友 / 加群）。 */
  function pushRequest({ requestType = 'friend', request_type, userId, user_id, comment = '', flag = '', ...rest } = {}) {
    return pushEvent({
      post_type: 'request',
      request_type: request_type || requestType,
      ...(userId !== undefined || user_id !== undefined ? { user_id: toNumber(userId ?? user_id, 0) } : {}),
      ...(rest.groupId !== undefined || rest.group_id !== undefined ? { group_id: toNumber(rest.groupId ?? rest.group_id, 0) } : {}),
      comment,
      flag,
      ...rest,
    })
  }

  /** 推一条元事件；默认 heartbeat。 */
  function pushMetaEvent({ metaEventType = 'heartbeat', meta_event_type, subType, sub_type, ...rest } = {}) {
    return pushEvent({
      post_type: 'meta_event',
      meta_event_type: meta_event_type || metaEventType,
      ...(subType !== undefined || sub_type !== undefined ? { sub_type: subType ?? sub_type } : {}),
      ...(meta_event_type || metaEventType === 'heartbeat' ? { status: { online: true, good: true }, interval: 30000 } : {}),
      ...rest,
    })
  }

  function pushHeartbeat(extra = {}) {
    return pushEvent({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { online: true, good: true }, interval: 30000, ...extra })
  }

  function pushLifecycle(subType = 'connect', extra = {}) {
    return pushEvent({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: subType, ...extra })
  }

  function onCall(fn) {
    callListeners.add(fn)
    return () => callListeners.delete(fn)
  }

  function onConnection(fn) {
    connectionListeners.add(fn)
    return () => connectionListeners.delete(fn)
  }

  /** 等第一个 WS 客户端连上（e2e 里连上可能滞后几毫秒）。 */
  function waitForConnection({ timeoutMs = 5000 } = {}) {
    if (connections.size > 0) return Promise.resolve(connections.size)
    return new Promise((resolve, reject) => {
      const off = onConnection((count) => {
        if (count <= 0) return
        clearTimeout(timer)
        off()
        resolve(count)
      })
      const timer = setTimeout(() => {
        off()
        reject(new Error('mock-onebot：等待 WS 连接超时'))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
  }

  /** 等一条新的 action 调用（默认从现有 calls 里找）。 */
  function waitForCall(action, { timeoutMs = 5000, predicate, since = 0 } = {}) {
    const match = (call) => call.action === action && (!predicate || predicate(call))
    for (let i = since; i < calls.length; i += 1) {
      if (match(calls[i])) return Promise.resolve(calls[i])
    }
    return new Promise((resolve, reject) => {
      const off = onCall((call) => {
        if (!match(call)) return
        clearTimeout(timer)
        off()
        resolve(call)
      })
      const timer = setTimeout(() => {
        off()
        reject(new Error(`mock-onebot：等待 action ${action} 超时`))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
  }

  function sent(action) {
    return action ? calls.filter((call) => call.action === action) : [...calls]
  }

  function clearCalls() {
    calls.length = 0
    pushed.length = 0
  }

  // ---- WS 连接处理 ---------------------------------------------------------

  function attachSocket(socket) {
    const connection = { socket, buffer: Buffer.alloc(0), fragments: [] }
    connections.add(connection)
    notifyConnections()

    socket.on('data', (chunk) => handleSocketData(connection, chunk))
    socket.on('close', () => {
      connections.delete(connection)
      notifyConnections()
    })
    socket.on('error', () => {
      connections.delete(connection)
      notifyConnections()
      try {
        socket.destroy()
      } catch (error) {}
    })
  }

  function handleSocketData(connection, chunk) {
    connection.buffer = Buffer.concat([connection.buffer, chunk])
    const { frames, rest } = decodeFrames(connection.buffer)
    connection.buffer = rest
    for (const frame of frames) {
      if (frame.opcode === 0x8) {
        // 客户端主动关闭：回一个 close 帧再断开
        try {
          connection.socket.write(encodeFrame(frame.payload, 0x8))
        } catch (error) {}
        connection.socket.end()
        return
      }
      if (frame.opcode === 0x9) {
        try {
          connection.socket.write(encodeFrame(frame.payload, 0xa))
        } catch (error) {}
        continue
      }
      if (frame.opcode === 0xa) continue
      if (frame.opcode !== 0x0 && frame.opcode !== 0x1 && frame.opcode !== 0x2) continue
      connection.fragments.push(frame.payload)
      if (!frame.fin) continue
      const text = Buffer.concat(connection.fragments).toString('utf8')
      connection.fragments = []
      let message
      try {
        message = JSON.parse(text)
      } catch (error) {
        continue
      }
      void handleWsAction(connection, message)
    }
  }

  async function handleWsAction(connection, message) {
    if (!message || typeof message !== 'object') return
    const action = String(message.action || '').trim()
    if (!action) return
    const params = message.params && typeof message.params === 'object' ? message.params : {}
    const echo = message.echo
    recordCall({ action, params: deepClone(params), transport: 'ws', echo, t: Date.now() })
    if (state.autoReply === false) return

    const delay = delayFor(action)
    if (delay > 0) await sleep(delay)
    const failure = failureFor(action, params)
    if (failure) {
      sendJsonTo(connection, { ...failure, data: null, echo })
      return
    }
    let data
    try {
      data = handleAction(action, params)
    } catch (error) {
      sendJsonTo(connection, { status: 'failed', retcode: 100, message: error.message, data: null, echo })
      return
    }
    sendJsonTo(connection, { status: 'ok', retcode: 0, data: clean(data), echo })
  }

  // ---- HTTP 服务 -----------------------------------------------------------

  function sendHttp(res, status, body) {
    try {
      const text = JSON.stringify(body)
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(text)
    } catch (error) {
      try {
        res.destroy()
      } catch (inner) {}
    }
  }

  async function readJsonBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_HTTP_BODY) throw new Error('请求体过大')
      chunks.push(buffer)
    }
    const text = Buffer.concat(chunks).toString('utf8').trim()
    if (!text) return {}
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed
  }

  /** _mock 控制端点：供人工联调脚本 / verify-plugin.ps1 推事件、看调用。 */
  async function handleMockControl(req, res, path, url) {
    if (req.method === 'GET' && (path === '/_mock/state' || path === '/_mock')) {
      return sendHttp(res, 200, {
        ok: true,
        selfId: currentSelfId(),
        nickname: state.nickname,
        connected: connections.size,
        calls: calls.length,
        pushed: pushed.length,
        loginUserId: loginUserId(),
        delays: { ...state.delays, get_login_info: state.loginDelayMs || undefined },
        failures: Object.keys(state.failures),
        httpUrl,
        wsUrl,
        httpUrlWithToken: httpUrl,
        wsUrlWithToken: withToken(wsUrl),
      })
    }
    if (req.method === 'GET' && path === '/_mock/calls') {
      return sendHttp(res, 200, { ok: true, calls: deepClone(calls) })
    }
    if (req.method === 'POST' && path === '/_mock/clear') {
      clearCalls()
      return sendHttp(res, 200, { ok: true })
    }
    if (req.method === 'POST' && path === '/_mock/config') {
      // 只允许改状态字段，不能替换函数/整个对象
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        return sendHttp(res, 400, { ok: false, message: error.message })
      }
      if (body.nickname !== undefined) state.nickname = String(body.nickname)
      if (body.loginUserId !== undefined) state.loginUserId = String(body.loginUserId)
      if (body.loginDelayMs !== undefined) state.loginDelayMs = Math.max(0, Number(body.loginDelayMs) || 0)
      if (body.autoReply !== undefined) state.autoReply = Boolean(body.autoReply)
      if (body.delays && typeof body.delays === 'object') {
        for (const [key, value] of Object.entries(body.delays)) {
          const delay = Math.max(0, Number(value) || 0)
          if (delay > 0) state.delays[key] = delay
          else delete state.delays[key]
        }
      }
      if (body.failures && typeof body.failures === 'object') {
        for (const [key, value] of Object.entries(body.failures)) {
          if (value === null || value === false) delete state.failures[key]
          else state.failures[key] = value
        }
      }
      return sendHttp(res, 200, { ok: true })
    }
    if (req.method === 'POST' && path === '/_mock/push') {
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        return sendHttp(res, 400, { ok: false, message: error.message })
      }
      const payload = body.event && typeof body.event === 'object' ? body.event : body
      let sentTo = 0
      if (payload && typeof payload === 'object' && payload.post_type) {
        sentTo = pushEvent(payload)
      } else if (payload && payload.type === 'private') {
        sentTo = pushPrivateMessage({
          userId: payload.userId ?? payload.user_id,
          nickname: payload.nickname,
          message: payload.message ?? payload.text ?? '',
        })
      } else if (payload && payload.type === 'group') {
        sentTo = pushGroupMessage({
          groupId: payload.groupId ?? payload.group_id,
          userId: payload.userId ?? payload.user_id,
          nickname: payload.nickname,
          message: payload.message ?? payload.text ?? '',
        })
      } else if (payload && payload.type === 'notice') {
        sentTo = pushNotice(payload)
      } else if (payload && payload.type === 'heartbeat') {
        sentTo = pushHeartbeat()
      } else {
        return sendHttp(res, 400, { ok: false, message: '无法识别的事件；请传 OneBot 原始事件或 { type: private|group|notice|heartbeat }' })
      }
      return sendHttp(res, 200, { ok: true, sent: sentTo })
    }
    return sendHttp(res, 404, { ok: false, message: `未知的 mock 控制端点：${req.method} ${url.pathname}` })
  }

  const server = http.createServer(async (req, res) => {
    let url
    try {
      url = new URL(req.url || '/', 'http://mock.local')
    } catch (error) {
      return sendHttp(res, 400, { status: 'failed', retcode: 1400, message: '非法 URL' })
    }
    try {
      // 人工联调用的控制端点（不需要 OneBot token）
      if (url.pathname.startsWith('/_mock')) return await handleMockControl(req, res, url.pathname, url)
      if (req.method === 'GET' && url.pathname === '/') {
        return sendHttp(res, 200, {
          ok: true,
          app: 'dsh-onebot-qq mock OneBot v11 gateway',
          selfId: currentSelfId(),
          nickname: state.nickname,
          connected: connections.size,
          calls: calls.length,
          httpUrl,
          wsUrl,
          tokenRequired: Boolean(token),
        })
      }
      if (req.method !== 'POST') {
        return sendHttp(res, 405, { status: 'failed', retcode: 1404, message: '只支持 POST /:action' })
      }
      if (!checkToken(req, url, httpAuthModes)) {
        return sendHttp(res, 401, { status: 'failed', retcode: 1403, message: 'token 校验失败（HTTP）' })
      }
      const action = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      if (!action) return sendHttp(res, 400, { status: 'failed', retcode: 1400, message: '缺少 action' })
      let params
      try {
        params = await readJsonBody(req)
      } catch (error) {
        return sendHttp(res, 400, { status: 'failed', retcode: 1400, message: error.message })
      }
      recordCall({ action, params: deepClone(params), transport: 'http', t: Date.now() })
      const delay = delayFor(action)
      if (delay > 0) await sleep(delay)
      const failure = failureFor(action, params)
      if (failure) return sendHttp(res, 200, { ...failure, data: null })
      let data
      try {
        data = handleAction(action, params)
      } catch (error) {
        return sendHttp(res, 200, { status: 'failed', retcode: 100, message: error.message, data: null })
      }
      return sendHttp(res, 200, { status: 'ok', retcode: 0, data: clean(data) })
    } catch (error) {
      return sendHttp(res, 500, { status: 'failed', retcode: 1500, message: error.message || String(error) })
    }
  })

  server.on('upgrade', (req, socket) => {
    let url
    try {
      url = new URL(req.url || '/', 'http://mock.local')
    } catch (error) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      return
    }
    if (!checkToken(req, url, wsAllowedModes)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      return
    }
    const key = req.headers['sec-websocket-key']
    if (!key) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      return
    }
    try {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${wsAccept(String(key))}\r\n\r\n`,
      )
    } catch (error) {
      socket.destroy()
      return
    }
    socket.setNoDelay?.(true)
    attachSocket(socket)
  })

  // ---- 启动 / 关闭 ---------------------------------------------------------

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(Number(port) || 0, host)
  })

  const actualPort = server.address().port
  httpUrl = `http://${host}:${actualPort}`
  wsUrl = `ws://${host}:${actualPort}`

  function withToken(base) {
    if (!token) return base
    return `${base}?access_token=${encodeURIComponent(String(token))}`
  }

  async function close() {
    if (closed) return
    closed = true
    for (const connection of connections) {
      try {
        connection.socket.destroy()
      } catch (error) {}
    }
    connections.clear()
    notifyConnections()
    await new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve()
      }
      try {
        server.close(finish)
        // 关掉 fetch keep-alive 留下的空闲连接，否则 server.close 会一直等（Node 19+ 有这两个方法）
        server.closeIdleConnections?.()
        server.closeAllConnections?.()
      } catch (error) {
        finish()
      }
      const timer = setTimeout(finish, 2000)
      if (typeof timer.unref === 'function') timer.unref()
    })
  }

  return {
    port: actualPort,
    host,
    httpUrl,
    wsUrl,
    /** 带上 token 的地址，方便人工/脚本直接连 */
    httpUrlWithToken: httpUrl,
    wsUrlWithToken: withToken(wsUrl),
    token,
    selfId: currentSelfId(),
    state,
    calls,
    pushed,
    /** 当前 WS 客户端数 */
    connected: () => connections.size,
    /** 已收到的全部（或指定 action 的）调用 */
    sent,
    clearCalls,
    onCall,
    onConnection,
    waitForConnection,
    waitForCall,
    pushEvent,
    pushPrivateMessage,
    pushGroupMessage,
    pushNotice,
    pushRequest,
    pushMetaEvent,
    pushHeartbeat,
    pushLifecycle,
    close,
  }
}
