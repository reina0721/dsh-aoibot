// 插件配置：默认值 + 规范化/校验 + 持久化 + 面板字段表。
//
// 设计原则（见 docs/ARCHITECTURE.md）：
// 1. 所有算法参数（重连退避、超时、重试、缓冲容量、过滤规则…）都必须是配置项；
// 2. 默认值集中在 DEFAULTS，面板字段表由 CONFIG_GROUPS 数据驱动（UI 不写死表单）；
// 3. 配置写在数据目录 config.json，原子写；损坏时回退默认值并记录问题。

import { dataDir, readJson, writeJson, existsSync } from './store.js'
import { registerSecret, clearSecrets } from './redact.js'

export const CONFIG_VERSION = 1
export const CONFIG_FILE = 'config.json'

export const DEFAULTS = {
  version: CONFIG_VERSION,
  // 总开关：插件启动后是否自动连接（面板上随时可以手动连接）
  enabled: true,
  // 网关类型：onebot = 直接连你填的 OneBot v11 地址；snowluma = 从 SnowLuma 配置里自动读地址
  gateway: 'onebot',
  // 机器人 QQ 号（用于登录核验；留空则不核验账号，只展示）
  botQQ: '',
  // 账号不一致时的策略：off 不检查；warn 只警告；enforce 断开并暂停自动重连
  accountCheck: 'warn',
  onebot: {
    wsUrl: '',
    httpUrl: '',
    wsToken: '',
    httpToken: '',
    // HTTP 调用时 token 的携带方式：bearer = Authorization: Bearer；header-token = X-Access-Token；
    // query = ?access_token=（部分网关只认这种）
    httpAuth: 'bearer',
  },
  snowluma: {
    // SnowLuma 安装目录（含 index.mjs 与 config/）；留空 = 尝试从默认位置探测
    dir: '',
    // 指定读取哪个账号的 OneBot 配置（onebot_<uin>.json）；留空 = 自动扫描
    uin: '',
    autoDetect: true,
  },
  reconnect: {
    enabled: true,
    minDelayMs: 2000,
    maxDelayMs: 30000,
    factor: 2,
    jitterRatio: 0.2,
  },
  timeouts: {
    callMs: 30000,
    connectMs: 10000,
    verifyMs: 10000,
    probeMs: 3000,
    maxRetries: 3,
    retryDelaysMs: [1000, 3000, 5000],
  },
  verification: {
    enabled: true,
    // 核验期间暂存的事件上限，核验通过后按序补发
    bufferSize: 100,
  },
  events: {
    enabled: true,
    bufferSize: 200,
    includeSelfMessages: true,
    kinds: { message: true, notice: true, request: true, meta_event: true },
    messageSubTypes: { private: true, group: true },
    ignoreUsers: [],
    ignoreGroups: [],
    // 原始事件落盘/展示时的截断上限，防止一条超大消息撑爆内存
    rawMaxBytes: 16384,
    persist: { enabled: false, file: 'events.jsonl', maxMB: 32 },
  },
  logging: {
    level: 'info',
    bufferSize: 500,
    persist: { enabled: false },
    redact: true,
  },
  ui: {
    refreshMs: 2000,
    eventPageSize: 50,
    logPageSize: 100,
    // 以下外观/动效偏好全部由面板「界面」分组读写并持久化；client.js 不写死这些值。
    // 取值与 console-web 的 appearance preferences 对齐（accent/density/fontScale/motion/pageTransition）。
    accent: 'purple', // purple | blue | green | orange | inherit
    density: 'standard', // compact | standard | comfortable
    fontScale: 'standard', // small | standard | large
    contentWidth: 'wide', // standard(72rem) | wide(100rem) | auto
    motion: 'system', // system | full | reduced | off
    pageTransition: 'default', // default | fade | fade-slide | fade-up | fade-down | none
  },
  security: {
    // 面板「高级」里透传任意 OneBot action（调试用，默认关）
    allowRawAction: false,
  },
}

/**
 * 面板字段表：数据驱动渲染，新增配置项只要在这里加一条。
 * type: switch | text | secret | number | select | string-list | number-list | textarea
 */
