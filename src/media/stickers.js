import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_MAX_COUNT = 200
const MIME_EXTENSIONS = {
  'image/png': new Set(['.png']),
  'image/jpeg': new Set(['.jpg', '.jpeg']),
  'image/gif': new Set(['.gif']),
  'image/webp': new Set(['.webp']),
}
const EXTENSION_MIME = Object.fromEntries(Object.entries(MIME_EXTENSIONS).flatMap(([mime, extensions]) => [...extensions].map((ext) => [ext, mime])))

function cleanTags(tags) {
  return [...new Set((Array.isArray(tags) ? tags : String(tags || '').split(/[,，]/))
    .map((tag) => String(tag || '').trim().slice(0, 40)).filter(Boolean))].slice(0, 20)
}

function publicRecord(record) {
  if (!record) return null
  const { file, ...value } = record
  return { ...value, tags: [...(record.tags || [])] }
}

export function createStickerService({ dataDir, getConfig, logger } = {}) {
  if (typeof getConfig !== 'function') throw new Error('createStickerService 需要 getConfig')
  const log = logger?.child?.('stickers') || logger || { warn() {} }
  const root = resolve(String(dataDir || 'media'))
  const filesDir = join(root, 'stickers')
  const indexFile = join(root, 'stickers.json')
  let loaded = false
  let records = []
  let queue = Promise.resolve()

  const limits = () => {
    const config = getConfig()?.media?.stickers || {}
    return {
      enabled: config.enabled !== false,
      maxBytes: Math.max(1024, Math.min(50 * 1024 * 1024, Number(config.maxBytes) || DEFAULT_MAX_BYTES)),
      maxCount: Math.max(1, Math.min(5000, Number(config.maxCount) || DEFAULT_MAX_COUNT)),
    }
  }

  async function ensureLoaded() {
    if (loaded) return
    await mkdir(filesDir, { recursive: true })
    try {
      const parsed = JSON.parse(await readFile(indexFile, 'utf8'))
      const source = Array.isArray(parsed) ? parsed : parsed?.items
      records = (Array.isArray(source) ? source : []).filter((item) => item && item.id && item.file && item.hash)
        .map((item) => ({
          id: String(item.id), name: basename(String(item.name || item.file)), mime: String(item.mime || ''),
          size: Math.max(0, Number(item.size) || 0), hash: String(item.hash), tags: cleanTags(item.tags),
          createdAt: String(item.createdAt || new Date(0).toISOString()), file: basename(String(item.file)),
        }))
    } catch (error) {
      records = []
      if (error?.code !== 'ENOENT') log.warn?.(`表情包索引损坏，已按空库加载：${error.message}`)
    }
    loaded = true
  }

  async function persist() {
    await mkdir(root, { recursive: true })
    const temp = `${indexFile}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, JSON.stringify({ version: 1, items: records }, null, 2) + '\n', { flag: 'wx' })
      await rename(temp, indexFile)
    } catch (error) {
      await unlink(temp).catch(() => {})
      throw error
    }
  }

  function serialized(work) {
    const next = queue.then(work, work)
    queue = next.catch(() => {})
    return next
  }

  async function importBuffer(buffer, { name, mime, tags } = {}) {
    return serialized(async () => {
      await ensureLoaded()
      const value = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || [])
      const config = limits()
      if (!config.enabled) throw new Error('表情包未启用')
      if (!value.length) throw new Error('图片不能为空')
      if (value.length > config.maxBytes) throw new Error(`图片超过大小限制 ${config.maxBytes} bytes`)
      const normalizedMime = String(mime || '').split(';')[0].trim().toLowerCase()
      const extension = extname(basename(String(name || ''))).toLowerCase()
      if (!MIME_EXTENSIONS[normalizedMime] || !EXTENSION_MIME[extension]) throw new Error('只支持 png/jpg/jpeg/gif/webp 图片')
      if (!MIME_EXTENSIONS[normalizedMime].has(extension)) throw new Error('图片扩展名与 MIME 不匹配')
      const hash = createHash('sha256').update(value).digest('hex')
      const duplicate = records.find((item) => item.hash === hash)
      if (duplicate) return publicRecord(duplicate)
      if (records.length >= config.maxCount) throw new Error(`表情包数量已达上限 ${config.maxCount}`)
      await mkdir(filesDir, { recursive: true })
      const id = randomUUID()
      const file = `${id}${extension}`
      await writeFile(join(filesDir, file), value, { flag: 'wx' })
      const record = {
        id, name: basename(String(name || `sticker${extension}`)).slice(0, 120), mime: normalizedMime,
        size: value.length, hash, tags: cleanTags(tags), createdAt: new Date().toISOString(), file,
      }
      records.push(record)
      try { await persist() } catch (error) { records.pop(); await unlink(join(filesDir, file)).catch(() => {}); throw error }
      return publicRecord(record)
    })
  }

  async function importFile(filePath, { tags } = {}) {
    const fullPath = resolve(String(filePath || ''))
    const extension = extname(fullPath).toLowerCase()
    const mime = EXTENSION_MIME[extension]
    if (!mime) throw new Error('只支持 png/jpg/jpeg/gif/webp 图片')
    return importBuffer(await readFile(fullPath), { name: basename(fullPath), mime, tags })
  }

  async function list({ query = '', tag = '', limit = 100 } = {}) {
    await ensureLoaded()
    const needle = String(query || '').trim().toLowerCase()
    const wantedTag = String(tag || '').trim().toLowerCase()
    const max = Math.max(1, Math.min(500, Number(limit) || 100))
    return records.filter((item) => {
      const tags = item.tags.map((value) => value.toLowerCase())
      return (!wantedTag || tags.includes(wantedTag)) && (!needle || item.name.toLowerCase().includes(needle) || tags.some((value) => value.includes(needle)))
    }).slice(0, max).map(publicRecord)
  }

  async function pick(options = {}) {
    const matches = await list({ ...options, limit: 500 })
    return matches.length ? matches[Math.floor(Math.random() * matches.length)] : null
  }

  async function updateTags(id, tags) {
    return serialized(async () => {
      await ensureLoaded()
      const record = records.find((item) => item.id === String(id || ''))
      if (!record) return null
      const previous = record.tags
      record.tags = cleanTags(tags)
      try { await persist() } catch (error) { record.tags = previous; throw error }
      return publicRecord(record)
    })
  }

  async function remove(id) {
    return serialized(async () => {
      await ensureLoaded()
      const index = records.findIndex((item) => item.id === String(id || ''))
      if (index < 0) return false
      const [record] = records.splice(index, 1)
      try { await persist() } catch (error) { records.splice(index, 0, record); throw error }
      await unlink(join(filesDir, record.file)).catch((error) => { if (error?.code !== 'ENOENT') log.warn?.(`删除表情包文件失败：${error.message}`) })
      return true
    })
  }

  async function fileFor(id) {
    await ensureLoaded()
    const record = records.find((item) => item.id === String(id || ''))
    if (!record) return null
    const path = resolve(filesDir, record.file)
    if (!path.startsWith(`${resolve(filesDir)}${sep}`)) return null
    try {
      const info = await stat(path)
      return info.isFile() ? { path, mime: record.mime, size: info.size } : null
    } catch (error) { return null }
  }

  async function status() {
    await ensureLoaded()
    const config = limits()
    return { enabled: config.enabled, count: records.length, maxCount: config.maxCount, maxBytes: config.maxBytes }
  }

  return { importBuffer, importFile, list, pick, updateTags, remove, fileFor, status }
}
