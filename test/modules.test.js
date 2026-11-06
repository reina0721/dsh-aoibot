import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createModuleKernel } from '../src/modules/kernel.js'
import { createCommandService } from '../src/cognition/commands.js'

async function moduleDir(root, id, manifest, source) {
  const dir = join(root, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'module.json'), JSON.stringify({ id, entry: 'index.mjs', ...manifest }), 'utf8')
  await writeFile(join(dir, 'index.mjs'), source, 'utf8')
  return dir
}

async function harness(registry = []) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-modules-'))
  const sent = []
  const commandReplies = []
  const commands = createCommandService({
    getConfig: () => ({ access: { ownerQQ: 'owner' } }),
    access: { isOwner: (_cfg, id) => id === 'owner' },
    outbound: { async deliver(payload) { commandReplies.push(payload); return { ok: true } } },
  })
  const kernel = createModuleKernel({
    dataDir: root,
    registry,
    getConfig: () => ({}),
    commands,
    outbound: { async deliver(payload) { sent.push(payload); return { ok: true } } },
    cognition: {
      snapshot: () => ({ ready: true }), overview: async () => ({ ok: true }), memories: () => [],
      personDetail: () => null, relationshipsList: () => [], timeline: () => [],
      registerKnowledgeSource: () => () => {}, registerCapability: () => () => {},
    },
  })
  const turn = (text, senderId = 'owner') => ({ text, senderId, chatType: 'private', chatId: senderId })
  return { root, sent, commandReplies, commands, kernel, turn }
}

