// DSH Session 内的 QQ 工具。定义本身不依赖 dsh-tools，作用域在创建时固定，
// 因而模型不能通过参数选择其它聊天或 QQ 目标。

function text(value) {
  return String(value ?? '').trim()
}

function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

function objectSchema(properties, required = []) {
  return { type: 'object', additionalProperties: false, properties, required }
}

function safeMessage(error, fallback) {
  const code = text(error?.code || error?.message || error)
  if (/ACCESS|DENIED|RATE|LIMIT|BLOCK/i.test(code)) return code.slice(0, 80)
  return fallback
}

function rejectUnknown(args, allowed) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是对象')
  const extra = Object.keys(args).find((key) => !allowed.includes(key))
  if (extra) throw new Error('不能指定其它 QQ 目标')
}

export function createQqTools({ chat = {}, gateway = null, outbound = null, delivery = null, getConfig = null, logger = null } = {}) {
  const scope = {
    chatType: chat.chatType === 'group' ? 'group' : 'private',
    chatId: text(chat.chatId),
    senderId: text(chat.senderId),
  }
  const actions = () => gateway?.actions
  const output = (properties) => ({
    schema: objectSchema({ ok: { type: 'boolean' }, ...properties }, ['ok']),
    render: renderJson,
  })
  const fail = (message) => { throw new Error(message) }
  const requirePrivate = () => {
    if (scope.chatType !== 'private' || !scope.chatId) fail('此工具只能用于当前私聊')
  }

  return [
    {
      name: 'qq_send_text',
      description: '向当前 QQ 会话额外发送一条文本；不能指定其它会话。',
      parameters: objectSchema({ text: { type: 'string' } }, ['text']),
      output: output({ chatType: { type: 'string' }, chatId: { type: 'string' }, messageId: { type: 'string' } }),
      async execute(args) {
        rejectUnknown(args, ['text'])
        const value = text(args?.text)
        if (!value) fail('文本不能为空')
        if (value.length > 4000) fail('文本最多 4000 字符')
        const sender = delivery?.deliver ? delivery : outbound
        if (!sender?.deliver) fail('QQ 发送服务不可用')
        try {
          const result = await sender.deliver({
            chatType: scope.chatType,
            chatId: scope.chatId,
            segments: [{ type: 'text', data: { text: value } }],
            source: 'agent-tool',
          })
          if (!result?.ok) fail(safeMessage(result?.error, '消息未发送'))
          return { ok: true, chatType: scope.chatType, chatId: scope.chatId, messageId: text(result.messageId) }
        } catch (error) {
          throw new Error(safeMessage(error, '消息发送失败'))
        }
      },
    },
    {
      name: 'qq_like_user',
      description: '给当前私聊对象点赞 1–10 次；不能指定其它用户。',
      parameters: objectSchema({ times: { type: 'integer', enum: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] } }),
      output: output({ userId: { type: 'string' }, times: { type: 'integer' } }),
      async execute(args) {
        rejectUnknown(args, ['times'])
        requirePrivate()
        const times = args?.times === undefined ? 1 : Number(args.times)
        if (!Number.isInteger(times) || times < 1 || times > 10) fail('点赞次数必须是 1 到 10 的整数')
        if (!actions()?.sendLike) fail('QQ 点赞服务不可用')
        try { await actions().sendLike(scope.chatId, times) } catch (error) { throw new Error(safeMessage(error, 'QQ 点赞失败')) }
        return { ok: true, userId: scope.chatId, times }
      },
    },
    {
      name: 'qq_poke_user',
      description: '戳一戳当前私聊对象；不能指定其它用户。',
      parameters: objectSchema({}),
      output: output({ userId: { type: 'string' } }),
      async execute(args) {
        rejectUnknown(args, [])
        requirePrivate()
        if (!actions()?.friendPoke) fail('QQ 戳一戳服务不可用')
        try { await actions().friendPoke(scope.chatId) } catch (error) { throw new Error(safeMessage(error, 'QQ 戳一戳失败')) }
        return { ok: true, userId: scope.chatId }
      },
    },
  ]
}
