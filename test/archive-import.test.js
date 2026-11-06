import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createArchiveImportService } from '../src/cognition/archive-import.js'
import { createCognition } from '../src/cognition/index.js'
import { createFakeScheduler } from '../src/cognition/util.js'
import { normalizeConfig, CONFIG_GROUPS } from '../src/core/config.js'

const NOW = Date.parse('2026-11-06T12:00:00Z')
function harness(config = {}) {
  const rows = new Map(), puts = [], logs = []
  const store = {
    get: (kind, id) => rows.get(`${kind}:${id}`),
    put(kind, id, item, options) { puts.push({ kind, id, item, options }); rows.set(`${kind}:${id}`, item) },
  }
  const service = createArchiveImportService({ store, getConfig: () => ({ cognition: { import: config } }), clock: { now: () => NOW }, logger: { info: (...args) => logs.push(args) } })
  return { service, store, puts, logs }
}

test('archive import: JSON array, all wrapper keys and single object, auto detection', () => {
  for (const wrap of [(items) => items, ...['memories', 'items', 'data', 'records'].map((key) => (items) => ({ [key]: items }))]) {
    const { service, puts } = harness()
    const content = JSON.stringify(wrap([{ text: '档案一' }, { content: '档案二' }, { summary: '档案三' }, { memory: '档案四' }]))
    const result = service.importArchive({ content })
    assert.deepEqual(result, { ok: true, format: 'json', bytes: Buffer.byteLength(content), total: 4, imported: 4, skipped: 0, invalid: 0, scope: { scopeType: 'global', scopeId: '' } })
    assert.deepEqual(puts.map(({ item }) => item.content), ['档案一', '档案二', '档案三', '档案四'])
  }
  assert.equal(harness().service.importArchive({ content: '\uFEFF\n{\n "text": "single"\n}', format: 'json' }).imported, 1)
})

test('archive import: JSONL auto/explicit skips malformed lines and items, counts nonempty lines', () => {
  const content = '\n{"text":"first"}\r\n\nsecret invalid syntax\n42\n{"content":"second"}\n{"text":""}\n'
  for (const format of ['auto', 'jsonl']) {
    const result = harness().service.importArchive({ content, format })
    assert.equal(result.format, 'jsonl')
    assert.equal(result.total, 5)
    assert.equal(result.imported, 2)
    assert.equal(result.invalid, 3)
  }
  assert.equal(harness().service.importArchive({ content: '{"text":"line"}', format: 'jsonl' }).format, 'jsonl')
})

test('archive import: stable IDs, batch dedupe and repeated imports preserve existing records', () => {
  const { service, puts, store } = harness()
  const content = JSON.stringify([{ text: ' same ' }, { text: 'same', type: 'self', importance: 1 }, { text: 'other' }])
  assert.equal(service.importArchive({ content }).skipped, 1)
  const first = puts[0].item
  assert.match(first.id, /^imp_[a-f0-9]{64}$/)
  store.put('memory', first.id, { ...first, status: 'inactive' })
  const writes = puts.length
  assert.equal(service.importArchive({ content }).skipped, 3)
  assert.equal(puts.length, writes)
  assert.equal(store.get('memory', first.id).status, 'inactive')
  assert.equal(harness().service.importArchive({ content }).imported, 2)
  const second = harness(); second.service.importArchive({ content })
  assert.equal(second.puts[0].id, first.id)
})

test('archive import: request scopes default, item overrides and scoped/person identity dedupe', () => {
  const { service, puts } = harness()
  const scope = { scopeType: 'private', scopeId: '123' }
  const content = JSON.stringify([
    { text: 'same' }, { text: 'same', scopeId: '456' },
    { text: 'same', scopeType: 'group', scopeId: '123' },
    { text: 'same', scopeType: 'global' }, { text: 'same', personId: 'p1' },
  ])
  assert.deepEqual(service.importArchive({ content, scope }).scope, scope)
  assert.equal(new Set(puts.map(({ id }) => id)).size, 5)
  assert.deepEqual(puts.map(({ item }) => [item.scopeType, item.scopeId]), [['private', '123'], ['private', '456'], ['group', '123'], ['global', ''], ['private', '123']])
})