test('modules：加载、稳定 API、存储、事件与命令可用，列表不泄露路径', async (t) => {
  const h = await harness()
  t.after(() => h.kernel.dispose())
  const dir = await moduleDir(h.root, 'echo', {
    name: 'Echo', version: '1.0.0', description: 'test', permissions: ['commands', 'events', 'storage'],
  }, `
    export async function setup(api) {
      await api.storage.set('count', 0)
      api.on('message', async () => api.storage.set('count', (await api.storage.get('count', 0)) + 1))
      api.registerCommand('echo', async ({ args }) => ({ reply: args + ':' + await api.storage.get('count', 0) }))
    }
  `)
  await h.kernel.start()
  const items = h.kernel.list()
  assert.equal(items[0].status, 'loaded')
  assert.equal(items[0].name, 'Echo')
  assert.doesNotMatch(JSON.stringify(items), new RegExp(h.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  await h.kernel.dispatch({ kind: 'message', message: { text: 'hi' } })
  const stored = JSON.parse(await readFile(join(dir, 'data.json'), 'utf8'))
  assert.equal(stored.count, 1)
  const result = await h.commands.handle(h.turn('/echo hello'))
  assert.equal(result.reply, 'hello:1')
  assert.equal(h.commandReplies.length, 1)
})

test('modules：缺少 commands/send:text 权限时 setup 失败', async (t) => {
  const h = await harness()
  t.after(() => h.kernel.dispose())
  await moduleDir(h.root, 'no-command', {}, `export function setup(api) { api.registerCommand('denied', () => 'no') }`)
  await moduleDir(h.root, 'no-send', {}, `export async function setup(api) { await api.sendText({ chatType:'private', chatId:'1', text:'no' }) }`)
  await h.kernel.start()
  const byId = Object.fromEntries(h.kernel.list().map((item) => [item.id, item]))
  assert.equal(byId['no-command'].status, 'error')
  assert.match(byId['no-command'].error, /permission: commands/)
  assert.equal(byId['no-send'].status, 'error')
  assert.match(byId['no-send'].error, /permission: send:text/)
  assert.equal(h.sent.length, 0)
})

test('modules：setup 抛错与语法错误被隔离，列表仍可读取', async (t) => {
  const h = await harness()
  t.after(() => h.kernel.dispose())
  await moduleDir(h.root, 'throws', {}, `export function setup() { throw new Error('boom') }`)
  await moduleDir(h.root, 'syntax', {}, `export function setup( {`)
  await moduleDir(h.root, 'healthy', {}, `export function setup() {}`)
  await h.kernel.start()
  const byId = Object.fromEntries(h.kernel.list().map((item) => [item.id, item]))
  assert.equal(byId.healthy.status, 'loaded')
  assert.equal(byId.throws.status, 'error')
  assert.match(byId.throws.error, /boom/)
  assert.equal(byId.syntax.status, 'error')
})

test('modules：热重载更新行为，停用移除命令/事件，启用重新加载', async (t) => {
  const h = await harness()
  t.after(() => h.kernel.dispose())
  const dir = await moduleDir(h.root, 'reloadable', { permissions: ['commands', 'events', 'storage'] }, `
    export function setup(api) {
      api.registerCommand('versioned', () => 'v1')
      api.on('message', async () => api.storage.set('events', (await api.storage.get('events', 0)) + 1))
    }
  `)
  await h.kernel.start()
  assert.equal((await h.commands.handle(h.turn('/versioned'))).reply, 'v1')
  await writeFile(join(dir, 'index.mjs'), `export function setup(api) { api.registerCommand('versioned', () => 'v2'); api.on('message', async () => api.storage.set('events', (await api.storage.get('events', 0)) + 10)) }`, 'utf8')
  assert.equal((await h.kernel.reload('reloadable')).status, 'loaded')
  assert.equal((await h.commands.handle(h.turn('/versioned'))).reply, 'v2')
  await h.kernel.dispatch({ kind: 'message' })
  assert.equal(JSON.parse(await readFile(join(dir, 'data.json'), 'utf8')).events, 10)

  const disabled = await h.kernel.setEnabled('reloadable', false)
  assert.equal(disabled.status, 'disabled')
  const replacementDispose = h.commands.registerCommand('versioned', () => 'replacement')
  await h.kernel.dispatch({ kind: 'message' })
  assert.equal(JSON.parse(await readFile(join(dir, 'data.json'), 'utf8')).events, 10)
  replacementDispose()

  const enabled = await h.kernel.setEnabled('reloadable', true)
  assert.equal(enabled.status, 'loaded')
  assert.equal((await h.commands.handle(h.turn('/versioned'))).reply, 'v2')
})

test('modules：损坏 state.json 可容忍，entry 路径与符号链接逃逸被拒绝', async (t) => {
  const h = await harness()
  t.after(() => h.kernel.dispose())
  await writeFile(join(h.root, 'state.json'), '{broken', 'utf8')
  await moduleDir(h.root, 'ok', {}, `export function setup() {}`)
  const escapeDir = join(h.root, 'escape')
  await mkdir(escapeDir)
  await writeFile(join(escapeDir, 'module.json'), JSON.stringify({ id: 'escape', entry: '../outside.mjs' }), 'utf8')
  await writeFile(join(h.root, 'outside.mjs'), 'export function setup() {}', 'utf8')
  const linkDir = join(h.root, 'link')
  await mkdir(linkDir)
  await writeFile(join(linkDir, 'module.json'), JSON.stringify({ id: 'link', entry: 'index.mjs' }), 'utf8')
  await symlink(join(h.root, 'outside.mjs'), join(linkDir, 'index.mjs'))
  await h.kernel.start()
  const byId = Object.fromEntries(h.kernel.list().map((item) => [item.id, item]))
  assert.equal(byId.ok.status, 'loaded')
  assert.match(byId.escape.error, /不能离开/)
  assert.match(byId.link.error, /符号链接/)
})


test('modules：事件 handler 异常会隔离模块并清理命令', async (t) => {
  const h = await harness()
  t.after(() => h.kernel.dispose())
  await moduleDir(h.root, 'bad-event', { permissions: ['events', 'commands'] }, `
    export function setup(api) {
      api.on('message', () => { throw new Error('event-boom') })
      api.registerCommand('bad', () => 'still-here')
    }
  `)
  await h.kernel.start()
  assert.equal((await h.commands.handle(h.turn('/bad'))).reply, 'still-here')
  await h.kernel.dispatch({ kind: 'message' })
  const item = h.kernel.list().find((row) => row.id === 'bad-event')
  assert.equal(item.status, 'error')
  assert.match(item.error, /event-boom/)
  assert.match((await h.commands.handle(h.turn('/bad'))).reply, /未知命令/)
})

function builtin(id, load, extra = {}, defaultEnabled = false) {
  return { manifest: { id, name: id, version: '1', ...extra }, defaultEnabled, load }
}
const row = (kernel, id) => kernel.list().find((item) => item.id === id)

test('modules v2：内置默认不导入，来源只读，启停持久化，独立存储与保留目录', async (t) => {
  let imports = 0, setups = 0
  const descriptor = builtin('builtin-test', async () => {
    imports++
    return { async setup(api) {
      setups++
      assert.equal(api.source, 'builtin'); assert.equal(api.builtin, true)
      assert.throws(() => { api.source = 'external' }, TypeError)
      assert.equal(api.dir, join(h.root, '.builtin', 'builtin-test'))
      await api.storage.set('count', (await api.storage.get('count', 0)) + 1)
    } }
  }, { permissions: ['storage'], source: 'external', builtin: false, canReload: true })
  const h = await harness([descriptor]); t.after(() => h.kernel.dispose())
  await mkdir(join(h.root, '.builtin', 'garbage'), { recursive: true })
  await h.kernel.start()
  assert.equal(h.kernel.list().length, 1)
  assert.equal(imports, 0); assert.equal(setups, 0)
  assert.deepEqual(Object.fromEntries(['source', 'builtin', 'canReload', 'canToggle', 'apiVersion', 'requires', 'status'].map((key) => [key, row(h.kernel, 'builtin-test')[key]])), {
    source: 'builtin', builtin: true, canReload: false, canToggle: true, apiVersion: 1, requires: [], status: 'disabled',
  })
  await h.kernel.setEnabled('builtin-test', true)
  assert.deepEqual(JSON.parse(await readFile(join(h.root, 'state.json'), 'utf8')), { disabled: [], enabled: ['builtin-test'] })
  await assert.rejects(h.kernel.reload('builtin-test'), { code: 'MODULE_BUILTIN_RELOAD' })
  await h.kernel.setEnabled('builtin-test', false)
  await h.kernel.setEnabled('builtin-test', true)
  assert.equal(imports, 1); assert.equal(setups, 2)
  assert.equal(JSON.parse(await readFile(join(h.root, '.builtin', 'builtin-test', 'data.json'), 'utf8')).count, 2)
  const restarted = createModuleKernel({ dataDir: h.root, registry: [descriptor] }); t.after(() => restarted.dispose())
  await h.kernel.dispose(); await restarted.start()
  assert.equal(row(restarted, 'builtin-test').status, 'loaded')
})

test('modules v2：生产示例默认关闭；开启后仅主人可使用固定回复', async (t) => {
  const { builtinRegistry } = await import('../src/modules/registry.js')
  assert.ok(Object.isFrozen(builtinRegistry)); assert.ok(Object.isFrozen(builtinRegistry[0].manifest))
  const h = await harness(builtinRegistry); t.after(() => h.kernel.dispose())
  await h.kernel.start()
  const item = row(h.kernel, 'builtin-sample')
  assert.equal(item.name, '内置示例'); assert.equal(item.version, '1.0.0')
  assert.equal(item.status, 'disabled')
  await h.kernel.setEnabled(item.id, true)
  assert.equal((await h.commands.handle(h.turn('/module-sample'))).reply, '内置示例模块已启用。')
  const before = h.commandReplies.length
  await h.commands.handle(h.turn('/module-sample', 'other'))
  assert.equal(h.commandReplies.length, before)
  await h.kernel.setEnabled(item.id, false)
  assert.match((await h.commands.handle(h.turn('/module-sample'))).reply, /未知命令/)
})

test('modules v2：保留前缀、API 版本、requires 验证，忽略伪造来源与能力', async (t) => {
  const h = await harness(); t.after(() => h.kernel.dispose())
  for (const [id, manifest] of [
    ['builtin-evil', {}], ['v2', { apiVersion: 2 }], ['vstring', { apiVersion: '1' }],
    ['dup', { requires: ['valid', 'valid'] }], ['self', { requires: ['self'] }],
    ['invalid-dep', { requires: ['../bad'] }], ['many', { requires: Array.from({ length: 17 }, (_, i) => 'd' + i) }],
    ['valid', { apiVersion: 1, source: 'builtin', builtin: true, canReload: false, canToggle: false }],
  ]) await moduleDir(h.root, id, manifest, 'export function setup(api) { if (api.source !== "external" || api.builtin !== false) throw Error("source") }')
  await h.kernel.start()
  for (const item of h.kernel.list()) assert.equal(item.status, item.id === 'valid' ? 'loaded' : 'error', item.id)
  assert.match(row(h.kernel, 'builtin-evil').error, /保留/)
  assert.equal(row(h.kernel, 'valid').canReload, true)
  assert.equal(row(h.kernel, 'valid').canToggle, true)
  const invalid = createModuleKernel({ dataDir: h.root, registry: [builtin('bad-id', () => ({}))] })
  await assert.rejects(invalid.start(), /builtin-/); await invalid.dispose()
})

test('modules v2：稳定依赖顺序跨来源，重载/启停级联逆序清理，内置只导入一次', async (t) => {
  const trace = []; let imports = 0
  const h = await harness([
    builtin('builtin-root', () => { imports++; return { setup() { trace.push('+builtin-root'); return () => trace.push('-builtin-root') } } }, {}, true),
    builtin('builtin-child', () => { imports++; return { setup() { trace.push('+builtin-child'); return () => trace.push('-builtin-child') } } }, { requires: ['a'] }, true),
  ]); t.after(() => h.kernel.dispose())
  // 外部代码通过事件发送日志，不需进程全局测试状态。
  const source = (id) => `export async function setup(api) { await api.sendText({chatType:'private',chatId:'owner',text:'+${id}'}); return () => api.sendText({chatType:'private',chatId:'owner',text:'-${id}'}) }`
  h.sent.push = (payload) => { trace.push(payload.segments[0].data.text) }
  await moduleDir(h.root, 'a', { permissions: ['send:text'], requires: ['builtin-root'] }, source('a'))
  await moduleDir(h.root, 'z', { permissions: ['send:text'] }, source('z'))
  await h.kernel.start()
  assert.deepEqual(trace, ['+builtin-root', '+a', '+builtin-child', '+z'])
  trace.length = 0
  await h.kernel.reload('a')
  assert.deepEqual(trace, ['-builtin-child', '-a', '+a', '+builtin-child'])
  assert.equal(imports, 2)
  trace.length = 0
  await h.kernel.setEnabled('builtin-root', false)
  assert.deepEqual(trace, ['-builtin-child', '-a', '-builtin-root'])
  assert.equal(row(h.kernel, 'a').status, 'blocked'); assert.equal(row(h.kernel, 'builtin-child').status, 'blocked')
  trace.length = 0
  await h.kernel.setEnabled('builtin-child', true)
  assert.deepEqual(trace, []); assert.equal(row(h.kernel, 'builtin-root').enabled, false)
  await h.kernel.setEnabled('builtin-root', true)
  assert.deepEqual(trace, ['+builtin-root', '+a', '+builtin-child'])
  assert.equal(imports, 2)
  trace.length = 0; await h.kernel.dispose()
  assert.deepEqual(trace, ['-z', '-builtin-child', '-a', '-builtin-root'])
})

test('modules v2：缺失/环/失败/禁用依赖与下游隔离，修复后恢复', async (t) => {
  const h = await harness(); t.after(() => h.kernel.dispose())
  const configs = {
    missing: { requires: ['absent'] }, downstream: { requires: ['missing'] },
    cyclea: { requires: ['cycleb'] }, cycleb: { requires: ['cyclea'] }, cyclechild: { requires: ['cycleb'] },
    failed: {}, failchild: { requires: ['failed'] }, off: { enabled: false }, offchild: { requires: ['off'] }, healthy: {},
  }
  for (const [id, manifest] of Object.entries(configs)) await moduleDir(h.root, id, manifest, `export function setup() { ${id === 'failed' ? 'throw Error("failed")' : ''} }`)
  await h.kernel.start()
  for (const id of ['missing', 'cyclea', 'cycleb', 'failed']) assert.equal(row(h.kernel, id).status, 'error', id)
  for (const id of ['downstream', 'cyclechild', 'failchild', 'offchild']) assert.equal(row(h.kernel, id).status, 'blocked', id)
  assert.equal(row(h.kernel, 'healthy').status, 'loaded')
  await moduleDir(h.root, 'absent', {}, 'export default function() {}')
  await h.kernel.reload('absent')
  assert.equal(row(h.kernel, 'downstream').status, 'loaded')
  await moduleDir(h.root, 'cycleb', {}, 'export default { setup() {} }')
  await h.kernel.reload('cycleb')
  assert.equal(row(h.kernel, 'cyclechild').status, 'loaded')
})

test('modules v2：兼容旧状态，disabled 优先，enabled 不越过外部清单上限', async (t) => {
  for (const state of [{ disabled: ['ext', 'builtin-on'] }, { disabled: ['builtin-on'], enabled: ['builtin-on', 'builtin-off', 'ceiling'] }, { enabled: ['builtin-off'] }]) {
    const h = await harness([
      builtin('builtin-on', () => ({ setup() {} }), {}, true),
      builtin('builtin-off', () => ({ setup() {} })),
    ]); t.after(() => h.kernel.dispose())
    await moduleDir(h.root, 'ext', {}, 'export function setup() {}')
    await moduleDir(h.root, 'ceiling', { enabled: false }, 'throw Error("must not import")')
    await writeFile(join(h.root, 'state.json'), JSON.stringify(state))
    await h.kernel.start()
    assert.equal(row(h.kernel, 'ext').enabled, !state.disabled?.includes('ext'))
    assert.equal(row(h.kernel, 'builtin-on').enabled, !state.disabled?.includes('builtin-on'))
    assert.equal(row(h.kernel, 'builtin-off').enabled, Boolean(state.enabled?.includes('builtin-off')))
    assert.equal(row(h.kernel, 'ceiling').status, 'disabled'); assert.equal(row(h.kernel, 'ceiling').canToggle, false)
    await assert.rejects(h.kernel.setEnabled('ceiling', true), { code: 'MODULE_MANIFEST_DISABLED' })
  }
})

test('modules v2：状态写失败保持 live 与内存状态，后续操作仍可运行', async (t) => {
  const { rm } = await import('node:fs/promises')
  let setups = 0, cleanups = 0
  const h = await harness([builtin('builtin-test', () => ({ setup() { setups++; return () => cleanups++ } }), {}, true)])
  t.after(() => h.kernel.dispose()); await h.kernel.start()
  // 将目标改为目录，rename 必须失败（不依赖 root 下的权限语义）。
  await mkdir(join(h.root, 'state.json'))
  await assert.rejects(h.kernel.setEnabled('builtin-test', false), { code: 'MODULE_STATE_WRITE_FAILED' })
  assert.equal(row(h.kernel, 'builtin-test').status, 'loaded'); assert.equal(cleanups, 0)
  await rm(join(h.root, 'state.json'), { recursive: true })
  await h.kernel.setEnabled('builtin-test', false)
  assert.equal(cleanups, 1); assert.equal(setups, 1)
  assert.deepEqual(JSON.parse(await readFile(join(h.root, 'state.json'), 'utf8')), { disabled: ['builtin-test'], enabled: [] })
})

test('modules v2：内置存储符号链接与 1 MiB 限制，不扫描 .builtin', async (t) => {
  const outside = await mkdtemp(join(tmpdir(), 'dsh-module-outside-'))
  const h = await harness([builtin('builtin-storage', () => ({ async setup(api) { await api.storage.set('big', 'x'.repeat(1024 * 1024)) } }), { permissions: ['storage'] }, true)])
  t.after(() => h.kernel.dispose()); await h.kernel.start()
  assert.match(row(h.kernel, 'builtin-storage').error, /存储超过/)
  const h2 = await harness([builtin('builtin-storage', () => ({ setup() {} }), {}, true)])
  t.after(() => h2.kernel.dispose())
  await symlink(outside, join(h2.root, '.builtin'))
  await h2.kernel.start()
  assert.equal(h2.kernel.list().length, 1)
  assert.match(row(h2.kernel, 'builtin-storage').error, /符号链接/)
})

test('modules v2：旧异步事件失败不会破坏重载后的 runtime；当前失败级联阻塞', async (t) => {
  let rejectEvent, entered
  const enteredPromise = new Promise((resolve) => { entered = resolve })
  let setups = 0, cleanups = 0
  const h = await harness([
    builtin('builtin-root', () => ({ setup(api) { api.on('message', () => { entered(); return new Promise((_resolve, reject) => { rejectEvent = reject }) }) } }), { permissions: ['events'] }, true),
    builtin('builtin-child', () => ({ setup() { setups++; return () => cleanups++ } }), { requires: ['builtin-root'] }, true),
  ]); t.after(() => h.kernel.dispose()); await h.kernel.start()
  const pending = h.kernel.dispatch({ kind: 'message' }); await enteredPromise
  await h.kernel.setEnabled('builtin-root', true)
  rejectEvent(Error('stale')); await pending
  assert.equal(row(h.kernel, 'builtin-root').status, 'loaded'); assert.equal(row(h.kernel, 'builtin-child').status, 'loaded')
  const next = h.kernel.dispatch({ kind: 'message' })
  await new Promise((resolve) => setImmediate(resolve)); rejectEvent(Error('current')); await next
  assert.equal(row(h.kernel, 'builtin-root').status, 'error'); assert.equal(row(h.kernel, 'builtin-child').status, 'blocked')
  assert.equal(setups, 2); assert.equal(cleanups, 2)
})

test('modules v2：外部 default/named/default object/CommonJS 导出仍兼容，目录符号链接拒绝', async (t) => {
  const h = await harness(); t.after(() => h.kernel.dispose())
  await moduleDir(h.root, 'default-fn', {}, 'export default function() {}')
  await moduleDir(h.root, 'default-obj', {}, 'export default { setup() {} }')
  const dir = await moduleDir(h.root, 'common', { entry: 'index.cjs.js' }, '')
  await writeFile(join(dir, 'package.json'), '{"type":"commonjs"}')
  await writeFile(join(dir, 'index.cjs.js'), 'exports.setup = function() {}')
  const outside = await mkdtemp(join(tmpdir(), 'dsh-mod-link-'))
  await moduleDir(outside, 'link-dir', {}, 'export function setup() {}')
  await symlink(join(outside, 'link-dir'), join(h.root, 'link-dir'))
  await h.kernel.start()
  for (const id of ['default-fn', 'default-obj', 'common']) assert.equal(row(h.kernel, id).status, 'loaded', id)
  assert.match(row(h.kernel, 'link-dir').error, /符号链接/)
})


test('modules v2：清理排空存储写入后重新读取磁盘，修复内置存储可重试', async (t) => {
  const seen = []; let imports = 0
  const h = await harness([builtin('builtin-storage', () => {
    imports++
    return { async setup(api) { seen.push(await api.storage.get('value')); await Promise.all([api.storage.set('a', 1), api.storage.set('b', 2)]) } }
  }, { permissions: ['storage'] }, true)])
  t.after(() => h.kernel.dispose())
  const dir = join(h.root, '.builtin', 'builtin-storage')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'data.json'), 'x'.repeat(1024 * 1024 + 1))
  await h.kernel.start()
  assert.equal(row(h.kernel, 'builtin-storage').status, 'error'); assert.equal(imports, 0)
  await writeFile(join(dir, 'data.json'), '{"value":"repaired"}')
  await h.kernel.setEnabled('builtin-storage', true)
  assert.equal(row(h.kernel, 'builtin-storage').status, 'loaded')
  await h.kernel.setEnabled('builtin-storage', false)
  await writeFile(join(dir, 'data.json'), '{"value":"edited"}')
  await Promise.all([h.kernel.setEnabled('builtin-storage', true), h.kernel.setEnabled('builtin-storage', false), h.kernel.setEnabled('builtin-storage', true)])
  assert.deepEqual(seen, ['repaired', 'edited', 'edited'])
  assert.equal(imports, 1)
  assert.equal(row(h.kernel, 'builtin-storage').status, 'loaded')
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'data.json'), 'utf8')), { value: 'edited', a: 1, b: 2 })
})
