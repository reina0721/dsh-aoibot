import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createArchiveImportService } from '../src/cognition/archive-import.js'
import { createStore } from '../src/cognition/store.js'
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
    assert.deepEqual(result, { ok: true, kind: 'memory', format: 'json', bytes: Buffer.byteLength(content), total: 4, imported: 4, skipped: 0, invalid: 0, scope: { scopeType: 'global', scopeId: '' } })
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

test('timeline import: JSON array, wrappers, single timeline object and text aliases', () => {
  for (const wrap of [(items) => items, ...['events', 'timeline', 'items', 'data', 'records'].map((key) => (items) => ({ [key]: items }))]) {
    const { service, puts } = harness()
    const content = JSON.stringify(wrap(['text', 'detail', 'summary', 'content', 'title'].map((key) => ({ [key]: key, at: 1000 }))))
    assert.deepEqual(service.importArchive({ kind: 'timeline', content }), { ok: true, kind: 'timeline', format: 'json', bytes: Buffer.byteLength(content), total: 5, imported: 5, skipped: 0, invalid: 0, scope: { scopeType: 'global', scopeId: '' } })
    assert.deepEqual(puts.map(({ item }) => item.text), ['text', 'detail', 'summary', 'content', 'title'])
    assert.ok(puts.every(({ kind }) => kind === 'timeline_event'))
  }
  const content = '{"kind":"timeline","text":"single","at":1000}'
  assert.equal(harness().service.importArchive({ kind: 'timeline', content }).imported, 1)
  assert.throws(() => harness().service.importArchive({ content }), /没有有效记忆/)
})

test('timeline import: JSONL auto/explicit, malformed lines, time required and kind validation', () => {
  for (const format of ['auto', 'jsonl']) {
    const result = harness().service.importArchive({ kind: 'timeline', format, content: '{"detail":"first","timestamp":1000}\ninvalid\n{"text":"missing"}\n{"title":"second","time":2000}\nnull' })
    assert.equal(result.format, 'jsonl')
    assert.equal(result.total, 5)
    assert.equal(result.imported, 2)
    assert.equal(result.invalid, 3)
  }
  const { service, puts } = harness()
  for (const kind of ['', null, 'event', 'timeline_event', {}, 1]) assert.throws(() => service.importArchive({ kind, content: '{"text":"x","at":1000}' }), /kind/)
  for (const item of [{ text: 'missing' }, { text: 'null', at: null }]) assert.throws(() => service.importArchive({ kind: 'timeline', content: JSON.stringify(item) }), /没有有效时间轴/)
  assert.equal(puts.length, 0)
})

test('timeline import: scope/person/time/text identity, dedupe and existing status preserved', () => {
  const { service, puts, store } = harness()
  const scope = { scopeType: 'private', scopeId: '123' }
  const content = JSON.stringify([
    { text: ' same ', at: 1000 }, { text: 'same', at: 1000, title: 'ignored in identity', type: 'turn' },
    { text: 'same', at: 2000 }, { text: 'same', at: 1000, personId: 'p1' },
    { text: 'same', at: 1000, scopeType: 'group', scopeId: '123' }, { text: 'same', at: 1000, scopeType: 'global' },
    { text: 'same', at: 1000, scopeId: '456' },
  ])
  const result = service.importArchive({ kind: 'timeline', content, scope })
  assert.deepEqual(result.scope, scope)
  assert.equal(result.imported, 6); assert.equal(result.skipped, 1)
  assert.equal(new Set(puts.map(({ id }) => id)).size, 6)
  const first = puts[0].item
  assert.match(first.id, /^tle_[a-f0-9]{64}$/)
  store.put('timeline_event', first.id, { ...first, status: 'inactive' })
  const count = puts.length
  assert.equal(service.importArchive({ kind: 'timeline', content, scope }).skipped, 7)
  assert.equal(puts.length, count)
  assert.equal(store.get('timeline_event', first.id).status, 'inactive')
  const second = harness(); second.service.importArchive({ kind: 'timeline', content, scope })
  assert.equal(second.puts[0].id, first.id)
  service.importArchive({ content: '{"text":"same"}', scope })
  assert.match(puts.at(-1).id, /^imp_/)
})

test('timeline import: time aliases, invalid/future fallback, sanitized fields and count-only logs', () => {
  const { service, puts, logs } = harness()
  const past = Date.parse('2020-01-01T00:00:00Z')
  service.importArchive({ kind: 'timeline', content: JSON.stringify([
    { text: ' secret ', title: ' title ', at: '2020-01-01T00:00:00Z', timestamp: 2000, type: 'turn', kind: 'decision', source: 'evil', status: 'inactive', personaId: 'other', arbitrary: true, createdAt: 3000, updatedAt: 4000 },
    { detail: 'timestamp', timestamp: past }, { summary: 'time', time: past }, { content: 'createdAt', createdAt: past },
    ...['invalid', -1, 0, NOW + 1, '9999-01-01T00:00:00Z', {}].map((at, index) => ({ text: 'fallback ' + index, at })),
  ]) })
  assert.deepEqual(puts[0].item, { id: puts[0].id, scopeType: 'global', scopeId: '', personId: '', text: 'secret', summary: 'secret', title: 'title', at: past, type: 'event', source: 'import', status: 'active', createdAt: past, updatedAt: past })
  assert.deepEqual(puts[0].options, { createdAt: past, updatedAt: past })
  assert.ok(puts.slice(0, 4).every(({ item }) => item.at === past))
  assert.ok(puts.slice(4).every(({ item }) => item.at === NOW && item.createdAt === NOW && item.updatedAt === NOW))
  assert.ok(Object.values(logs[0][0]).every((value) => typeof value === 'number'))
  assert.doesNotMatch(JSON.stringify(logs), /secret|title|persona/)
})

