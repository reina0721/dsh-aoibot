// 本地模块内核：只加载数据目录中由操作员安装的 JavaScript 模块。
// 模块是任意本地代码；这里的 permissions 约束稳定 API 的暴露面，不是进程沙箱。

import { constants } from 'node:fs'
import { access, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const COMMAND_RE = /^[a-z][a-z0-9_-]{0,31}$/
const EVENT_NAMES = new Set(['message', 'notice', 'request', 'meta_event', 'any'])
const KNOWN_PERMISSIONS = new Set(['events', 'commands', 'send:text', 'cognition:read', 'knowledge', 'capabilities', 'storage'])
const MAX_STORAGE_BYTES = 1024 * 1024

function messageOf(error) {
  return String(error?.message || error || '未知错误').replace(/\s+/g, ' ').trim().slice(0, 500)
}

function clone(value) {
  if (value === undefined) return undefined
  return structuredClone(value)
}

function inside(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch (error) { return clone(fallback) }
}

async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8')
  await rename(temporary, file)
}

function publicRecord(record) {
  return {
    id: record.id,
    name: record.name,
    version: record.version,
    description: record.description,
    permissions: [...record.permissions],
    enabled: Boolean(record.enabled),
    status: record.status,
    error: record.error,
    loadedAt: record.loadedAt,
  }
}

/**
 * @param {object} options
 * @param {string} options.dataDir `<plugin data>/modules`
 */
