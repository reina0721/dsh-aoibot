// Exact command text and parsing shared by core fallback and builtin override.
export function reminderCommand({ turn, parsed, reminders }) {
  const target = { chatType: turn.chatType, chatId: turn.chatId }
  const usage = () => (parsed.name === 'remind' ? '用法：/remind <整数秒（重复）|未来ISO时间（一次）> <1–500字文本>' : parsed.name === 'reminders' ? '用法：/reminders' : '用法：/forgetreminder rem_ID')
  try {
    if (parsed.name === 'remind') {
      const match = /^(\S+)\s+([\s\S]+)$/.exec(parsed.args)
      if (!match) return usage()
      const time = match[1]
      if (!/^\d+$/.test(time) && !/^\d{4}-\d{2}-\d{2}T/.test(time)) return usage()
      const item = reminders.add({ ...target, text: match[2], createdBy: turn.senderId,
        ...(/^\d+$/.test(time) ? { everySeconds: Number(time) } : { at: time }) })
      return `已创建提醒 ${item.id}；下次 ${new Date(item.nextAt).toISOString()}。`
    }
    if (parsed.name === 'reminders') {
      if (parsed.args) return usage()
      const items = reminders.list({ ...target, status: 'active', limit: 10 })
      return items.length ? ['当前聊天提醒：', ...items.map((item) => `${item.id} · ${new Date(item.nextAt).toISOString()} · ${item.text}`)].join('\n') : '当前聊天没有活跃提醒。'
    }
    if (!/^rem_[a-f0-9]+$/.test(parsed.args)) return usage()
    reminders.cancel(parsed.args, { ...target, operatorId: turn.senderId })
    return `已取消提醒 ${parsed.args}。`
  } catch (error) {
    const messages = { REMINDERS_DISABLED: '提醒未启用。', OWNER_ONLY: '仅主人可操作提醒。', INVALID_TARGET: '当前会话无效。', INVALID_TEXT: '提醒文本须为 1–500 个 Unicode 字符。', INVALID_SCHEDULE: '须选择一种提醒时间。', INVALID_AT: '一次提醒须使用未来 ISO 时间。', INVALID_INTERVAL: '重复间隔超出配置范围（硬限制 60–2592000 秒）。', REMINDER_DUPLICATE: '已有相同活跃提醒。', MAX_ACTIVE: '活跃提醒已达上限。', REMINDER_NOT_FOUND: '当前聊天没有这个活跃提醒。' }
    return messages[error?.message] || '提醒操作失败。'
  }
}
