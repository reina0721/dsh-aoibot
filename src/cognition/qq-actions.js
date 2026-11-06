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

  return { like, poke, groupInfo, memberInfo }
}
