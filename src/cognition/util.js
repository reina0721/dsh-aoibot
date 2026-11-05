// 认知内核共用工具：纯函数 + 可注入时钟/随机数/调度器。
// 保持无依赖，便于单测与 Node/浏览器边界复用。

import { createHash, randomUUID } from 'node:crypto'

export const HOUR_MS = 60 * 60 * 1000
export const DAY_MS = 24 * HOUR_MS

export function nowMs() {
  return Date.now()
}

export function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return n < min ? min : n > max ? max : n
}

export function round(value, digits = 4) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  const f = 10 ** digits
  return Math.round(n * f) / f
}

export function uid(prefix = 'id') {
  return `${prefix}_${randomUUID()}`
}

export function hashText(text, length = 16) {
  return createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, length)
}

export function safeJson(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch (error) {
    return fallback
  }
}

export function deepClone(value) {
  return safeJson(value, value)
}

export function truncate(text, max = 200) {
  const s = String(text ?? '')
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + '…'
}

export function normalizeText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200b-\u200f\u202a-\u202e]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 中文按单字+二元组切分，英文/数字按词；用于 FTS 与 lexical 相关度。 */
export function tokenize(text) {
  const s = normalizeText(text).toLowerCase()
  const tokens = []
  const latin = s.match(/[a-z0-9_]+/g) || []
  tokens.push(...latin)
  const cjk = s.match(/[\u3400-\u9fff]+/g) || []
  for (const run of cjk) {
    for (let i = 0; i < run.length; i += 1) {
      tokens.push(run[i])
      if (i + 1 < run.length) tokens.push(run.slice(i, i + 2))
    }
  }
  // 标点/表情/其它单字符保留少量信号
  const symbols = s.match(/[\p{Extended_Pictographic}]/gu) || []
  tokens.push(...symbols)
  return tokens
}

export function ftsText(text) {
  return tokenize(text).join(' ')
}

export function estimateTokens(text) {
  const s = String(text ?? '')
  if (!s) return 0
  // 粗略：中文 ~1 token/字，英文 ~4 字符/token；只用于预算，不用于计费。
  const cjk = (s.match(/[\u3400-\u9fff]/g) || []).length
  const rest = s.length - cjk
  return Math.ceil(cjk + rest / 4)
}

export function dayKey(ms = nowMs()) {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

export function hourKey(ms = nowMs()) {
  return Math.floor(ms / HOUR_MS)
}

export function createClock(overrides = {}) {
  return {
    now: typeof overrides.now === 'function' ? overrides.now : () => Date.now(),
  }
}

/** 确定性随机数（测试/可复现实验用）。 */
export function createRng(seed = 1) {
  let a = Number(seed) >>> 0 || 1
  return function rng() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 定时器接口；测试用 FakeScheduler 替换，生产用 Node timers。 */
export function createScheduler() {
  const timers = new Set()
  return {
    setTimeout(fn, ms) {
      const handle = setTimeout(() => {
        timers.delete(handle)
        try { fn() } catch (error) {}
      }, Math.max(0, Number(ms) || 0))
      if (handle.unref) handle.unref()
      timers.add(handle)
      return handle
    },
    clearTimeout(handle) {
      if (handle) {
        timers.delete(handle)
        clearTimeout(handle)
      }
    },
    dispose() {
      for (const handle of timers) clearTimeout(handle)
      timers.clear()
    },
  }
}

export function createFakeScheduler(start = 0) {
  let current = start
  let seq = 0
  const jobs = new Map()
  return {
    now: () => current,
    setTimeout(fn, ms) {
      seq += 1
      const id = `t${seq}`
      jobs.set(id, { at: current + Math.max(0, Number(ms) || 0), fn })
      return id
    },
    clearTimeout(id) {
      jobs.delete(id)
    },
    advance(ms) {
      current += Math.max(0, Number(ms) || 0)
      for (;;) {
        const due = [...jobs.entries()].filter(([, job]) => job.at <= current).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        jobs.delete(due[0])
        try { due[1].fn() } catch (error) {}
      }
    },
    dispose() { jobs.clear() },
  }
}

export function normalizeScope(scope = {}) {
  const type = ['global', 'group', 'private', 'topic'].includes(scope.scopeType) ? scope.scopeType : 'global'
  return {
    scopeType: type,
    scopeId: type === 'global' ? '' : String(scope.scopeId || ''),
  }
}

export function scopeKey(scope = {}) {
  return `${scope.scopeType || 'global'}:${scope.scopeId || ''}`
}

export function scopeAllows(recordScope, queryScope) {
  if (!recordScope) return false
  if (recordScope.scopeType === 'global') return true
  return recordScope.scopeType === queryScope.scopeType && String(recordScope.scopeId) === String(queryScope.scopeId)
}

export function isRecent(ms, windowMs, now = Date.now()) {
  return ms > 0 && now - ms <= windowMs
}
