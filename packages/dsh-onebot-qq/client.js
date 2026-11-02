// dsh-onebot-qq · 网页半边（浏览器端，单文件）
//
// 侧栏「QQ 连接」入口 + 整页面板（概览 / 连接 / 消息 / 配置 / 日志 / 关于）。
// 只读写宿主半边的 /onebot-qq/api/* 接口；所有配置项（含默认值、范围、选项）全部来自
// GET /config 的 groups 字段表，客户端不写死任何默认值。
//
// 视觉：只使用 DSH 主题语义 token（--dsw-alias-* / --dsw-radius-* / --dsw-font-*），
// 浅色/深色跟随主题；字重 ≤500；不引入 UI 库、不用 JSX。
//
// 结构：纯函数（可测试）→ 样式 → 基础控件 → 六个标签页 → 根组件 → apply 注册。

window.__ModuleLoader__.load({
  id: 'dsh-onebot-qq',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react') || {}
    const { useState, useEffect, useRef, useCallback, useMemo, Fragment } = React
    const h = React.createElement

    const inject = ['slots']
    const PANEL_ID = 'onebot-qq'
    const API = '/onebot-qq/api'
    const STYLE_ID = 'dsh-onebot-qq-panel-style'
    const REFRESH_MIN = 500
    const REFRESH_MAX = 60000
    const LOG_LEVELS = ['debug', 'info', 'warn', 'error']
    const EVENT_KINDS = ['message', 'notice', 'request', 'meta_event', 'unknown']

    // =====================================================================
    // 纯函数区（挂到 module.exports，便于 node:test 直接断言）
    // =====================================================================

    function clone(value) {
      if (value === undefined) return undefined
      try {
        return JSON.parse(JSON.stringify(value))
      } catch (error) {
        return value
      }
    }

    function isPlainObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    }

    function safeArray(value) {
      return Array.isArray(value) ? value : []
    }

    function safeObject(value) {
      return isPlainObject(value) ? value : {}
    }

    /** 深比较：对象/数组递归；其余用 ===（NaN 视作相等）。 */
    function deepEqual(a, b) {
      if (a === b) return true
      if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return true
      if (a == null || b == null) return a == null && b == null
      if (typeof a !== 'object' || typeof b !== 'object') return false
      const aIsArray = Array.isArray(a)
      const bIsArray = Array.isArray(b)
      if (aIsArray !== bIsArray) return false
      if (aIsArray) {
        if (a.length !== b.length) return false
        for (let i = 0; i < a.length; i += 1) if (!deepEqual(a[i], b[i])) return false
        return true
      }
      const aKeys = Object.keys(a)
      const bKeys = Object.keys(b)
      if (aKeys.length !== bKeys.length) return false
      for (const key of aKeys) {
        if (!Object.prototype.hasOwnProperty.call(b, key)) return false
        if (!deepEqual(a[key], b[key])) return false
      }
      return true
    }

    function getByPath(obj, path) {
      const keys = String(path == null ? '' : path).split('.')
      let cur = obj
      for (const key of keys) {
        if (cur == null) return undefined
        cur = cur[key]
      }
      return cur
    }

    /** 纯函数写路径：返回新对象，不修改入参。 */
    function setByPath(obj, path, value) {
      const root = clone(isPlainObject(obj) ? obj : {})
      const keys = String(path == null ? '' : path).split('.').filter((key) => key !== '')
      if (!keys.length) return root
      let cur = root
      for (let i = 0; i < keys.length - 1; i += 1) {
        const key = keys[i]
        if (!isPlainObject(cur[key])) cur[key] = {}
        cur = cur[key]
      }
      cur[keys[keys.length - 1]] = value
      return root
    }

    function clampNumber(value, min, max, fallback) {
      const n = Number(value)
      if (!Number.isFinite(n)) return fallback
      const lo = Number.isFinite(Number(min)) ? Number(min) : -Infinity
      const hi = Number.isFinite(Number(max)) ? Number(max) : Infinity
      return Math.min(hi, Math.max(lo, n))
    }

    function pad2(n) {
      return String(n).padStart(2, '0')
    }

    function toDate(value) {
      if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        // OneBot 事件的 time 是 Unix 秒；宿主内部时间戳是毫秒。小于 1e12 的按秒处理。
        const d = new Date(value < 1e12 ? value * 1000 : value)
        return Number.isNaN(d.getTime()) ? null : d
      }
      if (typeof value === 'string' && value.trim()) {
        const d = new Date(value)
        return Number.isNaN(d.getTime()) ? null : d
      }
      return null
    }

    function formatTime(value) {
      const d = toDate(value)
      if (!d) return '—'
      return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
    }

    function formatDateTime(value) {
      const d = toDate(value)
      if (!d) return '—'
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + formatTime(d)
    }

    function formatDuration(ms) {
      const n = Number(ms)
      if (!Number.isFinite(n) || n < 0) return '—'
      if (n < 1000) return Math.round(n) + ' 毫秒'
      const totalSeconds = Math.floor(n / 1000)
      if (totalSeconds < 60) return totalSeconds + ' 秒'
      const totalMinutes = Math.floor(totalSeconds / 60)
      if (totalMinutes < 60) return totalMinutes + ' 分 ' + (totalSeconds % 60) + ' 秒'
      const totalHours = Math.floor(totalMinutes / 60)
      if (totalHours < 24) return totalHours + ' 小时 ' + (totalMinutes % 60) + ' 分'
      return Math.floor(totalHours / 24) + ' 天 ' + (totalHours % 24) + ' 小时'
    }

    function formatRelative(value, now) {
      const d = toDate(value)
      if (!d) return '—'
      const base = Number.isFinite(Number(now)) ? Number(now) : Date.now()
      const diff = base - d.getTime()
      if (diff < 0) return '刚刚'
      if (diff < 60000) return '刚刚'
      if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前'
      if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前'
      if (diff < 30 * 86400000) return Math.floor(diff / 86400000) + ' 天前'
      return formatDateTime(d)
    }

    function truncateText(text, max) {
      const value = String(text == null ? '' : text)
      const limit = Number.isFinite(Number(max)) ? Number(max) : 200
      if (value.length <= limit) return value
      return value.slice(0, Math.max(1, limit - 1)) + '…'
    }

    /** 端点脱敏：去掉账号密码与 token 类查询参数的值。 */
    function maskEndpoint(value) {
      const raw = String(value == null ? '' : value).trim()
      if (!raw) return ''
      let url = null
      try {
        url = new URL(raw)
      } catch (error) {
        url = null
      }
      if (!url) return raw.replace(/([?&](?:access_token|token|key|secret|password)=)[^&#]*/gi, '$1***')
      const path = url.pathname && url.pathname !== '/' ? url.pathname : ''
      const query = []
      url.searchParams.forEach((paramValue, key) => {
        query.push(key + '=' + (/(token|key|secret|password|auth)/i.test(key) ? '***' : paramValue))
      })
      return url.protocol + '//' + url.host + path + (query.length ? '?' + query.join('&') : '')
    }

    function buildQuery(params) {
      const source = isPlainObject(params) ? params : {}
      const parts = []
      Object.keys(source).forEach((key) => {
        const value = source[key]
        if (value === undefined || value === null || value === '') return
        parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)))
      })
      return parts.length ? '?' + parts.join('&') : ''
    }

    function formatApiError(payload, fallback) {
      const source = safeObject(payload)
      const message = source.message == null ? '' : String(source.message).trim()
      if (message) return message
      return fallback || '操作失败'
    }

    /** 统一处理宿主 { ok:false, message } 与网络错误。 */
    function parseApiResponse(payload) {
      if (payload == null) return { ok: false, message: '没有收到插件响应', data: null }
      if (typeof payload !== 'object') return { ok: false, message: '插件返回了无法识别的内容', data: null }
      if (payload.ok === false) return { ok: false, message: formatApiError(payload, '操作失败'), data: null }
      return { ok: true, message: payload.message == null ? '' : String(payload.message), data: payload }
    }

    /** POST /config/save 与 /config/reset 的返回形状。 */
    function mergeConfigSave(payload) {
      const parsed = parseApiResponse(payload)
      if (!parsed.ok) return { ok: false, config: null, issues: [], message: parsed.message }
      const data = safeObject(parsed.data)
      const config = isPlainObject(data.config) ? data.config : null
      const issues = safeArray(data.issues).map((item) => String(item)).filter(Boolean)
      return { ok: true, config, issues, message: parsed.message }
    }

    const FIELD_TYPES = ['switch', 'text', 'secret', 'number', 'select', 'string-list', 'number-list', 'textarea']

    function normalizeFieldSpec(field) {
      if (!isPlainObject(field)) return null
      const path = typeof field.path === 'string' ? field.path.trim() : ''
      if (!path) return null
      const type = FIELD_TYPES.indexOf(field.type) >= 0 ? field.type : 'text'
      const spec = {
        path,
        type,
        label: typeof field.label === 'string' && field.label.trim() ? field.label : path,
      }
      if (Object.prototype.hasOwnProperty.call(field, 'default')) spec.default = clone(field.default)
      if (field.help != null && String(field.help).trim()) spec.help = String(field.help)
      if (field.placeholder != null && String(field.placeholder).trim()) spec.placeholder = String(field.placeholder)
      if (field.unit != null && String(field.unit).trim()) spec.unit = String(field.unit)
      if (type === 'number') {
        if (Number.isFinite(Number(field.min))) spec.min = Number(field.min)
        if (Number.isFinite(Number(field.max))) spec.max = Number(field.max)
        if (Number.isFinite(Number(field.step))) spec.step = Number(field.step)
      }
      if (type === 'select') {
        spec.options = safeArray(field.options)
          .filter((option) => isPlainObject(option) && option.value !== undefined)
          .map((option) => ({
            value: String(option.value),
            label: option.label != null ? String(option.label) : String(option.value),
          }))
      }
      return spec
    }

    /** groups（服务端字段表）→ 可渲染的规格；非法字段降级或跳过。 */
    function buildFieldSpecs(groups) {
      if (!Array.isArray(groups)) return []
      const out = []
      groups.forEach((group, index) => {
        if (!isPlainObject(group)) return
        const fields = safeArray(group.fields).map(normalizeFieldSpec).filter(Boolean)
        if (!fields.length) return
        out.push({
          id: typeof group.id === 'string' && group.id ? group.id : 'group-' + index,
          title: typeof group.title === 'string' && group.title ? group.title : '配置',
          description: typeof group.description === 'string' ? group.description : '',
          fields,
        })
      })
      return out
    }

    function flattenFieldSpecs(groups) {
      return buildFieldSpecs(groups).reduce((acc, group) => acc.concat(group.fields), [])
    }

    function fieldSpecByPath(groups, path) {
      const target = String(path == null ? '' : path)
      return flattenFieldSpecs(groups).find((field) => field.path === target) || null
    }

    function defaultsFromGroups(groups) {
      let out = {}
      flattenFieldSpecs(groups).forEach((field) => {
        if (!Object.prototype.hasOwnProperty.call(field, 'default')) return
        out = setByPath(out, field.path, clone(field.default))
      })
      return out
    }

    /** 刷新间隔：优先 config.ui.refreshMs，缺省时取服务端字段表 default，最后才用兜底值。 */
    function computeRefreshMs(config, groups, fallbackMs) {
      const fallback = Number.isFinite(Number(fallbackMs)) ? Number(fallbackMs) : 2000
      let raw = getByPath(isPlainObject(config) ? config : {}, 'ui.refreshMs')
      if (raw === undefined || raw === null || raw === '') {
        const spec = fieldSpecByPath(groups, 'ui.refreshMs')
        raw = spec && Object.prototype.hasOwnProperty.call(spec, 'default') ? spec.default : undefined
      }
      const value = Number(raw)
      if (!Number.isFinite(value)) return fallback
      return clampNumber(value, REFRESH_MIN, REFRESH_MAX, fallback)
    }

    const STATE_LABELS = {
      connected: { text: '已连接', tone: 'ok' },
      connecting: { text: '连接中', tone: 'warn' },
      disconnected: { text: '已断开', tone: 'err' },
      stopped: { text: '已停止', tone: 'dim' },
      unconfigured: { text: '未配置', tone: 'warn' },
      paused: { text: '已暂停', tone: 'err' },
    }

    function stateLabel(state) {
      const key = String(state == null ? '' : state)
      return STATE_LABELS[key] || { text: key || '未知', tone: 'dim' }
    }

    function loginCheckLabel(check) {
      switch (String(check == null ? '' : check)) {
        case 'ok':
          return { text: '核验通过', tone: 'ok' }
        case 'mismatch':
          return { text: '账号不一致', tone: 'err' }
        case 'error':
          return { text: '核验失败', tone: 'err' }
        case 'pending':
          return { text: '等待核验', tone: 'warn' }
        case 'off':
          return { text: '未开启核验', tone: 'dim' }
        default:
          return { text: '未知', tone: 'dim' }
      }
    }

    function endpointModeLabel(mode) {
      return mode === 'snowluma' ? '从 SnowLuma 读取' : mode === 'onebot' ? 'OneBot 地址' : '未设置'
    }

    function accountCheckLabel(value) {
      if (value === 'enforce') return '断开并暂停自动重连'
      if (value === 'off') return '不检查'
      if (value === 'warn') return '只警告'
      return String(value == null ? '' : value) || '—'
    }

    function eventKindLabel(kind) {
      switch (String(kind == null ? '' : kind)) {
        case 'message':
          return '消息'
        case 'notice':
          return '通知'
        case 'request':
          return '请求'
        case 'meta_event':
          return '元事件'
        case 'unknown':
          return '未知'
        default:
          return String(kind == null ? '' : kind) || '未知'
      }
    }

    function segmentText(segment) {
      if (!isPlainObject(segment)) return ''
      const data = isPlainObject(segment.data) ? segment.data : segment
      if (segment.type === 'text' || (data.text !== undefined && segment.type !== 'image')) {
        return String(data.text == null ? '' : data.text)
      }
      if (segment.type === 'at') return '@' + String(data.qq || data.name || '')
      if (segment.type === 'image') return '[图片]'
      if (segment.type === 'face') return '[表情]'
      if (segment.type === 'record') return '[语音]'
      if (segment.type === 'video') return '[视频]'
      if (segment.type === 'file') return '[文件]'
      if (segment.type === 'reply') return ''
      return segment.type ? '[' + String(segment.type) + ']' : ''
    }

    function noticeSummary(notice) {
      const source = safeObject(notice)
      const parts = []
      if (source.type) parts.push(String(source.type))
      if (source.subType) parts.push(String(source.subType))
      if (source.groupId) parts.push('群 ' + String(source.groupId))
      if (source.userId) parts.push('用户 ' + String(source.userId))
      if (source.targetId) parts.push('目标 ' + String(source.targetId))
      return parts.length ? '[通知] ' + parts.join(' · ') : '[通知]'
    }

    function requestSummary(request) {
      const source = safeObject(request)
      const parts = []
      if (source.type) parts.push(String(source.type))
      if (source.subType) parts.push(String(source.subType))
      if (source.groupId) parts.push('群 ' + String(source.groupId))
      if (source.userId) parts.push('用户 ' + String(source.userId))
      if (source.comment) parts.push(String(source.comment))
      return parts.length ? '[请求] ' + parts.join(' · ') : '[请求]'
    }

    function metaSummary(meta) {
      const source = safeObject(meta)
      const parts = []
      if (source.type) parts.push(String(source.type))
      if (source.subType) parts.push(String(source.subType))
      return parts.length ? '[元事件] ' + parts.join(' · ') : '[元事件]'
    }

    /** 规范化事件 → 展示用结构（不伪造字段，缺什么就留空）。 */
    function describeEvent(event) {
      const source = safeObject(event)
      const kind = typeof source.kind === 'string' && source.kind ? source.kind : 'unknown'
      const message = isPlainObject(source.message) ? source.message : null
      const notice = isPlainObject(source.notice) ? source.notice : null
      const request = isPlainObject(source.request) ? source.request : null
      const meta = isPlainObject(source.meta) ? source.meta : null
      const sender = message && isPlainObject(message.sender) ? message.sender : null
      const segments = message ? safeArray(message.segments) : []
      const mentions = message ? safeArray(message.mentions) : []
      const images = message ? safeArray(message.images) : []
      let chatType = ''
      let chatId = ''
      if (message) {
        chatType = message.chatType === 'group' ? 'group' : message.chatType === 'private' ? 'private' : ''
        chatId = String(message.chatId == null ? '' : message.chatId)
      } else if (notice && notice.groupId) {
        chatType = 'group'
        chatId = String(notice.groupId)
      }
      let text = ''
      if (message && typeof message.text === 'string') text = message.text
      if (!text && segments.length) text = segments.map(segmentText).filter(Boolean).join('')
      let summary = ''
      if (kind === 'message') summary = text || (images.length ? '[图片 × ' + images.length + ']' : '')
      else if (kind === 'notice') summary = noticeSummary(notice)
      else if (kind === 'request') summary = requestSummary(request)
      else if (kind === 'meta_event') summary = metaSummary(meta)
      else summary = text || eventKindLabel(kind)
      return {
        seq: Number.isFinite(Number(source.seq)) ? Number(source.seq) : undefined,
        time: formatTime(source.time != null ? source.time : source.receivedAt),
        kind,
        kindLabel: eventKindLabel(kind),
        chatType,
        chatId,
        chatLabel: chatType === 'group' ? '群 ' + (chatId || '?') : chatType === 'private' ? '私聊 ' + (chatId || '?') : '',
        senderName: sender ? String(sender.nickname || sender.card || sender.userId || '') : '',
        segments,
        mentions,
        images,
        summary: truncateText(summary, 240),
        fullText: String(summary || ''),
      }
    }

    function normalizeFriend(item) {
      const source = safeObject(item)
      const id = String(source.user_id != null ? source.user_id : source.userId != null ? source.userId : '')
      return {
        id,
        name: String(source.remark || source.nickname || source.card || id || ''),
        nickname: String(source.nickname || ''),
        remark: String(source.remark || ''),
      }
    }

    function normalizeGroup(item) {
      const source = safeObject(item)
      const id = String(source.group_id != null ? source.group_id : source.groupId != null ? source.groupId : '')
      const memberCount = Number(source.member_count != null ? source.member_count : source.memberCount)
      return {
        id,
        name: String(source.group_name || source.groupName || id || ''),
        memberCount: Number.isFinite(memberCount) ? memberCount : null,
      }
    }

    function normalizeLogEntry(entry) {
      const source = safeObject(entry)
      const level = LOG_LEVELS.indexOf(source.level) >= 0 ? source.level : 'info'
      return {
        seq: Number.isFinite(Number(source.seq)) ? Number(source.seq) : undefined,
        time: source.time != null && String(source.time).trim() ? String(source.time) : formatTime(source.t),
        level,
        area: source.area == null ? '' : String(source.area),
        text: source.text == null ? '' : String(source.text),
      }
    }

    /** 增量合并：按 seq 去重并升序（宿主 /events、/logs 都带自增 seq）。 */
    function mergeIncremental(previous, incoming) {
      const map = new Map()
      safeArray(previous).forEach((item) => {
        if (isPlainObject(item) && Number.isFinite(Number(item.seq))) map.set(Number(item.seq), item)
      })
      safeArray(incoming).forEach((item) => {
        if (isPlainObject(item) && Number.isFinite(Number(item.seq))) map.set(Number(item.seq), item)
      })
      return Array.from(map.values()).sort((a, b) => Number(a.seq) - Number(b.seq))
    }

    function nextSince(items, fallback) {
      const base = Number.isFinite(Number(fallback)) ? Number(fallback) : 0
      if (!Array.isArray(items) || !items.length) return base
      return items.reduce((max, item) => {
        const n = Number(item && item.seq)
        return Number.isFinite(n) && n > max ? n : max
      }, base)
    }

    /** 探测时把当前草稿里的端点一起带上；宿主不认识就按已保存配置探测。 */
    function probeEndpointFromDraft(draft) {
      const source = safeObject(draft)
      const onebot = safeObject(source.onebot)
      return {
        mode: source.gateway === 'snowluma' ? 'snowluma' : 'onebot',
        wsUrl: onebot.wsUrl == null ? '' : String(onebot.wsUrl),
        httpUrl: onebot.httpUrl == null ? '' : String(onebot.httpUrl),
        wsToken: onebot.wsToken == null ? '' : String(onebot.wsToken),
        httpToken: onebot.httpToken == null ? '' : String(onebot.httpToken),
        httpAuth: onebot.httpAuth == null ? '' : String(onebot.httpAuth),
      }
    }

    /** POST /probe 返回 → 展示结构（兼容 endpointHint / url 两种字段）。 */
    function describeProbe(payload) {
      const parsed = parseApiResponse(payload)
      if (!parsed.ok) {
        return { ok: false, message: parsed.message, error: parsed.message, endpointHint: '', login: null, httpStatus: 0, elapsedMs: 0 }
      }
      const probe = isPlainObject(parsed.data.probe) ? parsed.data.probe : {}
      const login = isPlainObject(probe.login)
        ? { userId: String(probe.login.userId == null ? '' : probe.login.userId), nickname: String(probe.login.nickname == null ? '' : probe.login.nickname) }
        : null
      const failed = probe.ok === false || Boolean(probe.error)
      return {
        ok: !failed,
        message: parsed.message,
        error: failed ? String(probe.error || probe.message || '探测失败') : '',
        endpointHint: String(probe.endpointHint || probe.url || ''),
        login,
        httpStatus: Number.isFinite(Number(probe.httpStatus)) ? Number(probe.httpStatus) : 0,
        elapsedMs: Number.isFinite(Number(probe.elapsedMs)) ? Number(probe.elapsedMs) : 0,
      }
    }

    /** GET /gateway/detect 返回 → 展示结构（端点可能是脱敏后的 safeUrl）。 */
    function describeDetect(payload) {
      const parsed = parseApiResponse(payload)
      if (!parsed.ok) return { ok: false, message: parsed.message, reason: '', snowluma: null, endpoint: null }
      const data = safeObject(parsed.data)
      const snowluma = isPlainObject(data.snowluma) ? data.snowluma : null
      const endpoint = isPlainObject(data.endpoint) ? data.endpoint : null
      const endpointFound = Boolean(
        (snowluma && snowluma.endpointFound) || (endpoint && (endpoint.wsConfigured || endpoint.httpConfigured)),
      )
      return {
        ok: true,
        message: parsed.message,
        reason: data.reason == null ? '' : String(data.reason),
        snowluma: snowluma
          ? {
              installed: Boolean(snowluma.installed),
              dir: snowluma.dir == null ? '' : String(snowluma.dir),
              version: snowluma.version == null ? '' : String(snowluma.version),
              endpointFound,
              error: snowluma.error != null ? String(snowluma.error) : snowluma.reason != null ? String(snowluma.reason) : '',
            }
          : null,
        endpoint: endpoint
          ? {
              httpUrl: endpoint.httpUrl != null ? String(endpoint.httpUrl) : endpoint.httpUrlSafe != null ? String(endpoint.httpUrlSafe) : '',
              wsUrl: endpoint.wsUrl != null ? String(endpoint.wsUrl) : endpoint.wsUrlSafe != null ? String(endpoint.wsUrlSafe) : '',
              httpConfigured: Boolean(endpoint.httpConfigured),
              wsConfigured: Boolean(endpoint.wsConfigured),
              source: endpoint.source != null ? String(endpoint.source) : data.source != null ? String(data.source) : '',
            }
          : null,
      }
    }

    // =====================================================================
    // 网络（统一 /onebot-qq/api 前缀与错误形状）
    // =====================================================================

    async function request(path, options) {
      const opts = options || {}
      const init = { method: opts.method || 'GET', cache: 'no-store', headers: {} }
      if (opts.body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(opts.body)
      }
      try {
        const response = await fetch(API + path, init)
        let payload = null
        try {
          payload = await response.json()
        } catch (error) {
          payload = null
        }
        if (!response.ok && !isPlainObject(payload)) {
          return { ok: false, message: '插件接口返回 HTTP ' + response.status }
        }
        return payload
      } catch (error) {
        const reason = error && error.message ? error.message : String(error)
        return { ok: false, message: '连不上插件：' + reason }
      }
    }

    const get = (path) => request(path)
    const post = (path, body) => request(path, { method: 'POST', body: body === undefined ? {} : body })

    function pageHidden() {
      return typeof document !== 'undefined' && document.visibilityState === 'hidden'
    }

    // =====================================================================
    // 样式（只注入一次；apply 里用 ctx.effect 清理，SSR/测试环境自动跳过）
    // =====================================================================

    const PANEL_CSS = `
.ob-root{
  --ob-bg:var(--dsw-alias-bg-base);
  --ob-card:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1));
  --ob-card-2:var(--dsw-alias-bg-layer-2);
  --ob-card-3:var(--dsw-alias-bg-layer-3);
  --ob-text:var(--dsw-alias-label-primary);
  --ob-sub:var(--dsw-alias-label-secondary);
  --ob-dim:var(--dsw-alias-label-tertiary);
  --ob-line:var(--dsw-alias-border-l3);
  --ob-line-soft:var(--dsw-alias-border-l2);
  --ob-hover:var(--dsw-alias-interactive-bg-hover);
  --ob-brand:var(--dsw-alias-brand-primary);
  --ob-ok:var(--dsw-alias-state-success-primary);
  --ob-warn:var(--dsw-alias-state-warn-primary);
  --ob-err:var(--dsw-alias-state-error-primary);
  --ob-ok-bg:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);
  --ob-warn-bg:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);
  --ob-err-bg:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);
  --ob-ring:color-mix(in srgb,var(--dsw-alias-brand-primary) 26%,transparent);
  height:100%;overflow:auto;box-sizing:border-box;background:var(--ob-bg);color:var(--ob-text);
  font-family:var(--dsw-font-family,var(--dsh-font-family-text,inherit));font-size:13px;line-height:1.55;
  padding:20px 0 40px;
}
.ob-root *{box-sizing:border-box}
/* macOS 隐藏式标题栏：入口页自己让出顶部安全区（同 Plugins 页的写法）；Windows 的 frame 已留出标题栏。 */
:root[data-platform='darwin'] .ob-root{padding-top:calc(20px + var(--dsh-frame-top-clearance,0px))}
.ob-wrap{max-width:1080px;margin:0 auto;padding:0 24px}
.ob-head{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:12px 16px;margin-bottom:14px}
.ob-title{flex:1 1 220px;min-width:0}
.ob-title h1{margin:0;font-size:20px;line-height:28px;font-weight:500;letter-spacing:0;overflow-wrap:anywhere}
.ob-title p{margin:4px 0 0;font-size:13px;line-height:20px;color:var(--ob-sub);overflow-wrap:anywhere}
.ob-head-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
.ob-status{display:inline-flex;align-items:center;gap:6px;height:28px;max-width:100%;padding:0 10px;border-radius:var(--dsw-radius-sm);border:0.5px solid var(--ob-line);background:var(--ob-card);font-size:12px;color:var(--ob-sub)}
.ob-status-text{white-space:nowrap}
.ob-status-extra{max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ob-dim)}
.ob-dot{flex:none;width:8px;height:8px;border-radius:50%;corner-shape:round;background:var(--ob-dim)}
.ob-dot.ok{background:var(--ob-ok)}
.ob-dot.warn{background:var(--ob-warn)}
.ob-dot.err{background:var(--ob-err)}
.ob-tabs{position:sticky;top:0;z-index:5;display:flex;gap:2px;margin:0 0 16px;padding:4px;border-radius:var(--dsw-radius-lg);border:0.5px solid var(--ob-line);background:var(--ob-card);overflow-x:auto;scrollbar-width:none}
:root[data-platform='darwin'] .ob-tabs{top:var(--dsh-frame-top-clearance,0px)}
.ob-tabs::-webkit-scrollbar{display:none}
:root[data-platform='darwin'] .ob-tabs::before{content:"";position:absolute;left:0;right:0;bottom:calc(100% + 1px);height:var(--dsh-frame-top-clearance,0px);background:var(--ob-bg);pointer-events:none}
.ob-tab{flex:none;display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--ob-sub);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.ob-tab.on{background:var(--ob-card-2);color:var(--ob-text);font-weight:500}
.ob-tab-dirty{width:6px;height:6px;border-radius:50%;corner-shape:round;background:var(--ob-warn)}
.ob-stack{display:flex;flex-direction:column;gap:12px}
.ob-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr))}
.ob-grid-4{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(min(100%,132px),1fr))}
.ob-card{min-width:0;border-radius:var(--dsw-radius-xl);border:0.5px solid var(--dsw-alias-settings-card-stroke,var(--ob-line));background:var(--ob-card);padding:16px 18px}
.ob-card-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:10px}
.ob-card-head h2,.ob-card-head h3{margin:0;font-size:14px;line-height:22px;font-weight:500;min-width:0;overflow-wrap:anywhere}
.ob-card-desc{margin:-2px 0 12px;font-size:12.5px;line-height:1.55;color:var(--ob-sub);overflow-wrap:anywhere}
.ob-spacer{flex:1 1 auto}
.ob-stat{padding:14px 16px}
.ob-stat-n{font-size:22px;line-height:28px;font-weight:500;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.ob-stat-l{margin-top:2px;font-size:12px;line-height:1.5;color:var(--ob-sub);overflow-wrap:anywhere}
.ob-stat-h{margin-top:2px;font-size:11px;line-height:1.5;color:var(--ob-dim);overflow-wrap:anywhere}
.ob-kv{display:grid;grid-template-columns:minmax(80px,auto) minmax(0,1fr);gap:6px 14px;margin:0;font-size:12.5px}
.ob-kv dt{color:var(--ob-sub);overflow-wrap:anywhere}
.ob-kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.ob-kv-state{display:inline-flex;align-items:center;gap:6px}
.ob-issue-list,.ob-about-list{margin:4px 0 0;padding-left:18px;font-size:12.5px;line-height:1.6;color:var(--ob-sub)}
.ob-issue-list li,.ob-about-list li{overflow-wrap:anywhere}
.ob-issue-list li+li,.ob-about-list li+li{margin-top:4px}
.ob-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;max-width:100%;height:32px;padding:0 12px;border-radius:var(--dsw-radius-md);border:0.5px solid var(--ob-line);background:var(--ob-card);color:var(--ob-text);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.ob-btn.sm{height:28px;padding:0 10px;font-size:12px}
.ob-btn.primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}
.ob-btn.danger{color:var(--ob-err)}
.ob-btn.ghost{border-color:transparent;background:transparent;color:var(--ob-sub)}
.ob-btn:disabled{opacity:.55;cursor:default}
.ob-icon-btn{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:0;border:0.5px solid transparent;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--ob-sub);font:inherit;font-size:16px;line-height:1;cursor:pointer}
.ob-input,.ob-select,.ob-textarea{width:100%;min-width:0;height:32px;padding:0 10px;border:0.5px solid var(--ob-line);border-radius:var(--dsw-radius-md);background:var(--ob-card);color:var(--ob-text);font:inherit;font-size:13px;outline:none}
.ob-textarea{height:auto;min-height:84px;padding:8px 10px;resize:vertical;line-height:1.55}
.ob-input:focus,.ob-select:focus,.ob-textarea:focus{border-color:var(--ob-brand);box-shadow:0 0 0 3px var(--ob-ring)}
.ob-input::placeholder,.ob-textarea::placeholder{color:var(--ob-dim)}
.ob-input.sm{width:110px}
.ob-input-wrap{position:relative;display:flex;width:100%;min-width:0}
.ob-input-wrap .ob-input{padding-right:58px}
.ob-eye{position:absolute;top:4px;right:4px;height:24px;padding:0 8px;border:0.5px solid transparent;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--ob-sub);font:inherit;font-size:12px;cursor:pointer}
.ob-unit{flex:none;font-size:12px;color:var(--ob-sub);white-space:nowrap}
.ob-field{display:flex;flex-wrap:wrap;align-items:flex-start;gap:6px 16px;padding:10px 0;border-top:0.5px solid var(--ob-line-soft)}
.ob-field:first-of-type{border-top:0;padding-top:0}
.ob-field-label{flex:1 1 190px;min-width:0}
.ob-field-label b{display:block;font-size:13px;line-height:20px;font-weight:500;overflow-wrap:anywhere}
.ob-field-label small{display:block;margin-top:2px;font-size:12px;line-height:1.5;color:var(--ob-dim);overflow-wrap:anywhere}
.ob-field-ctl{display:flex;flex:1 1 240px;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
.ob-switch{position:relative;flex:none;width:38px;height:22px;padding:0;border:0;border-radius:999px;corner-shape:round;background:var(--ob-line);cursor:pointer}
.ob-switch::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-switch-thumb,var(--ob-card));box-shadow:var(--dsw-elevation-soft);transition:left .15s}
.ob-switch.on{background:var(--ob-brand)}
.ob-switch.on::after{left:19px}
.ob-switch:disabled{opacity:.55;cursor:default}
.ob-tags{display:flex;flex-wrap:wrap;align-items:center;gap:6px;width:100%;min-width:0}
.ob-tag{display:inline-flex;align-items:center;gap:2px;max-width:100%;height:26px;padding:0 2px 0 8px;border:0.5px solid var(--ob-line);border-radius:var(--dsw-radius-sm);background:var(--ob-card-2);font-size:12px}
.ob-tag span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ob-tag button{flex:none;width:20px;height:20px;padding:0;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--ob-sub);font:inherit;line-height:1;cursor:pointer}
.ob-tags input{flex:1 1 140px;min-width:110px;height:32px;padding:0 10px;border:0.5px solid var(--ob-line);border-radius:var(--dsw-radius-md);background:var(--ob-card);color:var(--ob-text);font:inherit;font-size:13px;outline:none}
.ob-tags input:focus{border-color:var(--ob-brand);box-shadow:0 0 0 3px var(--ob-ring)}
.ob-badge{display:inline-flex;align-items:center;height:18px;max-width:100%;padding:0 6px;border:0.5px solid var(--ob-line);border-radius:var(--dsw-radius-xs);background:var(--ob-card-2);color:var(--ob-sub);font-size:11px;line-height:1;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ob-badge.ok{border-color:transparent;background:var(--ob-ok-bg);color:var(--ob-ok)}
.ob-badge.warn{border-color:transparent;background:var(--ob-warn-bg);color:var(--ob-warn)}
.ob-badge.err{border-color:transparent;background:var(--ob-err-bg);color:var(--ob-err)}
.ob-banner{display:flex;flex-wrap:wrap;align-items:flex-start;gap:8px 10px;margin:0 0 12px;padding:10px 12px;border:1px solid var(--ob-line);border-radius:var(--dsw-radius-md);background:var(--ob-card-2);font-size:12.5px;line-height:1.55}
.ob-banner.warn{border-color:var(--dsw-alias-state-warn-secondary,var(--ob-warn));background:var(--ob-warn-bg)}
.ob-banner.err{border-color:var(--dsw-alias-state-error-secondary,var(--ob-err));background:var(--ob-err-bg)}
.ob-banner-msg{flex:1 1 200px;min-width:0;overflow-wrap:anywhere}
.ob-banner-actions{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.ob-note{margin:0 0 12px;padding:10px 12px;border:0.5px solid var(--ob-line);border-radius:var(--dsw-radius-md);background:var(--ob-card-2);color:var(--ob-sub);font-size:12.5px;line-height:1.55;overflow-wrap:anywhere}
.ob-note:last-child{margin-bottom:0}
.ob-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:26px 12px;color:var(--ob-dim);font-size:13px;text-align:center}
.ob-empty-icon{font-size:22px;line-height:1;opacity:.9}
.ob-loading{display:flex;align-items:center;justify-content:center;gap:8px;padding:30px 12px;color:var(--ob-sub);font-size:13px}
.ob-spin{display:inline-block;flex:none;width:12px;height:12px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;corner-shape:round;animation:ob-spin .7s linear infinite;vertical-align:-2px}
@keyframes ob-spin{to{transform:rotate(360deg)}}
.ob-list{display:flex;flex-direction:column;min-width:0}
.ob-item{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;min-width:0;padding:8px 0;border-top:0.5px solid var(--ob-line-soft)}
.ob-item:first-child{border-top:0;padding-top:0}
.ob-item-main{flex:1 1 160px;min-width:0;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.ob-item-main b{display:block;font-size:13px;line-height:20px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ob-item-main small{display:block;font-size:12px;line-height:1.5;color:var(--ob-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ob-item-act{flex:none}
.ob-scroll{max-height:320px;overflow:auto}
.ob-logs{display:flex;flex-direction:column;gap:1px;max-height:520px;overflow:auto;padding:6px 0;border:0.5px solid var(--ob-line);border-radius:var(--dsw-radius-lg);background:var(--ob-card-2)}
.ob-log{display:flex;flex-wrap:wrap;align-items:flex-start;gap:2px 8px;padding:3px 12px;font-family:var(--dsh-font-family-code,var(--dsw-font-family-code,ui-monospace,monospace));font-size:12px;line-height:1.5}
.ob-log .ob-log-time{flex:none;color:var(--ob-dim);font-variant-numeric:tabular-nums}
.ob-log .ob-log-area{flex:none;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ob-dim)}
.ob-log-text{flex:1 1 100%;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}
.ob-log.warn .ob-log-text{color:var(--ob-warn)}
.ob-log.error .ob-log-text{color:var(--ob-err)}
.ob-log.debug .ob-log-text{color:var(--ob-dim)}
.ob-event{min-width:0;padding:9px 0;border-top:0.5px solid var(--ob-line-soft)}
.ob-event:first-child{border-top:0;padding-top:0}
.ob-event-head{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;min-width:0;font-size:12px;color:var(--ob-dim)}
.ob-event-text{margin-top:4px;font-size:13px;line-height:1.55;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}
.ob-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
.ob-chip{display:inline-flex;align-items:center;max-width:100%;height:20px;padding:0 6px;border-radius:var(--dsw-radius-xs);background:var(--ob-card-2);border:0.5px solid var(--ob-line);color:var(--ob-sub);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ob-seg{display:inline-flex;border:0.5px solid var(--ob-line);border-radius:var(--dsw-radius-md);overflow:hidden}
.ob-seg button{height:30px;padding:0 14px;border:0;border-left:0.5px solid var(--ob-line);background:var(--ob-card);color:var(--ob-sub);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.ob-seg button:first-child{border-left:0}
.ob-seg button.on{background:var(--ob-card-2);color:var(--ob-text);font-weight:500}
.ob-savebar{position:sticky;bottom:12px;z-index:8;display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin-top:16px;padding:10px 14px;border:0.5px solid var(--ob-brand);border-radius:var(--dsw-radius-lg);background:var(--ob-card);box-shadow:var(--dsw-elevation-panel)}
.ob-savebar-msg{flex:1 1 160px;min-width:0;font-size:13px;font-weight:500;overflow-wrap:anywhere}
.ob-kbd{display:inline-block;padding:0 4px;border:0.5px solid var(--ob-line);border-radius:var(--dsw-radius-xs);background:var(--ob-card-2);font-size:11px;line-height:16px}
.ob-toast{position:fixed;left:50%;bottom:24px;z-index:60;display:flex;align-items:center;gap:8px;max-width:min(560px,calc(100vw - 32px));padding:10px 14px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label);box-shadow:var(--dsw-elevation-prominent);font-size:13px;line-height:1.5;transform:translateX(-50%);overflow-wrap:anywhere}
.ob-toast-mark{display:inline-flex;align-items:center;justify-content:center;flex:none;width:16px;height:16px;border-radius:50%;corner-shape:round;font-size:11px;font-weight:500}
.ob-toast.ok .ob-toast-mark{background:var(--ob-ok);color:var(--dsw-alias-label-primary-foreground)}
.ob-toast.err .ob-toast-mark{background:var(--ob-err);color:var(--dsw-alias-label-primary-foreground)}
.ob-toast.info .ob-toast-mark{background:var(--ob-card-3);color:var(--ob-text)}
.ob-mono{font-family:var(--dsh-font-family-code,var(--dsw-font-family-code,ui-monospace,monospace));font-size:12px;overflow-wrap:anywhere}
.ob-muted{color:var(--ob-sub)}
.ob-dim{color:var(--ob-dim)}
.ob-small{font-size:12px;line-height:1.5}
.ob-nowrap{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.ob-a{color:var(--dsw-alias-link);text-decoration:none;font-weight:500}
@media (hover: hover){
  .ob-tab:hover{color:var(--ob-text)}
  .ob-btn:not(:disabled):hover{background:var(--ob-hover)}
  .ob-btn.primary:not(:disabled):hover{background:var(--dsw-alias-button-primary-hover)}
  .ob-btn.ghost:not(:disabled):hover{background:var(--ob-hover)}
  .ob-icon-btn:hover{background:var(--ob-hover);color:var(--ob-text)}
  .ob-eye:hover{background:var(--ob-hover);color:var(--ob-text)}
  .ob-switch:not(:disabled):hover{filter:brightness(.96)}
  .ob-tag button:hover{background:var(--ob-hover);color:var(--ob-text)}
  .ob-seg button:hover{color:var(--ob-text)}
  .ob-item-main{cursor:pointer}
  .ob-a:hover{text-decoration:underline;text-decoration-style:dotted;text-underline-offset:3px}
}
.ob-root button:focus-visible,.ob-root .ob-tab:focus-visible,.ob-root input:focus-visible,.ob-root select:focus-visible,.ob-root textarea:focus-visible{outline:2px solid var(--ob-brand);outline-offset:2px}
.ob-input:focus-visible,.ob-textarea:focus-visible{outline:none}
@media (max-width:640px){
  .ob-wrap{padding:0 14px}
  .ob-field-label{flex-basis:100%}
  .ob-field-ctl{flex-basis:100%}
  .ob-log-text{flex-basis:100%}
  .ob-log{padding:5px 10px}
}
@media (max-width:420px){
  .ob-wrap{padding:0 12px}
  .ob-card{padding:14px}
  .ob-tab{padding:0 10px}
  .ob-savebar{padding:10px 12px}
}
@media (pointer: coarse){
  .ob-input,.ob-select,.ob-textarea,.ob-tags input{font-size:16px}
  .ob-btn{height:36px}
  .ob-tab{height:36px}
}
@media (prefers-reduced-motion: reduce){
  .ob-root *{transition:none!important;animation:none!important}
}
`

    function ensureStyleElement() {
      if (typeof document === 'undefined' || !document.head) return null
      const existing = document.getElementById(STYLE_ID)
      if (existing) return existing
      const el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = PANEL_CSS
      document.head.appendChild(el)
      return el
    }

    function installStyle(ctx) {
      if (typeof document === 'undefined' || !document.head) return
      const mount = () => {
        ensureStyleElement()
        return () => {
          try {
            const el = document.getElementById(STYLE_ID)
            if (el && el.parentNode) el.parentNode.removeChild(el)
          } catch (error) {}
        }
      }
      if (ctx && typeof ctx.effect === 'function') {
        try {
          ctx.effect(mount, 'onebot-qq: 面板样式')
          return
        } catch (error) {}
      }
      try {
        mount()
      } catch (error) {}
    }

    function usePanelStyle() {
      useEffect(() => {
        ensureStyleElement()
      }, [])
    }

    // =====================================================================
    // 基础控件
    // =====================================================================

    function cx() {
      const parts = []
      for (let i = 0; i < arguments.length; i += 1) {
        const value = arguments[i]
        if (value) parts.push(value)
      }
      return parts.join(' ')
    }

    function OneBotIcon(props) {
      const size = (props && props.size) || 18
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M4 5.5h16v10H9.5L4 19v-3.5z' }),
        h('circle', { cx: 9, cy: 10.5, r: 0.9, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 15, cy: 10.5, r: 0.9, fill: 'currentColor', stroke: 'none' }),
      )
    }

    function RefreshIcon() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M20 11a8 8 0 1 0-2.4 6.4' }),
        h('path', { d: 'M20 4.5V11h-6.5' }),
      )
    }

    function Switch(props) {
      const on = Boolean(props.on)
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': on,
        'aria-label': props.label || undefined,
        className: cx('ob-switch', on && 'on'),
        disabled: Boolean(props.disabled),
        title: props.title || undefined,
        onClick: () => {
          if (props.disabled) return
          if (typeof props.onChange === 'function') props.onChange(!on)
        },
      })
    }

    function Btn(props) {
      const kind = props.kind ? ' ' + props.kind : ''
      const size = props.small ? ' sm' : ''
      return h(
        'button',
        {
          type: props.type || 'button',
          className: 'ob-btn' + kind + size,
          disabled: Boolean(props.disabled) || Boolean(props.busy),
          title: props.title || undefined,
          'aria-busy': props.busy ? 'true' : undefined,
          onClick: props.onClick,
        },
        props.busy ? h('span', { className: 'ob-spin', 'aria-hidden': true }) : null,
        h('span', null, props.children),
      )
    }

    function IconBtn(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'ob-icon-btn',
          title: props.title || undefined,
          'aria-label': props.label || props.title || '操作',
          onClick: props.onClick,
        },
        props.children,
      )
    }

    function Card(props) {
      return h(
        'div',
        { className: cx('ob-card', props.className) },
        props.title || props.right
          ? h('div', { className: 'ob-card-head' }, props.title ? h('h2', null, props.title) : null, h('span', { className: 'ob-spacer' }), props.right || null)
          : null,
        props.desc ? h('p', { className: 'ob-card-desc' }, props.desc) : null,
        props.children,
      )
    }

    function Empty(props) {
      return h('div', { className: 'ob-empty' }, h('div', { className: 'ob-empty-icon', 'aria-hidden': true }, props.icon || '·'), h('div', null, props.text || '暂无内容'), props.children || null)
    }

    function Loading(props) {
      return h('div', { className: 'ob-loading' }, h('span', { className: 'ob-spin', 'aria-hidden': true }), h('span', null, props.text || '加载中…'))
    }

    function ErrorNote(props) {
      return h(
        'div',
        { className: 'ob-banner err', role: 'alert' },
        h('span', { className: 'ob-banner-msg' }, props.message || '操作失败'),
        props.onRetry
          ? h('span', { className: 'ob-banner-actions' }, h(Btn, { small: true, onClick: props.onRetry, busy: props.retrying }, props.retryLabel || '重试'))
          : null,
      )
    }

    function Badge(props) {
      return h('span', { className: cx('ob-badge', props.tone), title: props.title || undefined }, props.children)
    }

    function Stat(props) {
      return h('div', { className: 'ob-card ob-stat' }, h('div', { className: 'ob-stat-n' }, props.value == null || props.value === '' ? '0' : props.value), h('div', { className: 'ob-stat-l' }, props.label), props.hint ? h('div', { className: 'ob-stat-h' }, props.hint) : null)
    }

    function KV(props) {
      const rows = safeArray(props.rows)
      return h(
        'dl',
        { className: 'ob-kv' },
        rows.map((row, index) =>
          h(
            Fragment,
            { key: index },
            h('dt', null, row && row[0] != null ? row[0] : ''),
            h('dd', null, row && row[1] != null && row[1] !== '' ? row[1] : '—'),
          ),
        ),
      )
    }

    function Tabs(props) {
      const tabs = safeArray(props.tabs)
      const current = props.current
      const ref = useRef(null)
      const onKeyDown = (event) => {
        const index = tabs.findIndex((tab) => tab.id === current)
        let next = -1
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
        else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length
        else if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = tabs.length - 1
        if (next < 0) return
        event.preventDefault()
        props.onChange(tabs[next].id)
        try {
          const buttons = ref.current ? ref.current.querySelectorAll('[role="tab"]') : []
          if (buttons[next] && buttons[next].focus) buttons[next].focus()
        } catch (error) {}
      }
      return h(
        'div',
        { className: 'ob-tabs', role: 'tablist', 'aria-label': 'QQ 连接面板', ref, onKeyDown },
        tabs.map((tab) =>
          h(
            'button',
            {
              key: tab.id,
              type: 'button',
              role: 'tab',
              id: 'ob-tab-' + tab.id,
              'aria-selected': current === tab.id,
              'aria-controls': 'ob-panel-' + tab.id,
              tabIndex: current === tab.id ? 0 : -1,
              className: cx('ob-tab', current === tab.id && 'on'),
              onClick: () => props.onChange(tab.id),
            },
            tab.label,
            props.dirty && tab.id === 'config' ? h('i', { className: 'ob-tab-dirty', title: '有未保存的改动' }) : null,
          ),
        ),
      )
    }

    function Toast(props) {
      const message = props.message
      if (!message) return null
      const kind = message.kind || 'info'
      const mark = kind === 'ok' ? '✓' : kind === 'err' ? '!' : 'i'
      return h(
        'div',
        { className: cx('ob-toast', kind), role: 'status', 'aria-live': 'polite' },
        h('span', { className: 'ob-toast-mark', 'aria-hidden': true }, mark),
        h('span', null, message.text),
      )
    }

    // ---- 数据驱动字段控件 ----

    function FieldControl(props) {
      const spec = props.spec || {}
      const type = spec.type || 'text'
      const value = props.value
      const onChange = typeof props.onChange === 'function' ? props.onChange : () => {}
      const id = props.id
      const describedBy = props.describedBy
      if (type === 'switch') {
        return h(Switch, { on: Boolean(value), onChange, disabled: props.disabled, label: spec.label, title: spec.help })
      }
      if (type === 'number') {
        return h('input', {
          id,
          className: 'ob-input sm',
          type: 'number',
          min: spec.min,
          max: spec.max,
          step: spec.step === undefined ? 'any' : spec.step,
          value: value === undefined || value === null ? '' : String(value),
          placeholder: spec.placeholder || undefined,
          disabled: props.disabled,
          'aria-label': spec.label,
          'aria-describedby': describedBy,
          onChange: (event) => {
            const raw = event.target.value
            onChange(raw === '' ? '' : Number(raw))
          },
        })
      }
      if (type === 'select') {
        const options = safeArray(spec.options)
        return h(
          'select',
          {
            id,
            className: 'ob-select',
            value: value === undefined || value === null ? '' : String(value),
            disabled: props.disabled,
            'aria-label': spec.label,
            'aria-describedby': describedBy,
            onChange: (event) => onChange(event.target.value),
          },
          options.length
            ? options.map((option) => h('option', { key: option.value, value: option.value }, option.label))
            : h('option', { value: '' }, '没有可选项'),
        )
      }
      if (type === 'secret') return h(SecretField, { id, spec, value, onChange, disabled: props.disabled, describedBy })
      if (type === 'string-list') return h(StringListField, { id, spec, value, onChange, disabled: props.disabled })
      if (type === 'number-list') return h(NumberListField, { id, spec, value, onChange, disabled: props.disabled })
      if (type === 'textarea') {
        return h('textarea', {
          id,
          className: 'ob-textarea',
          rows: 3,
          value: value === undefined || value === null ? '' : String(value),
          placeholder: spec.placeholder || undefined,
          disabled: props.disabled,
          'aria-label': spec.label,
          'aria-describedby': describedBy,
          onChange: (event) => onChange(event.target.value),
        })
      }
      return h('input', {
        id,
        className: 'ob-input',
        type: 'text',
        value: value === undefined || value === null ? '' : String(value),
        placeholder: spec.placeholder || undefined,
        disabled: props.disabled,
        'aria-label': spec.label,
        'aria-describedby': describedBy,
        onChange: (event) => onChange(event.target.value),
      })
    }

    function SecretField(props) {
      const [visible, setVisible] = useState(false)
      const spec = props.spec || {}
      return h(
        'div',
        { className: 'ob-input-wrap' },
        h('input', {
          id: props.id,
          className: 'ob-input',
          type: visible ? 'text' : 'password',
          autoComplete: 'off',
          value: props.value === undefined || props.value === null ? '' : String(props.value),
          placeholder: spec.placeholder || undefined,
          disabled: props.disabled,
          'aria-label': spec.label,
          'aria-describedby': props.describedBy,
          onChange: (event) => props.onChange(event.target.value),
        }),
        h(
          'button',
          {
            type: 'button',
            className: 'ob-eye',
            'aria-pressed': visible,
            'aria-label': visible ? '隐藏内容' : '显示内容',
            onClick: () => setVisible((current) => !current),
          },
          visible ? '隐藏' : '显示',
        ),
      )
    }

    function StringListField(props) {
      const [text, setText] = useState('')
      const list = safeArray(props.value).map((item) => String(item))
      const add = () => {
        const value = text.trim()
        if (!value) return
        if (list.indexOf(value) < 0) props.onChange(list.concat([value]))
        setText('')
      }
      return h(
        'div',
        { className: 'ob-tags' },
        list.map((item) =>
          h(
            'span',
            { className: 'ob-tag', key: item, title: item },
            h('span', null, item),
            h('button', { type: 'button', 'aria-label': '移除 ' + item, onClick: () => props.onChange(list.filter((entry) => entry !== item)) }, '×'),
          ),
        ),
        h('input', {
          id: props.id,
          type: 'text',
          value: text,
          placeholder: (props.spec && props.spec.placeholder) || '输入后回车添加',
          disabled: props.disabled,
          'aria-label': (props.spec && props.spec.label) || '列表输入',
          onChange: (event) => setText(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              add()
            } else if (event.key === 'Backspace' && !text && list.length) {
              props.onChange(list.slice(0, -1))
            }
          },
        }),
      )
    }

    function formatNumberList(value) {
      return safeArray(value).join(', ')
    }

    function NumberListField(props) {
      const current = formatNumberList(props.value)
      const [text, setText] = useState(current)
      const lastRef = useRef(current)
      useEffect(() => {
        const next = formatNumberList(props.value)
        if (next !== lastRef.current) {
          setText(next)
          lastRef.current = next
        }
      }, [props.value])
      return h('input', {
        id: props.id,
        className: 'ob-input',
        type: 'text',
        value: text,
        placeholder: (props.spec && props.spec.placeholder) || '用逗号分隔，例如 1000, 3000, 5000',
        disabled: props.disabled,
        'aria-label': (props.spec && props.spec.label) || '数字列表',
        onChange: (event) => {
          const raw = event.target.value
          setText(raw)
          const parts = raw.split(/[,\s，;；]+/).map((item) => item.trim()).filter(Boolean)
          const numbers = parts.map((item) => Number(item)).filter((item) => Number.isFinite(item))
          if (numbers.length === parts.length) {
            lastRef.current = formatNumberList(numbers)
            props.onChange(numbers)
          }
        },
        onBlur: () => {
          const next = formatNumberList(props.value)
          setText(next)
          lastRef.current = next
        },
      })
    }

    function FieldRow(props) {
      const spec = props.spec || {}
      const id = 'ob-field-' + String(spec.path || '').replace(/[^a-zA-Z0-9_-]+/g, '-')
      const describedBy = spec.help ? id + '-help' : undefined
      const labelNode = h('b', null, spec.label || spec.path)
      return h(
        'div',
        { className: 'ob-field' },
        h(
          'div',
          { className: 'ob-field-label' },
          spec.type === 'switch' ? labelNode : h('label', { htmlFor: id }, labelNode),
          spec.help ? h('small', { id: id + '-help' }, spec.help) : null,
        ),
        h(
          'div',
          { className: 'ob-field-ctl' },
          h(FieldControl, { id, spec, value: props.value, onChange: props.onChange, disabled: props.disabled, describedBy }),
          spec.unit ? h('span', { className: 'ob-unit' }, spec.unit) : null,
        ),
      )
    }

    function Seg(props) {
      const options = safeArray(props.options)
      return h(
        'div',
        { className: 'ob-seg', role: 'group', 'aria-label': props.label || '选择' },
        options.map((option) =>
          h(
            'button',
            {
              key: option.value,
              type: 'button',
              className: props.value === option.value ? 'on' : '',
              'aria-pressed': props.value === option.value,
              disabled: props.disabled,
              onClick: () => props.onChange(option.value),
            },
            option.label,
          ),
        ),
      )
    }

    function EventLine(props) {
      const data = props.data || describeEvent(props.event)
      const chips = []
      safeArray(data.segments).forEach((segment, index) => {
        if (!isPlainObject(segment)) return
        const type = String(segment.type || '')
        if (!type || type === 'text' || type === 'reply') return
        const label = segmentText(segment)
        if (label) chips.push(label)
      })
      safeArray(data.mentions).forEach((mention) => {
        if (!isPlainObject(mention)) return
        chips.push('@' + String(mention.name || mention.userId || ''))
      })
      safeArray(data.images).forEach((image) => {
        const summary = isPlainObject(image) ? String(image.summary || image.file || '') : ''
        chips.push('[图片]' + (summary ? ' ' + truncateText(summary, 40) : ''))
      })
      return h(
        'div',
        { className: 'ob-event' },
        h(
          'div',
          { className: 'ob-event-head' },
          h('span', null, data.time),
          h(Badge, null, data.kindLabel),
          data.chatLabel ? h('span', null, data.chatLabel) : null,
          data.senderName ? h('span', { className: 'ob-nowrap' }, data.senderName) : null,
          data.seq !== undefined ? h('span', { className: 'ob-dim' }, '#' + data.seq) : null,
        ),
        h('div', { className: 'ob-event-text', title: data.fullText || undefined }, data.summary || '（没有可显示的正文）'),
        chips.length ? h('div', { className: 'ob-chips' }, chips.slice(0, 12).map((label, index) => h('span', { className: 'ob-chip', key: index, title: label }, label))) : null,
      )
    }

    function LogLine(props) {
      const entry = props.entry || {}
      return h(
        'div',
        { className: cx('ob-log', entry.level) },
        h('span', { className: 'ob-log-time' }, entry.time || '—'),
        h(Badge, { tone: entry.level === 'error' ? 'err' : entry.level === 'warn' ? 'warn' : undefined }, entry.level || 'info'),
        entry.area ? h('span', { className: 'ob-log-area' }, entry.area) : null,
        h('span', { className: 'ob-log-text', title: entry.text || undefined }, entry.text || ''),
      )
    }

    // =====================================================================
    // 标签页：概览
    // =====================================================================

    function Overview(props) {
      const status = props.status
      const gateway = safeObject(status && status.gateway)
      const events = safeObject(status && status.events)
      const logs = safeObject(status && status.logs)
      const config = safeObject(props.configInfo && props.configInfo.config)
      const state = stateLabel(gateway.state)
      const check = loginCheckLabel(gateway.loginCheck)
      const login = isPlainObject(gateway.login) ? gateway.login : null
      const byKind = safeObject(events.byKind)
      const byChat = safeObject(events.byChat)
      const recent = safeArray(status && status.recentEvents)
      const [busy, setBusy] = useState('')

      const act = async (name, label) => {
        setBusy(name)
        try {
          await props.gatewayAction(name, label)
        } finally {
          setBusy('')
        }
      }

      const connected = gateway.state === 'connected'
      const connecting = gateway.state === 'connecting'
      return h(
        'div',
        { className: 'ob-stack' },
        !gateway.configured
          ? h(
              'div',
              { className: 'ob-banner warn' },
              h('span', { className: 'ob-banner-msg' }, '还没有可用的 OneBot 地址：去「连接」填 WebSocket / HTTP 地址并保存，再点「连接」'),
              h('span', { className: 'ob-banner-actions' }, h(Btn, { small: true, onClick: () => props.go('connect') }, '去连接')),
            )
          : null,
        gateway.state === 'paused'
          ? h('div', { className: 'ob-banner err' }, h('span', { className: 'ob-banner-msg' }, '登录账号与配置不一致，自动重连已暂停：确认机器人 QQ 号或网关登录的账号后，到「连接」页重新连接'))
          : null,
        gateway.lastError
          ? h('div', { className: 'ob-banner err' }, h('span', { className: 'ob-banner-msg' }, '最近错误：' + String(gateway.lastError)))
          : null,
        h(
          'div',
          { className: 'ob-grid' },
          h(
            Card,
            { title: '连接状态' },
            h(KV, {
              rows: [
                ['状态', h('span', { className: 'ob-kv-state' }, h('i', { className: cx('ob-dot', state.tone) }), ' ' + state.text)],
                ['已配置', gateway.configured ? '是' : '否'],
                ['网关模式', endpointModeLabel(gateway.endpoint && gateway.endpoint.mode)],
                [
                  '连接时间',
                  gateway.connectedAt
                    ? formatRelative(gateway.connectedAt) + (connected ? ' · 已连接 ' + formatDuration(Date.now() - Number(gateway.connectedAt)) : '')
                    : '—',
                ],
                ['上次断开', gateway.lastDisconnectAt ? formatRelative(gateway.lastDisconnectAt) : '—'],
                ['重连次数', gateway.reconnects == null ? '—' : String(gateway.reconnects)],
                ['登录尝试', gateway.loginAttempts == null ? '—' : String(gateway.loginAttempts)],
              ],
            }),
          ),
          h(
            Card,
            { title: '登录账号', desc: '连上后通过 get_login_info 核验；核验结果会显示在这里。' },
            h(KV, {
              rows: [
                ['登录账号', login ? String(login.nickname || '') + (login.userId ? '（' + String(login.userId) + '）' : '') : '未获取'],
                ['期望账号', gateway.expectedBotQQ || config.botQQ || '未填写'],
                ['核验结果', h('span', null, h(Badge, { tone: check.tone }, check.text))],
                ['不一致时', accountCheckLabel(gateway.accountCheck || config.accountCheck)],
              ],
            }),
          ),
        ),
        h(
          'div',
          { className: 'ob-grid-4' },
          h(Stat, { label: '收到事件', value: events.received || 0 }),
          h(Stat, { label: '已接受', value: events.accepted || 0 }),
          h(Stat, { label: '已丢弃', value: events.dropped || 0 }),
          h(Stat, { label: '事件缓冲', value: (events.buffered || 0) + ' / ' + (events.capacity || 0) }),
          h(Stat, { label: '日志总数', value: logs.total || 0, hint: '缓冲 ' + (logs.buffered || 0) + ' 条' }),
        ),
        h(
          'div',
          { className: 'ob-grid' },
          h(
            Card,
            { title: '按类型统计' },
            h(KV, {
              rows: EVENT_KINDS.map((kind) => [eventKindLabel(kind), String(byKind[kind] || 0)]),
            }),
          ),
          h(
            Card,
            { title: '按会话统计' },
            h(KV, {
              rows: [
                ['私聊', String(byChat.private || 0)],
                ['群聊', String(byChat.group || 0)],
                ['其他', String(byChat.other || 0)],
                ['最后事件', events.lastAt ? formatRelative(events.lastAt) : '—'],
              ],
            }),
          ),
        ),
        h(
          Card,
          {
            title: '最近事件',
            right: h(Btn, { small: true, kind: 'ghost', onClick: () => props.go('messages') }, '去消息页查看全部 →'),
          },
          recent.length
            ? h('div', null, recent.slice(-8).reverse().map((event, index) => h(EventLine, { key: (event && event.seq) || index, event })))
            : h(Empty, { icon: '📡', text: '还没有收到事件。连上网关后，收到的消息会出现在这里' }),
        ),
        h(
          Card,
          { title: '快捷操作', desc: '操作作用于已保存的配置；如果刚改过地址，请先保存。' },
          h(
            'div',
            { className: 'ob-chips' },
            h(Btn, { kind: 'primary', onClick: () => act('connect', '连接'), busy: busy === 'connect', disabled: connected || connecting }, connected ? '已连接' : '连接'),
            h(Btn, { onClick: () => act('reconnect', '重连'), busy: busy === 'reconnect' }, '重连'),
            h(Btn, { onClick: () => act('disconnect', '断开'), busy: busy === 'disconnect', disabled: gateway.state === 'stopped' }, '断开'),
            h(Btn, { kind: 'ghost', onClick: () => props.refreshAll(), busy: false }, '刷新状态'),
          ),
        ),
      )
    }

    // =====================================================================
    // 标签页：连接
    // =====================================================================

    function Connect(props) {
      const configInfo = props.configInfo
      const draft = props.draft
      const groups = configInfo ? configInfo.groups : null
      const gateway = safeObject(props.status && props.status.gateway)
      const [busy, setBusy] = useState('')
      const [detecting, setDetecting] = useState(false)
      const [detect, setDetect] = useState(null)
      const [probing, setProbing] = useState(false)
      const [probe, setProbe] = useState(null)

      if (!configInfo || !draft) {
        return h(
          Card,
          { title: '连接' },
          configInfo === null
            ? h(ErrorNote, { message: '配置读取失败，无法显示连接字段', onRetry: () => props.refreshAll(), retryLabel: '重新读取' })
            : h(Loading, { text: '正在读取配置…' }),
        )
      }

      const setField = (path, value) => props.updateDraft((previous) => setByPath(previous || {}, path, value))
      const renderField = (path) => {
        const spec = fieldSpecByPath(groups, path)
        if (!spec) return null
        return h(FieldRow, { spec, value: getByPath(draft, path), onChange: (value) => setField(path, value) })
      }

      const doDetect = async () => {
        setDetecting(true)
        setDetect(null)
        const result = describeDetect(await get('/gateway/detect'))
        setDetect(result)
        setDetecting(false)
        if (!result.ok) props.toast('检测失败：' + result.message, 'err')
      }

      const doProbe = async () => {
        setProbing(true)
        setProbe(null)
        const result = describeProbe(await post('/probe', { endpoint: probeEndpointFromDraft(draft) }))
        setProbe(result)
        setProbing(false)
        if (result.ok) props.toast('探测成功', 'ok')
        else props.toast('探测失败：' + (result.error || result.message || '未知错误'), 'err')
      }

      const act = async (name, label) => {
        setBusy(name)
        try {
          await props.gatewayAction(name, label)
        } finally {
          setBusy('')
        }
      }

      const endpoint = safeObject(gateway.endpoint)
      const state = stateLabel(gateway.state)
      return h(
        'div',
        { className: 'ob-stack' },
        h(
          Card,
          {
            title: '网关模式',
            desc: '连接已有 OneBot v11 地址，或让插件只读 SnowLuma 自己的配置。这里不下载、不启动、不注入任何进程。',
            right: props.dirty
              ? h(Btn, { small: true, kind: 'primary', onClick: () => props.save(), busy: props.saving, disabled: props.saving }, '保存改动')
              : h(Badge, null, '已保存'),
          },
          renderField('gateway'),
          renderField('onebot.wsUrl'),
          renderField('onebot.httpUrl'),
          renderField('onebot.wsToken'),
          renderField('onebot.httpToken'),
          renderField('onebot.httpAuth'),
        ),
        h(
          Card,
          { title: 'SnowLuma 地址读取', desc: 'SnowLuma 模式会从它的 config/onebot*.json 读取端口与 token；本插件只读，不启动它。' },
          renderField('snowluma.autoDetect'),
          renderField('snowluma.dir'),
          renderField('snowluma.uin'),
        ),
        h(
          Card,
          {
            title: '检测与探测',
            desc: '「检测」只读取本机 SnowLuma 安装与端点解析结果；「探测」只调用一次 get_login_info，不改变当前连接。',
            right: h(
              'span',
              { className: 'ob-banner-actions' },
              h(Btn, { small: true, onClick: doDetect, busy: detecting }, detecting ? '检测中…' : '检测 SnowLuma'),
              h(Btn, { small: true, onClick: doProbe, busy: probing }, probing ? '探测中…' : '探测登录'),
            ),
          },
          detecting ? h(Loading, { text: '正在检测本机 SnowLuma…' }) : null,
          !detecting && detect
            ? detect.ok
              ? h(
                  'div',
                  null,
                  h(KV, {
                    rows: [
                      ['SnowLuma', detect.snowluma ? (detect.snowluma.installed ? '已安装' : '未检测到') : '无结果'],
                      ['安装目录', detect.snowluma && detect.snowluma.dir ? detect.snowluma.dir : '—'],
                      ['版本', detect.snowluma && detect.snowluma.version ? detect.snowluma.version : '—'],
                      ['OneBot 端点', detect.snowluma ? (detect.snowluma.endpointFound ? '已找到' : '未找到') : '—'],
                      ['端点来源', detect.endpoint && detect.endpoint.source ? detect.endpoint.source : '—'],
                      ['WebSocket', detect.endpoint && detect.endpoint.wsUrl ? maskEndpoint(detect.endpoint.wsUrl) : '—'],
                      ['HTTP', detect.endpoint && detect.endpoint.httpUrl ? maskEndpoint(detect.endpoint.httpUrl) : '—'],
                    ],
                  }),
                  detect.reason ? h('div', { className: 'ob-note' }, '检测提示：' + detect.reason) : null,
                  detect.snowluma && detect.snowluma.error ? h('div', { className: 'ob-note' }, 'SnowLuma 检测提示：' + detect.snowluma.error) : null,
                )
              : h(ErrorNote, { message: '检测失败：' + detect.message, onRetry: doDetect, retryLabel: '重试' })
            : null,
          !detecting && !detect ? h('div', { className: 'ob-note' }, '还没有检测结果。点右上角「检测 SnowLuma」查看本机安装情况') : null,
          probing ? h(Loading, { text: '正在探测网关登录信息…' }) : null,
          !probing && probe
            ? probe.ok
              ? h(
                  'div',
                  null,
                  h(KV, {
                    rows: [
                      ['探测结果', h(Badge, { tone: 'ok' }, '成功')],
                      ['端点提示', probe.endpointHint ? maskEndpoint(probe.endpointHint) : '—'],
                      ['登录账号', probe.login ? String(probe.login.nickname || '') + (probe.login.userId ? '（' + String(probe.login.userId) + '）' : '') : '未返回'],
                      ['HTTP 状态', probe.httpStatus ? String(probe.httpStatus) : '—'],
                      ['耗时', probe.elapsedMs ? probe.elapsedMs + ' ms' : '—'],
                    ],
                  }),
                )
              : h(ErrorNote, { message: '探测失败：' + (probe.error || probe.message || '未知错误'), onRetry: doProbe, retryLabel: '重试' })
            : null,
          !probing && !probe ? h('div', { className: 'ob-note' }, '「探测登录」会用当前表单里的地址调用一次 HTTP get_login_info，适合在保存前确认地址和 token 是否正确') : null,
        ),
        h(
          Card,
          {
            title: '连接控制',
            right: h(Badge, { tone: state.tone }, state.text),
          },
          h(
            'div',
            { className: 'ob-chips' },
            h(Btn, { kind: 'primary', onClick: () => act('connect', '连接'), busy: busy === 'connect', disabled: gateway.state === 'connected' || gateway.state === 'connecting' }, '连接'),
            h(Btn, { onClick: () => act('reconnect', '重连'), busy: busy === 'reconnect' }, '重连'),
            h(Btn, { onClick: () => act('disconnect', '断开'), busy: busy === 'disconnect', disabled: gateway.state === 'stopped' }, '断开'),
            h(Btn, { kind: 'ghost', onClick: () => props.refreshAll() }, '刷新状态'),
          ),
          h('div', { className: 'ob-note' }, '连接使用已保存的配置；上方表单改动后需要保存才会生效。'),
          gateway.lastError ? h('div', { className: 'ob-banner err' }, h('span', { className: 'ob-banner-msg' }, '最近错误：' + String(gateway.lastError))) : null,
        ),
        h(
          Card,
          { title: '当前端点（脱敏）', desc: '只展示协议、主机、端口与路径；token 一律打码。' },
          h(KV, {
            rows: [
              ['模式', endpointModeLabel(endpoint.mode)],
              ['WebSocket', endpoint.wsUrlSafe ? maskEndpoint(endpoint.wsUrlSafe) : '—'],
              ['HTTP', endpoint.httpUrlSafe ? maskEndpoint(endpoint.httpUrlSafe) : '—'],
              ['WS 已配置', endpoint.wsConfigured ? '是' : '否'],
              ['HTTP 已配置', endpoint.httpConfigured ? '是' : '否'],
            ],
          }),
        ),
      )
    }

    // =====================================================================
    // 标签页：消息
    // =====================================================================

    function Messages(props) {
      const refreshMs = computeRefreshMs(props.configInfo && props.configInfo.config, props.configInfo && props.configInfo.groups)
      const [chatType, setChatType] = useState('private')
      const [chatId, setChatId] = useState('')
      const [text, setText] = useState('')
      const [sending, setSending] = useState(false)
      const [sendResult, setSendResult] = useState(null)
      const [friends, setFriends] = useState({ loading: false, error: '', items: null })
      const [groups, setGroups] = useState({ loading: false, error: '', items: null })
      const [events, setEvents] = useState([])
      const [eventsError, setEventsError] = useState('')
      const [eventsLoading, setEventsLoading] = useState(true)
      const [paused, setPaused] = useState(false)
      const [kindFilter, setKindFilter] = useState('')
      const sinceRef = useRef(0)
      const pausedRef = useRef(false)
      pausedRef.current = paused

      const loadList = useCallback(async (which) => {
        const setState = which === 'friends' ? setFriends : setGroups
        setState((previous) => ({ loading: true, error: '', items: previous.items }))
        const parsed = parseApiResponse(await get('/' + which))
        if (!parsed.ok) {
          setState({ loading: false, error: parsed.message, items: [] })
          return
        }
        const items = safeArray(parsed.data[which])
        setState({ loading: false, error: '', items })
      }, [])

      useEffect(() => {
        loadList('friends')
        loadList('groups')
      }, [loadList])

      const loadEvents = useCallback(async (reset) => {
        const since = reset ? 0 : sinceRef.current
        const parsed = parseApiResponse(await get('/events' + buildQuery({ since, limit: 100 })))
        if (!parsed.ok) {
          setEventsError(parsed.message)
          setEventsLoading(false)
          return
        }
        const items = safeArray(parsed.data.items)
        const serverSince = Number(parsed.data.nextSince)
        sinceRef.current = Number.isFinite(serverSince) ? serverSince : nextSince(items, since)
        setEvents((previous) => (reset ? items.slice() : mergeIncremental(previous, items)))
        setEventsError('')
        setEventsLoading(false)
      }, [])

      useEffect(() => {
        let alive = true
        loadEvents(true)
        const timer = setInterval(() => {
          if (!alive || pausedRef.current || pageHidden()) return
          loadEvents(false)
        }, Math.max(1000, refreshMs))
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [loadEvents, refreshMs])

      useEffect(() => {
        if (!paused) loadEvents(false)
      }, [paused, loadEvents])

      const send = async () => {
        const id = String(chatId || '').trim()
        if (!id) {
          setSendResult({ ok: false, message: '请先填写 ' + (chatType === 'group' ? '群号' : 'QQ 号') })
          return
        }
        if (!String(text || '').trim()) {
          setSendResult({ ok: false, message: '消息内容不能为空' })
          return
        }
        setSending(true)
        setSendResult(null)
        const parsed = parseApiResponse(await post('/send', { chatType, chatId: id, message: text }))
        setSending(false)
        if (!parsed.ok) {
          setSendResult({ ok: false, message: parsed.message })
          props.toast('发送失败：' + parsed.message, 'err')
          return
        }
        const result = safeObject(parsed.data.result)
        const messageId = result.message_id
        setSendResult({ ok: true, message: messageId === undefined || messageId === null ? '已发送' : '已发送，message_id：' + String(messageId) })
        props.toast('消息已发送', 'ok')
        setText('')
      }

      const clearEvents = async () => {
        const parsed = parseApiResponse(await post('/events/clear'))
        if (!parsed.ok) {
          props.toast('清空失败：' + parsed.message, 'err')
          return
        }
        sinceRef.current = 0
        setEvents([])
        props.toast('事件缓冲已清空', 'ok')
        loadEvents(true)
      }

      const filtered = kindFilter ? events.filter((event) => event && event.kind === kindFilter) : events

      const fillTarget = (type, id) => {
        setChatType(type)
        setChatId(String(id || ''))
        props.toast('已填入发送目标', 'ok')
      }

      const renderList = (state, which) => {
        if (state.loading && state.items === null) return h(Loading, { text: '正在加载列表…' })
        if (state.error) return h(ErrorNote, { message: state.error, onRetry: () => loadList(which), retryLabel: '重试' })
        const items = safeArray(state.items)
        if (!items.length) return h(Empty, { icon: which === 'friends' ? '👥' : '👪', text: which === 'friends' ? '没有好友，或网关没有返回好友列表' : '没有群，或网关没有返回群列表' })
        return h(
          'div',
          { className: 'ob-list ob-scroll' },
          items.map((item, index) => {
            if (which === 'friends') {
              const friend = normalizeFriend(item)
              return h(
                'div',
                { className: 'ob-item', key: friend.id || index },
                h('button', { type: 'button', className: 'ob-item-main', title: '填入发送目标', onClick: () => fillTarget('private', friend.id) }, h('b', null, friend.name || friend.id), h('small', null, 'QQ ' + (friend.id || '未知') + (friend.nickname && friend.nickname !== friend.name ? ' · ' + friend.nickname : ''))),
              )
            }
            const group = normalizeGroup(item)
            return h(
              'div',
              { className: 'ob-item', key: group.id || index },
              h('button', { type: 'button', className: 'ob-item-main', title: '填入发送目标', onClick: () => fillTarget('group', group.id) }, h('b', null, group.name || group.id), h('small', null, '群 ' + (group.id || '未知') + (group.memberCount != null ? ' · ' + group.memberCount + ' 人' : ''))),
            )
          }),
        )
      }

      return h(
        'div',
        { className: 'ob-stack' },
        h(
          Card,
          { title: '发送消息', desc: '消息文本会原样交给 OneBot v11 网关；发送结果里的 message_id 会显示在下面。' },
          h(
            'div',
            { className: 'ob-field' },
            h('div', { className: 'ob-field-label' }, h('b', null, '会话类型')),
            h('div', { className: 'ob-field-ctl' }, h(Seg, { value: chatType, label: '会话类型', options: [{ value: 'private', label: '私聊' }, { value: 'group', label: '群聊' }], onChange: setChatType })),
          ),
          h(
            'div',
            { className: 'ob-field' },
            h('div', { className: 'ob-field-label' }, h('label', { htmlFor: 'ob-send-chatid' }, h('b', null, chatType === 'group' ? '群号' : 'QQ 号'))),
            h('div', { className: 'ob-field-ctl' }, h('input', { id: 'ob-send-chatid', className: 'ob-input', type: 'text', inputMode: 'numeric', value: chatId, placeholder: chatType === 'group' ? '例如 123456789' : '例如 10001', onChange: (event) => setChatId(event.target.value) })),
          ),
          h(
            'div',
            { className: 'ob-field' },
            h('div', { className: 'ob-field-label' }, h('label', { htmlFor: 'ob-send-text' }, h('b', null, '消息内容'))),
            h('div', { className: 'ob-field-ctl' }, h('textarea', { id: 'ob-send-text', className: 'ob-textarea', rows: 3, value: text, placeholder: '输入要发送的文字', onChange: (event) => setText(event.target.value) })),
          ),
          h(
            'div',
            { className: 'ob-chips' },
            h(Btn, { kind: 'primary', onClick: send, busy: sending, disabled: sending }, sending ? '发送中…' : '发送'),
            h(Btn, { kind: 'ghost', onClick: () => { setText(''); setSendResult(null) } }, '清空输入'),
          ),
          sendResult
            ? sendResult.ok
              ? h('div', { className: 'ob-note' }, h(Badge, { tone: 'ok' }, '成功'), ' ' + sendResult.message)
              : h(ErrorNote, { message: sendResult.message })
            : null,
        ),
        h(
          'div',
          { className: 'ob-grid' },
          h(Card, { title: '好友列表', desc: 'GET /friends；点一条可以填入发送目标。', right: h(Btn, { small: true, kind: 'ghost', onClick: () => loadList('friends') }, '刷新') }, renderList(friends, 'friends')),
          h(Card, { title: '群列表', desc: 'GET /groups；点一条可以填入发送目标。', right: h(Btn, { small: true, kind: 'ghost', onClick: () => loadList('groups') }, '刷新') }, renderList(groups, 'groups')),
        ),
        h(
          Card,
          {
            title: '事件流',
            desc: '增量拉取宿主事件缓冲（GET /events?since=&limit=）；按类型过滤只影响显示。',
            right: h(
              'span',
              { className: 'ob-banner-actions' },
              h(
                'select',
                {
                  className: 'ob-select',
                  value: kindFilter,
                  'aria-label': '按事件类型过滤',
                  onChange: (event) => setKindFilter(event.target.value),
                },
                h('option', { value: '' }, '全部类型'),
                EVENT_KINDS.map((kind) => h('option', { key: kind, value: kind }, eventKindLabel(kind))),
              ),
              h(Btn, { small: true, onClick: () => setPaused((value) => !value) }, paused ? '继续' : '暂停'),
              h(Btn, { small: true, kind: 'danger', onClick: clearEvents }, '清空'),
              h(Btn, { small: true, kind: 'ghost', onClick: () => loadEvents(true) }, '刷新'),
            ),
          },
          h('div', { className: 'ob-note' }, paused ? '已暂停：不再自动拉取新事件，点「继续」恢复。' : '自动刷新中（每 ' + refreshMs + ' 毫秒增量拉取一次）。'),
          eventsError ? h(ErrorNote, { message: '事件拉取失败：' + eventsError, onRetry: () => loadEvents(false), retryLabel: '重试' }) : null,
          eventsLoading ? h(Loading, { text: '正在读取事件缓冲…' }) : null,
          !eventsLoading && !filtered.length ? h(Empty, { icon: '📨', text: events.length ? '没有符合过滤条件的事件' : '事件缓冲是空的。收到 QQ 事件后会出现在这里' }) : null,
          !eventsLoading && filtered.length ? h('div', { className: 'ob-scroll' }, filtered.slice(-120).reverse().map((event, index) => h(EventLine, { key: (event && event.seq) || index, event }))) : null,
        ),
      )
    }

    // =====================================================================
    // 标签页：配置
    // =====================================================================

    function ConfigTab(props) {
      const configInfo = props.configInfo
      const draft = props.draft
      const groups = useMemo(() => buildFieldSpecs(configInfo && configInfo.groups), [configInfo])
      if (!configInfo || !draft) {
        return h(
          Card,
          { title: '配置' },
          configInfo === null
            ? h(ErrorNote, { message: '配置读取失败，无法渲染字段表', onRetry: () => props.refreshAll(), retryLabel: '重新读取' })
            : h(Loading, { text: '正在读取配置…' }),
        )
      }
      if (!groups.length) {
        return h(Card, { title: '配置' }, h(ErrorNote, { message: '服务端没有返回可渲染的配置字段表（groups 为空）', onRetry: () => props.refreshAll(), retryLabel: '重新读取' }))
      }
      const setField = (path, value) => props.updateDraft((previous) => setByPath(previous || {}, path, value))
      return h(
        'div',
        { className: 'ob-stack' },
        h(
          'div',
          { className: 'ob-note' },
          '所有配置项都来自服务端字段表；改动后点底部「保存」或按 ',
          h('span', { className: 'ob-kbd' }, 'Ctrl'),
          ' + ',
          h('span', { className: 'ob-kbd' }, 'S'),
          ' 保存。带单位/范围的字段保存时由服务端规范化并给出提示。',
        ),
        props.issues.length
          ? h(
              'div',
              { className: 'ob-banner warn', role: 'status' },
              h('span', { className: 'ob-banner-msg' }, '保存结果有 ' + props.issues.length + ' 条提示：'),
              h('ul', { className: 'ob-issue-list' }, props.issues.map((issue, index) => h('li', { key: index }, issue))),
            )
          : null,
        groups.map((group) =>
          h(
            Card,
            { key: group.id, title: group.title, desc: group.description || undefined },
            group.fields.map((field) =>
              h(FieldRow, { key: field.path, spec: field, value: getByPath(draft, field.path), onChange: (value) => setField(field.path, value), disabled: props.saving }),
            ),
          ),
        ),
        h(
          Card,
          { title: '保存与重置' },
          h(
            'div',
            { className: 'ob-chips' },
            h(Btn, { kind: 'primary', onClick: () => props.save(), busy: props.saving, disabled: props.saving || !props.dirty }, props.saving ? '保存中…' : '保存配置'),
            h(Btn, { onClick: () => props.undo(), disabled: props.saving || !props.dirty }, '撤销改动'),
            h(Btn, { kind: 'danger', onClick: () => props.reset(), disabled: props.saving }, '恢复默认'),
          ),
          h('div', { className: 'ob-note' }, '「恢复默认」会把所有配置项重置为服务端默认值（需要确认）；当前文件会立即写盘。'),
        ),
      )
    }

    // =====================================================================
    // 标签页：日志
    // =====================================================================

    function Logs(props) {
      const refreshMs = computeRefreshMs(props.configInfo && props.configInfo.config, props.configInfo && props.configInfo.groups)
      const [level, setLevel] = useState('')
      const [paused, setPaused] = useState(false)
      const [entries, setEntries] = useState([])
      const [error, setError] = useState('')
      const [loading, setLoading] = useState(true)
      const sinceRef = useRef(0)
      const levelRef = useRef('')
      const pausedRef = useRef(false)
      const firstLevelRef = useRef(true)
      pausedRef.current = paused

      const load = useCallback(async (reset) => {
        const since = reset ? 0 : sinceRef.current
        const parsed = parseApiResponse(await get('/logs' + buildQuery({ since, level: levelRef.current, limit: 200 })))
        if (!parsed.ok) {
          setError(parsed.message)
          setLoading(false)
          return
        }
        const items = safeArray(parsed.data.items).map(normalizeLogEntry)
        const serverSince = Number(parsed.data.nextSince)
        sinceRef.current = Number.isFinite(serverSince) ? serverSince : nextSince(items, since)
        setEntries((previous) => (reset ? items.slice() : mergeIncremental(previous, items)))
        setError('')
        setLoading(false)
      }, [])

      useEffect(() => {
        let alive = true
        load(true)
        const timer = setInterval(() => {
          if (!alive || pausedRef.current || pageHidden()) return
          load(false)
        }, Math.max(1000, refreshMs))
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [load, refreshMs])

      useEffect(() => {
        if (firstLevelRef.current) {
          firstLevelRef.current = false
          return
        }
        levelRef.current = level
        sinceRef.current = 0
        setLoading(true)
        load(true)
      }, [level, load])

      useEffect(() => {
        if (!paused) load(false)
      }, [paused, load])

      const clearLogs = async () => {
        const parsed = parseApiResponse(await post('/logs/clear'))
        if (!parsed.ok) {
          props.toast('清空日志失败：' + parsed.message, 'err')
          return
        }
        sinceRef.current = 0
        setEntries([])
        props.toast('日志缓冲已清空', 'ok')
        load(true)
      }

      return h(
        'div',
        { className: 'ob-stack' },
        h(
          Card,
          {
            title: '日志',
            desc: '增量拉取宿主日志环形缓冲（GET /logs?since=&level=&limit=）；token 已在服务端脱敏。',
            right: h(
              'span',
              { className: 'ob-banner-actions' },
              h(
                'select',
                { className: 'ob-select', value: level, 'aria-label': '日志级别过滤', onChange: (event) => setLevel(event.target.value) },
                h('option', { value: '' }, '全部级别'),
                LOG_LEVELS.map((name) => h('option', { key: name, value: name }, name)),
              ),
              h(Btn, { small: true, onClick: () => setPaused((value) => !value) }, paused ? '继续' : '暂停'),
              h(Btn, { small: true, kind: 'danger', onClick: clearLogs }, '清空'),
              h(Btn, { small: true, kind: 'ghost', onClick: () => load(true) }, '刷新'),
            ),
          },
          h('div', { className: 'ob-note' }, paused ? '已暂停：不再自动拉取新日志，点「继续」恢复。' : '自动刷新中（每 ' + refreshMs + ' 毫秒增量拉取一次）。'),
          error ? h(ErrorNote, { message: '日志拉取失败：' + error, onRetry: () => load(false), retryLabel: '重试' }) : null,
          loading ? h(Loading, { text: '正在读取日志…' }) : null,
          !loading && !entries.length ? h(Empty, { icon: '📝', text: '还没有日志' }) : null,
          !loading && entries.length ? h('div', { className: 'ob-logs' }, entries.slice(-400).reverse().map((entry, index) => h(LogLine, { key: entry.seq === undefined ? index : entry.seq, entry }))) : null,
        ),
      )
    }

    // =====================================================================
    // 标签页：关于
    // =====================================================================

    function About(props) {
      const configInfo = props.configInfo || {}
      const status = props.status || {}
      const version = configInfo.version || status.version || '—'
      const apiVersion = configInfo.apiVersion || status.apiVersion
      const dataDir = configInfo.dataDir || status.dataDir || '—'
      return h(
        'div',
        { className: 'ob-stack' },
        h(
          Card,
          { title: 'dsh-onebot-qq', desc: 'DeepSeek Harness 的 OneBot v11 QQ 接入插件：连接管理、事件规范化与缓冲、消息发送、完整网页面板与持久化配置。' },
          h(KV, {
            rows: [
              ['插件名', 'dsh-onebot-qq'],
              ['插件版本', String(version)],
              ['接口版本', apiVersion === undefined || apiVersion === null ? '—' : String(apiVersion)],
              ['数据目录', h('span', { className: 'ob-mono' }, String(dataDir))],
              ['许可证', 'MIT'],
            ],
          }),
        ),
        h(
          Card,
          { title: '能力与边界' },
          h('ul', { className: 'ob-about-list' },
            h('li', null, '连接已有 OneBot v11 网关（NapCat / SnowLuma / Lagrange / LLOneBot），只填地址，不下载、不启动、不注入任何进程。'),
            h('li', null, 'SnowLuma 模式只读取它自己的 config/onebot*.json，用来解析端口与 token。'),
            h('li', null, '规范化事件（消息 / 通知 / 请求 / 元事件）并缓冲，供后续认知、记忆、防抖等插件消费。'),
            h('li', null, '所有可调参数都在配置里（含重连退避、超时、过滤、缓冲容量、日志级别等），面板不写死默认值。'),
            h('li', null, '本插件只做「QQ 感知与执行接入层」；人格、记忆、认知与行为策略由后续插件在本层之上构建。'),
          ),
        ),
        h(
          Card,
          { title: '第三方与许可' },
          h(KV, {
            rows: [
              ['本项目许可', 'MIT'],
              ['参考实现', 'aureth-labs/dsh-aurabot-qq（MIT）：OneBot 客户端、数据目录、脱敏、日志与面板写法参考'],
              ['OneBot 协议', h('a', { className: 'ob-a', href: 'https://github.com/botuniverse/onebot-11', target: '_blank', rel: 'noreferrer noopener' }, 'OneBot v11 规范')],
            ],
          }),
          h('p', { className: 'ob-note' }, 'SnowLuma / NapCat 是独立的第三方项目，仅作为外部网关地址接入；使用非官方 QQ 工具存在账号风险，建议使用小号。'),
        ),
      )
    }

    // =====================================================================
    // 根组件
    // =====================================================================

    const TABS = [
      { id: 'overview', label: '概览' },
      { id: 'connect', label: '连接' },
      { id: 'messages', label: '消息' },
      { id: 'config', label: '配置' },
      { id: 'logs', label: '日志' },
      { id: 'about', label: '关于' },
    ]

    function configInfoFromPayload(payload) {
      const data = safeObject(payload)
      return {
        config: safeObject(data.config),
        defaults: safeObject(data.defaults),
        groups: safeArray(data.groups),
        version: data.version,
        apiVersion: data.apiVersion,
        dataDir: data.dataDir,
      }
    }

    function OneBotPage() {
      usePanelStyle()
      const [tab, setTab] = useState('overview')
      const [status, setStatus] = useState(null)
      const [configInfo, setConfigInfo] = useState(null)
      const [draft, setDraft] = useState(null)
      const [loading, setLoading] = useState(true)
      const [refreshing, setRefreshing] = useState(false)
      const [error, setError] = useState('')
      const [toastMessage, setToastMessage] = useState(null)
      const [saving, setSaving] = useState(false)
      const [issues, setIssues] = useState([])

      const draftRef = useRef(null)
      const configInfoRef = useRef(null)
      const dirtyRef = useRef(false)
      const saveRef = useRef(null)
      const toastTimer = useRef(null)
      const errorDismissedRef = useRef(false)
      const lastErrorRef = useRef('')

      const dirty = useMemo(() => Boolean(configInfo && draft) && !deepEqual(draft, configInfo.config), [draft, configInfo])
      dirtyRef.current = dirty
      configInfoRef.current = configInfo
      draftRef.current = draft

      const toast = useCallback((text, kind) => {
        const value = String(text == null ? '' : text).trim() || '操作完成'
        const tone = kind === 'ok' || kind === 'err' ? kind : 'info'
        setToastMessage({ text: value, kind: tone })
        if (toastTimer.current) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToastMessage(null), 3600)
      }, [])

      useEffect(
        () => () => {
          if (toastTimer.current) clearTimeout(toastTimer.current)
        },
        [],
      )

      // 错误横幅：同一条错误被用户关掉后不再每次轮询都弹回来；错误内容变化时重新出现。
      const showError = useCallback((message) => {
        const text = String(message == null ? '' : message).trim()
        if (!text) return
        if (errorDismissedRef.current && text === lastErrorRef.current) return
        errorDismissedRef.current = false
        lastErrorRef.current = text
        setError(text)
      }, [])

      const clearError = useCallback(() => {
        errorDismissedRef.current = true
        setError('')
      }, [])

      const loadConfig = useCallback(async () => {
        const parsed = parseApiResponse(await get('/config'))
        if (!parsed.ok) return { ok: false, message: parsed.message }
        const info = configInfoFromPayload(parsed.data)
        setConfigInfo(info)
        configInfoRef.current = info
        if (!dirtyRef.current) {
          setDraft(clone(info.config))
          draftRef.current = clone(info.config)
        }
        return { ok: true }
      }, [])

      const refreshStatus = useCallback(async () => {
        const parsed = parseApiResponse(await get('/status'))
        if (!parsed.ok) {
          showError(parsed.message)
          return false
        }
        const data = parsed.data
        setStatus(data)
        errorDismissedRef.current = false
        lastErrorRef.current = ''
        setError('')
        if (!dirtyRef.current && isPlainObject(data.config)) {
          setDraft((previous) => (previous == null ? previous : deepEqual(previous, data.config) ? previous : clone(data.config)))
          setConfigInfo((previous) => (previous == null ? previous : deepEqual(previous.config, data.config) ? previous : Object.assign({}, previous, { config: data.config })))
        }
        return true
      }, [showError])

      const refreshAll = useCallback(async () => {
        setRefreshing(true)
        try {
          await Promise.all([refreshStatus(), loadConfig()])
        } finally {
          setRefreshing(false)
        }
      }, [refreshStatus, loadConfig])

      useEffect(() => {
        let alive = true
        ;(async () => {
          setLoading(true)
          const results = await Promise.all([get('/status'), get('/config')])
          if (!alive) return
          const statusParsed = parseApiResponse(results[0])
          const configParsed = parseApiResponse(results[1])
          if (statusParsed.ok) {
            setStatus(statusParsed.data)
            errorDismissedRef.current = false
            lastErrorRef.current = ''
            setError('')
          } else {
            showError(statusParsed.message)
          }
          if (configParsed.ok) {
            const info = configInfoFromPayload(configParsed.data)
            setConfigInfo(info)
            configInfoRef.current = info
            setDraft(clone(info.config))
            draftRef.current = clone(info.config)
          } else if (!statusParsed.ok) {
            showError(configParsed.message)
          }
          setLoading(false)
        })()
        return () => {
          alive = false
        }
      }, [])

      const refreshMs = useMemo(() => computeRefreshMs(configInfo && configInfo.config, configInfo && configInfo.groups), [configInfo])

      useEffect(() => {
        if (loading) return
        let alive = true
        const timer = setInterval(() => {
          if (!alive || pageHidden()) return
          refreshStatus()
        }, refreshMs)
        const onVisibility = () => {
          if (!pageHidden()) refreshStatus()
        }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
        return () => {
          alive = false
          clearInterval(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [loading, refreshMs, refreshStatus])

      const updateDraft = useCallback((updater) => {
        setDraft((previous) => {
          const next = typeof updater === 'function' ? updater(previous) : updater
          draftRef.current = next
          dirtyRef.current = true
          return next
        })
      }, [])

      const save = useCallback(async () => {
        if (saving) return false
        const body = draftRef.current
        if (!body) return false
        setSaving(true)
        const merged = mergeConfigSave(await post('/config/save', { config: body }))
        setSaving(false)
        if (!merged.ok) {
          setIssues([])
          toast('保存失败：' + merged.message, 'err')
          return false
        }
        if (merged.config) {
          setConfigInfo((previous) => (previous ? Object.assign({}, previous, { config: merged.config }) : previous))
          setDraft(clone(merged.config))
          draftRef.current = clone(merged.config)
          dirtyRef.current = false
        }
        setIssues(merged.issues)
        toast(merged.issues.length ? '已保存，有 ' + merged.issues.length + ' 条提示' : '配置已保存', 'ok')
        refreshStatus()
        return true
      }, [saving, toast, refreshStatus])

      saveRef.current = save

      const reset = useCallback(async () => {
        if (saving) return
        const confirmed = typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm('恢复默认配置？当前所有改动都会被默认值覆盖，并立即写入配置文件。') : true
        if (!confirmed) return
        setSaving(true)
        const merged = mergeConfigSave(await post('/config/reset'))
        setSaving(false)
        if (!merged.ok) {
          toast('恢复默认失败：' + merged.message, 'err')
          return
        }
        if (merged.config) {
          setConfigInfo((previous) => (previous ? Object.assign({}, previous, { config: merged.config }) : previous))
          setDraft(clone(merged.config))
          draftRef.current = clone(merged.config)
          dirtyRef.current = false
        }
        setIssues(merged.issues)
        toast('已恢复默认配置', 'ok')
        refreshStatus()
      }, [saving, toast, refreshStatus])

      const undo = useCallback(() => {
        const info = configInfoRef.current
        if (!info) return
        setDraft(clone(info.config))
        draftRef.current = clone(info.config)
        setIssues([])
        toast('已撤销未保存的改动', 'info')
      }, [toast])

      useEffect(() => {
        if (typeof window === 'undefined') return
        const onKey = (event) => {
          if ((event.ctrlKey || event.metaKey) && !event.altKey && String(event.key || '').toLowerCase() === 's') {
            if (!dirtyRef.current) return
            event.preventDefault()
            if (saveRef.current) saveRef.current()
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [])

      const applyGateway = useCallback((gateway) => {
        if (!isPlainObject(gateway)) return
        setStatus((previous) => (previous ? Object.assign({}, previous, { gateway }) : previous))
      }, [])

      const gatewayAction = useCallback(
        async (name, label) => {
          const actionLabel = label || (name === 'connect' ? '连接' : name === 'disconnect' ? '断开' : '重连')
          const parsed = parseApiResponse(await post('/' + name))
          if (!parsed.ok) {
            toast(actionLabel + '失败：' + parsed.message, 'err')
            return { ok: false, message: parsed.message }
          }
          if (parsed.data && isPlainObject(parsed.data.gateway)) applyGateway(parsed.data.gateway)
          toast(actionLabel + '成功', 'ok')
          refreshStatus()
          return { ok: true }
        },
        [applyGateway, refreshStatus, toast],
      )

      const go = useCallback((id) => setTab(id), [])

      if (loading && !status && !configInfo) {
        return h('div', { className: 'ob-root' }, h('div', { className: 'ob-wrap' }, h('div', { className: 'ob-loading' }, h('span', { className: 'ob-spin', 'aria-hidden': true }), h('span', null, '正在读取插件状态…'))))
      }

      const gateway = safeObject(status && status.gateway)
      const state = stateLabel(gateway.state)
      const login = isPlainObject(gateway.login) ? gateway.login : null
      const version = (configInfo && configInfo.version) || (status && status.version) || ''
      const tabProps = {
        status,
        configInfo,
        draft,
        updateDraft,
        toast,
        go,
        gatewayAction,
        refreshAll,
        refreshStatus,
        saving,
        dirty,
        issues,
        save,
        reset,
        undo,
      }
      let body = null
      if (tab === 'overview') body = h(Overview, tabProps)
      else if (tab === 'connect') body = h(Connect, tabProps)
      else if (tab === 'messages') body = h(Messages, tabProps)
      else if (tab === 'config') body = h(ConfigTab, tabProps)
      else if (tab === 'logs') body = h(Logs, tabProps)
      else body = h(About, tabProps)

      return h(
        'div',
        { className: 'ob-root' },
        h(
          'div',
          { className: 'ob-wrap' },
          h(
            'div',
            { className: 'ob-head' },
            h(
              'div',
              { className: 'ob-title' },
              h('h1', null, 'QQ 连接'),
              h('p', null, 'OneBot v11 接入' + (version ? ' · v' + version : '') + ' · ' + (login && login.nickname ? '登录账号 ' + String(login.nickname) : '连接 NapCat / SnowLuma / Lagrange / LLOneBot')),
            ),
            h(
              'div',
              { className: 'ob-head-actions' },
              h(
                'span',
                { className: 'ob-status', title: '网关状态' },
                h('i', { className: cx('ob-dot', state.tone), 'aria-hidden': true }),
                h('span', { className: 'ob-status-text' }, state.text),
                login && login.nickname ? h('span', { className: 'ob-status-extra' }, String(login.nickname)) : null,
              ),
              h(Btn, { small: true, onClick: () => refreshAll(), busy: refreshing }, refreshing ? '刷新中…' : '刷新'),
            ),
          ),
          error
            ? h(
                'div',
                { className: 'ob-banner err', role: 'alert' },
                h('span', { className: 'ob-banner-msg' }, error),
                h(
                  'span',
                  { className: 'ob-banner-actions' },
                  h(Btn, { small: true, onClick: () => refreshAll(), busy: refreshing }, '重试'),
                  h(IconBtn, { title: '关闭提示', label: '关闭提示', onClick: clearError }, '×'),
                ),
              )
            : null,
          h(Tabs, { tabs: TABS, current: tab, onChange: go, dirty }),
          h('div', { id: 'ob-panel-' + tab, role: 'tabpanel', 'aria-labelledby': 'ob-tab-' + tab }, body),
          dirty
            ? h(
                'div',
                { className: 'ob-savebar' },
                h('span', { className: 'ob-savebar-msg' }, '有未保存的配置改动'),
                h('span', { className: 'ob-small ob-muted' }, h('span', { className: 'ob-kbd' }, 'Ctrl'), ' + ', h('span', { className: 'ob-kbd' }, 'S')),
                h(Btn, { kind: 'ghost', onClick: undo, disabled: saving }, '撤销'),
                h(Btn, { kind: 'primary', onClick: () => save(), busy: saving, disabled: saving }, saving ? '保存中…' : '保存'),
              )
            : null,
        ),
        h(Toast, { message: toastMessage }),
      )
    }

    // =====================================================================
    // apply：注入样式 + 注册两个 slot
    // =====================================================================

    function apply(ctx) {
      try {
        applyImpl(ctx)
      } catch (error) {
        // 注册失败会让客户端 entry 变成 failed（DSH boot 页只显示 "failed"），
        // 这里补一条可读的浏览器控制台错误，便于定位。
        try {
          console.error('[dsh-onebot-qq] 面板注册失败：', error)
        } catch (inner) {}
        throw error
      }
    }

    function applyImpl(ctx) {
      if (!ctx) return
      installStyle(ctx)
      let slots = null
      try {
        slots = typeof ctx.get === 'function' ? ctx.get('slots') : undefined
      } catch (error) {
        slots = undefined
      }
      if (!slots) slots = ctx.slots
      if (!slots || typeof slots.inject !== 'function') return
      slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, OneBotPage))
      slots.inject('sidebar.panellist', () => slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => 'QQ 连接' }, OneBotIcon))
    }

    // ---- 导出（apply/inject 给 DSH，其余给测试） ----
    exports.inject = inject
    exports.apply = apply
    exports.PANEL_ID = PANEL_ID
    exports.API_PREFIX = API
    exports.STYLE_ID = STYLE_ID
    exports.PANEL_CSS = PANEL_CSS
    exports.TABS = TABS
    exports.OneBotPage = OneBotPage
    exports.OneBotIcon = OneBotIcon
    exports.Overview = Overview
    exports.Connect = Connect
    exports.Messages = Messages
    // 注意：这里刻意导出发为 ConfigTab（而不是 Config）。Cordis 把插件对象的 `Config`
    // 属性当作配置 schema，会调用 Config['~standard'].validate；面板组件若叫 Config，
    // 客户端插件激活时会直接崩溃（实测踩坑，见 test/panel.test.js 的回归用例）。
    exports.ConfigTab = ConfigTab
    exports.Logs = Logs
    exports.About = About
    exports.clampNumber = clampNumber
    exports.deepEqual = deepEqual
    exports.getByPath = getByPath
    exports.setByPath = setByPath
    exports.clone = clone
    exports.formatTime = formatTime
    exports.formatDateTime = formatDateTime
    exports.formatDuration = formatDuration
    exports.formatRelative = formatRelative
    exports.truncateText = truncateText
    exports.maskEndpoint = maskEndpoint
    exports.buildQuery = buildQuery
    exports.parseApiResponse = parseApiResponse
    exports.mergeConfigSave = mergeConfigSave
    exports.normalizeFieldSpec = normalizeFieldSpec
    exports.buildFieldSpecs = buildFieldSpecs
    exports.flattenFieldSpecs = flattenFieldSpecs
    exports.fieldSpecByPath = fieldSpecByPath
    exports.defaultsFromGroups = defaultsFromGroups
    exports.computeRefreshMs = computeRefreshMs
    exports.stateLabel = stateLabel
    exports.loginCheckLabel = loginCheckLabel
    exports.endpointModeLabel = endpointModeLabel
    exports.accountCheckLabel = accountCheckLabel
    exports.eventKindLabel = eventKindLabel
    exports.describeEvent = describeEvent
    exports.normalizeFriend = normalizeFriend
    exports.normalizeGroup = normalizeGroup
    exports.normalizeLogEntry = normalizeLogEntry
    exports.mergeIncremental = mergeIncremental
    exports.nextSince = nextSince
    exports.probeEndpointFromDraft = probeEndpointFromDraft
    exports.describeProbe = describeProbe
    exports.describeDetect = describeDetect
    exports.FIELD_TYPES = FIELD_TYPES
    exports.LOG_LEVELS = LOG_LEVELS
    exports.EVENT_KINDS = EVENT_KINDS
    exports.REFRESH_MIN = REFRESH_MIN
    exports.REFRESH_MAX = REFRESH_MAX
    return module.exports
  },
})
