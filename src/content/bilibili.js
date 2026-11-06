const API = 'https://api.bilibili.com'
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; dsh-bot/1.0; +https://github.com/reina0721/dsh-bot)',
  Referer: 'https://www.bilibili.com/',
}

function stripTitle(value) {
  return String(value ?? '').replace(/<em\b[^>]*>/gi, '').replace(/<\/em>/gi, '').replace(/<[^>]+>/g, '').trim()
}

function playCount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value))
  const text = String(value ?? '').trim()
  const number = Number.parseFloat(text.replace(/[^0-9.]/g, ''))
  if (!Number.isFinite(number)) return 0
  if (text.includes('亿')) return Math.floor(number * 100000000)
  if (text.includes('万')) return Math.floor(number * 10000)
  return Math.max(0, Math.floor(number))
}

function duration(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0))
  const minutes = Math.floor(seconds / 60)
  return String(minutes).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0')
}

function normalizeVideo(raw = {}) {
  const bvid = String(raw.bvid || '').trim()
  const seconds = typeof raw.duration === 'string' && raw.duration.includes(':')
    ? raw.duration.split(':').reduce((total, part) => total * 60 + (Number(part) || 0), 0)
    : Number(raw.duration) || 0
  return {
    title: stripTitle(raw.title),
    author: String(raw.author || raw.owner?.name || '').trim(),
    play: playCount(raw.play ?? raw.stat?.view),
    duration: duration(seconds),
    url: `https://www.bilibili.com/video/${bvid}`,
    bvid,
  }
}

export function createBilibiliService({ getConfig, logger = null, fetchImpl = globalThis.fetch } = {}) {
  const cfg = () => {
    try { return getConfig?.()?.content?.bilibili || {} } catch (error) { return {} }
  }
  const settings = () => ({
    enabled: cfg().enabled === true,
    timeoutMs: Math.max(1000, Number(cfg().timeoutMs) || 15000),
    maxResults: Math.max(1, Math.min(20, Number(cfg().maxResults) || 5)),
  })

  async function request(path, params = {}) {
    const options = settings()
    if (!options.enabled) throw new Error('B站内容未启用')
    if (typeof fetchImpl !== 'function') throw new Error('B站请求服务不可用')
    const url = new URL(path, API)
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)))
    let response
    try {
      response = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(options.timeoutMs) })
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new Error('B站请求超时')
      throw new Error('B站请求失败')
    }
    if (!response?.ok) throw new Error(`B站接口 HTTP ${Number(response?.status) || '错误'}`)
    let payload
    try { payload = await response.json() } catch (error) { throw new Error('B站接口返回无效数据') }
    if (Number(payload?.code) !== 0) {
      const message = String(payload?.message || payload?.msg || '').trim()
      if ([-101, -352, -412].includes(Number(payload?.code))) throw new Error('B站公开接口要求登录或当前访问被限制；本服务不使用 Cookie/WBI')
      throw new Error(`B站接口错误 ${payload?.code}${message ? `：${message}` : ''}`)
    }
    return payload.data
  }

  async function search(keyword) {
    const value = String(keyword || '').trim()
    if (!value) throw new Error('请输入搜索关键词')
    const options = settings()
    const data = await request('/x/web-interface/search/type', { search_type: 'video', keyword: value, page: 1, page_size: options.maxResults })
    const rows = Array.isArray(data?.result) ? data.result : []
    return { ok: true, items: rows.slice(0, options.maxResults).map(normalizeVideo) }
  }

  async function hot() {
    const options = settings()
    const data = await request('/x/web-interface/popular', { pn: 1, ps: options.maxResults })
    const rows = Array.isArray(data?.list) ? data.list : []
    return { ok: true, items: rows.slice(0, options.maxResults).map(normalizeVideo) }
  }

  async function video(bvid) {
    const value = String(bvid || '').trim()
    if (!/^BV[0-9A-Za-z]{3,}$/i.test(value)) throw new Error('无效的 BV 号')
    const data = await request('/x/web-interface/view', { bvid: value })
    return { ok: true, items: [normalizeVideo(data)] }
  }

  return { search, hot, video }
}
