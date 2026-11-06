// 本地出站文本检查；只返回脱敏文本及类别/次数，绝不返回匹配值。
export const MAX_TEXT_LENGTH = 100000
const REPLACEMENT = '[REDACTED]'
const PATTERNS = [
  ['bearer', /\bBearer[ \t]+[A-Za-z0-9._~+/-]{16,}=*/gi],
  ['api_key', /\bapi_?key["']?[ \t]*[:=][ \t]*["']?[^\s"'`,;<>]{16,}/gi],
  ['openai', /\bsk-[A-Za-z0-9_-]{20,}/g],
  ['github', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g],
  ['aws', /\bAKIA[A-Z0-9]{16}\b/g],
]

function textOnly(text) {
  if (typeof text !== 'string') throw new TypeError('LEAK_GUARD_INVALID_TEXT')
  return text
}

function validateAction(action) {
  if (action !== 'redact' && action !== 'block') throw new TypeError('LEAK_GUARD_INVALID_ACTION')
}

/** clean 是脱敏后的文本；超限文本整体替换，不截断后放行。 */
export function scanText(text) {
  textOnly(text)
  if (text.length > MAX_TEXT_LENGTH) {
    return { clean: REPLACEMENT, detections: [{ kind: 'input_too_long', count: 1 }], matched: true }
  }
  const ranges = []
  // indexOf + 单向游标，避免多次 BEGIN 而无 END 时的二次复杂度。
  const pem = /-----BEGIN ((?:[A-Z0-9]+ )?PRIVATE KEY)-----/g
  let header
  while ((header = pem.exec(text))) {
    const footer = `-----END ${header[1]}-----`
    const endAt = text.indexOf(footer, pem.lastIndex)
    const end = endAt < 0 ? text.length : endAt + footer.length
    ranges.push({ start: header.index, end, kind: 'private_key' })
    pem.lastIndex = end
  }
  for (const [kind, pattern] of PATTERNS) {
    // 每次使用独立 RegExp，纯函数不共享 lastIndex。
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      ranges.push({ start: match.index, end: match.index + match[0].length, kind })
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end)
  const merged = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous && range.start < previous.end) previous.end = Math.max(previous.end, range.end)
    else merged.push({ ...range })
  }
  let clean = '', cursor = 0
  const counts = new Map()
  for (const range of merged) { // 重叠 token 只替换/计数一次。
    clean += text.slice(cursor, range.start) + REPLACEMENT
    cursor = range.end
    counts.set(range.kind, (counts.get(range.kind) || 0) + 1)
  }
  clean += text.slice(cursor)
  return { clean, detections: [...counts].map(([kind, count]) => ({ kind, count })), matched: counts.size > 0 }
}

// detections 只是摘要，不包含位置，不能作为跳过重扫的依据。
export function redactText(text, detections) {
  return scanText(text).clean
}

/** 只复制有变化的 text 段；非文本段（含 base64）原样保留。block 不返回正文。 */
export function guardSegments(segments, { action = 'redact' } = {}) {
  validateAction(action)
  if (!Array.isArray(segments)) throw new TypeError('LEAK_GUARD_INVALID_SEGMENTS')
  const counts = new Map()
  const textSegments = segments.filter((segment) => segment?.type === 'text')
  let length = 0
  for (const segment of textSegments) length += textOnly(segment.data?.text).length
  const overLimit = length > MAX_TEXT_LENGTH
  const guarded = segments.map((segment) => {
    if (segment?.type !== 'text') return segment
    const result = overLimit
      ? { clean: REPLACEMENT, detections: [{ kind: 'input_too_long', count: 1 }], matched: true }
      : scanText(segment.data.text)
    for (const { kind, count } of result.detections) counts.set(kind, (counts.get(kind) || 0) + count)
    return result.matched ? { ...segment, data: { ...segment.data, text: result.clean } } : segment
  })
  const detections = [...counts].map(([kind, count]) => ({ kind, count }))
  const blocked = action === 'block' && detections.length > 0
  return { segments: blocked ? [] : guarded, detections, blocked }
}

export function createLeakGuard({ getConfig, logger } = {}) {
  function config() {
    let value
    try { value = getConfig?.()?.security?.leakGuard } catch {}
    return { enabled: value?.enabled !== false, action: value?.action === 'block' ? 'block' : 'redact' }
  }
  function report(detections) {
    if (detections.length) logger?.warn?.('leak_guard', detections)
  }
  return {
    get enabled() { return config().enabled },
    get action() { return config().action },
    scan(text) {
      const result = config().enabled ? scanText(text) : { clean: textOnly(text), detections: [], matched: false }
      report(result.detections)
      return result
    },
    guard(segments) {
      const settings = config()
      const result = settings.enabled ? guardSegments(segments, settings) : { segments, detections: [], blocked: false }
      report(result.detections)
      return result
    },
  }
}
