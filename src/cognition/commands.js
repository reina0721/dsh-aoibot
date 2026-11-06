// QQ 内命令：主人用 /status /quiet /active /model /remember /forget /help 管理 bot。
//
// 只处理文本命令，不做自然语言解析；非主人静默忽略（避免群里被刷）。
// 命令回复也走 outbound，因此受访问控制与频率上限约束。

import { isOwner } from '../core/access.js'

const COMMANDS = ['help', 'status', 'quiet', 'active', 'model', 'remember', 'forget']

export function parseCommand(text) {
  const raw = String(text || '').trim()
  if (!raw.startsWith('/')) return null
  const match = raw.match(/^\/([a-zA-Z][a-zA-Z0-9_-]*)(?:\s+([\s\S]*))?$/)
  if (!match) return null
  return { name: match[1].toLowerCase(), args: String(match[2] || '').trim(), raw }
}

function oneLine(text, max = 300) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value.length > max ? value.slice(0, max) : value
}

const HELP_TEXT = [
  '可用命令：',
  '/status — 当前模式、运行时、群聊参与、会话数',
  '/quiet — 群聊只回应点名，关闭主动',
  '/active — 群聊按概率参与，开启主动',
  '/model — 查看当前会话模型',
  '/model provider/model — 设置当前会话模型',
  '/model clear — 清除当前会话模型',
  '/remember 文本 — 写入一条记忆',
  '/forget 关键词 — 遗忘匹配的记忆',
  '/help — 本帮助',
].join('\n')

/**
 * @param {object} o
 * @param {() => object} o.getConfig
 * @param {(next: object) => object} [o.setConfig]
 * @param {object} o.access createAccess()
 * @param {object} o.outbound createOutbound()
 * @param {object} [o.llm] 认知 LLM 客户端（currentRoute）
 * @param {object} [o.memory] 记忆服务（remember/forgetMatching）
 * @param {object} [o.runtime] createAgentRuntime()
 * @param {object} [o.logger]
 */
