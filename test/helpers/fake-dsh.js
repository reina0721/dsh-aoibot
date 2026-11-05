// 测试用的最小假 DSH 宿主：只实现 dsh-bot 宿主半边实际用到的服务。
//
// 宿主半边（src/host.js 及其依赖）只用到：
//   - ctx.effect(fn, label)：注册清理函数（插件卸载时逆序执行）；
//   - ctx.webServer.register({ kind:'exact', path, handler })：注册 REST 路由；
//   - ctx.emit(name, ...args) / ctx.on(name, fn)：插件事件总线；
//   - ctx.logger.info/warn/error/debug：把插件日志转给 DSH 自己的日志器；
//   - ctx.get(name) / ctx.provide(name, value)：无害的宿主服务查询（本插件暂不需要）。
//
// 本文件提供：
//   - createFakeDsh()：构造 fake ctx，并暴露 routes / disposers / listeners / emitted / logs；
//   - fake.call(path, body, { method, headers })：按注册的 exact（或 prefix）路由执行一次
//     模拟的 HTTP 请求，返回 { status, text, json, headers }，供 e2e 断言 REST 行为；
//   - fake.dispose()：逆序执行所有注册的清理函数（等价于 DSH 卸载插件）；
//   - waitFor(fn, { timeoutMs, intervalMs, label })：轮询异步条件，超时抛可读错误；
//   - sleep(ms)。
//
// 参考 aureth-labs/dsh-aurabot-qq 的 test/helpers/fake-dsh.js（MIT，见 THIRD_PARTY_NOTICES.md），
// 但本插件只需要「宿主装配」部分，不包含会话/模型/工具等无关服务。

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)))

/**
 * 轮询等待条件成立：fn 可以是同步/异步，返回真值即成功。默认 5s / 25ms。
 * 超时错误里带上最后一次异常，方便定位（比如 HTTP 还没起来）。
 * @template T
 * @param {() => T | Promise<T>} fn
 * @param {{ timeoutMs?: number, intervalMs?: number, label?: string }} [options]
 * @returns {Promise<T>}
 */
export async function waitFor(fn, { timeoutMs = 5000, intervalMs = 25, label = '条件' } = {}) {
  const startedAt = Date.now()
  let lastError = null
  for (;;) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    if (Date.now() - startedAt >= timeoutMs) {
      const detail = lastError ? `；最后一次错误：${lastError.message || lastError}` : ''
      throw new Error(`等待${label}超时（${timeoutMs}ms）${detail}`)
    }
    await sleep(intervalMs)
  }
}

/** 匹配 EXACT / PREFIX（不区分大小写），指标签用。 */
function methodOf(value) {
  return String(value || '').toUpperCase()
}

/**
 * 创建假 DSH 宿主。
 * @param {{ logger?: (level: string, message: string) => void }} [options]
 */
