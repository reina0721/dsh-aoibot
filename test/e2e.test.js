// 宿主插件端到端测试：用假 DSH 宿主（test/helpers/fake-dsh.js）挂载 src/host.js，
// 用内存 OneBot v11 假网关（test/helpers/mock-onebot.js）模拟 NapCat / SnowLuma。
//
// 覆盖：
//   1. 启动即注册 REST 路由：/health、/status、/config、/modules 的形状与默认值；
//   2. 配置保存热应用、恢复默认、非法值回退 + issues；
//   3. POST /connect → WS 连接 + get_login_info 账号核验（loginCheck='ok'）；
//   4. 账号不一致：warn 只告警不断线；enforce 断开并 paused；
//   5. 核验期间事件缓冲不丢，核验后按序补发到 /events；
//   6. 事件过滤器：ignoreUsers / ignoreGroups / kinds 生效；
//   7. POST /send → send_group_msg / send_private_msg 参数正确；
//   8. POST /disconnect、GET /logs、POST /logs/clear。
//
// 隔离：每个用例独立临时数据目录（DSH_BOT_DATA_DIR）+ 独立 mock 网关；
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

test('e2e: archive import API accepts JSON, dedupes, validates bodies and disabled config', async (t) => {
  const { fake } = await boot(t)
  const body = { content: '[{"text":"archive API 旧档案"}]', scopeType: 'private', scopeId: '12345' }
  const imported = await postJson(fake, '/cognition/import', body)
  assert.equal(imported.imported, 1)
  assert.equal(imported.format, 'json')
  assert.equal((await postJson(fake, '/cognition/import', body)).skipped, 1)
  const memories = await getJson(fake, '/cognition/memories?query=archive&scopeType=private&scopeId=12345')
  assert.equal(memories.items.length, 1)
  assert.equal(memories.items[0].source, 'import')
  for (const invalid of [null, [], { content: {} }, { content: 'secret-marker broken JSON' }, { ...body, scopeId: 'bad' }, { ...body, scopeType: null }, { ...body, scopeId: null }, { ...body, format: 'xml' }]) {
    const response = await fake.call(API + '/cognition/import', invalid, { method: 'POST' })
    assert.equal(response.json.ok, false)
    assert.ok(response.json.message)
    assert.doesNotMatch(response.json.message, /secret-marker/)
  }
  await patchConfig(fake, { cognition: { import: { enabled: false } } })
  const disabled = await fake.call(API + '/cognition/import', body, { method: 'POST' })
  assert.equal(disabled.json.ok, false)
  assert.match(disabled.json.message, /禁用/)
})

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
  const previousDataDir = process.env.DSH_BOT_DATA_DIR
  process.env.DSH_BOT_DATA_DIR = dir

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
    if (previousDataDir === undefined) delete process.env.DSH_BOT_DATA_DIR
    else process.env.DSH_BOT_DATA_DIR = previousDataDir
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

test('product rename preserves OneBot API and config event contract', async (t) => {
  const { fake } = await boot(t, { rowConfig: {} })
  const health = await getJson(fake, '/health')
  assert.ok(health)
  await patchConfig(fake, { enabled: false })
  assert.ok(fake.emitted.some(event => event.name === 'onebot-qq/config'))
})

test('媒体表情包 API：上传、列表与按 ID 读取图片', async (t) => {
  const { fake } = await boot(t, { rowConfig: {} })
  const bytes = Buffer.from('e2e-png-bytes')
  const uploaded = await postJson(fake, '/media/stickers/upload', {
    name: 'e2e.png', mime: 'image/png', data: bytes.toString('base64'),
  })
  assert.ok(uploaded.item.id)
  assert.equal('path' in uploaded.item, false)
  assert.equal('file' in uploaded.item, false)

  const listed = await getJson(fake, '/media/stickers')
  assert.equal(listed.items.length, 1)
  assert.equal(listed.items[0].id, uploaded.item.id)

  const file = await fake.call(API + '/media/stickers/file?id=' + encodeURIComponent(uploaded.item.id), undefined, { method: 'GET' })
  assert.equal(file.status, 200)
  assert.equal(file.headers['content-type'], 'image/png')
  assert.equal(file.text, bytes.toString('utf8'))
})

