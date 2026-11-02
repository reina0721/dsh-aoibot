// 日志/错误文本脱敏：token、密码、Cookie 一律不能原样出现。
// 移植/改写自 aureth-labs/dsh-aurabot-qq 的 src/core/redact.js（MIT，见 THIRD_PARTY_NOTICES.md）。

const PATTERNS = [
  // Authorization: Bearer xxx（先于 key=value，免得只截掉 "Bearer"）
  [/(Authorization["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[A-Za-z0-9._~+/=-]{8,}/gi, '$1***'],
  // key=value / key: value
  [/((?:access[_-]?token|token|password|passwd|pwd|secret|api[_-]?key|cookie|MUSIC_U|p_skey|skey|clientkey|authorization)["']?\s*[:=]\s*["']?)([^\s"',;&]{4,})/gi, '$1***'],
  // Bearer xxx
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, '$1***'],
  // 常见 sk- 密钥
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, 'sk-***'],
  // URL 查询参数里的 token
  [/([?&](?:token|access_token|key)=)[^&\s]+/gi, '$1***'],
]

/** 已登记的敏感值（当前配置里的 token 等）：出现就整段替换。 */
const known = new Set()

export function registerSecret(value) {
  const v = String(value ?? '')
  if (v.length >= 4) known.add(v)
}

export function clearSecrets() {
  known.clear()
}

export function redact(text) {
  let s = String(text ?? '')
  for (const v of known) if (v && s.includes(v)) s = s.split(v).join('***')
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep)
  return s
}
