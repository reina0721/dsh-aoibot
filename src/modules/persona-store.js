// 内置模块的窄同步仓库；仅保存 JSON 值，不暴露底层 store、kind 或人格 ID。
import { ID_RE } from './manifest.js'
import { MODULE_STORE_KIND } from '../cognition/persona-scope.js'

const MAX_VALUE_BYTES = 64 * 1024
const MAX_RECORDS = 1000
const QUOTA_EXCEEDED = Symbol('quota')

function assertJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (!value || typeof value !== 'object' || ancestors.has(value)) throw new Error('invalid JSON')
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('invalid JSON')
  if (Object.getOwnPropertySymbols(value).length) throw new Error('invalid JSON')
  ancestors.add(value)
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new Error('invalid JSON array')
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) throw new Error('invalid JSON array')
      assertJson(value[i], ancestors)
    }
  } else {
    for (const item of Object.values(value)) assertJson(item, ancestors)
  }
  ancestors.delete(value)
}

function cloneValue(value) {
  let copy, text
  try {
    assertJson(value)
    copy = structuredClone(value)
    assertJson(copy)
    text = JSON.stringify(copy)
  } catch {
    throw new Error('人格仓库值必须是可克隆的 JSON 值')
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_VALUE_BYTES) throw new Error('人格仓库每条值最多 64 KiB')
  return copy
}

export function createModulePersonaStore({ store, moduleId, assertActive }) {
  if (typeof moduleId !== 'string' || !ID_RE.test(moduleId) || !moduleId.startsWith('builtin-')) throw new Error('人格仓库模块命名空间不合法')
  const prefix = `module:${moduleId}:`
  const owns = row => typeof row.id === 'string' && row.id.startsWith(prefix)
  const idOf = key => {
    if (typeof key !== 'string' || !ID_RE.test(key)) throw new Error('人格仓库 key 必须是 1–64 位小写安全 ID')
    return prefix + key
  }
  function ready(actual, minimum, maximum = minimum) {
    assertActive()
    if (actual < minimum || actual > maximum) throw new Error('人格仓库参数不合法')
    if (!store) throw new Error('人格仓库服务不可用')
  }
  function access(work) {
    try { return work() } catch (error) {
      if (error === QUOTA_EXCEEDED) throw new Error('人格仓库每模块每人格最多 1000 条')
      throw new Error('人格仓库操作失败')
    }
  }
  const count = () => store.count(MODULE_STORE_KIND, owns)
  return Object.freeze({
    get(key) {
      ready(arguments.length, 1)
      const id = idOf(key)
      return access(() => {
        const row = store.get(MODULE_STORE_KIND, id)
        return row ? structuredClone(row.value) : null
      })
    },
    put(key, value) {
      ready(arguments.length, 2)
      const id = idOf(key), copy = cloneValue(value)
      // 同步事务中检查当前人格/模块额度，覆盖已有 key 不占新额度。
      return access(() => store.tx(() => {
        if (!store.get(MODULE_STORE_KIND, id) && count() >= MAX_RECORDS) throw QUOTA_EXCEEDED
        return structuredClone(store.put(MODULE_STORE_KIND, id, { value: copy }).value)
      }))
    },
    remove(key) {
      ready(arguments.length, 1)
      const id = idOf(key)
      return access(() => store.tx(() => {
        if (!store.get(MODULE_STORE_KIND, id)) return false
        store.remove(MODULE_STORE_KIND, id)
        return true
      }))
    },
    list(options = {}) {
      ready(arguments.length, 0, 1)
      if (!options || typeof options !== 'object' || Array.isArray(options) || Reflect.ownKeys(options).some(key => key !== 'limit')) throw new Error('人格仓库 list 仅接受 limit')
      const limit = options.limit === undefined ? 100 : options.limit
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECORDS) throw new Error('人格仓库 limit 必须是 1–1000 的整数')
      return access(() => store.list(MODULE_STORE_KIND, { where: owns, limit }).map(row => ({
        key: row.id.slice(prefix.length), value: structuredClone(row.value),
      })))
    },
    count() {
      ready(arguments.length, 0)
      return access(count)
    },
  })
}
