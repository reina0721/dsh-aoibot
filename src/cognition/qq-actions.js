// QQ 动作服务：点赞、拍一拍、群/成员信息。
//
// 只给「主人命令」和后续 agent 工具复用；每个动作都先校验调用者与当前会话，
// 不允许通过参数任意跨群/跨用户操作。返回值只保留可展示字段，避免把网关原始
// 响应里的敏感字段带进聊天或日志。

function text(value) {
  return String(value ?? '').trim()
}

function numberOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

export function createQqActions({ gateway = null, getConfig = null, logger = null } = {}) {
  const log = logger?.child?.('qq-actions') || logger || { debug() {}, warn() {} }
  const actions = () => gateway?.actions || null

  function ownerId(operatorId) {
    const config = (() => {
      try { return getConfig?.() || {} } catch (error) { return {} }
    })()
    return text(config.access?.ownerQQ || config.ownerQQ || '') === text(operatorId) && Boolean(text(operatorId))
  }

  function currentTarget({ chatType, chatId, userId }) {
    if (chatType === 'private') return text(chatId || userId)
    return text(userId)
  }

  async function like({ operatorId, chatType, chatId, userId, times = 1 } = {}) {
    if (!ownerId(operatorId)) return { ok: false, error: 'NOT_OWNER' }
    const target = currentTarget({ chatType, chatId, userId })
    if (!target) return { ok: false, error: 'NO_TARGET' }
    const api = actions()
    if (!api?.sendLike) return { ok: false, error: 'GATEWAY_UNAVAILABLE' }
    const count = Math.max(1, Math.min(10, numberOr(times, 1)))
    try {
      await api.sendLike(target, count)
      return { ok: true, target, times: count }
    } catch (error) {
      log.debug?.('点赞失败：', error.message)
      return { ok: false, error: String(error?.message || error) }
    }
  }

  async function poke({ operatorId, chatType, chatId, userId } = {}) {
    if (!ownerId(operatorId)) return { ok: false, error: 'NOT_OWNER' }
    const target = currentTarget({ chatType, chatId, userId })
    if (!target) return { ok: false, error: 'NO_TARGET' }
    const api = actions()
    if (chatType === 'group') {
      if (!api?.groupPoke) return { ok: false, error: 'GATEWAY_UNAVAILABLE' }
      try {
        await api.groupPoke(chatId, target)
        return { ok: true, target, chatType }
      } catch (error) {
        return { ok: false, error: String(error?.message || error) }
      }
    }
    if (!api?.friendPoke) return { ok: false, error: 'GATEWAY_UNAVAILABLE' }
    try {
      await api.friendPoke(target)
      return { ok: true, target, chatType: 'private' }
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
  }

  async function groupInfo({ operatorId, chatType, chatId } = {}) {
    if (!ownerId(operatorId)) return { ok: false, error: 'NOT_OWNER' }
    if (chatType !== 'group') return { ok: false, error: 'GROUP_ONLY' }
    const api = actions()
    if (!api?.getGroupInfo) return { ok: false, error: 'GATEWAY_UNAVAILABLE' }
    try {
      const raw = await api.getGroupInfo(chatId)
      const data = raw?.data && typeof raw.data === 'object' ? raw.data : raw || {}
      return {
        ok: true,
        groupId: text(data.group_id || chatId),
        groupName: text(data.group_name),
        memberCount: Number(data.member_count) || 0,
        maxMemberCount: Number(data.max_member_count) || 0,
        ownerId: text(data.owner_id),
      }
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
  }

  async function memberInfo({ operatorId, chatType, chatId, userId } = {}) {
    if (!ownerId(operatorId)) return { ok: false, error: 'NOT_OWNER' }
    if (chatType !== 'group') return { ok: false, error: 'GROUP_ONLY' }
    const target = text(userId || operatorId)
    const api = actions()
    if (!api?.getGroupMemberInfo) return { ok: false, error: 'GATEWAY_UNAVAILABLE' }
    try {
      const raw = await api.getGroupMemberInfo(chatId, target)
      const data = raw?.data && typeof raw.data === 'object' ? raw.data : raw || {}
      return {
        ok: true,
        groupId: text(chatId),
        userId: text(data.user_id || target),
        nickname: text(data.nickname),
        card: text(data.card),
        role: text(data.role),
        joinTime: Number(data.join_time) || 0,
        lastSentTime: Number(data.last_sent_time) || 0,
      }
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
  }

  // Fixed command-only operations. Never forward an arbitrary action name/params.
  function adminConfig() {
    try { return getConfig?.()?.cognition?.qqAdmin || {} } catch { return {} }
  }

  function validId(value, message = false) {
    const str = text(value), n = Number(str)
    return (message ? /^-?[1-9]\d*$/.test(str) : /^[1-9]\d*$/.test(str)) && Number.isSafeInteger(n)
      && (!message || (n >= -2147483648 && n <= 2147483647))
  }

  function validText(value) {
    const max = Math.max(1, Math.min(100, Number(adminConfig().maxText) || 100))
    return typeof value === 'string' && Boolean(text(value)) && Array.from(text(value)).length <= max && !/[\x00-\x1f\x7f]/.test(value)
  }

  async function adminAction(method, input = {}) {
    const { operatorId, chatType, chatId, userId, messageId, confirmed } = input
    if (!ownerId(operatorId)) return { ok: false, error: 'NOT_OWNER' }
    const cfg = adminConfig()
    if (cfg.enabled !== true) return { ok: false, error: 'QQ_ADMIN_DISABLED' }
    if (!['group', 'private'].includes(chatType) || !validId(chatId)) return { ok: false, error: 'INVALID_CHAT' }
    if (method === 'setProfile') {
      if (chatType !== 'private' || text(chatId) !== text(operatorId)) return { ok: false, error: 'OWNER_PRIVATE_ONLY' }
    } else if (method !== 'deleteMsg' && chatType !== 'group') return { ok: false, error: 'GROUP_ONLY' }
    if (chatType === 'private' && text(chatId) !== text(operatorId)) return { ok: false, error: 'OWNER_PRIVATE_ONLY' }
    if (['setGroupCard', 'setGroupAdmin', 'setGroupBan', 'setGroupKick'].includes(method) && !validId(userId)) return { ok: false, error: 'INVALID_USER_ID' }
    if (['setProfile', 'setGroupCard', 'setGroupName'].includes(method) && !validText(input.nickname ?? input.card ?? input.name)) return { ok: false, error: 'INVALID_TEXT' }
    if (['setGroupAdmin', 'setGroupWholeBan'].includes(method) && typeof input.enable !== 'boolean') return { ok: false, error: 'INVALID_ENABLE' }
    if (method === 'setGroupBan' && (!Number.isInteger(input.durationSeconds) || input.durationSeconds < 0 || input.durationSeconds > 2592000)) return { ok: false, error: 'INVALID_DURATION' }
    const destructive = method === 'setGroupKick' || method === 'deleteMsg'
    if (destructive && (method === 'setGroupKick' || cfg.requireConfirm !== false) && confirmed !== 'confirm') return { ok: false, error: 'CONFIRM_REQUIRED' }
    const api = actions()
    if (!api?.[method]) return { ok: false, error: method === 'setProfile' ? 'UNSUPPORTED_SET_QQ_PROFILE' : 'GATEWAY_UNAVAILABLE' }
    try {
      if (method === 'setEssence' || method === 'deleteMsg') {
        if (!validId(messageId, true)) return { ok: false, error: 'INVALID_MESSAGE_ID' }
        if (!api.getMsg) return { ok: false, error: 'MESSAGE_SCOPE_UNVERIFIED' }
        const raw = await api.getMsg(messageId)
        const msg = raw?.data || raw || {}
        // get_msg's standard response need not include a chat ID. Fail closed if the
        // gateway cannot prove the current conversation (do not infer from text).
        const sameChat = msg.message_type === chatType && (chatType === 'group'
          ? text(msg.group_id) === text(chatId)
          : !msg.group_id && text(msg.user_id || msg.target_id || msg.sender?.user_id) === text(chatId))
        if (!sameChat) return { ok: false, error: 'MESSAGE_SCOPE_UNVERIFIED' }
      }
      const args = {
        setProfile: [{ nickname: text(input.nickname) }],
        setGroupCard: [chatId, userId, text(input.card)],
        setGroupName: [chatId, text(input.name)],
        setGroupAdmin: [chatId, userId, input.enable],
        setGroupBan: [chatId, userId, input.durationSeconds],
        setGroupWholeBan: [chatId, input.enable],
        setGroupKick: [chatId, userId],
        setEssence: [messageId],
        deleteMsg: [messageId],
      }[method]
      if (destructive) log.info?.('QQ destructive action', { action: method, operatorId: text(operatorId), chatType, chatId: text(chatId), target: text(userId || messageId) })
      const result = await api[method](...args)
      if (result?.status === 'failed' || (result?.retcode != null && Number(result.retcode) !== 0)) {
        return { ok: false, error: method === 'setProfile' ? 'UNSUPPORTED_SET_QQ_PROFILE' : 'GATEWAY_REJECTED' }
      }
      return { ok: true }
    } catch {
      // Do not return raw gateway errors: they may contain request URLs or tokens.
      return { ok: false, error: method === 'setProfile' ? 'UNSUPPORTED_SET_QQ_PROFILE' : 'GATEWAY_REJECTED' }
    }
  }

  return {
    like, poke, groupInfo, memberInfo,
    setProfile: (input) => adminAction('setProfile', input),
    setGroupCard: (input) => adminAction('setGroupCard', input),
    setGroupName: (input) => adminAction('setGroupName', input),
    setGroupAdmin: (input) => adminAction('setGroupAdmin', input),
    setGroupBan: (input) => adminAction('setGroupBan', input),
    setGroupWholeBan: (input) => adminAction('setGroupWholeBan', input),
    setGroupKick: (input) => adminAction('setGroupKick', input),
    setEssence: (input) => adminAction('setEssence', input),
    deleteMsg: (input) => adminAction('deleteMsg', input),
  }
}
