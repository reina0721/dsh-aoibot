// OneBot v11 action 封装：所有对 QQ 的「动作」都从这里走，统一参数校验与错误提示。
//
// 设计原则：
//   1. 面板/后续插件不直接拼 action 名与参数，避免每个调用点重复校验；
//   2. 显式封装 OneBot v11 action；资料/精华/文件等扩展取决于网关支持；
//   3. 超时/重试由 onebot client 的配置驱动（timeouts.*），这里只透传 opts。

import { OneBotError } from '../onebot/client.js'

/** 通用 QQ 号 / 群号参数：能用 Number 精确表示就用 Number（多数网关按 int 解析）。 */
export function idParam(value) {
  const text = String(value ?? '').trim()
  if (!text) return 0
  if (!/^-?\d+$/.test(text)) return text
  const n = Number(text)
  if (!Number.isSafeInteger(n)) return text
  return n
}

/** 非空字符串校验。 */
function requireText(value, field) {
  const text = String(value ?? '').trim()
  if (!text) throw new OneBotError('validate', { message: `${field} 不能为空` })
  return text
}

/** 管理动作只接受合法数值 ID；消息 ID 可以是负 int32。 */
function requireId(value, message = false) {
  const valueText = String(value ?? '').trim()
  const n = Number(valueText)
  if (!(message ? /^-?[1-9]\d*$/.test(valueText) : /^[1-9]\d*$/.test(valueText)) || !Number.isSafeInteger(n) || (message && (n < -2147483648 || n > 2147483647))) {
    throw new OneBotError('validate', { message: 'ID 无效' })
  }
  return n
}

function adminText(value, field) {
  const result = requireText(value, field)
  if (Array.from(result).length > 100 || /[\x00-\x1f\x7f]/.test(result)) throw new OneBotError('validate', { message: `${field} 最多 100 字符且不能含控制字符` })
  return result
}

function requireBoolean(value) {
  if (typeof value !== 'boolean') throw new OneBotError('validate', { message: 'enable 必须是 boolean' })
  return value
}

/**
 * 把面板/调用方给的消息统一成 OneBot v11 消息段数组。
 * - 字符串 → [{ type:'text', data:{ text } }]（不解释 CQ 码，避免注入不需要的段）；
 * - 数组 → 原样透传（逐项校验 type）；
 * - undefined/null → 报错。
 */
export function toSegments(message) {
  if (message === undefined || message === null) {
    throw new OneBotError('validate', { message: '消息内容不能为空' })
  }
  if (typeof message === 'string') {
    if (!message.length) throw new OneBotError('validate', { message: '消息内容不能为空' })
    return [{ type: 'text', data: { text: message } }]
  }
  if (Array.isArray(message)) {
    if (!message.length) throw new OneBotError('validate', { message: '消息段数组不能为空' })
    return message.map((segment, index) => {
      if (!segment || typeof segment !== 'object') {
        throw new OneBotError('validate', { message: `第 ${index + 1} 个消息段不是对象` })
      }
      const type = String(segment.type || '').trim()
      if (!type) throw new OneBotError('validate', { message: `第 ${index + 1} 个消息段缺少 type` })
      const data = segment.data && typeof segment.data === 'object' ? segment.data : {}
      return { type, data }
    })
  }
  throw new OneBotError('validate', { message: '消息必须是字符串或消息段数组' })
}

/**
 * 创建 action 集合。
 * @param {object} o
 * @param {(action: string, params: object, opts?: object) => Promise<any>} o.call OneBot 客户端调用
 */