export function createFakeDsh(options = {}) {
  /** @type {Map<string, { kind: string, path: string, handler: Function }>} */
  const routes = new Map()
  /** 由 ctx.effect 登记的清理函数（卸载时逆序执行）。 */
  const disposers = []
  /** 事件监听器：name → Set<fn> */
  const listeners = new Map()
  /** ctx.emit 记录：{ name, args, at }（e2e 可以断言事件广播）。 */
  const emitted = []
  /** ctx.logger 输出：{ level, message, at } */
  const logs = []
  /** ctx.provide 登记的服务。 */
  const services = new Map()
  /** 外部传入的 logger 旁路（可选）。 */
  const loggerSink = typeof options.logger === 'function' ? options.logger : null

  let disposed = false

  function emit(name, ...args) {
    const entry = { name: String(name), args, at: Date.now() }
    emitted.push(entry)
    for (const fn of listeners.get(entry.name) || []) {
      try {
        fn(...args)
      } catch (error) {
        // 监听器异常不能打断 emit（和 DSH 的事件总线保持一致：一个坏监听器不影响其它）
      }
    }
    return entry
  }

  function log(level) {
    return (message) => {
      const text = typeof message === 'string' ? message : JSON.stringify(message)
      const entry = { level, message: text, at: Date.now() }
      logs.push(entry)
      try {
        loggerSink?.(level, text)
      } catch (error) {}
    }
  }

  const ctx = {
    /** 事件总线 */
    emit,
    on(name, fn) {
      const key = String(name)
      if (!listeners.has(key)) listeners.set(key, new Set())
      listeners.get(key).add(fn)
      return () => listeners.get(key)?.delete(fn)
    },
    once(name, fn) {
      const off = ctx.on(name, (...args) => {
        off()
        fn(...args)
      })
      return off
    },
    /** 插件清理注册：立即执行 fn，返回逆序清理时调用的函数；重复调用安全。 */
    effect(fn, _label) {
      const created = typeof fn === 'function' ? fn() : fn
      const cleanup = typeof created === 'function' ? created : () => {}
      disposers.push(cleanup)
      let done = false
      return () => {
        if (done) return
        done = true
        try {
          cleanup()
        } catch (error) {}
      }
    },
    /** 网页服务：exact 路由按 path 存一份（与 DSH 的行为一致：同 path 不区分 method）。 */
    webServer: {
      register(route) {
        const kind = route?.kind === 'prefix' ? 'prefix' : 'exact'
        const full = String(route?.path || '')
        if (!full) throw new Error('fake-dsh：webServer.register 缺少 path')
        if (typeof route?.handler !== 'function') throw new Error(`fake-dsh：路由 ${full} 缺少 handler`)
        routes.set(full, { kind, path: full, handler: route.handler })
        return () => {
          const current = routes.get(full)
          if (current && current.handler === route.handler) routes.delete(full)
        }
      },
    },
    /** DSH 日志器（插件会把自身日志镜像到这里）。 */
    logger: {
      debug: log('debug'),
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
    },
    /** 宿主服务查询：本插件只做无害的 get；测试可以预置服务。 */
    get(name) {
      return services.get(name)
    },
    provide(name, value) {
      services.set(name, value)
      const off = () => services.delete(name)
      disposers.push(off)
      return off
    },
    /** 常用宿主服务占位，避免插件里可选访问时报 TypeError。 */
    services: {
      get(name) {
        return services.get(name)
      },
    },
  }

  /**
   * 走一遍已注册路由（模拟 DSH 的 exact/prefix 分发），返回响应快照。
   * @param {string} path 完整路径（可以带 query），例如 `/onebot-qq/api/status`
   * @param {any} [body] 请求体（对象会被 JSON 序列化；GET 传 undefined）
   * @param {{ method?: string, headers?: Record<string, string> }} [init]
   */
  async function call(path, body, { method = 'POST', headers = {} } = {}) {
    const raw = String(path || '')
    if (!raw) throw new Error('fake-dsh.call：path 不能为空')
    let url
    try {
      url = new URL(raw, 'http://dsh-fake.local')
    } catch (error) {
      throw new Error(`fake-dsh.call：非法路径 ${raw}`)
    }
    const pathname = url.pathname
    const upper = methodOf(method)

    let route = routes.get(pathname)
    if (!route) {
      // 和 DSH 一样：exact 之外退化到最长的 prefix 路由
      route = [...routes.values()]
        .filter((item) => item.kind === 'prefix' && (pathname === item.path || pathname.startsWith(item.path.endsWith('/') ? item.path : item.path + '/')))
        .sort((a, b) => b.path.length - a.path.length)[0]
    }
    if (!route) {
      throw new Error(`fake-dsh：没有注册路由 ${upper} ${pathname}；已注册：${[...routes.keys()].join(', ') || '(空)'}`)
    }

    const normalizedHeaders = {}
    for (const [key, value] of Object.entries(headers || {})) normalizedHeaders[key.toLowerCase()] = String(value)

    const hasBody = body !== undefined && body !== null
    const payload = hasBody ? (Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')) : null

    const req = {
      method: upper,
      url: raw.startsWith('http') ? `${url.pathname}${url.search}` : raw,
      headers: normalizedHeaders,
      httpVersion: '1.1',
      async *[Symbol.asyncIterator]() {
        if (payload) yield payload
      },
    }

    let status = 200
    let text = ''
    let endResolve = null
    let ended = false
    const finished = new Promise((resolve) => {
      endResolve = resolve
    })
    const outHeaders = {}
    const res = {
      get statusCode() {
        return status
      },
      set statusCode(value) {
        const n = Number(value)
        status = Number.isFinite(n) ? n : 200
      },
      setHeader(name, value) {
        outHeaders[String(name).toLowerCase()] = String(value)
      },
      getHeader(name) {
        return outHeaders[String(name).toLowerCase()]
      },
      removeHeader(name) {
        delete outHeaders[String(name).toLowerCase()]
      },
      write(chunk) {
        if (chunk !== undefined && chunk !== null) text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
        return true
      },
      end(chunk) {
        if (chunk !== undefined && chunk !== null) {
          text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
        }
        ended = true
        endResolve?.()
      },
      destroy() {
        ended = true
        endResolve?.()
      },
    }

    // 真实 HTTP 服务里路由处理函数是异步写 res 的（routes.js 的 answer() 不被 await），
    // 因此这里要等到 res.end() 真正发生，而不是路由函数返回就返回。
    let guard = null
    try {
      await route.handler(req, res)
      if (!ended) {
        await Promise.race([
          finished,
          new Promise((resolve, reject) => {
            guard = setTimeout(() => reject(new Error(`fake-dsh：路由 ${pathname} 在 15s 内没有结束响应`)), 15000)
          }),
        ])
      }
    } finally {
      clearTimeout(guard)
    }

    let json = null
    if (text) {
      try {
        json = JSON.parse(text)
      } catch (error) {
        json = null
      }
    }
    return { status, text, json, headers: outHeaders, route: route.path, method: upper }
  }

  /** 逆序执行清理函数（模拟 DSH 卸载插件）。可重复调用。 */
  function dispose() {
    if (disposed) return
    disposed = true
    for (const cleanup of [...disposers].reverse()) {
      try {
        cleanup()
      } catch (error) {}
    }
    disposers.length = 0
    routes.clear()
    listeners.clear()
  }

  return {
    ctx,
    routes,
    disposers,
    listeners,
    emitted,
    logs,
    services,
    call,
    dispose,
    get disposed() {
      return disposed
    },
  }
}

export { sleep }