test('archive import: invalid request scopes reject, invalid item scopes never broaden to global', () => {
  const { service, puts } = harness()
  for (const scope of [null, [], { scopeType: null }, { scopeType: 'other' }, { scopeType: 'private' }, { scopeType: 'group', scopeId: null }, { scopeType: 'group', scopeId: 123 }, { scopeType: 'group', scopeId: '-1' }, { scopeType: 'private', scopeId: '12x' }]) {
    assert.throws(() => service.importArchive({ content: '{"text":"secret"}', scope }), /作用域/)
  }
  const items = [{ text: 'valid' }, ...['', '-1', 'x', 123, {}].map((scopeId) => ({ text: 'secret', scopeType: 'private', scopeId })), { text: 'secret', scopeType: 'unknown' }, { text: 'secret', scopeType: 'group' }]
  assert.equal(service.importArchive({ content: JSON.stringify(items) }).invalid, 7)
  assert.equal(puts.length, 1)
})

test('archive import: Unicode text/person limits and invalid item types', () => {
  const { service, puts } = harness()
  const content = JSON.stringify([null, [], 1, 'text', {}, { text: ' ' }, { text: '😀'.repeat(4001) }, { text: 'person too long', personId: '人'.repeat(65) }, { text: 'bad person', personId: {} }, { text: '😀'.repeat(4000), personId: '人'.repeat(64) }])
  const result = service.importArchive({ content })
  assert.equal(result.invalid, 9)
  assert.equal(puts.length, 1)
  assert.equal([...puts[0].item.text].length, 4000)
})

test('archive import: format/parse/empty errors are clear, reveal no archive contents, and write nothing', () => {
  const { service, puts, logs } = harness()
  for (const content of [undefined, null, 1, {}, '', '  ', 'secret-marker', '[{"text":"secret-marker"}', '42', '[]', '{}', 'null', '{"text":""}', 'bad secret-marker\n{}']) {
    assert.throws(() => service.importArchive({ content }), (error) => !error.message.includes('secret-marker'))
  }
  assert.throws(() => service.importArchive({ format: 'xml', content: 'secret-marker' }), /格式/)
  assert.throws(() => service.importArchive({ format: 'json', content: '{"text":"valid"}\n{"text":"another"}' }), /合法 JSON/)
  assert.throws(() => service.importArchive({ format: 'jsonl', content: 'bad secret-marker\n[]' }), /没有有效/)
  assert.equal(puts.length, 0)
  assert.equal(logs.length, 0)
})

test('archive import: UTF-8 byte and item limits reject before writing, include invalid/duplicate items', () => {
  const content = '{"text":"中文"}'
  assert.equal(harness({ maxBytes: Buffer.byteLength(content) }).service.importArchive({ content }).bytes, Buffer.byteLength(content))
  const tiny = harness({ maxBytes: Buffer.byteLength(content) - 1 })
  assert.throws(() => tiny.service.importArchive({ content }), /大小上限/)
  assert.equal(tiny.puts.length, 0)
  for (const content of ['[{"text":"x"},{"text":"x"},null]', '{"text":"x"}\ninvalid\n{"text":"x"}']) {
    const limited = harness({ maxItems: 2 })
    assert.throws(() => limited.service.importArchive({ content }), /条数上限/)
    assert.equal(limited.puts.length, 0)
  }
  assert.throws(() => harness().service.importArchive({ content: 'x'.repeat(5242881) }), /大小上限/)
  assert.throws(() => harness().service.importArchive({ content: JSON.stringify(Array.from({ length: 5001 }, () => ({ text: 'x' }))) }), /条数上限/)
})