export function createActions({ call }) {
  if (typeof call !== 'function') throw new Error('createActions 需要 call 函数')

  /** 发私聊消息。 */
  async function sendPrivate(userId, message, opts = {}) {
    const params = { user_id: idParam(requireText(userId, 'QQ 号')), message: toSegments(message) }
    if (opts.autoEscape === true) params.auto_escape = true
    return call('send_private_msg', params, opts)
  }

  /** 发群消息。 */
  async function sendGroup(groupId, message, opts = {}) {
    const params = { group_id: idParam(requireText(groupId, '群号')), message: toSegments(message) }
    if (opts.autoEscape === true) params.auto_escape = true
    return call('send_group_msg', params, opts)
  }

  /**
   * 统一发送入口（面板 /send 使用）。
   * @param {{ chatType:'private'|'group', chatId:string|number, message:string|Array, autoEscape?:boolean }} o
   */
  async function sendMessage({ chatType, chatId, message, autoEscape } = {}) {
    if (chatType === 'group') return sendGroup(chatId, message, { autoEscape })
    if (chatType === 'private') return sendPrivate(chatId, message, { autoEscape })
    throw new OneBotError('validate', { message: 'chatType 必须是 private 或 group' })
  }

  return {
    sendPrivate,
    sendGroup,
    sendMessage,
    /** 上传群文件（OneBot v11 路径由网关进程读取）。 */
    uploadGroupFile(groupId, filePath, name, opts = {}) {
      return call('upload_group_file', {
        group_id: idParam(requireText(groupId, '群号')),
        file: requireText(filePath, '文件路径'),
        name: requireText(name, '文件名'),
      }, opts)
    },
    /** 上传私聊文件（部分 OneBot 实现扩展了此 v11 action）。 */
    uploadPrivateFile(userId, filePath, name, opts = {}) {
      return call('upload_private_file', {
        user_id: idParam(requireText(userId, 'QQ 号')),
        file: requireText(filePath, '文件路径'),
        name: requireText(name, '文件名'),
      }, opts)
    },
    /** 登录号信息：{ user_id, nickname } */
    getLoginInfo(opts = {}) {
      return call('get_login_info', {}, opts)
    },
    /** 好友列表 */
    getFriendList(opts = {}) {
      return call('get_friend_list', {}, opts)
    },
    /** 群列表 */
    getGroupList(opts = {}) {
      return call('get_group_list', {}, opts)
    },
    /** 群信息 */
    getGroupInfo(groupId, { noCache = true, ...opts } = {}) {
      return call('get_group_info', { group_id: idParam(requireText(groupId, '群号')), no_cache: noCache !== false }, opts)
    },
    /** 群成员信息 */
    getGroupMemberInfo(groupId, userId, { noCache = true, ...opts } = {}) {
      return call('get_group_member_info', {
        group_id: idParam(requireText(groupId, '群号')),
        user_id: idParam(requireText(userId, 'QQ 号')),
        no_cache: noCache !== false,
      }, opts)
    },
    /** 网关扩展；拒绝时由 QQ 服务给出明确 unsupported 错误。 */
    setProfile({ nickname } = {}, opts = {}) {
      return call('set_qq_profile', { nickname: adminText(nickname, '昵称') }, opts)
    },
    setGroupCard(groupId, userId, card, opts = {}) {
      return call('set_group_card', { group_id: requireId(groupId), user_id: requireId(userId), card: adminText(card, '名片') }, opts)
    },
    setGroupName(groupId, name, opts = {}) {
      return call('set_group_name', { group_id: requireId(groupId), group_name: adminText(name, '群名') }, opts)
    },
    setGroupAdmin(groupId, userId, enable, opts = {}) {
      return call('set_group_admin', { group_id: requireId(groupId), user_id: requireId(userId), enable: requireBoolean(enable) }, opts)
    },
    setGroupBan(groupId, userId, durationSeconds, opts = {}) {
      if (!Number.isInteger(durationSeconds) || durationSeconds < 0 || durationSeconds > 2592000) throw new OneBotError('validate', { message: '禁言秒数必须为 0–2592000 的整数' })
      return call('set_group_ban', { group_id: requireId(groupId), user_id: requireId(userId), duration: durationSeconds }, opts)
    },
    setGroupWholeBan(groupId, enable, opts = {}) {
      return call('set_group_whole_ban', { group_id: requireId(groupId), enable: requireBoolean(enable) }, opts)
    },
    setGroupKick(groupId, userId, opts = {}) {
      return call('set_group_kick', { group_id: requireId(groupId), user_id: requireId(userId), reject_add_request: false }, opts)
    },
    setEssence(messageId, opts = {}) {
      return call('set_essence_msg', { message_id: requireId(messageId, true) }, opts)
    },
    /** 撤回消息 */
    deleteMsg(messageId, opts = {}) {
      return call('delete_msg', { message_id: requireId(messageId, true) }, opts)
    },
    /** 查询消息 */
    getMsg(messageId, opts = {}) {
      return call('get_msg', { message_id: idParam(requireText(messageId, '消息 ID')) }, opts)
    },
    /**
     * 合并转发内容。不同网关参数名不同：go-cqhttp 用 id，NapCat/Lagrange 用 message_id。
     * 先按 id 试，失败再按 message_id 试；两次都失败抛第二次错误。
     */
    async getForwardMsg(id, opts = {}) {
      const value = requireText(id, '合并转发 id')
      try {
        return await call('get_forward_msg', { id: value }, opts)
      } catch (firstError) {
        return call('get_forward_msg', { message_id: idParam(value) }, opts)
      }
    },
    /** 群戳一戳 */
    groupPoke(groupId, userId, opts = {}) {
      return call('group_poke', { group_id: idParam(requireText(groupId, '群号')), user_id: idParam(requireText(userId, 'QQ 号')) }, opts)
    },
    /** 好友戳一戳 */
    friendPoke(userId, opts = {}) {
      return call('friend_poke', { user_id: idParam(requireText(userId, 'QQ 号')) }, opts)
    },
    /** 点赞 */
    sendLike(userId, times = 1, opts = {}) {
      return call('send_like', { user_id: idParam(requireText(userId, 'QQ 号')), times: Math.max(1, Math.min(10, Number(times) || 1)) }, opts)
    },
    /** 消息表态 */
    setMsgEmojiLike(messageId, emojiId = '128077', opts = {}) {
      return call('set_msg_emoji_like', { message_id: idParam(requireText(messageId, '消息 ID')), emoji_id: String(emojiId || '128077') }, opts)
    },
    /** 网关状态（在线账号等） */
    getStatus(opts = {}) {
      return call('get_status', {}, opts)
    },
    /** 网关版本信息 */
    getVersionInfo(opts = {}) {
      return call('get_version_info', {}, opts)
    },
    /** 原始 action 透传（受配置 security.allowRawAction 限制，由路由层把关） */
    raw(action, params = {}, opts = {}) {
      const name = String(action || '').trim()
      if (!name) throw new OneBotError('validate', { message: 'action 不能为空' })
      return call(name, params && typeof params === 'object' ? params : {}, opts)
    },
  }
}