export const CONFIG_GROUPS = [
  {
    id: 'basic',
    title: '基本',
    description: '插件开关、网关类型与机器人账号。',
    fields: [
      { path: 'enabled', label: '启用并自动连接', type: 'switch', default: true, help: '插件加载后按当前配置自动连接 QQ 网关。' },
      {
        path: 'gateway', label: '网关类型', type: 'select', default: 'onebot',
        options: [
          { value: 'onebot', label: '连接已有 OneBot v11 地址（NapCat / SnowLuma / Lagrange / LLOneBot）' },
          { value: 'snowluma', label: '从 SnowLuma 安装目录自动读取地址' },
        ],
        help: '「连接已有地址」只连接你填的地址，不启动、不注入任何进程；SnowLuma 模式只读取它自己的配置。',
      },
      { path: 'botQQ', label: '机器人 QQ 号', type: 'text', default: '', placeholder: '例如 123456789', help: '连上后用 get_login_info 核验登录账号；留空则只提示、不拦截。' },
      {
        path: 'accountCheck', label: '账号不一致时', type: 'select', default: 'warn',
        options: [
          { value: 'off', label: '不检查' },
          { value: 'warn', label: '只警告（推荐）' },
          { value: 'enforce', label: '断开并暂停自动重连' },
        ],
      },
    ],
  },
  {
    id: 'endpoint',
    title: '连接地址',
    description: 'OneBot v11 的正向 WebSocket 与 HTTP 地址。HTTP 留空时所有调用走 WS。',
    fields: [
      { path: 'onebot.wsUrl', label: 'WebSocket 地址', type: 'text', default: '', placeholder: 'ws://127.0.0.1:3001', help: '用于实时接收事件；NapCat 的「正向 WebSocket」、SnowLuma 的 wsServers。' },
      { path: 'onebot.httpUrl', label: 'HTTP 地址', type: 'text', default: '', placeholder: 'http://127.0.0.1:3000', help: '用于调用发送消息等接口；留空则全部走 WS。' },
      { path: 'onebot.wsToken', label: 'WS access token', type: 'secret', default: '', placeholder: '没有就留空' },
      { path: 'onebot.httpToken', label: 'HTTP access token', type: 'secret', default: '', placeholder: '没有就留空' },
      {
        path: 'onebot.httpAuth', label: 'HTTP token 携带方式', type: 'select', default: 'bearer',
        options: [
          { value: 'bearer', label: 'Authorization: Bearer <token>（NapCat / SnowLuma 标准做法）' },
          { value: 'header-token', label: 'X-Access-Token: <token>（非标准，仅特定网关）' },
          { value: 'query', label: 'URL 参数 ?access_token=<token>' },
        ],
        help: 'OneBot v11 规范没有定义鉴权头；NapCat 与 SnowLuma 优先认 Authorization: Bearer，也支持 ?access_token=。',
      },
      { path: 'reconnect.enabled', label: '断线自动重连', type: 'switch', default: true },
      { path: 'reconnect.minDelayMs', label: '首次重连等待', type: 'number', default: 2000, min: 500, max: 60000, step: 500, unit: 'ms' },
      { path: 'reconnect.maxDelayMs', label: '最大重连等待', type: 'number', default: 30000, min: 1000, max: 300000, step: 1000, unit: 'ms' },
      { path: 'reconnect.factor', label: '退避倍数', type: 'number', default: 2, min: 1.1, max: 5, step: 0.1, help: '每次重连失败后等待时间乘以这个系数。' },
      { path: 'reconnect.jitterRatio', label: '重连抖动比例', type: 'number', default: 0.2, min: 0, max: 1, step: 0.05, help: '0.2 = 等待时间上下浮动 20%，避免同时重连。' },
    ],
  },
  {
    id: 'snowluma',
    title: 'SnowLuma 地址读取',
    description: 'SnowLuma 模式下从它自己的 config/onebot*.json 读取端口与 token。本插件不下载、不启动、不注入 SnowLuma。',
    fields: [
      { path: 'snowluma.autoDetect', label: '自动探测安装目录', type: 'switch', default: true, help: '在常见路径与 PATH 中寻找 SnowLuma。' },
      { path: 'snowluma.dir', label: 'SnowLuma 安装目录', type: 'text', default: '', placeholder: 'C:\\SnowLuma（含 index.mjs）' },
      { path: 'snowluma.uin', label: '账号 UIN', type: 'text', default: '', placeholder: '留空自动扫描', help: '对应 config/onebot_<uin>.json；多账号时指定更稳。' },
    ],
  },
  {
    id: 'timeouts',
    title: '超时与重试',
    description: '所有网络调用的超时与重试策略。',
    fields: [
      { path: 'timeouts.callMs', label: '接口调用超时', type: 'number', default: 30000, min: 1000, max: 120000, step: 1000, unit: 'ms' },
      { path: 'timeouts.connectMs', label: '连接超时', type: 'number', default: 10000, min: 1000, max: 120000, step: 1000, unit: 'ms' },
      { path: 'timeouts.verifyMs', label: '账号核验超时', type: 'number', default: 10000, min: 1000, max: 120000, step: 1000, unit: 'ms' },
      { path: 'timeouts.probeMs', label: '探测超时', type: 'number', default: 3000, min: 1000, max: 60000, step: 500, unit: 'ms' },
      { path: 'timeouts.maxRetries', label: '网络错误重试次数', type: 'number', default: 3, min: 0, max: 10, step: 1 },
      { path: 'timeouts.retryDelaysMs', label: '每次重试等待（毫秒）', type: 'number-list', default: [1000, 3000, 5000] },
      { path: 'verification.enabled', label: '连上后核验登录账号', type: 'switch', default: true },
      { path: 'verification.bufferSize', label: '核验期间暂存事件上限', type: 'number', default: 100, min: 10, max: 1000, step: 10 },
    ],
  },
  {
    id: 'events',
    title: '事件',
    description: '事件接收、过滤与缓冲。事件是后续认知/记忆插件的输入。',
    fields: [
      { path: 'events.enabled', label: '接收并缓存事件', type: 'switch', default: true },
      { path: 'events.bufferSize', label: '内存缓冲条数', type: 'number', default: 200, min: 10, max: 2000, step: 10 },
      { path: 'events.includeSelfMessages', label: '包含机器人自己发的消息', type: 'switch', default: true },
      { path: 'events.kinds.message', label: '消息事件', type: 'switch', default: true },
      { path: 'events.kinds.notice', label: '通知事件（撤回/戳一戳/群成员变化等）', type: 'switch', default: true },
      { path: 'events.kinds.request', label: '请求事件（加好友/加群）', type: 'switch', default: true },
      { path: 'events.kinds.meta_event', label: '元事件（心跳/生命周期）', type: 'switch', default: true },
      { path: 'events.messageSubTypes.private', label: '私聊消息', type: 'switch', default: true },
      { path: 'events.messageSubTypes.group', label: '群聊消息', type: 'switch', default: true },
      { path: 'events.ignoreUsers', label: '忽略这些 QQ 号', type: 'string-list', default: [], placeholder: '输入 QQ 号后回车' },
      { path: 'events.ignoreGroups', label: '忽略这些群号', type: 'string-list', default: [], placeholder: '输入群号后回车' },
      { path: 'events.rawMaxBytes', label: '原始事件截断上限', type: 'number', default: 16384, min: 1024, max: 262144, step: 1024, unit: 'bytes' },
      { path: 'events.persist.enabled', label: '事件落盘（JSONL）', type: 'switch', default: false },
      { path: 'events.persist.file', label: '事件文件名', type: 'text', default: 'events.jsonl' },
      { path: 'events.persist.maxMB', label: '事件文件上限', type: 'number', default: 32, min: 1, max: 512, step: 1, unit: 'MB' },
    ],
  },
  {
    id: 'logging',
    title: '日志',
    description: '日志级别、缓冲容量与落盘。',
    fields: [
      { path: 'logging.level', label: '日志级别', type: 'select', default: 'info', options: [
        { value: 'debug', label: 'debug（最详细）' },
        { value: 'info', label: 'info' },
        { value: 'warn', label: 'warn' },
        { value: 'error', label: 'error' },
      ] },
      { path: 'logging.bufferSize', label: '日志缓冲条数', type: 'number', default: 500, min: 50, max: 2000, step: 50 },
      { path: 'logging.persist.enabled', label: '日志落盘', type: 'switch', default: false },
    ],
  },
  {
    id: 'ui',
    title: '界面',
    description: '面板刷新、列表分页与外观偏好。外观偏好保存后立即生效，不需要重连。',
    fields: [
      { path: 'ui.refreshMs', label: '状态刷新间隔', type: 'number', default: 2000, min: 500, max: 60000, step: 250, unit: 'ms' },
      { path: 'ui.eventPageSize', label: '事件列表每页条数', type: 'number', default: 50, min: 10, max: 500, step: 10 },
      { path: 'ui.logPageSize', label: '日志列表每页条数', type: 'number', default: 100, min: 10, max: 500, step: 10 },
      {
        path: 'ui.accent', label: '强调色', type: 'select', default: 'purple',
        options: [
          { value: 'purple', label: '紫（console-web 默认）' },
          { value: 'blue', label: '蓝' },
          { value: 'green', label: '绿' },
          { value: 'orange', label: '橙' },
          { value: 'inherit', label: '跟随 DSH 主题（黑白）' },
        ],
        help: '只影响本面板的品牌色/选中态/焦点环；不改变 DSH 其它界面。',
      },
      {
        path: 'ui.density', label: '界面密度', type: 'select', default: 'standard',
        options: [
          { value: 'compact', label: '紧凑' },
          { value: 'standard', label: '标准' },
          { value: 'comfortable', label: '舒适' },
        ],
        help: '调整控件高度与面板内距；紧凑密度不缩小可点击区域到 32px 以下。',
      },
      {
        path: 'ui.fontScale', label: '界面字号', type: 'select', default: 'standard',
        options: [
          { value: 'small', label: '小（93.75%）' },
          { value: 'standard', label: '标准（100%）' },
          { value: 'large', label: '大（112.5%）' },
        ],
      },
      {
        path: 'ui.contentWidth', label: '内容宽度', type: 'select', default: 'wide',
        options: [
          { value: 'standard', label: '标准（72rem）' },
          { value: 'wide', label: '宽（100rem）' },
          { value: 'auto', label: '自动铺满' },
        ],
      },
      {
        path: 'ui.motion', label: '动效模式', type: 'select', default: 'system',
        options: [
          { value: 'system', label: '跟随系统（推荐）' },
          { value: 'full', label: '始终开启' },
          { value: 'reduced', label: '减少动效' },
          { value: 'off', label: '关闭动效' },
        ],
        help: '减少/关闭会停用进场、切换、数字滚动等动画；页面内容仍然可用。',
      },
      {
        path: 'ui.pageTransition', label: '页面切换动画', type: 'select', default: 'default',
        options: [
          { value: 'default', label: '默认（轻抬升 + 淡入）' },
          { value: 'fade', label: '淡入（无位移）' },
          { value: 'fade-slide', label: '自右轻移入' },
          { value: 'fade-up', label: '自下轻移入' },
          { value: 'fade-down', label: '自上轻移入' },
          { value: 'none', label: '关闭切换动画' },
        ],
        help: '只控制标签页内容切换；关闭后其它动效（悬停、状态脉冲等）仍保留。',
      },
    ],
  },
  {
    id: 'security',
    title: '安全',
    description: '调试与危险操作开关。',
    fields: [
      { path: 'security.allowRawAction', label: '允许面板透传任意 OneBot action', type: 'switch', default: false, help: '仅调试用；开启后面板可以向网关发送任意 v11 接口调用。' },
    ],
  },
]

