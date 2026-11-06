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

async function harness() {
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
