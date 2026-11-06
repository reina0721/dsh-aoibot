// Opt-in, manual GitHub release metadata checks. Never downloads or installs releases.
const DEFAULTS = { enabled: false, channel: 'stable', repo: 'reina0721/dsh-bot', timeoutMs: 10000, cacheMinutes: 60 }

function version(value) {
  const match = typeof value === 'string' && /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value)
  if (!match || match.slice(1, 4).some((part) => !Number.isSafeInteger(Number(part)))) throw new Error(`版本号不合法：${String(value)}`)
  return { numbers: match.slice(1, 4).map(Number), pre: match[4]?.split('.') || [] }
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return Math.sign(a.numbers[i] - b.numbers[i])
  if (!a.pre.length || !b.pre.length) return Number(!a.pre.length) - Number(!b.pre.length)
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i]
    if (x === y) continue
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y)
    if (xn && yn) { if (BigInt(x) !== BigInt(y)) return BigInt(x) > BigInt(y) ? 1 : -1; continue }
    if (xn !== yn) return xn ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}

export function createUpgradeService({ getConfig, logger, currentVersion, fetchImpl = globalThis.fetch }) {
  const log = logger?.child?.('upgrade') || logger
  let cached = null, checkedAt = null, cacheKey = '', cachedAt = 0
  const config = () => ({ ...DEFAULTS, ...getConfig()?.ops?.upgrade })
  const key = (cfg) => `${cfg.repo}:${cfg.channel}:${currentVersion}`
  function status() {
    const cfg = config()
    const matches = cacheKey === key(cfg)
    return { enabled: cfg.enabled === true, channel: cfg.channel, repo: cfg.repo, current: currentVersion, cached: matches && cached ? { ...cached } : null, checkedAt: matches ? checkedAt : null }
  }
  async function check({ force = false } = {}) {
    const cfg = config()
    if (cfg.enabled !== true) throw new Error('升级检查未启用')
    if (typeof force !== 'boolean') throw new Error('force 必须是 boolean')
    if (!['stable', 'beta'].includes(cfg.channel)) throw new Error('升级通道不合法')
    if (typeof cfg.repo !== 'string' || cfg.repo.includes('..') || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(cfg.repo)) throw new Error('GitHub 仓库不合法（需要 owner/repo）')
    const current = version(currentVersion)
    const ttl = Number.isFinite(cfg.cacheMinutes) && cfg.cacheMinutes >= 0 ? cfg.cacheMinutes : DEFAULTS.cacheMinutes
    if (!force && cacheKey === key(cfg) && cached && Date.now() - cachedAt < ttl * 60000) return { ...cached }
    const timeoutMs = Number.isSafeInteger(cfg.timeoutMs) && cfg.timeoutMs >= 1 ? cfg.timeoutMs : DEFAULTS.timeoutMs
    try {
      const response = await fetchImpl(`https://api.github.com/repos/${cfg.repo}/releases?per_page=10`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': `dsh-bot/${currentVersion}`, referer: `https://github.com/${cfg.repo}` },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`)
      const releases = await response.json()
      if (!Array.isArray(releases)) throw new Error('GitHub release 响应格式不合法')
      const available = releases.filter((item) => item && item.draft === false && (cfg.channel === 'beta' || item.prerelease === false))
        .map((item) => ({ item, parsed: version(item.tag_name) }))
        .sort((a, b) => compare(b.parsed, a.parsed))
      if (!available.length) throw new Error('未找到可用 release')
      const { item, parsed } = available[0]
      const result = {
        ok: true, enabled: true, channel: cfg.channel, current: currentVersion, latest: item.tag_name,
        updateAvailable: compare(parsed, current) > 0,
        publishedAt: item.published_at || null,
        url: `https://github.com/${cfg.repo}/releases/tag/${encodeURIComponent(item.tag_name)}`,
        ...(typeof item.body === 'string' && item.body ? { notes: item.body.slice(0, 2000) } : {}),
      }
      cached = result
      cachedAt = Date.now()
      checkedAt = new Date(cachedAt).toISOString()
      cacheKey = key(cfg)
      log?.info?.(`升级检查完成：${currentVersion} → ${result.latest}（${cfg.channel}）`)
      return { ...result }
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new Error('GitHub 升级检查超时')
      throw new Error(`升级检查失败：${error?.message || error}`)
    }
  }
  return { status, check, dispose() {} }
}