// ---------------------------------------------------------------------------
// 1. 启动即注册的接口形状
// ---------------------------------------------------------------------------

test('模型 API：provider CRUD/选中/公开返回不包含密钥', { timeout: 20000 }, async (t) => {
  const { fake } = await boot(t, { rowConfig: {} })
  await t.test('初始预置与协议表', async () => {
    const data = await getJson(fake, '/models')
    assert.ok(Array.isArray(data.presets) && data.presets.length >= 10)
    assert.ok(Array.isArray(data.protocols) && data.protocols.some((item) => item.id === 'openai-completions'))
    assert.ok(data.protocols.some((item) => item.id === 'anthropic-messages'))
    assert.ok(data.protocols.some((item) => item.id === 'gemini-generate-content'))
  })
  const saved = await postJson(fake, '/models/provider', {
    provider: {
      id: 'e2e-openai', name: 'E2E OpenAI', protocol: 'openai-completions',
      baseUrl: 'https://example.test/v1', requestPath: '/chat/completions', modelsPath: '/models',
      auth: { type: 'bearer', header: 'Authorization', prefix: 'Bearer ' },
      apiKey: 'e2e-secret-key-12345678', apiKeyEnv: 'E2E_OPENAI_API_KEY',
      models: [{ id: 'e2e-model' }],
    },
  })
  assert.equal(saved.provider.id, 'e2e-openai')
  assert.equal(saved.provider.hasApiKey, true)
  assert.equal(saved.provider.apiKeyHint, '…5678')
  assert.equal(Object.prototype.hasOwnProperty.call(saved.provider, 'apiKey'), false)
  assert.ok(!JSON.stringify(saved).includes('e2e-secret-key-12345678'))

  const selected = await postJson(fake, '/models/select', { provider: 'e2e-openai', model: 'e2e-model' })
  assert.equal(selected.selected.model, 'e2e-model')
  const listed = await getJson(fake, '/models')
  assert.equal(listed.selected.provider, 'e2e-openai')
  assert.ok(!JSON.stringify(listed).includes('e2e-secret-key-12345678'))

  await postJson(fake, '/models/provider/delete', { providerId: 'e2e-openai' })
  const after = await getJson(fake, '/models')
  assert.equal(after.selected, null)
  assert.ok(!Array.isArray(after.providers) || !after.providers.some((item) => item.id === 'e2e-openai'))
})