test('archive import: known types, clamped importance, safe timestamps/defaults and field allowlist', () => {
  const { service, puts } = harness()
  const createdAt = Date.parse('2020-01-01T00:00:00Z')
  const content = JSON.stringify([
    { text: 'one', type: 'semantic', importance: 9, createdAt: '2020-01-01T00:00:00Z', updatedAt: createdAt + 1000, status: 'inactive', source: 'evil', confidence: -1, arbitrary: 'discard', personaId: 'other' },
    { text: 'two', type: 'unknown', importance: -9, createdAt: -1, updatedAt: 'invalid' },
    { text: 'three', importance: '0.9', createdAt, updatedAt: createdAt - 1000 },
    { text: 'future', createdAt: NOW + 1, updatedAt: '9999-01-01T00:00:00Z' },
    ...['episodic', 'emotional', 'social', 'procedural', 'self'].map((type) => ({ text: type, type })),
  ])
  service.importArchive({ content })
  const [one, two, three, future] = puts.map(({ item }) => item)
  assert.equal(one.type, 'semantic'); assert.equal(one.importance, 1)
  assert.deepEqual(puts[0].options, { createdAt, updatedAt: createdAt + 1000 })
  assert.equal(one.status, 'active'); assert.equal(one.source, 'import')
  assert.equal(one.confidence, 1); assert.equal(one.stability, 0.5); assert.equal(one.salience, 0.5)
  assert.equal(one.arbitrary, undefined); assert.equal(one.personaId, undefined)
  assert.equal(two.type, 'episodic'); assert.equal(two.importance, 0); assert.equal(two.createdAt, NOW)
  assert.equal(three.importance, 0.5); assert.equal(three.updatedAt, createdAt)
  assert.equal(future.createdAt, NOW); assert.equal(future.updatedAt, NOW)
  assert.deepEqual(puts.slice(4).map(({ item }) => item.type), ['episodic', 'emotional', 'social', 'procedural', 'self'])
})

test('archive import: logger only receives counts; storage errors never expose content', () => {
  const { service, store, logs } = harness()
  service.importArchive({ content: '{"text":"secret-marker","personId":"secret-person"}' })
  assert.deepEqual(Object.keys(logs[0][0]).sort(), ['bytes', 'imported', 'invalid', 'skipped', 'total'])
  assert.ok(Object.values(logs[0][0]).every((value) => typeof value === 'number'))
  assert.doesNotMatch(JSON.stringify(logs), /secret/)
  store.put = () => { throw new Error('secret-marker from storage') }
  assert.throws(() => service.importArchive({ content: '{"text":"different secret-marker"}' }), (error) => /写入失败/.test(error.message) && !error.message.includes('secret-marker'))
  assert.equal(logs.length, 1)
})

test('archive import: config defaults, normalization, panel fields and disabled gate', () => {
  assert.deepEqual(normalizeConfig({}).config.cognition.import, { enabled: true, maxBytes: 5242880, maxItems: 5000 })
  assert.deepEqual(normalizeConfig({ cognition: { import: { enabled: false, maxBytes: -1, maxItems: 99999 } } }).config.cognition.import, { enabled: false, maxBytes: 1, maxItems: 5000 })
  const fields = CONFIG_GROUPS.find((group) => group.id === 'cog-import')
  assert.equal(fields.title, '导入旧档案')
  assert.equal(fields.fields.length, 3)
  assert.throws(() => harness({ enabled: false }).service.importArchive({ content: '{"text":"secret"}' }), /禁用/)
})

test('archive import: cognition uses current persona, persists timestamps/search, respects disabled and unready', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-archive-'))
  const config = normalizeConfig({}).config
  const cog = createCognition({ dataRoot: dir, getConfig: () => config, scheduler: createFakeScheduler(), clock: { now: () => NOW } })
  try {
    const content = '{"text":"旧档案 archive keyword","createdAt":"2020-01-01T00:00:00Z"}'
    assert.equal(cog.importArchive({ content }).imported, 1)
    const originalId = cog.activePersonaId()
    const first = cog.memories({ query: 'archive' })
    assert.equal(first.length, 1)
    assert.equal(first[0].createdAt, Date.parse('2020-01-01T00:00:00Z'))
    const other = cog.createPersona({ name: '第二人格' })
    assert.equal(other.ok, true)
    assert.equal(cog.memories({}).length, 0)
    assert.equal(cog.importArchive({ content }).imported, 1)
    assert.equal(cog.importArchive({ content }).skipped, 1)
    cog.switchPersona(originalId)
    assert.equal(cog.memories({}).length, 1)
    assert.equal(cog.importArchive({ content }).skipped, 1)
    config.cognition.import.enabled = false
    assert.throws(() => cog.importArchive({ content }), /禁用/)
    config.cognition.import.enabled = true
    cog.dispose()
    assert.throws(() => cog.importArchive({ content }), /未就绪/)
  } finally {
    cog.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
