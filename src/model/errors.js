// 模型网关错误：所有厂商/协议错误统一为稳定 code，绝不把 key/header 放进消息。
export class ModelError extends Error {
  constructor(code, message, details = {}) {
    super(String(message || code || 'model error'))
    this.name = 'ModelError'
    this.code = String(code || 'MODEL_ERROR')
    this.details = details && typeof details === 'object' ? details : {}
    this.degraded = true
  }
}

export function modelError(code, message, details) {
  return new ModelError(code, message, details)
}

export function errorFromStatus(status, body = '', headers = null) {
  const code = status === 401 ? 'AUTH' : status === 403 ? 'FORBIDDEN' : status === 408 ? 'TIMEOUT'
    : status === 429 ? 'RATE_LIMIT' : status >= 500 ? 'UPSTREAM' : status === 400 || status === 422 ? 'PROTOCOL' : 'HTTP_ERROR'
  let detail = ''
  try {
    const json = typeof body === 'string' ? JSON.parse(body) : body
    detail = json?.error?.message || json?.error?.type || json?.message || json?.type || ''
  } catch (error) {
    detail = String(body || '').slice(0, 300)
  }
  const retryAfter = Number(headers?.get?.('retry-after') || headers?.get?.('x-ratelimit-reset-requests') || NaN)
  const message = status === 401 ? '认证失败（HTTP 401），请检查 API key/环境变量'
    : status === 403 ? '权限不足（HTTP 403），账号/套餐可能不支持此模型'
      : status === 429 ? '请求被限流（HTTP 429）'
        : status >= 500 ? `上游模型服务错误（HTTP ${status}）`
          : `模型请求失败（HTTP ${status}）${detail ? '：' + String(detail).slice(0, 300) : ''}`
  return new ModelError(code, message, { status, retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined })
}

export function normalizeModelError(error) {
  if (error instanceof ModelError) return error
  const message = String(error?.message || error || '模型调用失败')
  if (error?.name === 'AbortError' || /aborted|abort/i.test(message)) return new ModelError('ABORTED', '模型请求已取消', {})
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) return new ModelError('TIMEOUT', '模型请求超时', {})
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|network|socket/i.test(message)) return new ModelError('NETWORK', '无法连接模型端点', {})
  return new ModelError('MODEL_ERROR', message.slice(0, 400), {})
}

export function failureOf(result) {
  return result?.error || result?.failure || ''
}