export function createModuleKernel({ dataDir, getConfig, ctx = null, logger = null, cognition = null, outbound = null, commands = null } = {}) {
  if (!dataDir) throw new Error('module kernel 需要 dataDir')
  const root = resolve(dataDir)
  const stateFile = join(root, 'state.json')
  const log = logger?.child?.('modules') || logger || { info() {}, warn() {}, debug() {}, error() {}, child() { return this } }
  const records = new Map()
  let disabled = new Set()
  let started = false
  let disposed = false
  let operation = Promise.resolve()

  const serialize = (work) => {
    const next = operation.then(work, work)
    operation = next.catch(() => {})
    return next
  }

  function safeMessage(error) {
    return messageOf(error)
      .replaceAll(root, '<modules>')
      .replaceAll(pathToFileURL(root).href, 'file://<modules>')
  }

  async function requireModuleDirectory(id) {
    try {
      const info = await stat(join(root, id))
      if (!info.isDirectory()) throw new Error('不是目录')
    } catch (error) {
      throw new Error(`模块 ${id} 不存在`)
    }
  }

  async function loadState() {
    const state = await readJson(stateFile, {})
    disabled = new Set(Array.isArray(state?.disabled) ? state.disabled.filter((id) => ID_RE.test(String(id))) : [])
  }

  async function saveState() {
    await writeJsonAtomic(stateFile, { disabled: [...disabled].sort() })
  }

  async function manifestFor(moduleDir, directoryName) {
    const manifestFile = join(moduleDir, 'module.json')
    let manifest
    try {
      manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
    } catch (error) {
      throw new Error(`module.json 无法读取：${messageOf(error)}`)
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('module.json 必须是对象')
    const id = String(manifest.id || '')
    if (!ID_RE.test(id)) throw new Error('manifest.id 不合法')
    if (id !== directoryName) throw new Error(`manifest.id 必须与目录名一致（${directoryName}）`)
    const entry = String(manifest.entry || '')
    if (!entry || isAbsolute(entry) || !['.js', '.mjs'].includes(extname(entry).toLowerCase())) throw new Error('manifest.entry 必须是模块目录内的相对 .js/.mjs 文件')
    const entryPath = resolve(moduleDir, entry)
    if (!inside(moduleDir, entryPath)) throw new Error('manifest.entry 不能离开模块目录')
    const realModuleDir = await realpath(moduleDir)
    const realRoot = await realpath(root)
    if (!inside(realRoot, realModuleDir)) throw new Error('模块目录不能通过符号链接离开 modules 目录')
    let realEntry
    try {
      await access(entryPath, constants.R_OK)
      realEntry = await realpath(entryPath)
    } catch (error) {
      throw new Error(`入口文件无法读取：${messageOf(error)}`)
    }
    if (!inside(realModuleDir, realEntry)) throw new Error('manifest.entry 不能通过符号链接离开模块目录')
    const permissions = manifest.permissions === undefined ? [] : manifest.permissions
    if (!Array.isArray(permissions) || permissions.some((item) => typeof item !== 'string')) throw new Error('manifest.permissions 必须是字符串数组')
    const uniquePermissions = [...new Set(permissions)]
    const unknown = uniquePermissions.find((item) => !KNOWN_PERMISSIONS.has(item))
    if (unknown) throw new Error(`未知 permission：${unknown}`)
    return {
      id,
      name: String(manifest.name || id),
      version: String(manifest.version || ''),
      description: String(manifest.description || ''),
      permissions: uniquePermissions,
      manifestEnabled: manifest.enabled !== false,
      moduleDir: realModuleDir,
      entryPath: realEntry,
    }
  }

  function errorRecord(directoryName, error, previous = null) {
    return {
      id: previous?.id || directoryName,
      name: previous?.name || directoryName,
      version: previous?.version || '',
      description: previous?.description || '',
      permissions: previous?.permissions || [],
      enabled: !disabled.has(previous?.id || directoryName),
      status: 'error',
      error: safeMessage(error),
      loadedAt: previous?.loadedAt || null,
      moduleDir: previous?.moduleDir || join(root, directoryName),
      entryPath: previous?.entryPath || '',
      runtime: null,
    }
  }

  async function disposeRuntime(record) {
    const runtime = record?.runtime
    if (!runtime) return
    record.runtime = null
    const disposers = [...runtime.disposers].reverse()
    runtime.disposers.length = 0
    for (const dispose of disposers) {
      try { await dispose() } catch (error) { log.warn?.(`模块 ${record.id} 清理失败：${messageOf(error)}`) }
    }
  }

  function requirePermission(record, permission) {
    if (!record.permissions.includes(permission)) throw new Error(`模块 ${record.id} 缺少 permission: ${permission}`)
  }

  function storageApi(record, runtime) {
    const file = join(record.moduleDir, 'data.json')
    let valuesPromise = (async () => {
      try {
        const info = await stat(file)
        if (info.size > MAX_STORAGE_BYTES) throw new Error(`模块存储超过 ${MAX_STORAGE_BYTES} bytes`)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      return readJson(file, {})
    })()
    let writes = Promise.resolve()
    const values = async () => {
      const current = await valuesPromise
      return current && typeof current === 'object' && !Array.isArray(current) ? current : {}
    }
    const mutate = (work) => {
      const next = writes.then(async () => {
        const current = await values()
        const draft = clone(current)
        const result = work(draft)
        const text = JSON.stringify(draft, null, 2)
        if (Buffer.byteLength(text) > MAX_STORAGE_BYTES) throw new Error(`模块存储超过 ${MAX_STORAGE_BYTES} bytes`)
        await writeJsonAtomic(file, draft)
        valuesPromise = Promise.resolve(draft)
        return result
      })
      writes = next.catch(() => {})
      return next
    }
    return {
      async get(key, fallback = undefined) {
        const current = await values()
        return Object.hasOwn(current, String(key)) ? clone(current[String(key)]) : clone(fallback)
      },
      set(key, value) {
        return mutate((draft) => { draft[String(key)] = clone(value); return clone(value) })
      },
      delete(key) {
        return mutate((draft) => delete draft[String(key)])
      },
      async all() { return clone(await values()) },
    }
  }

  function apiFor(record, runtime) {
    const moduleLog = log?.child?.(record.id) || log
    const api = {
      id: record.id,
      name: record.name,
      version: record.version,
      dir: record.moduleDir,
      permissions: Object.freeze([...record.permissions]),
      log: moduleLog,
      on(eventName, handler) {
        requirePermission(record, 'events')
        const name = String(eventName || '')
        if (!EVENT_NAMES.has(name)) throw new Error(`不支持的事件名：${name}`)
        if (typeof handler !== 'function') throw new Error('事件 handler 必须是函数')
        const registration = { name, handler }
        runtime.handlers.add(registration)
        const dispose = () => runtime.handlers.delete(registration)
        runtime.disposers.push(dispose)
        return dispose
      },
      registerCommand(name, handler, options = {}) {
        requirePermission(record, 'commands')
        const normalized = String(name || '').toLowerCase()
        if (!COMMAND_RE.test(normalized)) throw new Error('命令名不合法')
        if (typeof handler !== 'function') throw new Error('命令 handler 必须是函数')
        if (!commands?.registerCommand) throw new Error('命令服务不可用')
        const dispose = commands.registerCommand(normalized, handler, { ownerOnly: options.ownerOnly !== false })
        runtime.disposers.push(dispose)
        return dispose
      },
      async sendText({ chatType, chatId, text } = {}) {
        requirePermission(record, 'send:text')
        if (!outbound?.deliver) throw new Error('出站服务不可用')
        const type = chatType === 'group' ? 'group' : chatType === 'private' ? 'private' : ''
        const id = String(chatId ?? '').trim()
        const value = String(text ?? '').trim()
        if (!type || !id || !value) throw new Error('sendText 需要 chatType、chatId、text')
        return outbound.deliver({ chatType: type, chatId: id, segments: [{ type: 'text', data: { text: value } }], source: `module:${record.id}` })
      },
      registerKnowledgeSource(source) {
        requirePermission(record, 'knowledge')
        if (!cognition?.registerKnowledgeSource) throw new Error('认知服务不可用')
        const dispose = cognition.registerKnowledgeSource(source)
        runtime.disposers.push(dispose)
        return dispose
      },
      registerCapability(name, impl) {
        requirePermission(record, 'capabilities')
        if (!cognition?.registerCapability) throw new Error('认知服务不可用')
        const dispose = cognition.registerCapability(name, impl)
        runtime.disposers.push(dispose)
        return dispose
      },
    }
    Object.defineProperty(api, 'storage', {
      enumerable: true,
      get() { requirePermission(record, 'storage'); return runtime.storage },
    })
    Object.defineProperty(api, 'cognition', {
      enumerable: true,
      get() {
        requirePermission(record, 'cognition:read')
        return Object.freeze({
          snapshot: (...args) => cognition?.snapshot?.(...args),
          overview: (...args) => cognition?.overview?.(...args),
          memories: (...args) => cognition?.memories?.(...args),
          personDetail: (...args) => cognition?.personDetail?.(...args),
          relationshipsList: (...args) => cognition?.relationshipsList?.(...args),
          timeline: (...args) => cognition?.timeline?.(...args),
        })
      },
    })
    return Object.freeze(api)
  }

  async function loadRecord(manifest, previous = null) {
    if (previous) await disposeRuntime(previous)
    const enabled = manifest.manifestEnabled && !disabled.has(manifest.id)
    const record = { ...manifest, enabled, status: enabled ? 'loading' : 'disabled', error: '', loadedAt: null, runtime: null }
    records.set(record.id, record)
    if (!enabled) return record
    const runtime = { handlers: new Set(), disposers: [], storage: null }
    record.runtime = runtime
    runtime.storage = storageApi(record, runtime)
    try {
      const fileStat = await stat(record.entryPath)
      const imported = await import(`${pathToFileURL(record.entryPath).href}?v=${fileStat.mtimeMs}-${Date.now()}`)
      const setup = typeof imported.setup === 'function' ? imported.setup : (typeof imported.default === 'function' ? imported.default : imported.default?.setup)
      if (typeof setup !== 'function') throw new Error('入口必须导出 setup(api)（named 或 default）')
      const cleanup = await setup(apiFor(record, runtime))
      if (cleanup !== undefined && typeof cleanup !== 'function') throw new Error('setup 返回值必须是 cleanup 函数或 undefined')
      if (cleanup) runtime.disposers.push(cleanup)
      record.status = 'loaded'
      record.loadedAt = Date.now()
      log.info?.(`模块 ${record.id} 已加载`)
    } catch (error) {
      await disposeRuntime(record)
      record.status = 'error'
      record.error = safeMessage(error)
      log.warn?.(`模块 ${record.id} 加载失败：${record.error}`)
    }
    return record
  }

  async function scan() {
    await mkdir(root, { recursive: true })
    await loadState()
    const entries = await readdir(root, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const directoryName = entry.name
      const existing = records.get(directoryName)
      try {
        const manifest = await manifestFor(join(root, directoryName), directoryName)
        await loadRecord(manifest, existing)
      } catch (error) {
        if (existing) await disposeRuntime(existing)
        records.set(directoryName, errorRecord(directoryName, error, existing))
      }
    }
  }

  function start() {
    return serialize(async () => {
      if (disposed) throw new Error('module kernel 已释放')
      if (started) return list()
      started = true
      await scan()
      return list()
    })
  }

  function list() {
    return [...records.values()].map(publicRecord).sort((a, b) => a.id.localeCompare(b.id))
  }

  function reload(id) {
    return serialize(async () => {
      const normalized = String(id || '')
      if (!ID_RE.test(normalized)) throw new Error('模块 id 不合法')
      const previous = records.get(normalized)
      try {
        await requireModuleDirectory(normalized)
      } catch (error) {
        if (previous) await disposeRuntime(previous)
        records.delete(normalized)
        throw error
      }
      try {
        const manifest = await manifestFor(join(root, normalized), normalized)
        return publicRecord(await loadRecord(manifest, previous))
      } catch (error) {
        if (previous) await disposeRuntime(previous)
        const record = errorRecord(normalized, error, previous)
        records.set(normalized, record)
        return publicRecord(record)
      }
    })
  }

  function setEnabled(id, enabled) {
    return serialize(async () => {
      const normalized = String(id || '')
      if (!ID_RE.test(normalized)) throw new Error('模块 id 不合法')
      await requireModuleDirectory(normalized)
      if (enabled) disabled.delete(normalized)
      else disabled.add(normalized)
      await saveState()
      const previous = records.get(normalized)
      if (!enabled && previous) {
        await disposeRuntime(previous)
        previous.enabled = false
        previous.status = 'disabled'
        previous.error = ''
        return publicRecord(previous)
      }
      try {
        const manifest = await manifestFor(join(root, normalized), normalized)
        return publicRecord(await loadRecord(manifest, previous))
      } catch (error) {
        const record = errorRecord(normalized, error, previous)
        records.set(normalized, record)
        return publicRecord(record)
      }
    })
  }

  async function dispatch(normalizedEvent) {
    if (disposed || !normalizedEvent) return
    const tasks = []
    for (const record of records.values()) {
      if (record.status !== 'loaded' || !record.runtime) continue
      for (const registration of record.runtime.handlers) {
        if (registration.name !== 'any' && registration.name !== normalizedEvent.kind) continue
        tasks.push(Promise.resolve().then(() => registration.handler(normalizedEvent)).catch(async (error) => {
          await disposeRuntime(record)
          record.status = 'error'
          record.error = `事件处理失败：${safeMessage(error)}`
          log.warn?.(`模块 ${record.id} 事件处理失败：${messageOf(error)}`)
        }))
      }
    }
    await Promise.allSettled(tasks)
  }

  function dispose() {
    return serialize(async () => {
      if (disposed) return
      disposed = true
      for (const record of records.values()) await disposeRuntime(record)
    })
  }

  return { start, list, reload, setEnabled, dispatch, dispose }
}