test('人格 profile API：读取默认、编辑持久化、群聊模式写入 config', { timeout: 20000 }, async (t) => {
  const { fake } = await boot(t, { rowConfig: {} })
  const initial = await getJson(fake, '/cognition/persona')
  assert.ok(initial.persona && initial.persona.profile)
  assert.equal(typeof initial.persona.profile.displayName, 'string')
  assert.ok(Array.isArray(initial.personas) && initial.personas.length >= 1)
  assert.ok(initial.activeId)
  const firstId = initial.activeId || initial.persona.id

  const edited = await postJson(fake, '/cognition/persona/edit', {
    profile: {
      displayName: 'E2E 小Q',
      personality: '温和、直接',
      speakingStyle: '短句',
      likes: ['猫', '音乐'],
      boundaries: ['不编造事实'],
    },
    reason: 'ui',
  })
  assert.equal(edited.result.persona.profile.displayName, 'E2E 小Q')
  assert.deepEqual(edited.result.persona.profile.likes, ['猫', '音乐'])
  assert.ok(edited.result.changes.some((change) => change.key === 'profile.displayName'))

  const persisted = await getJson(fake, '/cognition/persona')
  assert.equal(persisted.persona.profile.displayName, 'E2E 小Q')
  assert.equal(persisted.activeId, firstId)

  const created = await postJson(fake, '/cognition/persona/create', { name: 'E2E 第二人格' })
  assert.equal(created.persona.profile.displayName, 'E2E 第二人格')
  assert.equal(created.activeId, created.persona.id)
  assert.ok(created.personas.some((item) => item.id === firstId))
  assert.ok(created.personas.some((item) => item.id === created.persona.id && item.active === true))
  const afterCreate = await getJson(fake, '/cognition/persona')
  assert.equal(afterCreate.persona.profile.displayName, 'E2E 第二人格')

  const dataAll = await getJson(fake, '/cognition/persona/data?personaId=all')
  assert.ok(Array.isArray(dataAll.items) && dataAll.items.length >= 2)
  assert.ok(dataAll.items.some((item) => item.id === firstId && item.groups))
  const dataSecond = await getJson(fake, '/cognition/persona/data?personaId=' + encodeURIComponent(created.persona.id))
  assert.ok(dataSecond.summary && Array.isArray(dataSecond.summary.groups))
  const copiedData = await postJson(fake, '/cognition/persona/data/copy', {
    from: firstId,
    to: created.persona.id,
    groups: ['memory', 'emotion'],
  })
  assert.equal(copiedData.ok, true)
  assert.deepEqual(copiedData.groups.sort(), ['emotion', 'memory'])

  const switched = await postJson(fake, '/cognition/persona/switch', { personaId: firstId })
  assert.equal(switched.activeId, firstId)
  assert.equal(switched.persona.profile.displayName, 'E2E 小Q')

  const deleted = await postJson(fake, '/cognition/persona/delete', { personaId: created.persona.id })
  assert.equal(deleted.activeId, firstId)
  assert.equal(deleted.personas.length, 1)

  const lastDelete = await fake.call(API + '/cognition/persona/delete', { personaId: firstId }, { method: 'POST' })
  assert.equal(lastDelete.json.ok, false)
  assert.equal(lastDelete.json.code, 'LAST_PERSONA')

  const imported = await postJson(fake, '/cognition/persona/import', {
    name: 'E2E 导入人格',
    profile: { displayName: 'E2E 导入人格', identity: '导入测试', personality: '温和', speakingStyle: '短句' },
    traits: { extraversion: 0.55, warmth: 0.75 },
    style: { formality: 0.2, warmth: 0.8 },
    values: ['尊重边界'],
    source: { repo: 'https://example.invalid/persona', commit: 'abc', version: 'test' },
  })
  assert.equal(imported.activeId, imported.persona.id)
  assert.equal(imported.persona.profile.displayName, 'E2E 导入人格')
  assert.equal(imported.persona.traits.extraversion, 0.55)
  assert.equal(imported.persona.source.commit, 'abc')
  assert.equal(imported.personas.length, 2)
  const importedList = await getJson(fake, '/cognition/persona')
  assert.equal(importedList.persona.profile.identity, '导入测试')
  const importedDelete = await postJson(fake, '/cognition/persona/delete', { personaId: imported.persona.id })
  assert.equal(importedDelete.activeId, firstId)
  assert.equal(importedDelete.personas.length, 1)

  const saved = await patchConfig(fake, { cognition: { turn: { groupReplyMode: 'all', groupReplyProbability: 0.5 } } })
  assert.equal(saved.config.cognition.turn.groupReplyMode, 'all')
  assert.equal(saved.config.cognition.turn.groupReplyProbability, 0.5)
  const config = await getJson(fake, '/config')
  assert.equal(config.config.cognition.turn.groupReplyMode, 'all')
})

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
  assert.equal(status.config.version, 2)

  // /modules：未安装本地模块时返回空列表，不暴露数据目录路径
  const modules = await getJson(fake, '/modules')
  assert.deepEqual(modules.items, [])

  const backup = await getJson(fake, '/backup')
  assert.equal(backup.status.enabled, true)
  assert.equal(backup.status.allowRestore, false)
  assert.equal(backup.status.snapshotCount, 0)
  assert.deepEqual(backup.items, [])

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

  // 配置文件确实写到 DSH_BOT_DATA_DIR，且 token 不被改写
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
// 6b. 访问控制
// ---------------------------------------------------------------------------

