// 通用 JSON/JSONL 旧档案导入；只接收正文，不读取路径、不调用外部服务。
import { createHash } from 'node:crypto'
import { MEMORY_TYPES } from './memory.js'

const MAX_BYTES = 5 * 1024 * 1024
const MAX_ITEMS = 5000
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function normalizeScope(value, fallback = { scopeType: 'global', scopeId: '' }) {
  if (!isObject(value)) throw new Error('导入作用域必须是对象')
  const scopeType = value.scopeType === undefined ? fallback.scopeType : value.scopeType
  const scopeId = value.scopeId === undefined ? (scopeType === fallback.scopeType ? fallback.scopeId : '') : value.scopeId
  if (!['global', 'private', 'group'].includes(scopeType)) throw new Error('导入作用域类型无效')
  if (scopeType === 'global') return { scopeType, scopeId: '' }
  if (typeof scopeId !== 'string' || !/^[0-9]+$/.test(scopeId)) throw new Error('私聊/群导入作用域 ID 必须是非空数字字符串')
  return { scopeType, scopeId }
}

function timestamp(value, fallback, now) {
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) ? Date.parse(value) : NaN
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= now ? Math.trunc(parsed) : fallback
}

function normalizeItem(item, scope, now) {
  if (!isObject(item) || item.kind === 'timeline') return null
  const text = [item.text, item.content, item.summary, item.memory].find((value) => typeof value === 'string')?.trim()
  if (!text || [...text].length > 4000) return null
  if (item.personId !== undefined && (typeof item.personId !== 'string' || [...item.personId].length > 64)) return null
  let itemScope
  try { itemScope = normalizeScope(item, scope) } catch { return null }
  const personId = item.personId || ''
  const id = 'imp_' + createHash('sha256').update(JSON.stringify([itemScope.scopeType, itemScope.scopeId, personId, text])).digest('hex')
  const createdAt = timestamp(item.createdAt, now, now)
  const updatedAt = Math.max(createdAt, timestamp(item.updatedAt, createdAt, now))
  return {
    id, ...itemScope, personId, text, content: text, summary: text,
    type: MEMORY_TYPES.includes(item.type) ? item.type : 'episodic',
    importance: typeof item.importance === 'number' && Number.isFinite(item.importance) ? Math.max(0, Math.min(1, item.importance)) : 0.5,
    source: 'import', status: 'active', stability: 0.5, confidence: 1, salience: 0.5,
    accessCount: 0, lastAccessed: 0, version: 1, createdAt, updatedAt,
  }
}

function normalizeTimelineItem(item, scope, now) {
  if (!isObject(item)) return null
  const text = [item.text, item.detail, item.summary, item.content, item.title].find((value) => typeof value === 'string')?.trim()
  if (!text || [...text].length > 2000) return null
  const time = [item.at, item.timestamp, item.time, item.createdAt].find((value) => value !== undefined && value !== null)
  if (time === undefined) return null
  const at = timestamp(time, now, now)
  if (item.personId !== undefined && (typeof item.personId !== 'string' || [...item.personId].length > 64)) return null
  let title
  if (item.title !== undefined) {
    if (typeof item.title !== 'string') return null
    title = item.title.trim()
    if (!title || [...title].length > 200) return null
  }
  let itemScope
  try { itemScope = normalizeScope(item, scope) } catch { return null }
  const personId = item.personId || ''
  const id = 'tle_' + createHash('sha256').update(JSON.stringify([itemScope.scopeType, itemScope.scopeId, personId, at, text])).digest('hex')
  return {
    id, ...itemScope, personId, text, summary: text, ...(title ? { title } : {}), at,
    type: 'event', source: 'import', status: 'active', createdAt: at, updatedAt: at,
  }
}

function parse(content, format, kind) {
  const trimmed = content.trim().replace(/^\uFEFF/, '')
  let parsed
  if (format !== 'jsonl') {
    try { parsed = JSON.parse(trimmed) } catch {
      if (format === 'json' || trimmed.startsWith('[') || trimmed.split(/\r?\n/).filter((line) => line.trim()).length < 2) {
        throw new Error('旧档案不是合法 JSON；JSONL 请逐行提供 JSON 对象')
      }
      format = 'jsonl'
    }
  }
  if (format === 'jsonl') {
    const items = trimmed.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
      try { return JSON.parse(line) } catch { return null }
    })
    return { format, items }
  }
  if (Array.isArray(parsed)) return { format: 'json', items: parsed }
  if (isObject(parsed)) {
    const keys = kind === 'timeline' ? ['events', 'timeline', 'items', 'data', 'records'] : ['memories', 'items', 'data', 'records']
    const items = keys.map((key) => parsed[key]).find(Array.isArray)
    return { format: 'json', items: items || [parsed] }
  }
  throw new Error('旧档案 JSON 必须是数组或对象')
}

export function createArchiveImportService({ store, getConfig, clock = { now: Date.now }, logger } = {}) {
  function importArchive({ format = 'auto', kind = 'memory', content, scope = { scopeType: 'global', scopeId: '' } } = {}) {
    const config = getConfig?.()?.cognition?.import || {}
    if (config.enabled === false) throw new Error('导入旧档案已禁用')
    if (typeof content !== 'string' || !content.trim()) throw new Error('旧档案 content 必须是非空字符串')
    if (!['auto', 'json', 'jsonl'].includes(format)) throw new Error('导入格式只支持 auto、json、jsonl')
    if (!['memory', 'timeline'].includes(kind)) throw new Error('导入 kind 只支持 memory、timeline')
    const bytes = Buffer.byteLength(content, 'utf8')
    const maxBytes = Number.isFinite(config.maxBytes) ? Math.max(1, Math.min(MAX_BYTES, config.maxBytes)) : MAX_BYTES
    const maxItems = Number.isFinite(config.maxItems) ? Math.max(1, Math.min(MAX_ITEMS, config.maxItems)) : MAX_ITEMS
    if (bytes > maxBytes) throw new Error(`旧档案超过导入大小上限（${maxBytes} 字节）`)
    const requestScope = normalizeScope(scope)
    const parsed = parse(content, format, kind)
    if (parsed.items.length > maxItems) throw new Error(`旧档案超过导入条数上限（${maxItems} 条）`)
    const now = clock.now()
    const recordKind = kind === 'timeline' ? 'timeline_event' : 'memory'
    const normalize = kind === 'timeline' ? normalizeTimelineItem : normalizeItem
    const normalized = parsed.items.map((item) => normalize(item, requestScope, now))
    const invalid = normalized.filter((item) => !item).length
    if (!normalized.some(Boolean)) throw new Error(kind === 'timeline' ? '旧档案没有有效时间轴项；请检查 JSON/JSONL、正文、时间及作用域' : '旧档案没有有效记忆项；请检查 JSON/JSONL、正文及作用域')
    let imported = 0
    let skipped = 0
    const seen = new Set()
    const write = () => {
      for (const item of normalized) {
        if (!item) continue
        if (seen.has(item.id) || store.get(recordKind, item.id)) { skipped += 1; continue }
        seen.add(item.id)
        store.put(recordKind, item.id, item, { createdAt: item.createdAt, updatedAt: item.updatedAt })
        imported += 1
      }
    }
    try {
      if (store.tx) store.tx(write)
      else write()
    } catch {
      throw new Error('旧档案写入失败；请检查认知存储状态后重试')
    }
    const result = { ok: true, kind, format: parsed.format, bytes, total: parsed.items.length, imported, skipped, invalid, scope: requestScope }
    logger?.info?.({ bytes, total: result.total, imported, skipped, invalid })
    return result
  }
  return { importArchive }
}
