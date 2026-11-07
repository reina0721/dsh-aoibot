// Internal lifecycle seam. Only the module kernel may expose registration to built-ins.
export function createTurnHooks({ logger } = {}) {
  const hooks = new Map()

  function register({ id, onStart, onEnd } = {}) {
    if (typeof id !== 'string' || !id.trim()) throw new Error('turn hook 需要 id')
    if (hooks.has(id)) throw new Error('turn hook id 重复')
    if (onStart === undefined && onEnd === undefined) throw new Error('turn hook 至少需要一个 handler')
    if ((onStart !== undefined && typeof onStart !== 'function') || (onEnd !== undefined && typeof onEnd !== 'function')) throw new Error('turn hook handler 必须是函数')
    const hook = Object.freeze({ id, onStart, onEnd })
    hooks.set(id, hook)
    return () => {
      if (hooks.get(id) === hook) hooks.delete(id)
    }
  }

  async function run(handler, context, reverse = false) {
    const entries = [...hooks.values()]
    if (reverse) entries.reverse()
    for (const hook of entries) {
      try { await hook[handler]?.(context) } catch (error) {
        // Neither descriptors, context nor raw errors are safe to log.
        try { logger?.warn?.('turn lifecycle hook failed') } catch (error) {}
      }
    }
  }

  return Object.freeze({
    register,
    start: (context) => run('onStart', context),
    end: (context) => run('onEnd', context, true),
    list: () => [...hooks.values()],
  })
}