// ---------------------------------------------------------------------------
// 路径与深合并
// ---------------------------------------------------------------------------

export function getPath(obj, path) {
  return String(path).split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj)
}

export function setPath(obj, path, value) {
  const keys = String(path).split('.')
  let cur = obj
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {}
    cur = cur[keys[i]]
  }
  cur[keys[keys.length - 1]] = value
  return obj
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 深合并：patch 覆盖 base；两边都是对象时递归；数组整体替换。 */
export function deepMerge(base, patch) {
  if (Array.isArray(base)) return Array.isArray(patch) ? [...patch] : clone(base)
  if (!isPlainObject(base)) return patch === undefined ? base : clone(patch)
  const out = {}
  for (const [key, value] of Object.entries(base)) out[key] = clone(value)
  if (isPlainObject(patch)) {
    for (const [key, value] of Object.entries(patch)) {
      out[key] = key in out && (isPlainObject(out[key]) || Array.isArray(out[key])) ? deepMerge(out[key], value) : clone(value)
    }
  }
  return out
}

export function clone(value) {
  if (value === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(value))
  } catch (error) {
    return value
  }
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

function pickBool(value, def) {
  return typeof value === 'boolean' ? value : def
}

function pickNumber(value, def, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return def
  const clamped = Math.min(max, Math.max(min, n))
  return integer ? Math.round(clamped) : Number(clamped.toFixed(6))
}

