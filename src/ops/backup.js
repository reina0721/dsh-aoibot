// Local directory snapshots. No live SQLite checkpoint or transactional restore:
// stop writers before copying databases and restart after restoring (see USER-MANUAL).
import {
  constants, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
  renameSync, rmSync, openSync, closeSync, readSync, writeSync, fstatSync,
} from 'node:fs'
import { resolve, relative, join, dirname, sep, parse, isAbsolute } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'

const ID = /^\d{8}T\d{9}Z-[a-f0-9]{8}$/
const DEFAULTS = { enabled: true, includeMedia: false, maxSnapshots: 10, maxBytes: 209715200, maxFiles: 5000, prune: true, allowRestore: false }
const forbidden = (name) => /^(logs|backups|restore-.*)$/i.test(name) || /(^~|~$|^\.?#|\.(tmp|temp|swp|swo|part|partial)([.-]|$)|^\.staging-)/i.test(name)
const safeRelative = (path) => typeof path === 'string' && path.length > 0 && !path.includes('\\') && !path.includes(':') && !path.includes('\0') && path.split('/').every((p) => p && p !== '.' && p !== '..')
const included = (path, media) => path === 'config.json' || path === 'models.json' || /^(cognition|modules)\//.test(path) || (media ? /^media\//.test(path) : path === 'media/stickers.json' || path.startsWith('media/stickers/'))
const validPath = (path, media) => safeRelative(path) && !path.split('/').some(forbidden) && included(path, media)

export function createBackupService({ dataDir, getConfig = () => ({}), logger } = {}) {
  const root = resolve(dataDir)
  const log = logger?.child?.('backup') || logger
  const config = () => {
    const raw = getConfig()?.ops?.backup || {}
    const cfg = { ...DEFAULTS, ...raw }
    for (const key of ['maxSnapshots', 'maxBytes', 'maxFiles']) {
      if (!Number.isSafeInteger(cfg[key]) || cfg[key] < 1) cfg[key] = DEFAULTS[key]
    }
    return cfg
  }
  const enabled = () => { if (config().enabled !== true) throw new Error('备份服务已禁用') }
  const validateId = (id) => { if (typeof id !== 'string' || !ID.test(id)) throw new Error('非法备份 id'); return id }

  // Check every existing component, including ancestors of dataDir. Never follow links.
  function checked(path, { missing = false } = {}) {
    const target = resolve(root, path)
    const rel = relative(root, target)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw new Error('路径超出数据目录')
    const anchor = parse(target).root
    const parts = target.slice(anchor.length).split(sep).filter(Boolean)
    let current = anchor
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i])
      let stat
      try { stat = lstatSync(current) } catch (error) {
        if (missing && error.code === 'ENOENT') return target
        throw error
      }
      if (stat.isSymbolicLink()) throw new Error('路径含符号链接')
      if (i < parts.length - 1 && !stat.isDirectory()) throw new Error('父路径不是目录')
    }
    return target
  }
  function directory(path) {
    const target = checked(path, { missing: true })
    mkdirSync(target, { recursive: true, mode: 0o700 })
    if (!lstatSync(checked(path)).isDirectory()) throw new Error('路径不是目录')
    return target
  }
  function remove(path) { rmSync(checked(path), { recursive: true, force: true }) }
  function exists(path) {
    try { checked(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
  }

  // Bounded copy from regular file descriptors; O_NOFOLLOW also protects final components.
  function copy(source, destination, limit, expected) {
    const src = checked(source)
    directory(dirname(destination))
    const dst = checked(destination, { missing: true })
    if (exists(destination) && (!lstatSync(dst).isFile() || lstatSync(dst).nlink > 1)) throw new Error('恢复目标不是普通文件')
    const input = openSync(src, constants.O_RDONLY | constants.O_NOFOLLOW)
    let output
    try {
      if (!fstatSync(input).isFile()) throw new Error('备份源不是普通文件')
      output = openSync(dst, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600)
      const hash = createHash('sha256')
      const buffer = Buffer.alloc(64 * 1024)
      let bytes = 0, size
      while ((size = readSync(input, buffer, 0, buffer.length, null)) > 0) {
        bytes += size
        if (bytes > limit) throw new Error('备份超过 maxBytes 限制')
        hash.update(buffer.subarray(0, size))
        let written = 0
        while (written < size) written += writeSync(output, buffer, written, size - written)
      }
      const sha256 = hash.digest('hex')
      if (expected && (bytes !== expected.bytes || sha256 !== expected.sha256)) throw new Error('备份文件校验失败')
      return { bytes, sha256 }
    } finally {
      closeSync(input)
      if (output !== undefined) closeSync(output)
    }
  }

  const publicItem = (m) => ({ id: m.id, createdAt: m.createdAt, note: m.note, bytes: m.bytes, files: m.files.length, includeMedia: m.includeMedia })
  function manifest(id) {
    validateId(id)
    const path = `backups/${id}/manifest.json`
    const stat = lstatSync(checked(path))
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('非法备份 manifest')
    const m = JSON.parse(readFileSync(checked(path), 'utf8'))
    if (m.version !== 1 || m.id !== id || typeof m.createdAt !== 'string' || !Number.isFinite(Date.parse(m.createdAt)) || typeof m.note !== 'string' || m.note.length > 1000 || typeof m.includeMedia !== 'boolean' || !Array.isArray(m.files) || !Array.isArray(m.excluded)) throw new Error('非法备份 manifest')
    let total = 0
    const seen = new Set()
    for (const entry of m.files) {
      if (!entry || !validPath(entry.path, m.includeMedia) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256) || seen.has(entry.path)) throw new Error('非法备份文件路径或元数据')
      seen.add(entry.path)
      total += entry.bytes
    }
    if (!Number.isSafeInteger(total) || total !== m.bytes) throw new Error('备份大小不匹配')
    return m
  }
  function list() {
    if (!exists('backups')) return []
    const items = []
    for (const entry of readdirSync(checked('backups'), { withFileTypes: true })) {
      if (!ID.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue
      try { items.push(publicItem(manifest(entry.name))) } catch { /* Incomplete/corrupt snapshots are never offered for restore. */ }
    }
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  }
  function prune(protectId) {
    const cfg = config()
    const items = list().sort((a, b) => Number(b.id === protectId) - Number(a.id === protectId))
    if (cfg.prune === true) for (const item of items.slice(cfg.maxSnapshots)) remove(`backups/${item.id}`)
  }
  function create({ includeMedia = false, note = '' } = {}, { pruneAfter = true } = {}) {
    enabled()
    if (typeof includeMedia !== 'boolean' || typeof note !== 'string' || note.length > 1000) throw new Error('需要 includeMedia(boolean) 与 note(最多 1000 字)')
    const cfg = config()
    directory('backups')
    const createdAt = new Date().toISOString()
    const id = createdAt.replace(/[-:.]/g, '') + '-' + randomBytes(4).toString('hex')
    const staging = `backups/.staging-${id}`
    directory(`${staging}/files`)
    const m = { version: 1, id, createdAt, note, includeMedia, files: [], bytes: 0, excluded: [] }
    const walk = (path) => {
      const basename = path.split('/').at(-1)
      if (!safeRelative(path) || forbidden(basename)) { m.excluded.push({ path, reason: 'excluded' }); return }
      const stat = lstatSync(join(root, path))
      if (stat.isSymbolicLink()) { m.excluded.push({ path, reason: 'symlink' }); return }
      checked(path)
      if (stat.isDirectory()) {
        // Only descend into the allowlisted roots and sticker directory.
        if (!['cognition', 'modules', 'media', 'media/stickers'].includes(path) && !included(path + '/', includeMedia)) { m.excluded.push({ path, reason: 'not included' }); return }
        for (const name of readdirSync(checked(path)).sort()) walk(`${path}/${name}`)
      } else if (stat.isFile() && included(path, includeMedia)) {
        if (m.files.length >= cfg.maxFiles) throw new Error('备份超过 maxFiles 限制')
        if (stat.size > cfg.maxBytes - m.bytes) throw new Error('备份超过 maxBytes 限制')
        const result = copy(path, `${staging}/files/${path}`, cfg.maxBytes - m.bytes)
        m.files.push({ path, ...result })
        m.bytes += result.bytes
      } else m.excluded.push({ path, reason: 'not included or not regular' })
    }
    try {
      for (const name of readdirSync(checked('')).sort()) walk(name)
      writeFileSync(checked(`${staging}/manifest.json`, { missing: true }), JSON.stringify(m, null, 2), { mode: 0o600, flag: 'wx' })
      renameSync(checked(staging), checked(`backups/${id}`, { missing: true }))
    } catch (error) {
      remove(staging)
      throw error
    }
    if (pruneAfter) prune(id)
    log?.info?.(`本地备份已创建：${id}`)
    return publicItem(m)
  }
  function restore(id, { apply = false } = {}) {
    enabled()
    validateId(id)
    if (typeof apply !== 'boolean') throw new Error('apply 必须是 boolean')
    const cfg = config()
    if (apply && cfg.allowRestore !== true) throw new Error('应用恢复已禁用：需要 ops.backup.allowRestore=true')
    const m = manifest(id)
    if (m.files.length > cfg.maxFiles || m.bytes > cfg.maxBytes) throw new Error('备份超过 maxFiles 或 maxBytes 限制')
    // Validate all sources/targets before any restore work. Copy/checksum into private
    // staging before creating the safety snapshot (which may otherwise prune id).
    const destination = `restore-${id}`
    if (!apply && exists(destination)) throw new Error('恢复暂存目录已存在，请先移走该目录')
    for (const entry of m.files) {
      const source = `backups/${id}/files/${entry.path}`
      if (!lstatSync(checked(source)).isFile()) throw new Error('备份源不是普通文件')
      if (apply) {
        const target = checked(entry.path, { missing: true })
        if (exists(entry.path) && (!lstatSync(target).isFile() || lstatSync(target).nlink > 1)) throw new Error('恢复目标不是普通文件')
      }
    }
    const staging = `restore-tmp-${randomBytes(8).toString('hex')}`
    directory(staging)
    try {
      for (const entry of m.files) copy(`backups/${id}/files/${entry.path}`, `${staging}/${entry.path}`, entry.bytes, entry)
      if (!apply) {
        renameSync(checked(staging), checked(destination, { missing: true }))
        return { ok: true, requiresRestart: true, stagedPath: destination }
      }
      // Keep the pre-restore snapshot even if application fails. Prune only after success.
      const safety = create({ includeMedia: m.includeMedia, note: `pre-restore:${id}` }, { pruneAfter: false })
      for (const entry of m.files) copy(`${staging}/${entry.path}`, entry.path, entry.bytes, entry)
      prune(safety.id)
      return { ok: true, applied: true, requiresRestart: true }
    } finally {
      if (exists(staging)) remove(staging)
    }
  }
  return {
    // Synchronous filesystem operations keep mutations serialized within this process.
    create: async (options) => create(options),
    list: async () => list(),
    delete: async (id) => { enabled(); validateId(id); remove(`backups/${id}`); return { ok: true } },
    restore: async (id, options) => restore(id, options),
    status: async () => { const c = config(); return { enabled: c.enabled, maxSnapshots: c.maxSnapshots, maxBytes: c.maxBytes, allowRestore: c.allowRestore, snapshotCount: list().length } },
    dispose() {},
  }
}
