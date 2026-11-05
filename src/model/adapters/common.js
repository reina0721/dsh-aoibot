// 适配器共享：消息/结果归一化，避免每个协议重复处理空输出和 finish。
import { textOfContent, usageOf } from '../http.js'

export function normalizedMessages(system, messages) {
  const result = []
  if (system) result.push({ role: 'system', content: String(system) })
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message?.role === 'assistant' ? 'assistant' : message?.role === 'system' ? 'system' : 'user'
    const content = typeof message?.content === 'string' ? message.content : textOfContent(message?.content)
    if (content) result.push({ role, content })
  }
  if (!result.some((message) => message.role !== 'system')) result.push({ role: 'user', content: '' })
  return result
}

export function finishOf(kind, raw) {
  return { kind: ['stop', 'max-tokens', 'tool-calls', 'aborted', 'error'].includes(kind) ? kind : 'stop', raw: raw == null ? '' : String(raw) }
}

export function resultOf({ text = '', reasoning = '', usage = null, finish = null }) {
  return {
    text: String(text || ''),
    reasoning: String(reasoning || ''),
    usage: usageOf(usage),
    finish: finish || finishOf('stop', ''),
  }
}

export function parseEventData(data) {
  const raw = String(data || '').trim()
  if (!raw || raw === '[DONE]') return { done: true, json: null }
  try { return { done: false, json: JSON.parse(raw) } } catch (error) {
    return { done: false, json: null, error: 'SSE data 不是合法 JSON' }
  }
}

export async function collectResult(events) {
  let text = ''
  let reasoning = ''
  let usage = { input: 0, output: 0, total: 0 }
  let finish = null
  for await (const event of events) {
    if (event?.type === 'text-delta') text += event.text || ''
    else if (event?.type === 'reasoning-delta') reasoning += event.text || ''
    else if (event?.type === 'usage') {
      usage = {
        input: Math.max(usage.input, Number(event.usage?.input || 0)),
        output: Math.max(usage.output, Number(event.usage?.output || 0)),
        total: Math.max(usage.total, Number(event.usage?.total || 0)),
      }
    } else if (event?.type === 'finish') finish = event.reason || null
  }
  if (!usage.total) usage.total = usage.input + usage.output
  return resultOf({ text, reasoning, usage, finish })
}

export async function* collectEvents(iterable) {
  yield* iterable
}
