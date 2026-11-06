// 可选 OpenAI 兼容 embeddings；默认关闭，状态查询不联网，缓存仅驻内存。
import { createHash } from 'node:crypto'

const defaults = { enabled: false, baseUrl: '', model: 'text-embedding-3-small', apiKeyEnv: '', weight: 0.35 }

function endpoint(baseUrl) {
  try {
    const url = new URL(baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return ''
    url.pathname = url.pathname.replace(/\/+$/, '') + '/embeddings'
    return url.href
  } catch { return '' }
}

function validVectors(vectors, count) {
  const dimension = vectors[0]?.length
  return vectors.length === count && dimension >= 8 && dimension <= 4096
    && vectors.every((vector) => Array.isArray(vector) && vector.length === dimension
      && vector.every((value) => typeof value === 'number' && Number.isFinite(value)))
}

function cosine(a, b) {
  // 先缩放，避免有限但极大的元素在点积/范数中溢出。
  const scaleA = Math.max(...a.map(Math.abs)), scaleB = Math.max(...b.map(Math.abs))
  if (!scaleA || !scaleB) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] / scaleA, y = b[i] / scaleB
    dot += x * y
    normA += x * x
    normB += y * y
  }
  return Math.max(-1, Math.min(1, dot / Math.sqrt(normA * normB)))
}

export function createEmbeddingService({ getConfig, logger, fetchImpl = globalThis.fetch } = {}) {
  const cfg = () => ({ ...defaults, ...getConfig?.()?.cognition?.memory?.embedding })
  const cache = new Map()
  let cacheScope = ''
  function enabled() { return cfg().enabled === true }
  function status() {
    const c = cfg()
    return { enabled: c.enabled === true, configured: Boolean(endpoint(c.baseUrl) && typeof c.model === 'string' && c.model.trim() && typeof c.apiKeyEnv === 'string' && c.apiKeyEnv.trim()) }
  }

  async function embed(texts) {
    if (!Array.isArray(texts) || texts.length < 1 || texts.length > 32
      || texts.some((text) => typeof text !== 'string' || !text.trim() || [...text].length > 4000)) {
      throw new Error('embeddings 输入不合法（1–32 条，每条 1–4000 字符）')
    }
    const c = cfg()
    if (!enabled()) throw new Error('embeddings 已禁用')
    const url = endpoint(c.baseUrl)
    if (!url || typeof c.model !== 'string' || !c.model.trim() || !c.apiKeyEnv) throw new Error('embeddings 未配置')
    const key = process.env[c.apiKeyEnv]
    if (!key) throw new Error('embeddings 未配置密钥')
    // 配置/密钥变更后不复用其他 endpoint 的结果；摘要不记录或暴露。
    const scope = createHash('sha256').update(JSON.stringify([url, key])).digest('hex')
    if (scope !== cacheScope) { cache.clear(); cacheScope = scope }
    const keys = texts.map((text) => createHash('sha256').update(JSON.stringify([c.model, text])).digest('hex'))
    const found = new Map()
    const missing = new Map()
    keys.forEach((id, i) => {
      if (cache.has(id)) {
        const vector = cache.get(id)
        cache.delete(id)
        cache.set(id, vector)
        found.set(id, vector)
      } else if (!missing.has(id)) missing.set(id, texts[i])
    })
    if (missing.size) {
      const controller = new AbortController()
      const callMs = Number(getConfig?.()?.timeouts?.callMs)
      const timeoutMs = Number.isFinite(callMs) && callMs > 0 ? callMs : 30000
      let timer
      let timedOut = false
      try {
        const vectors = await Promise.race([
          (async () => {
            const response = await fetchImpl(url, {
              method: 'POST', redirect: 'error', signal: controller.signal,
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
              body: JSON.stringify({ model: c.model, input: [...missing.values()] }),
            })
            if (!response.ok) throw new Error(`embeddings HTTP ${Number(response.status) || 0}`)
            let payload
            try { payload = await response.json() } catch { throw new Error('embeddings 响应不合法') }
            if (!Array.isArray(payload?.data) || payload.data.length !== missing.size) throw new Error('embeddings 响应不合法')
            // 标准 index 可乱序；没有 index 的兼容响应按数组顺序。
            let data = payload.data
            if (data.some((item) => item?.index !== undefined)) {
              if (data.some((item) => !Number.isInteger(item?.index) || item.index < 0 || item.index >= data.length)
                || new Set(data.map((item) => item.index)).size !== data.length) throw new Error('embeddings 响应不合法')
              data = [...data].sort((a, b) => a.index - b.index)
            }
            const result = data.map((item) => item?.embedding)
            if (!validVectors(result, missing.size)) throw new Error('embeddings 响应不合法')
            return result
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true
              controller.abort()
              reject(new Error('embeddings 超时'))
            }, timeoutMs)
          }),
        ])
        ;[...missing.keys()].forEach((id, i) => found.set(id, vectors[i]))
        if (!validVectors(keys.map((id) => found.get(id)), texts.length)) throw new Error('embeddings 响应不合法')
        // 旧请求完成时不污染已切换配置的缓存。
        if (cacheScope === scope) for (const id of missing.keys()) {
          cache.set(id, found.get(id))
          if (cache.size > 2000) cache.delete(cache.keys().next().value)
        }
      } catch (error) {
        logger?.debug?.('embeddings 调用失败')
        if (timedOut) throw new Error('embeddings 超时')
        if (/^embeddings (HTTP \d+|响应不合法)$/.test(error?.message)) throw new Error(error.message)
        throw new Error('embeddings 请求失败')
      } finally { clearTimeout(timer) }
    }
    const vectors = keys.map((id) => found.get(id))
    if (!validVectors(vectors, texts.length)) throw new Error('embeddings 响应不合法')
    return vectors.map((vector) => [...vector])
  }

  async function similarity(query, texts) {
    if (!Array.isArray(texts)) throw new Error('embeddings 输入不合法')
    const [vector, ...others] = await embed([query, ...texts])
    return others.map((other) => cosine(vector, other))
  }

  return { enabled, status, embed, similarity }
}
