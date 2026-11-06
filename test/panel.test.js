// dsh-bot 网页半边单元测试（node:test，不依赖浏览器 / 真实网关）
//
// 做法：伪造 window.__ModuleLoader__ 捕获插件注册对象，用极简 React shim 执行 factory，
// 然后断言导出的纯函数、样式契约与 apply 的 slot 注册形状。

import { test } from 'node:test'
import assert from 'node:assert/strict'

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      captured = registration
    },
  },
}

let stateOverrides = null

const reactShim = {
  createElement: (type, props, ...children) => ({ type, props: props || null, children }),
  createContext: (defaultValue) => ({ Provider: 'Provider', Consumer: 'Consumer', _default: defaultValue }),
  useContext: () => ({ mode: 'full', systemReduced: false, categories: { screen: true, async: true, reveal: true, swap: true, feedback: true, media: true } }),
  useState: (initial) => [stateOverrides?.length ? stateOverrides.shift() : typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: (initial) => ({ current: initial === undefined ? null : initial }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  Fragment: Symbol('Fragment'),
  Component: class Component {
    constructor(props) {
      this.props = props
      this.state = {}
    }
    setState() {}
  },
}

const requireShim = (name) => {
  if (name === 'react') return reactShim
  throw new Error('unexpected module: ' + name)
}

await import('../client.js')

const registration = captured
const panel = registration ? registration.factory(requireShim) : null

test('module loader：id 与 factory 形状正确', () => {
  assert.ok(registration, 'client.js 应该调用 window.__ModuleLoader__.load')
  assert.equal(registration.id, 'dsh-bot')
  assert.equal(typeof registration.factory, 'function')
  assert.ok(panel, 'factory 应该返回 module.exports')
  assert.equal(typeof panel, 'object')
})

test('导出契约：inject / apply / 组件 / 纯函数齐全', () => {
  assert.deepEqual(panel.inject, ['slots', 'theme'])
  assert.equal(typeof panel.apply, 'function')
  assert.equal(typeof panel.OneBotPage, 'function')
  assert.equal(typeof panel.OneBotIcon, 'function')
  assert.equal(panel.PANEL_ID, 'onebot-qq')
  assert.equal(panel.API_PREFIX, '/onebot-qq/api')
  for (const name of [
    'getByPath',
    'setByPath',
    'deepEqual',
    'buildFieldSpecs',
    'flattenFieldSpecs',
    'fieldSpecByPath',
    'defaultsFromGroups',
    'computeRefreshMs',
    'mergeConfigSave',
    'parseApiResponse',
    'formatTime',
    'formatDuration',
    'formatRelative',
    'maskEndpoint',
    'describeEvent',
    'normalizeLogEntry',
    'mergeIncremental',
    'nextSince',
    'describeProbe',
    'describeDetect',
    'resolveMotionMode',
    'resolveContrast',
    'motionCategories',
    'motionDisabled',
    'shouldAnimate',
    'revealDelayMs',
    'countUpValue',
    'easeOutCubic',
    'nextPresence',
    'pageTransitionClass',
    'contentTransitionFor',
    'applyConfigPatch',
    'settingsSections',
    'accentValues',
    'fontScalePercent',
    'densityMetrics',
    'contentMaxWidth',
    'normalizeUiPreferences',
    'uiRootData',
    'splitBufferValue',
    'formatCount',
    'formatNumberList',
    'bindClientTheme',
  ]) {
    assert.equal(typeof panel[name], 'function', name + ' 应该是导出的函数')
  }
  assert.equal(typeof panel.SettingsTab, 'function', '系统设置组件应导出')
  assert.equal(typeof panel.SettingsShell, 'function', '持久设置壳组件应导出')
  assert.equal(typeof panel.ContentPage, 'function', '内容页组件应导出')
  assert.equal(typeof panel.TOKEN_CSS, 'string')
  assert.equal(typeof panel.MOTION_CSS, 'string')
  assert.equal(typeof panel.ACCENT_TOKENS, 'object')
  assert.equal(typeof panel.DEFAULT_UI, 'object')
  assert.equal(panel.DEFAULT_UI.contrast, 'system')
  assert.deepEqual(
    panel.TABS.map((tab) => tab.id),
    ['overview', 'connect', 'messages', 'media', 'content', 'modules', 'backup', 'config', 'persona', 'models', 'settings', 'cognition', 'logs', 'about'],
  )
})

test('回归：module.exports 不能有 Config 属性（Cordis 把它当配置 schema，会让客户端插件激活失败）', () => {
  // Cordis 的 validateConfig 是：if (!runtime.Config) return config; runtime.Config['~standard'].validate(...)。
  // 面板组件曾经叫 Config 并挂到 exports.Config，导致真实 DSH 里 client entry 激活即崩溃
  // （TypeError: Cannot read properties of undefined (reading 'validate')），这里锁死这个坑。
  assert.equal(panel.Config, undefined, 'exports 上不能出现 Config（Cordis 保留字）')
  assert.equal(typeof panel.ConfigTab, 'function', '配置页组件应导出为 ConfigTab')
})

test('apply：注册 sidebar.panellist 与 main 两个 slot', () => {
  const injected = []
  const registered = []
  const slots = {
    inject(name, register) {
      injected.push(name)
      assert.equal(typeof register, 'function')
      register()
    },
    register(def, component) {
      registered.push({ def, component })
      return def
    },
  }
  const ctx = {
    get(key) {
      return key === 'slots' ? slots : undefined
    },
    effect() {
      return () => {}
    },
  }
  assert.doesNotThrow(() => panel.apply(ctx))
  assert.deepEqual(injected, ['main', 'sidebar.panellist'])
  assert.equal(registered.length, 2)

  const main = registered.find((entry) => entry.def.name === 'main')
  assert.ok(main, '应该注册 main')
  assert.equal(main.def.key, 'onebot-qq')
  assert.equal(typeof main.component, 'function')

  const sidebar = registered.find((entry) => entry.def.name === 'sidebar.panellist')
  assert.ok(sidebar, '应该注册 sidebar.panellist')
  assert.equal(sidebar.def.id, 'onebot-qq')
  assert.equal(sidebar.def.order, 20)
  assert.equal(typeof sidebar.def.label, 'function')
  assert.equal(sidebar.def.label(), 'QQ 连接')
  assert.equal(typeof sidebar.component, 'function')
})

test('apply：兼容 ctx.slots 写法，缺 slots 时不抛错', () => {
  const registered = []
  const slots = {
    inject(name, register) {
      register()
    },
    register(def) {
      registered.push(def)
      return def
    },
  }
  assert.doesNotThrow(() => panel.apply({ slots }))
  assert.equal(registered.length, 2)
  assert.doesNotThrow(() => panel.apply({}))
  assert.doesNotThrow(() => panel.apply(null))
})

test('OneBotPage：无网关/无 document 时可安全渲染加载骨架', () => {
  let tree = null
  assert.doesNotThrow(() => {
    tree = panel.OneBotPage()
  })
  assert.ok(tree && typeof tree === 'object')
  const json = JSON.stringify(tree)
  assert.match(json, /ob-root/)
  assert.match(json, /ob-header/, '首屏应渲染页头骨架')
  assert.match(json, /ob-stat-grid/, '首屏应渲染统计骨架')
  assert.doesNotMatch(json, /ob-tabs/, '首屏骨架不渲染真实标签栏')
  const icon = panel.OneBotIcon({ size: 18 })
  assert.ok(icon && typeof icon === 'object')
  assert.equal(icon.props.name, 'message', '侧栏图标应渲染消息图标')
})

test('全部标签页：无数据与有数据都能渲染（不依赖真实网关）', () => {  const noop = () => {}
  const baseProps = {
    status: null,
    configInfo: null,
    draft: null,
    updateDraft: noop,
    toast: noop,
    go: noop,
    gatewayAction: async () => ({ ok: true }),
    refreshAll: noop,
    refreshStatus: noop,
    runWithProgress: (task) => task(),
    now: Date.now(),
    saving: false,
    dirty: false,
    issues: [],
    save: noop,
    reset: noop,
    undo: noop,
    saveUiPatch: () => Promise.resolve(true),
    retryPrefSave: noop,
    prefStatus: { saving: false, error: '', savedAt: 0 },
  }
  const tabNames = ['Overview', 'Connect', 'Messages', 'MediaPage', 'ModulesPage', 'ContentPage', 'BackupPage', 'ConfigTab', 'PersonaTab', 'ModelTab', 'SettingsTab', 'CognitionTab', 'Logs', 'About']
  for (const name of tabNames) {
    assert.equal(typeof panel[name], 'function', name + ' 应该导出')
    assert.doesNotThrow(() => panel[name](baseProps), name + ' 空数据应可渲染')
  }

  const groups = [
    {
      id: 'basic',
      title: '基本',
      description: '基础配置',
      fields: [
        { path: 'enabled', label: '启用', type: 'switch', default: true },
        { path: 'gateway', label: '网关', type: 'select', default: 'onebot', options: [{ value: 'onebot', label: '地址' }, { value: 'snowluma', label: 'SnowLuma' }] },
        { path: 'onebot.wsUrl', label: 'WS', type: 'text', default: '' },
        { path: 'onebot.wsToken', label: 'Token', type: 'secret', default: '' },
        { path: 'ui.refreshMs', label: '刷新', type: 'number', default: 2000, min: 500, max: 60000, step: 250, unit: 'ms' },
        { path: 'events.ignoreUsers', label: '忽略', type: 'string-list', default: [] },
        { path: 'timeouts.retryDelaysMs', label: '重试', type: 'number-list', default: [1000] },
        { path: 'note', label: '备注', type: 'textarea', default: '' },
      ],
    },
    {
      id: 'ui',
      title: '界面偏好',
      description: '外观与动效',
      fields: [
        { path: 'ui.refreshMs', label: '刷新', type: 'number', default: 2000 },
        { path: 'ui.accent', label: '强调色', type: 'select', default: 'purple', options: [{ value: 'purple', label: '紫' }, { value: 'blue', label: '蓝' }, { value: 'inherit', label: '跟随 DSH' }] },
        { path: 'ui.contrast', label: '对比度', type: 'select', default: 'system', options: [{ value: 'system', label: '跟随系统' }, { value: 'high', label: '高对比度' }] },
        { path: 'ui.density', label: '密度', type: 'select', default: 'standard', options: [{ value: 'compact', label: '紧凑' }, { value: 'standard', label: '标准' }] },
        { path: 'ui.fontScale', label: '字号', type: 'select', default: 'standard', options: [{ value: 'small', label: '小' }, { value: 'standard', label: '标准' }] },
        { path: 'ui.contentWidth', label: '内容宽度', type: 'select', default: 'wide', options: [{ value: 'wide', label: '宽' }, { value: 'auto', label: '自动' }] },
        { path: 'ui.motion', label: '动效模式', type: 'select', default: 'system', options: [{ value: 'system', label: '跟随系统' }, { value: 'full', label: '始终开启' }] },
        { path: 'ui.pageTransition', label: '页面切换动画', type: 'select', default: 'default', options: [{ value: 'default', label: '默认' }, { value: 'fade', label: '淡入' }] },
      ],
    },
  ]
  const config = {
    enabled: true,
    gateway: 'onebot',
    onebot: { wsUrl: 'ws://127.0.0.1:3001', wsToken: 'secret-token', httpUrl: '', httpToken: '' },
    ui: { refreshMs: 2000, accent: 'purple', contrast: 'system', density: 'standard', fontScale: 'standard', contentWidth: 'wide', motion: 'system', pageTransition: 'default' },
    events: { ignoreUsers: ['123'] },
    timeouts: { retryDelaysMs: [1000, 3000] },
  }
  const configInfo = { config, defaults: {}, groups, version: '0.1.0', apiVersion: 1, dataDir: 'C:\\data' }
  const status = {
    ok: true,
    apiVersion: 1,
    version: '0.1.0',
    dataDir: 'C:\\data',
    config,
    gateway: {
      state: 'connected',
      configured: true,
      endpoint: { mode: 'onebot', wsConfigured: true, httpConfigured: false, wsUrlSafe: 'ws://127.0.0.1:3001', httpUrlSafe: '' },
      connectedAt: Date.now() - 5000,
      lastDisconnectAt: 0,
      lastError: '',
      reconnects: 2,
      loginAttempts: 1,
      login: { userId: '10001', nickname: '机器人' },
      loginCheck: 'ok',
      expectedBotQQ: '10001',
      accountCheck: 'warn',
      snowluma: null,
    },
    events: {
      received: 10,
      accepted: 9,
      dropped: 1,
      byKind: { message: 8, notice: 1 },
      byChat: { private: 3, group: 6, other: 0 },
      buffered: 9,
      capacity: 200,
      lastAt: Date.now(),
    },
    logs: { total: 20, buffered: 20, byLevel: { debug: 0, info: 20, warn: 0, error: 0 } },
    recentEvents: [
      {
        seq: 1,
        kind: 'message',
        time: 1700000000,
        message: { chatType: 'private', chatId: 1, sender: { userId: 2, nickname: 'A' }, text: 'hi', segments: [{ type: 'text', data: { text: 'hi' } }] },
      },
    ],
  }
  const fullProps = Object.assign({}, baseProps, { status, configInfo, draft: JSON.parse(JSON.stringify(config)) })
  for (const name of tabNames) {
    let tree = null
    assert.doesNotThrow(() => {
      tree = panel[name](fullProps)
    }, name + ' 有数据应可渲染')
    assert.ok(tree && typeof tree === 'object', name + ' 应返回 React 元素')
  }
})

test('路径读写：getByPath / setByPath / deepEqual', () => {
  const source = { onebot: { wsUrl: 'ws://a' }, ui: { refreshMs: 2000 } }
  assert.equal(panel.getByPath(source, 'onebot.wsUrl'), 'ws://a')
  assert.equal(panel.getByPath(source, 'missing.deep.path'), undefined)

  const next = panel.setByPath(source, 'onebot.wsUrl', 'ws://b')
  assert.notEqual(next, source)
  assert.equal(next.onebot.wsUrl, 'ws://b')
  assert.equal(source.onebot.wsUrl, 'ws://a', 'setByPath 不能修改入参')
  assert.equal(panel.getByPath(panel.setByPath({}, 'a.b.c', 1), 'a.b.c'), 1)

  assert.equal(panel.deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true)
  assert.equal(panel.deepEqual({ a: 1 }, { a: 1, b: undefined }), false)
  assert.equal(panel.deepEqual({ a: [1] }, { a: [1, 2] }), false)
  assert.equal(panel.deepEqual(null, null), true)
  assert.equal(panel.deepEqual(Number.NaN, Number.NaN), true)
})

test('buildFieldSpecs：数据驱动字段表降级/过滤/默认值', () => {
  const groups = [
    {
      id: 'basic',
      title: '基本',
      description: '基础配置',
      fields: [
        { path: 'enabled', label: '启用', type: 'switch', default: true, help: '帮助' },
        {
          path: 'gateway',
          label: '网关',
          type: 'select',
          default: 'onebot',
          options: [{ value: 'onebot', label: '地址' }, { value: 'snowluma' }],
        },
        { path: 'onebot.wsUrl', label: 'WS', type: 'text', default: '', placeholder: 'ws://127.0.0.1:3001' },
        { path: 'reconnect.minDelayMs', label: '等待', type: 'number', default: 2000, min: 500, max: 60000, step: 500, unit: 'ms' },
        { path: 'mystery', label: '未知类型', type: 'weird' },
        { label: '没有 path' },
        null,
      ],
    },
    { title: '没有 id', fields: [{ path: 'a.b', type: 'textarea' }] },
    { id: 'empty', fields: [] },
    'bad',
  ]
  const specs = panel.buildFieldSpecs(groups)
  assert.equal(specs.length, 2)
  assert.equal(specs[0].id, 'basic')
  assert.equal(specs[0].fields.length, 5, '没有 path 的字段应被跳过')
  const enabled = panel.fieldSpecByPath(groups, 'enabled')
  assert.equal(enabled.type, 'switch')
  assert.equal(enabled.default, true)
  assert.equal(enabled.help, '帮助')
  const gateway = panel.fieldSpecByPath(groups, 'gateway')
  assert.deepEqual(gateway.options, [
    { value: 'onebot', label: '地址' },
    { value: 'snowluma', label: 'snowluma' },
  ])
  const number = panel.fieldSpecByPath(groups, 'reconnect.minDelayMs')
  assert.equal(number.type, 'number')
  assert.equal(number.min, 500)
  assert.equal(number.max, 60000)
  assert.equal(number.step, 500)
  assert.equal(number.unit, 'ms')
  assert.equal(panel.fieldSpecByPath(groups, 'mystery').type, 'text', '未知 type 降级为 text')
  assert.equal(specs[1].id, 'group-1')
  assert.equal(specs[1].title, '没有 id')
  assert.equal(panel.flattenFieldSpecs(groups).length, 6)

  const defaults = panel.defaultsFromGroups(groups)
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.gateway, 'onebot')
  assert.equal(defaults.onebot.wsUrl, '')
  assert.equal(defaults.reconnect.minDelayMs, 2000)
  assert.deepEqual(panel.buildFieldSpecs(null), [])
  assert.deepEqual(panel.buildFieldSpecs(undefined), [])
})

test('computeRefreshMs：取自配置并 clamp 500–60000', () => {
  assert.equal(panel.computeRefreshMs({ ui: { refreshMs: 100 } }), 500)
  assert.equal(panel.computeRefreshMs({ ui: { refreshMs: 999999 } }), 60000)
  assert.equal(panel.computeRefreshMs({ ui: { refreshMs: 2500 } }), 2500)
  assert.equal(panel.computeRefreshMs({ ui: { refreshMs: '3000' } }), 3000)
  assert.equal(panel.computeRefreshMs({}, [{ id: 'ui', fields: [{ path: 'ui.refreshMs', type: 'number', default: 3000 }] }]), 3000)
  assert.equal(panel.computeRefreshMs(undefined, undefined), 2000)
  assert.equal(panel.computeRefreshMs({ ui: { refreshMs: 'abc' } }, undefined, 7000), 7000)
})

test('parseApiResponse / mergeConfigSave：统一错误形状', () => {
  assert.equal(panel.parseApiResponse(null).ok, false)
  assert.equal(panel.parseApiResponse(undefined).message, '没有收到插件响应')
  const failed = panel.parseApiResponse({ ok: false, message: '只支持 POST' })
  assert.equal(failed.ok, false)
  assert.equal(failed.message, '只支持 POST')
  assert.equal(panel.parseApiResponse({ ok: false }).message, '操作失败')
  const good = panel.parseApiResponse({ ok: true, config: {} })
  assert.equal(good.ok, true)
  assert.equal(good.data.config !== undefined, true)

  const saved = panel.mergeConfigSave({ ok: true, config: { a: 1 }, issues: ['提示一', '', 2] })
  assert.equal(saved.ok, true)
  assert.deepEqual(saved.config, { a: 1 })
  assert.deepEqual(saved.issues, ['提示一', '2'])
  const savedNoIssues = panel.mergeConfigSave({ ok: true, config: { b: 2 } })
  assert.deepEqual(savedNoIssues.issues, [])
  const saveFailed = panel.mergeConfigSave({ ok: false, message: '写盘失败' })
  assert.equal(saveFailed.ok, false)
  assert.equal(saveFailed.message, '写盘失败')
  assert.equal(saveFailed.config, null)
  assert.equal(panel.mergeConfigSave({ ok: true, config: [] }).config, null, '数组不是合法 config')
})

test('时间格式化：秒/毫秒时间戳与相对时间', () => {
  const time = panel.formatTime(1700000000000)
  assert.match(time, /^\d{2}:\d{2}:\d{2}$/)
  assert.equal(panel.formatTime(1700000000), time, 'Unix 秒与毫秒应得到同一时刻')
  assert.equal(panel.formatTime('not-a-time'), '—')
  assert.match(panel.formatDateTime(1700000000000), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)

  const now = 1700000000000
  assert.equal(panel.formatRelative(now - 3000, now), '刚刚')
  assert.equal(panel.formatRelative(now - 120000, now), '2 分钟前')
  assert.equal(panel.formatRelative(now - 7200000, now), '2 小时前')
  assert.equal(panel.formatRelative(now - 3 * 86400000, now), '3 天前')
  assert.equal(panel.formatRelative(null, now), '—')

  assert.equal(panel.formatDuration(500), '500 毫秒')
  assert.equal(panel.formatDuration(1500), '1 秒')
  assert.equal(panel.formatDuration(90000), '1 分 30 秒')
  assert.equal(panel.formatDuration(3661000), '1 小时 1 分')
  assert.equal(panel.formatDuration(90000000), '1 天 1 小时')
  assert.equal(panel.formatDuration(-1), '—')
  assert.equal(panel.formatDuration('abc'), '—')
})

test('maskEndpoint / buildQuery / truncateText', () => {
  assert.equal(panel.maskEndpoint('ws://127.0.0.1:3001?access_token=secret'), 'ws://127.0.0.1:3001?access_token=***')
  assert.equal(panel.maskEndpoint('http://user:pass@example.com:3000/api?token=x&foo=1'), 'http://example.com:3000/api?token=***&foo=1')
  assert.equal(panel.maskEndpoint('ws://127.0.0.1:3001'), 'ws://127.0.0.1:3001')
  assert.equal(panel.maskEndpoint(''), '')
  assert.equal(panel.maskEndpoint(null), '')
  assert.equal(panel.maskEndpoint('http://x/?access_token=abc'), 'http://x?access_token=***')

  assert.equal(panel.buildQuery({ since: 0, limit: 50 }), '?since=0&limit=50')
  assert.equal(panel.buildQuery({ since: 0, level: '', limit: undefined }), '?since=0')
  assert.equal(panel.buildQuery({}), '')
  assert.equal(panel.truncateText('abcdef', 4), 'abc…')
  assert.equal(panel.truncateText('abc', 10), 'abc')
})

test('状态/核验/事件标签', () => {
  assert.equal(panel.stateLabel('connected').text, '已连接')
  assert.equal(panel.stateLabel('connected').tone, 'ok')
  assert.equal(panel.stateLabel('paused').tone, 'err')
  assert.equal(panel.stateLabel('weird').text, 'weird')
  assert.equal(panel.stateLabel('').text, '未知')
  assert.equal(panel.loginCheckLabel('ok').text, '核验通过')
  assert.equal(panel.loginCheckLabel('mismatch').tone, 'err')
  assert.equal(panel.loginCheckLabel('off').text, '未开启核验')
  assert.equal(panel.eventKindLabel('message'), '消息')
  assert.equal(panel.eventKindLabel('meta_event'), '元事件')
  assert.equal(panel.endpointModeLabel('snowluma'), '从 SnowLuma 读取')
  assert.equal(panel.accountCheckLabel('enforce'), '断开并暂停自动重连')
})

test('describeEvent：消息/通知/空事件都能得到可展示结构', () => {
  const messageEvent = {
    seq: 3,
    kind: 'message',
    time: 1700000000,
    message: {
      chatType: 'group',
      chatId: 123456,
      sender: { userId: 456, nickname: '小明', card: '' },
      text: '你好',
      segments: [
        { type: 'text', data: { text: '你好' } },
        { type: 'image', data: { url: 'http://example.com/a.png' } },
      ],
      mentions: [{ userId: '789', name: '小红' }],
      images: [{ url: 'http://example.com/a.png', summary: '图' }],
    },
  }
  const described = panel.describeEvent(messageEvent)
  assert.equal(described.seq, 3)
  assert.equal(described.kind, 'message')
  assert.equal(described.kindLabel, '消息')
  assert.equal(described.chatType, 'group')
  assert.equal(described.chatLabel, '群 123456')
  assert.equal(described.senderName, '小明')
  assert.equal(described.summary, '你好')
  assert.equal(described.segments.length, 2)
  assert.equal(described.mentions.length, 1)
  assert.equal(described.images.length, 1)
  assert.match(described.time, /^\d{2}:\d{2}:\d{2}$/)

  const noticeEvent = {
    seq: 4,
    kind: 'notice',
    notice: { type: 'notice', subType: 'group_increase', groupId: 111, userId: 222 },
  }
  const notice = panel.describeEvent(noticeEvent)
  assert.match(notice.summary, /\[通知\]/)
  assert.match(notice.summary, /group_increase/)
  assert.equal(notice.chatLabel, '群 111')

  const fallback = panel.describeEvent({ kind: 'request', request: { type: 'friend' } })
  assert.match(fallback.summary, /\[请求\]/)
  const empty = panel.describeEvent(null)
  assert.equal(empty.kind, 'unknown')
  assert.doesNotThrow(() => panel.describeEvent({}))
})

test('normalizeFriend / normalizeGroup / normalizeLogEntry', () => {
  assert.deepEqual(panel.normalizeFriend({ user_id: 10001, nickname: '昵称', remark: '备注' }), {
    id: '10001',
    name: '备注',
    nickname: '昵称',
    remark: '备注',
  })
  assert.equal(panel.normalizeFriend(null).id, '')
  assert.deepEqual(panel.normalizeGroup({ group_id: 888, group_name: '群名', member_count: 42 }), {
    id: '888',
    name: '群名',
    memberCount: 42,
  })
  assert.equal(panel.normalizeGroup({}).memberCount, null)

  const entry = panel.normalizeLogEntry({ seq: 1, t: 1700000000000, level: 'weird', area: 'gateway', text: 'hi' })
  assert.equal(entry.level, 'info')
  assert.equal(entry.area, 'gateway')
  assert.equal(entry.text, 'hi')
  assert.match(entry.time, /^\d{2}:\d{2}:\d{2}$/)
  assert.equal(panel.normalizeLogEntry({ level: 'warn', time: '12:00:00' }).time, '12:00:00')
})

test('mergeIncremental / nextSince：增量去重与游标', () => {
  const merged = panel.mergeIncremental(
    [{ seq: 2, text: 'old' }, { seq: 1 }],
    [{ seq: 2, text: 'new' }, { seq: 3 }, { bad: true }],
  )
  assert.deepEqual(merged.map((item) => item.seq), [1, 2, 3])
  assert.equal(merged[1].text, 'new', '同 seq 用新数据覆盖')
  assert.deepEqual(panel.mergeIncremental(null, null), [])
  assert.equal(panel.nextSince([], 5), 5)
  assert.equal(panel.nextSince([{ seq: 1 }, { seq: 7 }], 0), 7)
  assert.equal(panel.nextSince(null, 3), 3)
})

test('probeEndpointFromDraft / describeProbe / describeDetect', () => {
  const endpoint = panel.probeEndpointFromDraft({ gateway: 'snowluma', onebot: { wsUrl: 'ws://a', httpUrl: 'http://b', wsToken: 't', httpToken: 'u', httpAuth: 'bearer' } })
  assert.equal(endpoint.mode, 'snowluma')
  assert.equal(endpoint.wsUrl, 'ws://a')
  assert.equal(endpoint.httpAuth, 'bearer')
  assert.deepEqual(panel.probeEndpointFromDraft(null), {
    mode: 'onebot',
    wsUrl: '',
    httpUrl: '',
    wsToken: '',
    httpToken: '',
    httpAuth: '',
  })

  // 真实 manager.probe() 形状：{ ok, url, httpStatus, elapsedMs, login, message }
  const probeOk = panel.describeProbe({
    ok: true,
    probe: { ok: true, url: 'http://127.0.0.1:3000/get_login_info', httpStatus: 200, elapsedMs: 12, login: { userId: '1', nickname: '机器人' } },
  })
  assert.equal(probeOk.ok, true)
  assert.equal(probeOk.endpointHint, 'http://127.0.0.1:3000/get_login_info')
  assert.equal(probeOk.httpStatus, 200)
  assert.equal(probeOk.elapsedMs, 12)
  assert.deepEqual(probeOk.login, { userId: '1', nickname: '机器人' })
  // 也兼容契约里提到的 endpointHint 字段
  assert.equal(panel.describeProbe({ ok: true, probe: { ok: true, endpointHint: 'http://hint' } }).endpointHint, 'http://hint')
  const probeFail = panel.describeProbe({ ok: true, probe: { ok: false, message: '连不上网关：ECONNREFUSED', url: 'http://127.0.0.1:3000' } })
  assert.equal(probeFail.ok, false)
  assert.equal(probeFail.error, '连不上网关：ECONNREFUSED')
  assert.equal(panel.describeProbe({ ok: false, message: '未开启' }).ok, false)

  // 真实 snowluma.detectGateway() 形状：endpoint 只有脱敏后的 safeUrl。
  const detect = panel.describeDetect({
    ok: true,
    mode: 'onebot',
    source: 'snowluma',
    reason: '',
    snowluma: { installed: true, dir: 'C:\\SnowLuma', version: '2.0.0', reason: '' },
    endpoint: { httpUrlSafe: 'http://127.0.0.1:3000', wsUrlSafe: 'ws://127.0.0.1:3001', httpConfigured: true, wsConfigured: true, source: 'snowluma' },
  })
  assert.equal(detect.ok, true)
  assert.equal(detect.snowluma.installed, true)
  assert.equal(detect.snowluma.dir, 'C:\\SnowLuma')
  assert.equal(detect.snowluma.endpointFound, true)
  assert.equal(detect.endpoint.httpUrl, 'http://127.0.0.1:3000')
  assert.equal(detect.endpoint.wsUrl, 'ws://127.0.0.1:3001')
  assert.equal(detect.endpoint.source, 'snowluma')
  assert.equal(panel.describeDetect({ ok: false, message: '检测失败' }).ok, false)
})

test('样式契约：令牌唯一色值 / 动效唯一 keyframes / 面板样式消费变量', () => {
  const token = panel.TOKEN_CSS
  const motion = panel.MOTION_CSS
  const css = panel.PANEL_CSS

  // 令牌块：console-web 浅色/暗色 palette、强调色、密度/字号/宽度与动效变量
  assert.match(token, /--ob-canvas:#f6f7fb/)
  assert.match(token, /--ob-surface:#ffffff/)
  assert.match(token, /body\[data-ds-dark-theme\] \.ob-root/)
  assert.match(token, /--ob-canvas:#0d111c/)
  for (const accent of ['purple', 'blue', 'green', 'orange', 'inherit']) {
    assert.match(token, new RegExp("\\[data-accent='" + accent + "'\\]"), '缺少强调色 ' + accent)
  }
  assert.match(token, /\[data-density='compact'\]/)
  assert.match(token, /\[data-density='comfortable'\]/)
  assert.match(token, /\[data-font-scale='large'\]/)
  assert.match(token, /\[data-content-width='wide'\]/)
  assert.match(token, /\[data-contrast='high'\]/)
  assert.match(token, /--ob-preview-light-canvas:/)
  assert.match(token, /--ob-preview-dark-canvas:/)
  assert.match(token, /--ob-dur-fast:120ms/)
  assert.match(token, /--ob-dur-standard:180ms/)
  assert.match(token, /--ob-dur-slow:240ms/)
  assert.match(token, /--ob-ease:cubic-bezier\(0\.2,0\.8,0\.2,1\)/)

  // 动效块：语义配方 + reduced/off 降级
  for (const name of ['ob-content-rise', 'ob-swap-in', 'ob-reveal-rise', 'ob-feedback-enter', 'ob-feedback-exit', 'ob-feed-in', 'ob-progress-grow', 'ob-ping', 'ob-pulse']) {
    assert.match(motion, new RegExp('@keyframes ' + name), '缺少 keyframe ' + name)
  }
  assert.match(motion, /\.ob-enter-default/)
  assert.match(motion, /\.ob-swap\{/)
  assert.match(motion, /\[data-motion='reduced'\]/)
  assert.match(motion, /\[data-motion='off'\]/)
  assert.match(motion, /prefers-reduced-motion: reduce/)

  // 面板块：只用变量；无裸色值/裸字重/动画声明/UI 库
  assert.match(css, /\.ob-root/)
  assert.match(css, /\.ob-tabs/)
  assert.match(css, /\.ob-panel/)
  assert.match(css, /\.ob-settings-nav/)
  assert.match(css, /\.ob-option-card/)
  assert.match(css, /\.ob-theme-preview/)
  assert.match(css, /\.ob-state/)
  assert.match(css, /\.ob-savebar/)
  assert.match(css, /\.ob-toast/)
  assert.match(css, /\.ob-stat-value/)
  assert.match(css, /@media \(pointer:coarse\)/)
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, '组件样式不应写死十六进制颜色（应消耗 --ob-* 令牌）')
  assert.doesNotMatch(css, /font-weight\s*:\s*\d/, '组件样式不应写裸字重（应消耗 --ob-weight-* 令牌）')
  assert.doesNotMatch(css, /@keyframes|animation\s*:/, '组件样式不应声明动画（动效统一放 MOTION_CSS）')
  assert.doesNotMatch(css + token + motion, /@import|tailwind|bootstrap|antd|element-plus/i)
})

test('Motion Policy：system/full/reduced/off 与系统偏好矩阵', () => {
  assert.equal(panel.resolveMotionMode('system', false), 'full')
  assert.equal(panel.resolveMotionMode('system', true), 'reduced')
  assert.equal(panel.resolveMotionMode('full', true), 'full', 'full 显式覆盖系统减少动效')
  assert.equal(panel.resolveMotionMode('reduced', false), 'reduced')
  assert.equal(panel.resolveMotionMode('off', false), 'off')
  assert.equal(panel.resolveMotionMode('weird', false), 'full', '非法值回退 system')
  assert.equal(panel.motionDisabled('reduced'), true)
  assert.equal(panel.motionDisabled('off'), true)
  assert.equal(panel.motionDisabled('full'), false)
  assert.deepEqual(panel.motionCategories('off'), { screen: false, async: false, reveal: false, swap: false, feedback: false, media: false })
  assert.equal(panel.shouldAnimate('full', 'reveal'), true)
  assert.equal(panel.shouldAnimate('reduced', 'reveal'), false)
  assert.equal(panel.shouldAnimate('full', 'nope'), false)
})

test('动效数值：reveal stagger / count-up / presence / page transition', () => {
  assert.equal(panel.revealDelayMs(0), 0)
  assert.equal(panel.revealDelayMs(1), 40)
  assert.equal(panel.revealDelayMs(3), 120)
  assert.equal(panel.revealDelayMs(9), 120, 'stagger 上限 120ms')
  assert.equal(panel.revealDelayMs(-1), 0)

  assert.equal(panel.easeOutCubic(0), 0)
  assert.equal(panel.easeOutCubic(1), 1)
  assert.equal(panel.countUpValue(0, 100, 0), 0)
  assert.equal(panel.countUpValue(0, 100, 1), 100)
  assert.equal(panel.countUpValue(10, 20, 0.5), 19)
  assert.equal(panel.countUpValue(0, 10, 2), 10, 'progress 超出范围会 clamp')
  assert.equal(panel.countUpValue(0, 'abc', 0.5), 'abc')

  assert.equal(panel.nextPresence('unmounted', true), 'enter')
  assert.equal(panel.nextPresence('enter', true), 'stable')
  assert.equal(panel.nextPresence('enter', false), 'exit')
  assert.equal(panel.nextPresence('stable', false), 'exit')
  assert.equal(panel.nextPresence('exit', true), 'enter', '快速反转安全')
  assert.equal(panel.nextPresence('exit', false), 'unmounted')

  assert.equal(panel.pageTransitionClass('default'), 'ob-enter-default')
  assert.equal(panel.pageTransitionClass('fade-slide'), 'ob-enter-slide')
  assert.equal(panel.pageTransitionClass('fade-up'), 'ob-enter-up')
  assert.equal(panel.pageTransitionClass('fade-down'), 'ob-enter-down')
  assert.equal(panel.pageTransitionClass('fade'), 'ob-enter-fade')
  assert.equal(panel.pageTransitionClass('none'), '')
  assert.equal(panel.pageTransitionClass('zoom'), 'ob-enter-default', '非法值回退 default')
})

test('外观偏好：accent/density/fontScale/contentWidth/motion/pageTransition/contrast 映射与回退', () => {
  const prefs = panel.normalizeUiPreferences({
    accent: 'blue',
    density: 'compact',
    fontScale: 'large',
    contentWidth: 'standard',
    motion: 'reduced',
    pageTransition: 'fade',
    contrast: 'high',
  })
  assert.deepEqual(prefs, { accent: 'blue', density: 'compact', fontScale: 'large', contentWidth: 'standard', motion: 'reduced', pageTransition: 'fade', contrast: 'high' })
  const fallback = panel.normalizeUiPreferences({ accent: 'magenta', density: 'huge', motion: 'sometimes', contrast: 'ultra' })
  assert.equal(fallback.accent, 'purple')
  assert.equal(fallback.density, 'standard')
  assert.equal(fallback.motion, 'system')
  assert.equal(fallback.contrast, 'system')
  assert.deepEqual(panel.normalizeUiPreferences(null), {
    accent: 'purple',
    density: 'standard',
    fontScale: 'standard',
    contentWidth: 'wide',
    motion: 'system',
    pageTransition: 'default',
    contrast: 'system',
  })

  const root = panel.uiRootData(prefs, false, false)
  assert.deepEqual(root, {
    'data-accent': 'blue',
    'data-density': 'compact',
    'data-font-scale': 'large',
    'data-content-width': 'standard',
    'data-motion': 'reduced',
    'data-page-transition': 'fade',
    'data-contrast': 'high',
  })
  assert.equal(panel.uiRootData({ motion: 'system' }, true)['data-motion'], 'reduced')
  assert.equal(panel.uiRootData({ motion: 'full' }, true)['data-motion'], 'full')

  // 对比度：system 跟随 prefers-contrast；standard/high 显式生效；非法值回退 system。
  assert.equal(panel.resolveContrast('system', false), 'standard')
  assert.equal(panel.resolveContrast('system', true), 'high')
  assert.equal(panel.resolveContrast('standard', true), 'standard')
  assert.equal(panel.resolveContrast('high', false), 'high')
  assert.equal(panel.resolveContrast('weird', true), 'high')
  assert.equal(panel.uiRootData({}, false, false)['data-contrast'], 'standard')
  assert.equal(panel.uiRootData({}, false, true)['data-contrast'], 'high')

  assert.equal(panel.accentValues('purple', false).brand, '#5d49d6')
  assert.equal(panel.accentValues('purple', true).brand, '#9b8cff')
  assert.equal(panel.accentValues('inherit', false), null)
  assert.equal(panel.fontScalePercent('small'), 93.75)
  assert.equal(panel.fontScalePercent('large'), 112.5)
  assert.equal(panel.fontScalePercent('weird'), 100)
  assert.equal(panel.densityMetrics('compact').control, '2.25rem')
  assert.equal(panel.densityMetrics('weird').control, '2.75rem')
  assert.equal(panel.contentMaxWidth('standard'), '72rem')
  assert.equal(panel.contentMaxWidth('auto'), 'none')
  assert.equal(panel.contentMaxWidth('weird'), '100rem')
})

test('ConfigTab 过滤 ui 组；SettingsTab 渲染持久壳分类', () => {
  const groups = [
    { id: 'basic', title: '基本', fields: [{ path: 'enabled', label: '启用', type: 'switch', default: true }] },
    { id: 'ui', title: '界面偏好', fields: [{ path: 'ui.accent', label: '强调色', type: 'select', default: 'purple', options: [{ value: 'purple', label: '紫' }] }] },
  ]
  const config = { enabled: true, ui: { accent: 'purple' } }
  const configInfo = { config, defaults: {}, groups, version: '0.3.0', apiVersion: 1, dataDir: 'C:\\data' }
  const baseProps = {
    status: null,
    configInfo,
    draft: JSON.parse(JSON.stringify(config)),
    updateDraft: () => {},
    toast: () => {},
    go: () => {},
    gatewayAction: async () => ({ ok: true }),
    refreshAll: () => {},
    refreshStatus: () => {},
    runWithProgress: (task) => task(),
    now: Date.now(),
    saving: false,
    dirty: false,
    issues: [],
    save: () => {},
    reset: () => {},
    undo: () => {},
    saveUiPatch: () => Promise.resolve(true),
    retryPrefSave: () => {},
    prefStatus: { saving: false, error: '', savedAt: 0 },
  }
  const configJson = JSON.stringify(panel.ConfigTab(baseProps))
  assert.doesNotMatch(configJson, /界面偏好/, '配置页不应再渲染 ui 分组')
  assert.match(configJson, /保存与重置/)
  const settingsJson = JSON.stringify(panel.SettingsTab(baseProps))
  assert.match(settingsJson, /外观/)
  assert.match(settingsJson, /DSH 主题/)
  assert.match(settingsJson, /即时保存/)
})

test('设置壳转场：配置/系统设置强制 fade，其它页签使用配置值', () => {
  assert.equal(panel.contentTransitionFor('config', 'fade-slide'), 'fade')
  assert.equal(panel.contentTransitionFor('settings', 'fade-up'), 'fade')
  assert.equal(panel.contentTransitionFor('settings', 'none'), 'fade')
  assert.equal(panel.contentTransitionFor('overview', 'fade-slide'), 'fade-slide')
  assert.equal(panel.contentTransitionFor('logs', 'fade-up'), 'fade-up')
  assert.equal(panel.contentTransitionFor('about', 'bogus'), 'default')
  assert.equal(panel.contentTransitionFor('messages', 'none'), 'none')
})

test('applyConfigPatch：多字段不可变合并', () => {
  const base = { ui: { accent: 'purple', contrast: 'system' }, onebot: { wsUrl: 'ws://a' }, enabled: true }
  const next = panel.applyConfigPatch(base, { 'ui.accent': 'blue', 'ui.contrast': 'high' })
  assert.equal(next.ui.accent, 'blue')
  assert.equal(next.ui.contrast, 'high')
  assert.equal(next.onebot.wsUrl, 'ws://a')
  assert.equal(next.enabled, true)
  assert.equal(base.ui.accent, 'purple', '不能修改入参')
  const nested = panel.applyConfigPatch({}, { 'ui.motion': 'reduced', 'onebot.httpUrl': 'http://b' })
  assert.equal(nested.ui.motion, 'reduced')
  assert.equal(nested.onebot.httpUrl, 'http://b')
  assert.deepEqual(panel.applyConfigPatch(null, null), {})
})

test('settingsSections：ui 字段分类、未知字段落到 other、无 ui 组时只保留主题/重置', () => {
  const groups = [
    {
      id: 'ui',
      title: '界面偏好',
      fields: [
        { path: 'ui.accent', label: '强调色', type: 'select', default: 'purple', options: [{ value: 'purple', label: '紫' }] },
        { path: 'ui.contrast', label: '对比度', type: 'select', default: 'system', options: [{ value: 'high', label: '高' }] },
        { path: 'ui.density', label: '密度', type: 'select', default: 'standard', options: [{ value: 'compact', label: '紧凑' }] },
        { path: 'ui.motion', label: '动效模式', type: 'select', default: 'system', options: [{ value: 'full', label: '开' }] },
        { path: 'ui.pageTransition', label: '页面切换动画', type: 'select', default: 'default', options: [{ value: 'fade', label: '淡入' }] },
        { path: 'ui.futureThing', label: '未来字段', type: 'text', default: '' },
        { path: 'ui.refreshMs', label: '刷新间隔', type: 'number', default: 2000 },
      ],
    },
  ]
  const sections = panel.settingsSections(groups)
  const ids = sections.map((section) => section.id)
  assert.deepEqual(ids, ['appearance', 'layout', 'data', 'motion', 'other', 'reset'])
  const appearance = sections.find((section) => section.id === 'appearance')
  assert.deepEqual(appearance.fields.map((field) => field.path), ['ui.accent', 'ui.contrast'])
  const layout = sections.find((section) => section.id === 'layout')
  assert.deepEqual(layout.fields.map((field) => field.path), ['ui.density'])
  const data = sections.find((section) => section.id === 'data')
  assert.deepEqual(data.fields.map((field) => field.path), ['ui.refreshMs'])
  const motion = sections.find((section) => section.id === 'motion')
  assert.deepEqual(motion.fields.map((field) => field.path), ['ui.motion', 'ui.pageTransition'])
  const other = sections.find((section) => section.id === 'other')
  assert.deepEqual(other.fields.map((field) => field.path), ['ui.futureThing'])
  const reset = sections.find((section) => section.id === 'reset')
  assert.deepEqual(reset.fields, [])

  const empty = panel.settingsSections([])
  assert.deepEqual(empty.map((section) => section.id), ['appearance', 'reset'])
  assert.deepEqual(empty[0].fields, [])
})

test('格式化与缓冲值：formatCount / splitBufferValue', () => {
  assert.equal(panel.formatCount(0), '0')
  assert.equal(panel.formatCount(999), '999')
  assert.equal(panel.formatCount(1000), '1,000')
  assert.equal(panel.formatCount(1234567), '1,234,567')
  assert.equal(panel.formatCount('abc'), 'abc')
  assert.deepEqual(panel.splitBufferValue('2 / 200'), { used: 2, capacity: 200 })
  assert.deepEqual(panel.splitBufferValue('0/1'), { used: 0, capacity: 1 })
  assert.equal(panel.splitBufferValue('anything'), null)
  assert.equal(panel.splitBufferValue(null), null)
  assert.equal(panel.formatNumberList([1000, 3000]), '1000, 3000')
  assert.equal(panel.formatNumberList(null), '')
})


test('BackupPage: status/list render, staged restore defaults false and apply requires permission', async () => {
  const id = '20261106T000000000Z-deadbeef'
  const calls = []
  const originalFetch = globalThis.fetch
  const nodes = (tree) => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.children), ...nodes(tree.props?.actions)]
  const render = (allowRestore) => {
    stateOverrides = [{ status: { enabled: true, snapshotCount: 1, maxSnapshots: 10, maxBytes: 209715200, allowRestore }, items: [{ id, createdAt: '2026-11-06T00:00:00Z', note: 'before change', bytes: 100, files: 2, includeMedia: false }] }, false, false, '', '', false, 'restore-' + id]
    try { return panel.BackupPage({ toast() {} }) } finally { stateOverrides = null }
  }
  globalThis.fetch = async (path, init) => {
    calls.push({ path, body: init.body ? JSON.parse(init.body) : null })
    return { ok: true, json: async () => path.endsWith('/restore') ? { ok: true, stagedPath: 'restore-' + id } : { ok: true, status: {}, items: [] } }
  }
  try {
    const tree = render(false)
    const text = JSON.stringify(tree)
    assert.match(text, /before change/)
    assert.match(text, /restore-20261106/)
    assert.match(text, /重启/)
    assert.match(text, /密钥/)
    const buttons = nodes(tree)
    const stage = buttons.find((node) => node.children?.includes('暂存恢复'))
    const apply = buttons.find((node) => node.children?.includes('应用恢复'))
    assert.equal(apply.props.disabled, true)
    await stage.props.onClick()
    assert.deepEqual(calls[0], { path: panel.API_PREFIX + '/backup/restore', body: { id, apply: false } })
    const permitted = nodes(render(true)).find((node) => node.children?.includes('应用恢复'))
    assert.equal(permitted.props.disabled, false)
    await permitted.props.onClick()
    assert.ok(calls.some((call) => call.path.endsWith('/restore') && call.body.apply === true))
  } finally { globalThis.fetch = originalFetch }
})
