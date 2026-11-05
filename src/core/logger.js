// 分级日志：环形缓冲（面板轮询展示）+ 可选按天文件 + 脱敏。
// 移植/改写自 aureth-labs/dsh-aurabot-qq 的 src/core/logger.js（MIT，见 THIRD_PARTY_NOTICES.md），
// 增加了可配置等级/缓冲容量/持久化与自增序号（面板增量拉取）。

import { appendFileSync, readdirSync, unlinkSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir, ensureDir } from './store.js'
import { redact } from './redact.js'

export const LEVELS = ['debug', 'info', 'warn', 'error']
const RANK = new Map(LEVELS.map((name, index) => [name, index]))
const MAX_RING = 2000
const RETRIES = new Set()

/**
 * @param {object} o
 * @param {() => object} o.getConfig 读取当前配置（logging.level / bufferSize / persist）
 * @param {object} [o.dsh] DSH 宿主 ctx，用于镜像到 DSH 自己的日志
 */
export function createLogger({ getConfig, dsh } = {}) {
  const ring = []
  const listeners = new Set()
  let seq = 0
  let lastCleanup = 0

  const cfgOf = () => {
    try {
      return (getConfig && getConfig()) || {}
    } catch (error) {
      return {}
    }
  }
  const levelOf = () => {
    const level = String(cfgOf().logging?.level || 'info')
    return RANK.has(level) ? level : 'info'
  }
  const dir = () => ensureDir(dataDir('logs'))

  function cleanupFiles(retainDays = 14) {
    const now = Date.now()
    if (now - lastCleanup < 6 * 3600_000) return
    lastCleanup = now
    try {
      for (const name of readdirSync(dir())) {
        const p = join(dir(), name)
        if (now - statSync(p).mtimeMs > retainDays * 86400_000) unlinkSync(p)
      }
    } catch (error) {}
  }

  function write(level, area, message) {
    const min = levelOf()
    if (RANK.get(level) < RANK.get(min)) return null
    const cfg = cfgOf()
    // logging.redact 默认开启；关闭后按原样写（仅供本机排障，不建议）
    const text = cfg.logging?.redact === false ? String(message) : redact(message)
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    const entry = { seq: ++seq, t: d.getTime(), time, level, area, text }

    const bufferSize = Math.max(50, Math.min(MAX_RING, Number(cfg.logging?.bufferSize) || 500))
    ring.push(entry)
    while (ring.length > bufferSize) ring.shift()

    if (cfg.logging?.persist?.enabled) {
      try {
        appendFileSync(join(dir(), `${area || 'plugin'}-${day}.log`), `${day} ${time} [${level}] [${area}] ${text}\n`, 'utf8')
      } catch (error) {}
    }
    if (dsh && level !== 'debug') {
      try {
        const fn = level === 'error' ? dsh.logger?.error : level === 'warn' ? dsh.logger?.warn : dsh.logger?.info
        fn?.call(dsh.logger, `onebot-qq[${area}]: ${text}`)
      } catch (error) {}
    }
    for (const listener of listeners) {
      try {
        listener(entry)
      } catch (error) {}
    }
    cleanupFiles()
    return entry
  }

  const api = {
    child(area = 'plugin') {
      const child = { area }
      for (const level of LEVELS) {
        child[level] = (...args) => write(level, area, args.map(fmt).join(' '))
      }
      return child
    },
    /** 面板增量拉取：返回 since（不含）之后的条目。 */
    recent({ since = 0, limit = 200, minLevel = '' } = {}) {
      const floor = RANK.has(minLevel) ? RANK.get(minLevel) : -1
      const items = ring.filter((e) => e.seq > since && (floor < 0 || RANK.get(e.level) >= floor))
      const sliced = items.slice(-Math.max(1, Math.min(MAX_RING, Number(limit) || 200)))
      return { items: sliced, nextSince: sliced.length ? sliced[sliced.length - 1].seq : since }
    },
    clear() {
      ring.length = 0
      return { ok: true }
    },
    stats() {
      return {
        total: seq,
        buffered: ring.length,
        level: levelOf(),
        byLevel: LEVELS.reduce((acc, level) => {
          acc[level] = ring.filter((e) => e.level === level).length
          return acc
        }, {}),
        files: (() => {
          try {
            return readdirSync(dir()).length
          } catch (error) {
            return 0
          }
        })(),
      }
    },
    onEntry(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    fileOf() {
      return dir()
    },
  }
  return api
}

function fmt(value) {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch (error) {
    return String(value)
  }
}

export { existsSync, RETRIES }