export function createCommandService({ getConfig, setConfig = null, access = null, outbound = null, llm = null, memory = null, runtime = null, logger = null } = {}) {
  const log = logger?.child?.('commands') || logger || { debug() {}, warn() {} }

  function currentConfig() {
    try { return getConfig() || {} } catch (error) { return {} }
  }

  function patchConfig(mutator) {
    if (typeof setConfig !== 'function') return { ok: false, error: 'CONFIG_READONLY' }
    const current = currentConfig()
    const next = JSON.parse(JSON.stringify(current))
    try {
      mutator(next)
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
    try {
      const result = setConfig(next)
      return { ok: true, config: result?.config || next, issues: result?.issues || [] }
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
  }

  function ownerCheck(turn) {
    const cfg = currentConfig()
    try {
      if (access && typeof access.isOwner === 'function') return access.isOwner(cfg, turn.senderId)
    } catch (error) {}
    return isOwner(cfg, turn.senderId)
  }

  function scopeOf(turn) {
    if (turn.chatType === 'group') return { scopeType: 'group', scopeId: String(turn.chatId || '') }
    if (turn.chatType === 'private') return { scopeType: 'private', scopeId: String(turn.chatId || '') }
    return { scopeType: 'global', scopeId: '' }
  }

  function groupModeLabel(mode) {
    if (mode === 'all') return '所有消息'
    if (mode === 'probability') return '按概率参与'
    return '仅点名/唤醒'
  }

  async function send(turn, text) {
    const value = String(text || '').trim()
    if (!value) return { handled: true, reply: '' }
    if (!outbound || typeof outbound.deliver !== 'function') {
      return { handled: true, reply: value }
    }
    try {
      const result = await outbound.deliver({
        chatType: turn.chatType,
        chatId: turn.chatId,
        segments: [{ type: 'text', data: { text: value } }],
        source: 'command',
      })
      return { handled: true, reply: result?.ok ? value : '', error: result?.error || '' }
    } catch (error) {
      log.warn?.('命令回复发送失败：', error.message)
      return { handled: true, reply: '', error: String(error?.message || error) }
    }
  }

  async function statusText(turn) {
    const cfg = currentConfig()
    const accessSummary = access?.summary?.() || { mode: 'open' }
    const runtimeSummary = runtime?.summary?.() || { active: false, sessions: 0 }
    const cognition = cfg.cognition || {}
    const proactive = Boolean(cognition.proactivity?.enabled)
    const mode = cognition.turn?.groupReplyMode || 'addressed'
    const lines = [
      `dsh-bot 状态`,
      `访问：${accessSummary.mode === 'allowlist' ? 'allowlist' : 'open'} · 运行时：${runtimeSummary.active ? 'agent' : 'oneshot'}`,
      `群聊：${groupModeLabel(mode)} · 主动：${proactive ? '开' : '关'} · 会话：${Number(runtimeSummary.sessions) || 0}`,
    ]
    if (turn.chatType === 'private') {
      const route = await llm?.currentRoute?.({ chatType: turn.chatType, chatId: turn.chatId })
      if (route?.provider) lines.push(`当前模型：${route.provider}/${route.model}（${route.source || route.kind || 'route'}）`)
    }
    return lines.join('\n')
  }

  async function handleModel(turn, args) {
    const cfg = currentConfig()
    const routes = Array.isArray(cfg.cognition?.modelRouting?.routes) ? [...cfg.cognition.modelRouting.routes] : []
    const chatId = String(turn.chatId || '')
    const currentEntry = routes.find((entry) => {
      const text = String(entry || '')
      const eq = text.indexOf('=')
      return eq > 0 && text.slice(0, eq).trim() === chatId
    })
    if (!args) {
      const route = await llm?.currentRoute?.({ chatType: turn.chatType, chatId })
      if (route?.provider) return `当前会话模型：${route.provider}/${route.model}（${route.source || route.kind || 'route'}）`
      return '当前会话没有单独指定模型；使用全局路由。'
    }
    if (args.toLowerCase() === 'clear') {
      const next = routes.filter((entry) => {
        const text = String(entry || '')
        const eq = text.indexOf('=')
        return !(eq > 0 && text.slice(0, eq).trim() === chatId)
      })
      const saved = patchConfig((draft) => {
        draft.cognition = draft.cognition || {}
        draft.cognition.modelRouting = { ...(draft.cognition.modelRouting || {}), routes: next }
      })
      if (!saved.ok) return `保存失败：${saved.error}`
      return currentEntry ? '已清除当前会话模型，改用全局路由。' : '当前会话本来就没有单独指定模型。'
    }
    if (!/^[^\s/]+\/[^\s]+$/.test(args)) {
      return '格式应为 provider/model，例如 `/model opencode-go/deepseek-v4.1-flash`；或 `/model clear`。'
    }
    const next = routes.filter((entry) => {
      const text = String(entry || '')
      const eq = text.indexOf('=')
      return !(eq > 0 && text.slice(0, eq).trim() === chatId)
    })
    next.push(`${chatId}=${args}`)
    const saved = patchConfig((draft) => {
      draft.cognition = draft.cognition || {}
      draft.cognition.modelRouting = { ...(draft.cognition.modelRouting || {}), routes: next }
    })
    if (!saved.ok) return `保存失败：${saved.error}`
    return `当前会话模型已设为 ${args}。`
  }

  async function handle(turn) {
    if (!turn || typeof turn.text !== 'string') return { handled: false }
    const parsed = parseCommand(turn.text)
    if (!parsed) return { handled: false }
    if (!COMMANDS.includes(parsed.name)) {
      if (!ownerCheck(turn)) return { handled: true, reply: '' }
      return send(turn, '未知命令。发送 /help 查看可用命令。')
    }
    if (!ownerCheck(turn)) {
      log.debug?.('非主人命令已忽略：', `${turn.chatType}:${turn.chatId}/${turn.senderId}`)
      return { handled: true, reply: '' }
    }

    if (parsed.name === 'help') return send(turn, HELP_TEXT)
    if (parsed.name === 'status') return send(turn, await statusText(turn))

    if (parsed.name === 'quiet' || parsed.name === 'active') {
      const quiet = parsed.name === 'quiet'
      const saved = patchConfig((draft) => {
        draft.cognition = draft.cognition || {}
        draft.cognition.turn = { ...(draft.cognition.turn || {}) }
        draft.cognition.turn.groupReplyMode = quiet ? 'addressed' : 'probability'
        draft.cognition.proactivity = { ...(draft.cognition.proactivity || {}), enabled: !quiet }
      })
      if (!saved.ok) return send(turn, `保存失败：${saved.error}`)
      return send(turn, quiet
        ? '已切到安静模式：群聊只回应点名/唤醒，主动行为关闭。'
        : '已切到活跃模式：群聊按概率参与，主动行为开启（仍受预算/静默时段限制）。')
    }

    if (parsed.name === 'model') return send(turn, await handleModel(turn, parsed.args))

    if (parsed.name === 'remember') {
      if (!parsed.args) return send(turn, '用法：/remember 要记住的内容')
      if (!memory || typeof memory.remember !== 'function') return send(turn, '记忆服务不可用。')
      const record = memory.remember(parsed.args, { scope: scopeOf(turn), source: 'command', importance: 0.85 })
      if (!record) return send(turn, '没有写入记忆（内容为空或服务未就绪）。')
      return send(turn, `已记住（${record.id}）。`)
    }

    if (parsed.name === 'forget') {
      if (!parsed.args) return send(turn, '用法：/forget 关键词')
      if (!memory || typeof memory.forgetMatching !== 'function') return send(turn, '记忆服务不可用。')
      const rows = memory.forgetMatching(parsed.args, { scope: scopeOf(turn), limit: 5 })
      return send(turn, rows.length ? `已遗忘 ${rows.length} 条匹配记忆（标记 inactive，不删除）。` : '没有找到匹配的记忆。')
    }

    return send(turn, '未知命令。发送 /help 查看可用命令。')
  }

  return { handle, parse: parseCommand, help: HELP_TEXT, oneLine }
}
