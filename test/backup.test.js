import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, symlinkSync, linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createBackupService } from '../src/ops/backup.js'
import { normalizeConfig, DEFAULTS } from '../src/core/config.js'
import { createRoutes } from '../src/http/routes.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

function fixture(t, patch = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-backup-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const cfg = { ops: { backup: { ...DEFAULTS.ops.backup, ...patch } } }
  const service = createBackupService({ dataDir: root, getConfig: () => cfg })
  const put = (path, text = path) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text) }
  const read = (path) => readFileSync(join(root, path), 'utf8')
  const load = (id) => JSON.parse(read(`backups/${id}/manifest.json`))
  const save = (id, manifest) => put(`backups/${id}/manifest.json`, JSON.stringify(manifest))
  return { root, cfg, service, put, read, load, save }
}

test('backup: default directory snapshot, manifest and public list; excludes unsafe/temporary/inbound data', async (t) => {
  const { root, service, put, read, load } = fixture(t)
  const paths = ['config.json', 'models.json', 'cognition/state.json', 'cognition/persona/notes.txt', 'modules/state.json', 'modules/demo/module.json', 'modules/demo/index.js', 'modules/demo/data.json', 'modules/.builtin/builtin-sample/data.json', 'media/stickers.json', 'media/stickers/a.png']
  for (const path of paths) put(path)
  for (const path of ['logs/a.log', 'backups/unrelated/old', 'restore-old/config.json', 'modules/demo/backups/old', 'cognition/restore-old/state', 'cognition/state.tmp-42', 'cognition/a.swp', 'cognition/a~', 'media/inbound/a.png', 'media/tts/a.mp3']) put(path)
  const outside = mkdtempSync(join(tmpdir(), 'dsh-backup-outside-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  writeFileSync(join(outside, 'secret'), 'outside')
  symlinkSync(outside, join(root, 'cognition', 'link'), 'dir')
  symlinkSync(join(outside, 'secret'), join(root, 'modules', 'demo', 'link'))
  const item = await service.create({ note: 'before editing' })
  assert.match(item.id, /^\d{8}T\d{9}Z-[a-f0-9]{8}$/)
  assert.equal(item.files, paths.length)
  assert.equal(item.includeMedia, false)
  const manifest = load(item.id)
  assert.equal(manifest.version, 1)
  assert.equal(manifest.note, 'before editing')
  assert.deepEqual(manifest.files.map((f) => f.path).sort(), paths.sort())
  assert.equal(manifest.bytes, paths.reduce((sum, path) => sum + Buffer.byteLength(path), 0))
  assert.ok(manifest.excluded.some((entry) => entry.reason === 'symlink'))
  assert.ok(manifest.excluded.some((entry) => entry.path === 'logs'))
  for (const path of paths) assert.equal(read(`backups/${item.id}/files/${path}`), path)
  assert.deepEqual(await service.list(), [item])
  assert.deepEqual(Object.keys(item), ['id', 'createdAt', 'note', 'bytes', 'files', 'includeMedia'])
  assert.ok(!JSON.stringify([manifest, item]).includes(root))
  assert.deepEqual(await service.status(), { enabled: true, maxSnapshots: 10, maxBytes: 209715200, allowRestore: false, snapshotCount: 1 })
  assert.equal(service.dispose(), undefined)
})

test('backup: includeMedia includes all local media; configured default is used by panel, explicit API default stays false', async (t) => {
  const { service, put, load } = fixture(t, { includeMedia: true })
  put('media/inbound/a.png'); put('media/tts/a.mp3'); put('media/stickers.json')
  assert.equal((await service.create()).files, 1)
  const item = await service.create({ includeMedia: true })
  assert.equal(item.files, 3)
  assert.equal(load(item.id).includeMedia, true)
})

for (const [limit, patch] of [['maxBytes', { maxBytes: 3 }], ['maxFiles', { maxFiles: 1 }]]) {
  test(`backup: ${limit} fails atomically without publishing or pruning snapshots`, async (t) => {
    const { root, service, cfg, put } = fixture(t)
    put('config.json', 'one')
    const before = await service.create()
    Object.assign(cfg.ops.backup, patch)
    put('models.json', 'two')
    await assert.rejects(service.create(), new RegExp(limit))
    assert.deepEqual((await service.list()).map((i) => i.id), [before.id])
    assert.deepEqual(readdirSync(join(root, 'backups')), [before.id])
  })
}

test('backup: prune oldest only when enabled; list newest first and delete validates ID', async (t) => {
  const { service, cfg } = fixture(t, { maxSnapshots: 2, prune: false })
  const first = await service.create()
  await new Promise((resolve) => setTimeout(resolve, 5))
  const second = await service.create()
  await new Promise((resolve) => setTimeout(resolve, 5))
  const third = await service.create()
  assert.deepEqual((await service.list()).map((i) => i.id), [third.id, second.id, first.id])
  cfg.ops.backup.prune = true
  await new Promise((resolve) => setTimeout(resolve, 5))
  const fourth = await service.create()
  assert.deepEqual((await service.list()).map((i) => i.id), [fourth.id, third.id])
  assert.deepEqual(await service.delete(third.id), { ok: true })
  assert.equal((await service.list()).length, 1)
})

test('backup: reject ID traversal and wrong types for all ID operations', async (t) => {
  const { service } = fixture(t)
  for (const id of ['../config.json', '/tmp/x', 'x/../../', '20261106T000000000Z-deadbeef/..', '', undefined, {}, 123]) {
    await assert.rejects(service.restore(id), /id/)
    await assert.rejects(service.delete(id), /id/)
  }
  await assert.rejects(service.create({ includeMedia: 'true' }), /boolean/)
  await assert.rejects(service.create({ note: 'x'.repeat(1001) }), /1000/)
})

test('backup: staged restore preserves active files, returns relative path and refuses existing stage', async (t) => {
  const { root, service, put, read } = fixture(t)
  put('config.json', 'original'); put('cognition/data.sqlite', 'offline database fixture')
  const item = await service.create()
  put('config.json', 'changed')
  const staged = await service.restore(item.id)
  assert.deepEqual(staged, { ok: true, requiresRestart: true, stagedPath: `restore-${item.id}` })
  assert.ok(!staged.stagedPath.includes(root))
  assert.equal(read(`${staged.stagedPath}/config.json`), 'original')
  assert.equal(read('config.json'), 'changed')
  await assert.rejects(service.restore(item.id), /已存在/)
  const next = await service.create()
  assert.ok(!existsSync(join(root, 'backups', next.id, 'files', staged.stagedPath)))
})

test('backup: apply denied by default with no safety backup or data mutation', async (t) => {
  const { service, put, read } = fixture(t)
  put('config.json', 'original')
  const item = await service.create()
  put('config.json', 'changed')
  await assert.rejects(service.restore(item.id, { apply: true }), /allowRestore/)
  await assert.rejects(service.restore(item.id, { apply: 'false' }), /boolean/)
  assert.equal(read('config.json'), 'changed')
  assert.equal((await service.list()).length, 1)
})

test('backup: apply allowed preserves pre-restore state even with maxSnapshots=1', async (t) => {
  const { root, service, put, read } = fixture(t, { allowRestore: true, maxSnapshots: 1 })
  put('config.json', 'original'); put('media/inbound/a.png', 'original media')
  const item = await service.create({ includeMedia: true })
  put('config.json', 'changed'); put('media/inbound/a.png', 'changed media'); put('cognition/untouched.json', 'keep')
  assert.deepEqual(await service.restore(item.id, { apply: true }), { ok: true, applied: true, requiresRestart: true })
  assert.equal(read('config.json'), 'original')
  assert.equal(read('media/inbound/a.png'), 'original media')
  assert.equal(read('cognition/untouched.json'), 'keep')
  const [safety] = await service.list()
  assert.match(safety.note, /^pre-restore:/)
  assert.equal(read(`backups/${safety.id}/files/config.json`), 'changed')
  assert.equal(read(`backups/${safety.id}/files/media/inbound/a.png`), 'changed media')
  assert.ok(!readdirSync(root).some((name) => name.startsWith('restore-tmp-')))
})

test('backup: pre-restore backup failure aborts application', async (t) => {
  const { root, service, cfg, put, read } = fixture(t, { allowRestore: true })
  put('config.json', 'old')
  const item = await service.create()
  put('config.json', 'too much data')
  cfg.ops.backup.maxBytes = 4
  await assert.rejects(service.restore(item.id, { apply: true }), /maxBytes/)
  assert.equal(read('config.json'), 'too much data')
  assert.equal((await service.list()).length, 1)
  assert.ok(!readdirSync(root).some((name) => name.startsWith('restore-tmp-')))
})

for (const path of ['../escape', '/tmp/escape', 'cognition/../../escape', 'cognition\\escape', 'backups/escape', 'modules/x/backups/a', 'logs/a', 'media/inbound/a']) {
  test(`backup: rejects malicious manifest path ${path}`, async (t) => {
    const { service, put, load, save } = fixture(t)
    put('config.json', 'safe')
    const item = await service.create()
    const m = load(item.id); m.files[0].path = path; save(item.id, m)
    await assert.rejects(service.restore(item.id), /路径/)
    assert.deepEqual(await service.list(), [])
  })
}

test('backup: rejects corrupt manifests, changed content and missing files before applying', async (t) => {
  const { root, service, put, load, save, read } = fixture(t, { allowRestore: true })
  put('config.json', 'safe')
  const item = await service.create()
  const original = load(item.id)
  for (const patch of [{ version: 2 }, { bytes: -1 }, { files: [...original.files, ...original.files] }, { createdAt: 'invalid' }]) {
    save(item.id, { ...original, ...patch })
    await assert.rejects(service.restore(item.id))
  }
  save(item.id, original)
  put(`backups/${item.id}/files/config.json`, 'evil')
  put('config.json', 'current')
  await assert.rejects(service.restore(item.id, { apply: true }), /校验/)
  assert.equal(read('config.json'), 'current')
  assert.equal((await service.list()).length, 1)
  rmSync(join(root, 'backups', item.id, 'files', 'config.json'))
  await assert.rejects(service.restore(item.id), /ENOENT/)
})

for (const target of ['backups', 'source-file', 'source-dir', 'destination-file', 'destination-dir', 'stage', 'manifest', 'snapshot']) {
  test(`backup: rejects symlink ${target} without touching outside data`, async (t) => {
    const { root, service, put } = fixture(t, { allowRestore: true })
    const outside = mkdtempSync(join(tmpdir(), 'dsh-backup-link-'))
    t.after(() => rmSync(outside, { recursive: true, force: true }))
    writeFileSync(join(outside, 'secret'), 'protected')
    put('cognition/state', 'snapshot')
    if (target === 'backups') {
      symlinkSync(outside, join(root, 'backups'), 'dir')
      await assert.rejects(service.create(), /符号链接/)
      await assert.rejects(service.list(), /符号链接/)
    } else {
      const item = await service.create()
      const base = `backups/${item.id}`
      const path = { 'source-file': `${base}/files/cognition/state`, 'source-dir': `${base}/files/cognition`, 'destination-file': 'cognition/state', 'destination-dir': 'cognition', stage: `restore-${item.id}`, manifest: `${base}/manifest.json`, snapshot: base }[target]
      rmSync(join(root, path), { force: true, recursive: true })
      symlinkSync(target.endsWith('file') || target === 'manifest' ? join(outside, 'secret') : outside, join(root, path), target.endsWith('file') || target === 'manifest' ? 'file' : 'dir')
      await assert.rejects(service.restore(item.id, { apply: target.startsWith('destination') }), /符号链接/)
      if (target === 'snapshot') await assert.rejects(service.delete(item.id), /符号链接/)
    }
    assert.equal(readFileSync(join(outside, 'secret'), 'utf8'), 'protected')
    assert.deepEqual(readdirSync(outside), ['secret'])
  })
}

test('backup: rejects hardlinked apply destinations', async (t) => {
  const { root, service, put, read } = fixture(t, { allowRestore: true })
  put('config.json', 'original')
  const item = await service.create()
  put('cognition/linked', 'changed')
  rmSync(join(root, 'config.json'))
  linkSync(join(root, 'cognition/linked'), join(root, 'config.json'))
  await assert.rejects(service.restore(item.id, { apply: true }), /普通文件/)
  assert.equal(read('cognition/linked'), 'changed')
})

test('backup: disabled service denies mutations but keeps inventory/status readable; restore obeys current limits', async (t) => {
  const { service, cfg, put } = fixture(t)
  put('config.json', 'longer than one byte')
  const item = await service.create()
  cfg.ops.backup.maxBytes = 1
  await assert.rejects(service.restore(item.id), /maxBytes/)
  cfg.ops.backup.enabled = false
  assert.equal((await service.status()).enabled, false)
  assert.equal((await service.list()).length, 1)
  await assert.rejects(service.create(), /禁用/)
  await assert.rejects(service.delete(item.id), /禁用/)
  await assert.rejects(service.restore(item.id), /禁用/)
})

test('backup config: defaults, normalize booleans and bounded limits', () => {
  assert.deepEqual(normalizeConfig({}).config.ops.backup, DEFAULTS.ops.backup)
  const { config } = normalizeConfig({ ops: { backup: { enabled: 'no', includeMedia: true, maxBytes: 0, maxFiles: -1, maxSnapshots: 1001, allowRestore: 'true' } } })
  assert.equal(config.ops.backup.enabled, true)
  assert.equal(config.ops.backup.includeMedia, true)
  assert.equal(config.ops.backup.maxBytes, 1)
  assert.equal(config.ops.backup.maxFiles, 1)
  assert.equal(config.ops.backup.maxSnapshots, 1000)
  assert.equal(config.ops.backup.allowRestore, false)
})

test('backup routes: create, list, default staged restore, denied apply, delete and input errors', async (t) => {
  const { service, put } = fixture(t)
  put('config.json', 'route fixture')
  const fake = createFakeDsh()
  createRoutes({ ctx: fake.ctx, backup: service })
  t.after(() => fake.dispose())
  const call = async (path, body) => (await fake.call('/onebot-qq/api/backup' + path, body, { method: body === undefined ? 'GET' : 'POST' })).json
  const created = await call('/create', { note: 'routes' })
  assert.equal(created.ok, true)
  const id = created.item.id
  const listed = await call('')
  assert.equal(listed.status.snapshotCount, 1)
  assert.equal(listed.items[0].note, 'routes')
  assert.deepEqual(await call('/restore', { id }), { ok: true, requiresRestart: true, stagedPath: `restore-${id}` })
  assert.equal((await call('/restore', { id, apply: true })).ok, false)
  assert.equal((await call('/delete', { id: '../escape' })).ok, false)
  assert.equal((await call('/create', { includeMedia: 'false' })).ok, false)
  assert.equal((await call('/restore', { id, apply: 'false' })).ok, false)
  assert.equal((await call('/delete', { id })).ok, true)
  assert.equal((await call('')).items.length, 0)
})


test('backup: 内置 enabled/disabled 状态与 .builtin 数据可快照和暂存恢复', async (t) => {
  const { service, put, read } = fixture(t)
  const state = JSON.stringify({ disabled: ['external'], enabled: ['builtin-sample'] })
  put('modules/state.json', state)
  put('modules/.builtin/builtin-sample/data.json', '{"count":1}')
  const item = await service.create()
  put('modules/state.json', '{}')
  const result = await service.restore(item.id)
  assert.equal(read(`${result.stagedPath}/modules/state.json`), state)
  assert.equal(read(`${result.stagedPath}/modules/.builtin/builtin-sample/data.json`), '{"count":1}')
})