function pickEnum(value, def, allowed) {
  return allowed.includes(value) ? value : def
}

function pickString(value, def, { max = 4096 } = {}) {
  if (typeof value !== 'string') return def
  const s = value.trim()
  return s.length > max ? s.slice(0, max) : s
}

function pickStringArray(value, def, { maxItems = 500 } = {}) {
  if (!Array.isArray(value)) return clone(def)
  const out = []
  for (const item of value) {
    const s = String(item ?? '').trim()
    if (!s) continue
    if (!out.includes(s)) out.push(s.slice(0, 64))
    if (out.length >= maxItems) break
  }
  return out
}

function pickNumberArray(value, def, { min = 0, max = 600000, maxItems = 20 } = {}) {
  if (!Array.isArray(value)) return clone(def)
  const out = value
    .map((item) => Number(item))
    .filter((n) => Number.isFinite(n))
    .slice(0, maxItems)
    .map((n) => Math.min(max, Math.max(min, Math.round(n))))
  return out.length ? out : clone(def)
}

/**
 * 规范化配置：与 DEFAULTS 深合并 + 逐字段校验；返回 { config, issues }。
 * 非法值回退默认值，issues 里记录可读说明（面板/日志可见）。
 */
export function normalizeConfig(raw) {
  const issues = []
  const src = isPlainObject(raw) ? raw : {}
  const merged = deepMerge(DEFAULTS, src)

  if (isPlainObject(raw) && raw.version !== undefined && raw.version !== CONFIG_VERSION) {
    issues.push(`配置版本 ${raw.version} 与当前版本 ${CONFIG_VERSION} 不一致，已按当前版本补齐默认值`)
  }
  if (isPlainObject(raw) === false && raw != null) {
    issues.push('配置文件不是 JSON 对象，已使用默认值')
  }

  const cfg = {
    version: CONFIG_VERSION,
    enabled: pickBool(merged.enabled, DEFAULTS.enabled),
    gateway: pickEnum(merged.gateway, DEFAULTS.gateway, ['onebot', 'snowluma']),
    botQQ: pickString(merged.botQQ, DEFAULTS.botQQ, { max: 32 }).replace(/\s+/g, ''),
    accountCheck: pickEnum(merged.accountCheck, DEFAULTS.accountCheck, ['off', 'warn', 'enforce']),
    onebot: {
      wsUrl: normalizeUrl(merged.onebot?.wsUrl, DEFAULTS.onebot.wsUrl, ['ws:', 'wss:'], (msg) => issues.push(msg)),
      httpUrl: normalizeUrl(merged.onebot?.httpUrl, DEFAULTS.onebot.httpUrl, ['http:', 'https:'], (msg) => issues.push(msg)),
      wsToken: pickString(merged.onebot?.wsToken, '', { max: 1024 }),
      httpToken: pickString(merged.onebot?.httpToken, '', { max: 1024 }),
      httpAuth: pickEnum(merged.onebot?.httpAuth, DEFAULTS.onebot.httpAuth, ['bearer', 'header-token', 'query']),
    },
    snowluma: {
      autoDetect: pickBool(merged.snowluma?.autoDetect, DEFAULTS.snowluma.autoDetect),
      dir: pickString(merged.snowluma?.dir, '', { max: 1024 }),
      uin: pickString(merged.snowluma?.uin, '', { max: 32 }).replace(/\D/g, ''),
    },
    reconnect: {
      enabled: pickBool(merged.reconnect?.enabled, DEFAULTS.reconnect.enabled),
      minDelayMs: pickNumber(merged.reconnect?.minDelayMs, DEFAULTS.reconnect.minDelayMs, { min: 500, max: 60000 }),
      maxDelayMs: pickNumber(merged.reconnect?.maxDelayMs, DEFAULTS.reconnect.maxDelayMs, { min: 1000, max: 300000 }),
      factor: pickNumber(merged.reconnect?.factor, DEFAULTS.reconnect.factor, { min: 1.1, max: 5 }),
      jitterRatio: pickNumber(merged.reconnect?.jitterRatio, DEFAULTS.reconnect.jitterRatio, { min: 0, max: 1 }),
    },
    timeouts: {
      callMs: pickNumber(merged.timeouts?.callMs, DEFAULTS.timeouts.callMs, { min: 1000, max: 120000 }),
      connectMs: pickNumber(merged.timeouts?.connectMs, DEFAULTS.timeouts.connectMs, { min: 1000, max: 120000 }),
      verifyMs: pickNumber(merged.timeouts?.verifyMs, DEFAULTS.timeouts.verifyMs, { min: 1000, max: 120000 }),
      probeMs: pickNumber(merged.timeouts?.probeMs, DEFAULTS.timeouts.probeMs, { min: 1000, max: 60000 }),
      maxRetries: pickNumber(merged.timeouts?.maxRetries, DEFAULTS.timeouts.maxRetries, { min: 0, max: 10, integer: true }),
      retryDelaysMs: pickNumberArray(merged.timeouts?.retryDelaysMs, DEFAULTS.timeouts.retryDelaysMs, { min: 0, max: 600000 }),
    },
    verification: {
      enabled: pickBool(merged.verification?.enabled, DEFAULTS.verification.enabled),
      bufferSize: pickNumber(merged.verification?.bufferSize, DEFAULTS.verification.bufferSize, { min: 10, max: 1000, integer: true }),
    },
    events: {
      enabled: pickBool(merged.events?.enabled, DEFAULTS.events.enabled),
      bufferSize: pickNumber(merged.events?.bufferSize, DEFAULTS.events.bufferSize, { min: 10, max: 2000, integer: true }),
      includeSelfMessages: pickBool(merged.events?.includeSelfMessages, DEFAULTS.events.includeSelfMessages),
      kinds: {
        message: pickBool(merged.events?.kinds?.message, DEFAULTS.events.kinds.message),
        notice: pickBool(merged.events?.kinds?.notice, DEFAULTS.events.kinds.notice),
        request: pickBool(merged.events?.kinds?.request, DEFAULTS.events.kinds.request),
        meta_event: pickBool(merged.events?.kinds?.meta_event, DEFAULTS.events.kinds.meta_event),
      },
      messageSubTypes: {
        private: pickBool(merged.events?.messageSubTypes?.private, DEFAULTS.events.messageSubTypes.private),
        group: pickBool(merged.events?.messageSubTypes?.group, DEFAULTS.events.messageSubTypes.group),
      },
      ignoreUsers: pickStringArray(merged.events?.ignoreUsers, DEFAULTS.events.ignoreUsers),
      ignoreGroups: pickStringArray(merged.events?.ignoreGroups, DEFAULTS.events.ignoreGroups),
      rawMaxBytes: pickNumber(merged.events?.rawMaxBytes, DEFAULTS.events.rawMaxBytes, { min: 1024, max: 262144, integer: true }),
      persist: {
        enabled: pickBool(merged.events?.persist?.enabled, DEFAULTS.events.persist.enabled),
        file: normalizeFileName(merged.events?.persist?.file, DEFAULTS.events.persist.file),
        maxMB: pickNumber(merged.events?.persist?.maxMB, DEFAULTS.events.persist.maxMB, { min: 1, max: 512, integer: true }),
      },
    },
    logging: {
      level: pickEnum(merged.logging?.level, DEFAULTS.logging.level, ['debug', 'info', 'warn', 'error']),
      bufferSize: pickNumber(merged.logging?.bufferSize, DEFAULTS.logging.bufferSize, { min: 50, max: 2000, integer: true }),
      persist: { enabled: pickBool(merged.logging?.persist?.enabled, DEFAULTS.logging.persist.enabled) },
      redact: pickBool(merged.logging?.redact, DEFAULTS.logging.redact),
    },
    ui: {
      refreshMs: pickNumber(merged.ui?.refreshMs, DEFAULTS.ui.refreshMs, { min: 500, max: 60000 }),
      eventPageSize: pickNumber(merged.ui?.eventPageSize, DEFAULTS.ui.eventPageSize, { min: 10, max: 500, integer: true }),
      logPageSize: pickNumber(merged.ui?.logPageSize, DEFAULTS.ui.logPageSize, { min: 10, max: 500, integer: true }),
      // 外观/动效偏好：枚举非法时回退默认值，与 console-web 的 preference 校验语义一致。
      accent: pickEnum(merged.ui?.accent, DEFAULTS.ui.accent, ['purple', 'blue', 'green', 'orange', 'inherit']),
      density: pickEnum(merged.ui?.density, DEFAULTS.ui.density, ['compact', 'standard', 'comfortable']),
      fontScale: pickEnum(merged.ui?.fontScale, DEFAULTS.ui.fontScale, ['small', 'standard', 'large']),
      contentWidth: pickEnum(merged.ui?.contentWidth, DEFAULTS.ui.contentWidth, ['standard', 'wide', 'auto']),
      motion: pickEnum(merged.ui?.motion, DEFAULTS.ui.motion, ['system', 'full', 'reduced', 'off']),
      pageTransition: pickEnum(merged.ui?.pageTransition, DEFAULTS.ui.pageTransition, ['default', 'fade', 'fade-slide', 'fade-up', 'fade-down', 'none']),
    },
    security: {
      allowRawAction: pickBool(merged.security?.allowRawAction, DEFAULTS.security.allowRawAction),
    },
  }

  if (cfg.reconnect.minDelayMs > cfg.reconnect.maxDelayMs) {
    cfg.reconnect.minDelayMs = cfg.reconnect.maxDelayMs
    issues.push('reconnect.minDelayMs 大于 maxDelayMs，已按 maxDelayMs 收敛')
  }
  if (cfg.gateway === 'onebot' && !cfg.onebot.wsUrl && !cfg.onebot.httpUrl) {
    issues.push('尚未填写 OneBot WebSocket / HTTP 地址，插件不会自动建立连接')
  }
  return { config: cfg, issues }
}

