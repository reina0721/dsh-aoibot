// Internal composition slots. Only the host/module kernel may expose registration.
const ALLOWED_NAMES = new Set(['reminders'])

export function createProviderRegistry({ logger } = {}) {
  const registrations = new Map()

  function register(name, provider, { moduleId, source = 'builtin' } = {}) {
    if (!ALLOWED_NAMES.has(name)) throw new Error('未知 provider 名称')
    if (source !== 'builtin') throw new Error('provider 仅允许内置模块注册')
    if (typeof moduleId !== 'string' || !moduleId.trim()) throw new Error('provider 需要 moduleId')
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)
      || typeof provider.start !== 'function' || typeof provider.stop !== 'function'
      || (provider.status !== undefined && typeof provider.status !== 'function')) {
      throw new Error('provider 需要 start/stop 函数，status 必须是函数')
    }
    if (registrations.has(name)) throw new Error('provider 名称已注册')
    if ([...registrations.values()].some((entry) => entry.moduleId === moduleId)) throw new Error('provider moduleId 已注册')
    const entry = { name, moduleId, source, provider }
    registrations.set(name, entry)
    // A stale disposer cannot remove a later registration in the same slot.
    return () => {
      if (registrations.get(name) === entry) registrations.delete(name)
    }
  }

  function get(name) { return registrations.get(name)?.provider || null }
  function list() {
    return [...registrations.values()].map(({ name, moduleId, source }) => ({ name, moduleId, source }))
  }
  function remove(moduleId) {
    for (const [name, entry] of registrations) {
      if (entry.moduleId === moduleId) return registrations.delete(name)
    }
    return false
  }

  return Object.freeze({ register, get, list, remove })
}