test('访问控制 allowlist：非白名单消息不入事件/不回复，白名单与主人正常', { timeout: 25000 }, async (t) => {
  const owner = '10001'
  const group = '30001'
  const otherGroup = '30002'
  const stranger = '10002'
  const { fake, mock } = await boot(t, {
    rowConfig: (m) => ({
      ...endpointConfig(m),
      access: { mode: 'allowlist', ownerQQ: owner, private: [], groups: [group] },
    }),
  })
  await waitForLoginCheck(fake, 'ok')

  mock.pushPrivateMessage({ userId: stranger, message: 'blocked-private-秘密' })
  mock.pushGroupMessage({ groupId: otherGroup, userId: stranger, message: 'blocked-group-秘密' })
  mock.pushGroupMessage({ groupId: group, userId: stranger, message: 'allowed-group-可见' })
  mock.pushPrivateMessage({ userId: owner, message: 'allowed-owner-可见' })

  const stats = await waitFor(async () => {
    const data = await getJson(fake, '/access/stats')
    return data.counters?.inboundBlocked >= 2 && data.counters?.inboundAllowed >= 2 ? data : null
  }, { label: '访问控制计数' })
  assert.equal(stats.mode, 'allowlist')
  assert.equal(stats.ownerQQ, owner)
  assert.equal(stats.configured, true)

  const listed = await waitFor(async () => {
    const data = await getJson(fake, '/events')
    const text = JSON.stringify(data.items || data.events || [])
    return text.includes('allowed-owner-可见') && text.includes('allowed-group-可见') ? text : null
  }, { label: '白名单事件进入缓冲' })
  assert.ok(!listed.includes('blocked-private-秘密'), '被拒私聊不应进入事件缓冲')
  assert.ok(!listed.includes('blocked-group-秘密'), '被拒群聊不应进入事件缓冲')
  assert.equal(mock.sent('send_group_msg').length, 0, '认知不应给被拒会话发消息')

  const denied = await postJson(fake, '/access/check', { chatType: 'group', chatId: otherGroup, senderId: stranger })
  assert.equal(denied.allowed, false)
  assert.match(denied.reasonText, /群白名单/)
  const allowed = await postJson(fake, '/access/check', { chatType: 'private', chatId: owner, senderId: owner })
  assert.equal(allowed.allowed, true)
  assert.match(allowed.reasonText, /主人/)

  const status = await getJson(fake, '/status')
  assert.equal(status.access.mode, 'allowlist')
  assert.equal(status.access.counters.inboundBlocked, 2)
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

test('升级 API：默认零联网、手动检查、缓存/force 与真实错误', async (t) => {
  const originalFetch = globalThis.fetch
  let calls = 0, response = null
  globalThis.fetch = async () => { calls++; if (!response) throw new Error('unexpected network'); return response }
  t.after(() => { globalThis.fetch = originalFetch })
  const { fake } = await boot(t, { rowConfig: { enabled: false } })
  const upgrade = await getJson(fake, '/upgrade')
  assert.equal(upgrade.enabled, false)
  assert.equal(upgrade.channel, 'stable')
  assert.equal(upgrade.repo, 'reina0721/dsh-bot')
  assert.equal(upgrade.cached, null)
  assert.equal(upgrade.checkedAt, null)
  const status = await getJson(fake, '/status')
  assert.equal(upgrade.current, status.version)
  const { ok, ...upgradeStatus } = upgrade
  assert.deepEqual(status.upgrade, upgradeStatus)
  const result = await fake.call(API + '/upgrade/check', { force: true }, { method: 'POST' })
  assert.equal(result.json.ok, false)
  assert.match(result.json.message, /升级检查未启用/)
  assert.equal(calls, 0)

  await patchConfig(fake, { ops: { upgrade: { enabled: true, channel: 'beta' } } })
  assert.equal((await getJson(fake, '/upgrade')).enabled, true)
  assert.equal((await getJson(fake, '/status')).upgrade.cached, null)
  assert.equal(calls, 0, '启用与状态读取也不联网')
  response = { ok: true, json: async () => [{ draft: false, prerelease: true, tag_name: 'v0.12.0-beta.1', published_at: '2026-11-06T00:00:00Z', body: 'release notes' }] }
  const checked = await postJson(fake, '/upgrade/check', {})
  assert.equal(checked.latest, 'v0.12.0-beta.1')
  assert.equal(checked.updateAvailable, true)
  assert.equal(checked.channel, 'beta')
  assert.deepEqual((await getJson(fake, '/upgrade')).cached, checked)
  assert.deepEqual((await getJson(fake, '/status')).upgrade.cached, checked)
  await postJson(fake, '/upgrade/check', {})
  assert.equal(calls, 1, 'GET 状态和缓存命中均无新请求')
  await postJson(fake, '/upgrade/check', { force: true })
  assert.equal(calls, 2)
  response = { ok: false, status: 403 }
  const failed = await fake.call(API + '/upgrade/check', { force: true }, { method: 'POST' })
  assert.equal(failed.json.ok, false)
  assert.match(failed.json.message, /GitHub HTTP 403/)
  assert.deepEqual((await getJson(fake, '/upgrade')).cached, checked, '错误不会伪造或替换上次成功结果')
  assert.equal(calls, 3)
})

test('media image routes: disabled zero provider calls, local generate/edit results, no auto-send', async (t) => {
  const originalFetch = globalThis.fetch
  const calls = []
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  process.env.DSH_E2E_IMAGE_KEY = 'fake-image-key'
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    assert.ok(String(url).startsWith('https://image-provider.test/v1/images/'))
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
  }
  t.after(() => { globalThis.fetch = originalFetch; delete process.env.DSH_E2E_IMAGE_KEY })
  const { fake, mock } = await boot(t, { rowConfig: { enabled: false } })
  for (const path of ['/media/image/generate', '/media/image/edit']) {
    const result = await fake.call(API + path, { prompt: 'cat', path: 'source.png' }, { method: 'POST' })
    assert.equal(result.json.ok, false)
    assert.ok(result.json.message.includes('未启用'))
  }
  assert.equal(calls.length, 0)
  await patchConfig(fake, { media: { enabled: true, images: { generateEnabled: true, editEnabled: true, generateBaseUrl: 'https://image-provider.test/v1', generateApiKeyEnv: 'DSH_E2E_IMAGE_KEY' } } })
  const generated = await postJson(fake, '/media/image/generate', { prompt: 'cat', size: '512x512' })
  assert.equal(generated.size, '512x512')
  const status = await getJson(fake, '/media/status')
  assert.equal(status.images.generate.configured, true)
  assert.deepEqual(await readFile(join(status.dir, generated.path)), png)
  const edited = await postJson(fake, '/media/image/edit', { prompt: 'blue', path: generated.path })
  assert.deepEqual(await readFile(join(status.dir, edited.path)), png)
  assert.equal(calls.length, 2)
  assert.ok(calls[1].init.body instanceof FormData)
  for (const payload of [{ prompt: 'cat', path: '../outside.png' }, { prompt: 'cat', path: generated.path, size: 'auto' }]) {
    const rejected = await fake.call(API + '/media/image/edit', payload, { method: 'POST' })
    assert.equal(rejected.json.ok, false)
  }
  assert.equal(calls.length, 2)
  assert.equal(mock.calls.filter((call) => ['send_group_msg', 'send_private_msg'].includes(call.action)).length, 0)
})

test('e2e: timeline archive route imports current persona events and filters scope without adding memories', async (t) => {
  const { fake } = await boot(t)
  const at = Date.parse('2020-01-01T00:00:00Z')
  const body = { kind: 'timeline', format: 'jsonl', content: JSON.stringify({ kind: 'timeline', title: 'API 回忆', detail: 'archive event', at }), scopeType: 'group', scopeId: '12345' }
  const imported = await postJson(fake, '/cognition/import', body)
  assert.equal(imported.kind, 'timeline')
  assert.equal(imported.imported, 1)
  assert.equal((await postJson(fake, '/cognition/import', body)).skipped, 1)
  const all = await getJson(fake, '/cognition/timeline')
  assert.equal(all.items[0].type, 'event')
  const events = await getJson(fake, '/cognition/timeline?types=event&scopeType=group&scopeId=12345')
  assert.equal(events.items.length, 1)
  assert.equal(events.items[0].title, 'API 回忆')
  assert.equal(events.items[0].detail, 'archive event')
  assert.equal(events.items[0].at, at)
  assert.equal(events.stats.byType.event, 1)
  assert.equal((await getJson(fake, '/cognition/timeline?types=event&scopeType=private&scopeId=12345')).items.length, 0)
  assert.equal((await getJson(fake, '/cognition/memories')).items.length, 0)
  for (const invalid of [{ ...body, kind: 'event' }, { ...body, content: '{"text":"missing time"}' }]) {
    const response = await fake.call(API + '/cognition/import', invalid, { method: 'POST' })
    assert.equal(response.json.ok, false)
  }
})

test('media file routes: disabled gates, local upload/list/download/delete and 15 MiB body cap without QQ sends', async (t) => {
  const { fake, mock, dir } = await boot(t)
  for (const [path, body, method] of [['/media/files', undefined, 'GET'], ['/media/file/upload', { name: 'a.txt', dataBase64: 'YQ==' }, 'POST'], ['/media/file/download?name=a.txt', undefined, 'GET'], ['/media/file/delete', { name: 'a.txt' }, 'POST']]) {
    const rejected = await fake.call(API + path, body, { method })
    assert.equal(rejected.json.ok, false)
    assert.match(rejected.json.message, /文件功能未启用/)
  }
  await patchConfig(fake, { media: { enabled: true, files: { enabled: true }, maxBytes: 2 * 1024 * 1024 } })
  assert.deepEqual((await getJson(fake, '/media/files')).items, [])
  const buffer = Buffer.alloc(1024 * 1024 + 1, 65)
  const saved = await postJson(fake, '/media/file/upload', { name: 'report.pdf', dataBase64: buffer.toString('base64') })
  assert.match(saved.path, /^files\//)
  assert.equal(saved.name, 'report.pdf')
  assert.equal(saved.size, buffer.length)
  assert.deepEqual(await readFile(join(dir, 'media', saved.path)), buffer)
  const listed = await getJson(fake, '/media/files')
  assert.equal(listed.items[0].path, saved.path)
  assert.equal(listed.totalBytes, buffer.length)
  const name = saved.path.slice(6)
  const downloaded = await getJson(fake, '/media/file/download?name=' + encodeURIComponent(name))
  assert.deepEqual(downloaded, { ok: true, name, size: buffer.length, mime: 'application/pdf', dataBase64: buffer.toString('base64') })
  for (const invalid of [undefined, '', '../report.pdf', saved.path, '/etc/passwd', 'C:\\report.pdf', 'a\0.txt', 'a'.repeat(121), 'bad.exe', 'missing.txt']) {
    for (const [path, body, method] of [
      ['/media/file/download' + (invalid === undefined ? '' : '?name=' + encodeURIComponent(invalid)), undefined, 'GET'],
      ['/media/file/delete', { name: invalid }, 'POST'],
    ]) {
      const result = await fake.call(API + path, body, { method })
      assert.equal(result.json.ok, false)
      assert.doesNotMatch(result.text, new RegExp(dir))
    }
  }
  for (const [path, method] of [['/media/file/download', 'POST'], ['/media/file/delete', 'GET']]) {
    assert.equal((await fake.call(API + path, { name }, { method })).status, 405)
  }
  for (const body of [null, [], { path: saved.path }, { name: {} }]) assert.equal((await fake.call(API + '/media/file/delete', body, { method: 'POST' })).json.ok, false)
  for (const body of [null, [], { name: '../a.txt', dataBase64: 'YQ==' }, { name: 'a.txt', dataBase64: 'data:text/plain;base64,YQ==' }, { name: 'a.exe', dataBase64: 'YQ==' }]) {
    assert.equal((await fake.call(API + '/media/file/upload', body, { method: 'POST' })).json.ok, false)
  }
  const oversized = await fake.call(API + '/media/file/upload', { name: 'big.txt', dataBase64: 'A'.repeat(15 * 1024 * 1024) }, { method: 'POST' })
  assert.equal(oversized.json.ok, false)
  assert.match(oversized.json.message, /请求体过大/)
  assert.deepEqual(await postJson(fake, '/media/file/delete', { name }), { ok: true, name, removed: true })
  assert.deepEqual((await getJson(fake, '/media/files')).items, [])
  assert.equal((await fake.call(API + '/media/file/download?name=' + encodeURIComponent(name), undefined, { method: 'GET' })).json.message, '文件不存在')
  assert.equal((await fake.call(API + '/media/file/delete', { name }, { method: 'POST' })).json.message, '文件不存在')
  await patchConfig(fake, { media: { files: { enabled: false } } })
  assert.equal((await fake.call(API + '/media/files', undefined, { method: 'GET' })).json.ok, false)
  assert.match((await fake.call(API + '/media/file/download?name=a.txt', undefined, { method: 'GET' })).json.message, /文件功能未启用/)
  assert.match((await fake.call(API + '/media/file/delete', { name: 'a.txt' }, { method: 'POST' })).json.message, /文件功能未启用/)
  assert.equal(mock.calls.length, 0, 'local file operations must not call QQ gateway')
})


test('B站 API：默认关闭零网络，公开评论 limit/错误及离线分享', async (t) => {
  const originalFetch = globalThis.fetch, calls = []
  let replyCode = 0
  globalThis.fetch = async (input, init) => {
    const url = new URL(input)
    calls.push({ url, init })
    assert.equal(url.origin, 'https://api.bilibili.com')
    if (url.pathname === '/x/web-interface/view') return { ok: true, json: async () => ({ code: 0, data: { bvid: 'BV1xx411c7mD', aid: 98765 } }) }
    assert.equal(url.pathname, '/x/v2/reply')
    return { ok: true, json: async () => ({ code: replyCode, data: { replies: [{ rpid: 1, member: { uname: 'API作者' }, content: { message: 'API正文' }, like: 3, ctime: 1700000000 }] } }) }
  }
  t.after(() => { globalThis.fetch = originalFetch })
  const { fake } = await boot(t, { rowConfig: { enabled: false } })
  for (const path of ['/content/bilibili/comments?bvid=BV1xx411c7mD', '/content/bilibili/share?bvid=BV1xx411c7mD']) {
    const disabled = await fake.call(API + path, undefined, { method: 'GET' })
    assert.equal(disabled.json.ok, false)
    assert.match(disabled.json.message, /B站内容未启用/)
  }
  assert.equal(calls.length, 0)
  await patchConfig(fake, { content: { bilibili: { enabled: true } } })
  const shared = await getJson(fake, '/content/bilibili/share?bvid=BV1xx411c7mD')
  assert.deepEqual(shared, { ok: true, url: 'https://www.bilibili.com/video/BV1xx411c7mD', bvid: 'BV1xx411c7mD' })
  assert.equal(calls.length, 0)
  for (const path of ['/content/bilibili/share?bvid=bad', '/content/bilibili/comments']) {
    const invalid = await fake.call(API + path, undefined, { method: 'GET' })
    assert.equal(invalid.json.ok, false)
    assert.match(invalid.json.message, /无效的 BV/)
  }
  assert.equal(calls.length, 0)
  const comments = await getJson(fake, '/content/bilibili/comments?bvid=BV1xx411c7mD&limit=999')
  assert.deepEqual(comments.items, [{ author: 'API作者', content: 'API正文', like: 3, at: 1700000000 }])
  assert.equal(calls[1].url.searchParams.get('ps'), '20')
  assert.equal(calls[1].url.searchParams.get('oid'), '98765')
  replyCode = -352
  const blocked = await fake.call(API + '/content/bilibili/comments?bvid=BV1xx411c7mD', undefined, { method: 'GET' })
  assert.equal(blocked.json.ok, false)
  assert.match(blocked.json.message, /不使用 Cookie\/WBI/)
  const wrongMethod = await fake.call(API + '/content/bilibili/share?bvid=BV1xx411c7mD', {}, { method: 'POST' })
  assert.equal(wrongMethod.status, 405)
})

test('e2e: LLM budget usage/reset is confirmed, UTC/persona scoped and leaves config/secrets untouched', async (t) => {
  const secret = 'budget-test-secret-123456'
  const { fake, handle, dir } = await boot(t, { rowConfig: { cognition: { llm: { dailyTokenBudget: 4321 } }, onebot: { wsToken: secret } } })
  const initial = await getJson(fake, '/cognition/llm/usage')
  assert.deepEqual(Object.keys(initial).sort(), ['ok', 'date', 'budget', 'usageToday', 'budgetLeft', 'exhausted', 'personaScoped', 'personaId'].sort())
  assert.equal(initial.date, new Date().toISOString().slice(0, 10))
  assert.equal(initial.budget, 4321)
  assert.equal(initial.usageToday, 0)
  assert.equal(initial.budgetLeft, 4321)
  assert.equal(initial.exhausted, false)
  assert.equal(initial.personaScoped, true)
  assert.ok(initial.personaId)
  const { scopedStore } = handle.cognition.state
  scopedStore.put('llm_usage', initial.date, { tokens: 5000 })
  scopedStore.put('llm_usage', '2000-01-01', { tokens: 99 })
  const beforeConfig = await readFile(configFileOf(dir), 'utf8')
  const fullConfig = (await getJson(fake, '/config')).config
  for (const body of [{}, { confirm: false }, { confirm: 'true' }, null]) {
    const failed = await fake.call(API + '/cognition/llm/usage/reset', body, { method: 'POST' })
    assert.equal(failed.json.ok, false)
    assert.equal(failed.json.message, '重置今日 LLM 用量需要 confirm: true')
    assert.equal((await getJson(fake, '/cognition/llm/usage')).usageToday, 5000)
    assert.doesNotMatch(JSON.stringify(failed.json), new RegExp(secret))
  }
  const second = await postJson(fake, '/cognition/persona/create', { name: '预算隔离测试' })
  assert.equal((await getJson(fake, '/cognition/llm/usage')).usageToday, 0)
  scopedStore.put('llm_usage', initial.date, { tokens: 250 })
  await postJson(fake, '/cognition/persona/switch', { personaId: initial.personaId })
  const exhausted = await getJson(fake, '/cognition/llm/usage?date=2000-01-01&personaId=' + second.activeId)
  assert.equal(exhausted.usageToday, 5000)
  assert.equal(exhausted.exhausted, true)
  assert.equal(exhausted.budgetLeft, 0)
  const reset = await postJson(fake, '/cognition/llm/usage/reset', { confirm: true, date: '2000-01-01', personaId: second.activeId, tokens: 999 })
  assert.deepEqual(reset, { ...initial, reset: true, removed: true })
  assert.equal(scopedStore.get('llm_usage', initial.date), null)
  assert.equal(scopedStore.get('llm_usage', '2000-01-01').tokens, 99)
  assert.equal((await postJson(fake, '/cognition/llm/usage/reset', { confirm: true })).removed, false)
  assert.deepEqual((await getJson(fake, '/config')).config, fullConfig)
  assert.equal(await readFile(configFileOf(dir), 'utf8'), beforeConfig)
  await postJson(fake, '/cognition/persona/switch', { personaId: second.activeId })
  assert.equal((await getJson(fake, '/cognition/llm/usage')).usageToday, 250)
  for (const response of [initial, exhausted, reset]) {
    assert.doesNotMatch(JSON.stringify(response), new RegExp(secret))
    assert.doesNotMatch(JSON.stringify(response), /apiKey|wsToken|httpToken|provider|messages/)
  }
  handle.cognition.services.llm = null
  assert.equal(handle.cognition.llmUsage(), null)
  const unavailable = await fake.call(API + '/cognition/llm/usage/reset', { confirm: true }, { method: 'POST' })
  assert.equal(unavailable.json.ok, false)
  assert.equal(unavailable.json.message, 'LLM 用量服务不可用')
})