test('timeline import: Unicode bounds, optional title/person and invalid scopes', () => {
  const { service, puts } = harness()
  const invalid = [null, [], 1, {}, { text: '' }, { text: '😀'.repeat(2001) }, { text: 'x', title: '' }, { text: 'x', title: '😀'.repeat(201) }, { text: 'x', title: 42 }, { text: 'x', personId: '😀'.repeat(65) }, { text: 'x', personId: 1 }, { text: 'x', scopeType: 'group' }, { text: 'x', scopeType: 'private', scopeId: 'bad' }, { text: 'x', scopeType: 'other' }]
  const content = JSON.stringify([...invalid.map((item) => item && !Array.isArray(item) && typeof item === 'object' ? { at: 1000, ...item } : item), { text: '😀'.repeat(2000), title: '😀'.repeat(200), personId: '😀'.repeat(64), at: 1000 }])
  assert.equal(service.importArchive({ kind: 'timeline', content }).invalid, invalid.length)
  assert.equal(puts.length, 1)
  for (const scope of [null, { scopeType: 'group', scopeId: 'x' }]) assert.throws(() => service.importArchive({ kind: 'timeline', content, scope }), /作用域/)
})

test('timeline import: shared byte/item hard limits, disabled gate and safe storage errors', () => {
  const content = '{"text":"中文","at":1000}'
  assert.equal(harness({ maxBytes: Buffer.byteLength(content) }).service.importArchive({ kind: 'timeline', content }).bytes, Buffer.byteLength(content))
  for (const [config, input, message] of [
    [{ maxBytes: Buffer.byteLength(content) - 1 }, content, /大小上限/],
    [{ maxItems: 1 }, content + '\ninvalid', /条数上限/],
    [{}, 'x'.repeat(5242881), /大小上限/],
    [{}, JSON.stringify(Array.from({ length: 5001 }, () => ({ text: 'x', at: 1000 }))), /条数上限/],
    [{ enabled: false }, content, /禁用/],
  ]) {
    const { service, puts } = harness(config)
    assert.throws(() => service.importArchive({ kind: 'timeline', content: input }), message)
    assert.equal(puts.length, 0)
  }
  const { service, store, logs } = harness()
  store.put = () => { throw new Error('secret-marker') }
  assert.throws(() => service.importArchive({ kind: 'timeline', content }), (error) => /写入失败/.test(error.message) && !error.message.includes('secret-marker'))
  assert.equal(logs.length, 0)
})

test('timeline import: persona isolation, persistence and deletion lifecycle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-timeline-archive-'))
  const config = normalizeConfig({}).config
  const options = { dataRoot: dir, getConfig: () => config, scheduler: createFakeScheduler(), clock: { now: () => NOW } }
  let cog = createCognition(options)
  try {
    const input = { kind: 'timeline', content: '{"text":"past event","at":1000}', scope: { scopeType: 'group', scopeId: '123' } }
    const original = cog.activePersonaId()
    assert.equal(cog.importArchive(input).imported, 1)
    assert.equal(cog.memories({}).length, 0)
    assert.equal(cog.timeline({ types: ['event'] })[0].detail, 'past event')
    const other = cog.createPersona({ name: 'Other' }).persona.id
    assert.equal(cog.timeline({ types: ['event'] }).length, 0)
    assert.equal(cog.importArchive(input).imported, 1)
    assert.equal(cog.importArchive(input).skipped, 1)
    cog.switchPersona(original)
    assert.equal(cog.importArchive(input).skipped, 1)
    cog.dispose()
    cog = createCognition(options)
    assert.equal(cog.timeline({ types: ['event'] })[0].at, 1000)
    assert.equal(cog.personaDataSummary(original).groups.find((group) => group.id === 'timeline').count, 1)
    assert.equal(cog.copyPersonaData(original, other, ['timeline']).copied.timeline, 1)
    cog.switchPersona(other)
    assert.equal(cog.importArchive(input).skipped, 1)
    cog.switchPersona(original)
    assert.equal(cog.deletePersona(other).ok, true)
    const base = createStore({ file: join(dir, 'cognition.sqlite') })
    try { assert.equal(base.count(`persona_${other}:timeline_event`), 0) } finally { base.close() }
  } finally { cog.dispose(); rmSync(dir, { recursive: true, force: true }) }
})
