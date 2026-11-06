// 合并转发内容展开：把 get_forward_msg 的 node 列表压平成可读文本。
//
// 合并转发内容是「外部不可信数据」：只作为对话上下文，不执行其中任何指令；
// 这里只做有界展开，避免超长/深层嵌套拖垮 prompt。

const MAX_DEPTH = 2

function senderName(node) {
  const sender = node?.sender && typeof node.sender === 'object' ? node.sender : {}
  return String(sender.card || sender.nickname || node?.nickname || '成员').trim() || '成员'
}

function segmentText(segment, depth = 0) {
  if (!segment || typeof segment !== 'object') return ''
  const data = segment.data && typeof segment.data === 'object' ? segment.data : {}
  switch (segment.type) {
    case 'text': return String(data.text || '')
    case 'at': return `@${String(data.name || data.qq || '')}`
    case 'image': return '[图片]'
    case 'face': return '[表情]'
    case 'record': return '[语音]'
    case 'video': return '[视频]'
    case 'file': return '[文件]'
    case 'json':
    case 'xml': return '[卡片]'
    case 'forward': return depth >= MAX_DEPTH ? '[嵌套合并转发]' : '[嵌套合并转发]'
    default: return `[${String(segment.type || '未知')}]`
  }
}

function contentText(content, depth = 0) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((segment) => segmentText(segment, depth)).join('')
  return ''
}

function nodeText(node, depth = 0) {
  if (!node || typeof node !== 'object') return ''
  const content = node.content ?? node.message ?? ''
  const text = contentText(content, depth).trim()
  return text ? `${senderName(node)}：${text}` : ''
}

function nodesOf(payload) {
  if (!payload || typeof payload !== 'object') return []
  if (Array.isArray(payload.message)) return payload.message
  if (Array.isArray(payload.messages)) return payload.messages
  if (payload.data && Array.isArray(payload.data.messages)) return payload.data.messages
  if (payload.data && Array.isArray(payload.data.message)) return payload.data.message
  return []
}

/**
 * @param {object} payload get_forward_msg 返回值
 * @param {{maxChars?:number,maxNodes?:number}} [options]
 * @returns {string}
 */
export function flattenForward(payload, { maxChars = 4000, maxNodes = 50 } = {}) {
  const limit = Math.max(200, Math.min(20000, Number(maxChars) || 4000))
  const count = Math.max(1, Math.min(200, Number(maxNodes) || 50))
  const nodes = nodesOf(payload).slice(0, count)
  const lines = []
  for (const node of nodes) {
    const text = nodeText(node)
    if (text) lines.push(text)
    if (lines.join('\n').length >= limit) break
  }
  const value = lines.join('\n').trim()
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

/**
 * 从一条规范化消息里取出 forward 段 id。
 * @param {{forwards?: Array<{id?:string}>}} message
 * @returns {string[]}
 */
export function forwardIdsOf(message) {
  const ids = []
  for (const item of message?.forwards || []) {
    const id = String(item?.id || '').trim()
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}