function normalizeUrl(value, def, allowedProtocols, report) {
  const raw = pickString(value, def, { max: 2048 })
  if (!raw) return ''
  try {
    const url = new URL(raw)
    if (!allowedProtocols.includes(url.protocol)) {
      report?.(`地址协议 ${url.protocol} 不受支持（需要 ${allowedProtocols.join(' / ')}）：${raw}`)
      return ''
    }
    return raw
  } catch (error) {
    report?.(`地址格式不正确：${raw}`)
    return ''
  }
}

function normalizeFileName(value, def) {
  const name = pickString(value, def, { max: 128 })
  const safe = name.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '')
  return safe || def
}

// ---------------------------------------------------------------------------
// 读写
// ---------------------------------------------------------------------------

export function configFile() {
  return dataDir(CONFIG_FILE)
}

/** 读取配置；文件不存在时用默认值并写出一份（让用户知道文件在哪）。 */
export function loadConfig({ rowConfig } = {}) {
  const file = configFile()
  let raw = readJson(file, null)
  if (raw == null) {
    raw = isPlainObject(rowConfig) ? deepMerge(DEFAULTS, rowConfig) : clone(DEFAULTS)
    const { config } = normalizeConfig(raw)
    try {
      writeJson(file, config)
    } catch (error) {}
    refreshSecrets(config)
    return config
  }
  const { config, issues } = normalizeConfig(raw)
  const normalized = { config, issues }
  refreshSecrets(config)
  return normalized.config
}

/** 保存配置（先规范化再原子写），返回 { config, issues }。 */
export function saveConfig(next) {
  const { config, issues } = normalizeConfig(next)
  writeJson(configFile(), config)
  refreshSecrets(config)
  return { config, issues }
}

/** 恢复默认值并写盘。 */
export function resetConfig() {
  return saveConfig(clone(DEFAULTS))
}

/** 面板/接口展示用：不含任何运行时状态。 */
export function publicConfig(config) {
  return clone(config)
}

/** 把当前配置里的 token 登记进脱敏器。 */
export function refreshSecrets(config) {
  clearSecrets()
  try {
    registerSecret(config?.onebot?.wsToken)
    registerSecret(config?.onebot?.httpToken)
  } catch (error) {}
}

export function defaultConfig() {
  return clone(DEFAULTS)
}

export function configExists() {
  return existsSync(configFile())
}
