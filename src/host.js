// dsh-bot 插件入口（宿主半边）。
//
// 职责：
//   1. 加载/保存持久化配置（数据目录 config.json）；
//   2. 组装 gateway（OneBot v11 连接/账号核验）、事件缓冲、REST 接口；
//   3. 向 DSH 暴露事件与状态（ctx.emit），供后续认知/记忆插件消费；
//   4. 随插件卸载清理连接与路由。
//
// 网页半边（面板）见 client.js；接口契约见 docs/ARCHITECTURE.md。

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createLogger } from './core/logger.js'
import { createAccess } from './core/access.js'
import { createEventStore } from './core/events.js'
import { loadConfig, saveConfig, defaultConfig, refreshSecrets } from './core/config.js'
import { dataDir } from './core/store.js'
import { createGatewayManager } from './gateway/manager.js'
import { normalizeEvent } from './gateway/normalize.js'
import { createRoutes } from './http/routes.js'
import { createCognition } from './cognition/index.js'
import { createModelGateway } from './model/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = (() => {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  } catch (error) {
    return { version: '0.0.0' }
  }
})()
const VERSION = PKG.version
export const PLUGIN_ID = 'dsh-bot'

export const name = 'onebot-qq'
export const inject = ['webServer']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [rowConfig] cordis 行配置（仅首次生成 config.json 时作为初始值）
 */
export function apply(ctx, rowConfig) {
  const configState = { current: loadConfig({ rowConfig }) }
  refreshSecrets(configState.current)

  const logger = createLogger({ getConfig: () => configState.current, dsh: ctx })
  const log = logger.child('plugin')
  const eventLog = logger.child('events')
  const access = createAccess({ getConfig: () => configState.current, logger: logger.child('access') })

  const getConfig = () => configState.current

  const events = createEventStore({ getConfig, log: eventLog })

  // 模型网关独立于 QQ/认知：协议适配与 provider 注册表不感知平台。
  const models = createModelGateway({ dataRoot: dataDir(), logger, env: process.env })

  let gatewayRef = null
  const cognition = createCognition({
    ctx,
    getConfig,
    models,
    gateway: {
      get actions() {
        return {
          sendMessage: (...args) => {
            if (!gatewayRef?.actions?.sendMessage) throw new Error('QQ 网关尚未就绪')
            return gatewayRef.actions.sendMessage(...args)
          },
        }
      },
    },
    logger,
    dataRoot: dataDir('cognition'),
    access,
  })

  /** WS 原始事件 → raw 日志/认知 → 规范化 → 缓冲 → 广播给 DSH 插件事件总线。 */
  function onEvent(raw) {
    try {
      // 访问控制先于一切：被拒绝的消息不落 raw、不聚合、不回复。
      const gate = access.decideRaw(raw)
      if (!gate.allowed) {
        log.debug(`访问拒绝：${gate.chatType || '?'}:${gate.chatId || '?'}/${gate.senderId || '?'}（${gate.reason}）`)
        return
      }
      // 过滤前先交给认知：原始事件不能因为过滤规则丢失。
      try { cognition.ingestRaw(raw) } catch (error) { log.warn('认知 raw 事件失败：', error.message) }
      const normalized = normalizeEvent(raw, getConfig())
      if (!normalized) return
      const pushed = events.push(normalized)
      try { cognition.observe(pushed.record || normalized, { accepted: pushed.accepted, reason: pushed.reason || '' }) } catch (error) { log.warn('认知 observe 失败：', error.message) }
      if (!pushed.accepted) {
        log.debug(`事件被过滤：${pushed.reason}`)
        return
      }
      try {
        ctx.emit?.('onebot-qq/event', pushed.record)
      } catch (error) {
        log.warn('广播 onebot-qq/event 失败：', error.message)
      }
    } catch (error) {
      log.warn('处理 OneBot 事件失败：', error.message)
    }
  }

  const gateway = createGatewayManager({
    ctx,
    getConfig,
    log: logger.child('gateway'),
    onEvent,
    onState: (snapshot) => {
      try {
        ctx.emit?.('onebot-qq/state', snapshot)
      } catch (error) {}
    },
  })
  gatewayRef = gateway
  cognition.gateway = gateway

  // 对外暴露认知服务；宿主/其它插件可通过 ctx.get('onebotCognition') 读取。
  try {
    ctx.provide?.('onebotCognition', cognition)
  } catch (error) {
    log.warn('注册 onebotCognition 服务失败：', error.message)
  }
  try {
    ctx.provide?.('onebotModels', models)
  } catch (error) {
    log.warn('注册 onebotModels 服务失败：', error.message)
  }

  /** 保存配置并热应用（端点变化时 gateway 内部自动重连）。 */
  function setConfig(next) {
    const previous = configState.current
    const result = saveConfig(next)
    configState.current = result.config
    refreshSecrets(result.config)
    try { models.refreshSecrets() } catch (error) {}
    try {
      gateway.applyConfig(previous, result.config)
    } catch (error) {
      log.warn('热应用配置失败：', error.message)
    }
    try {
      ctx.emit?.('onebot-qq/config', result.config, previous)
    } catch (error) {}
    log.info('配置已保存' + (result.issues?.length ? `（${result.issues.length} 条提示）` : ''))
    return result
  }

  function resetConfig() {
    const result = setConfig(defaultConfig())
    return result
  }

  const routes = createRoutes({
    ctx,
    getConfig,
    setConfig,
    resetConfig,
    gateway,
    events,
    logger,
    cognition,
    models,
    access,
    version: VERSION,
    dataDir: dataDir(),
  })

  const ready = (async () => {
    try {
      await gateway.ready
      if (configState.current.enabled) await gateway.start()
      else gateway.stop()
    } catch (error) {
      log.warn('初始化 QQ 连接失败：', error.message)
    }
  })()
  ready.catch(() => {})

  function dispose() {
    try {
      routes.dispose()
    } catch (error) {}
    try {
      gateway.dispose()
    } catch (error) {}
    try {
      cognition.dispose()
    } catch (error) {}
    try {
      models.dispose()
    } catch (error) {}
    try {
      events.dispose()
    } catch (error) {}
    log.info('插件已卸载，连接已关闭')
  }

  try {
    ctx.effect(() => dispose, 'onebot-qq: 收尾')
  } catch (error) {
    // 测试替身环境下没有 ctx.effect；由调用方负责清理
  }

  log.info(`dsh-bot v${VERSION} 已加载；数据目录 ${dataDir()}`)

  // 返回句柄：cordis 忽略返回值；测试与后续插件可直接使用。
  return {
    name: PLUGIN_ID,
    version: VERSION,
    ready,
    getConfig,
    setConfig,
    resetConfig,
    gateway,
    events,
    cognition,
    models,
    access,
    logger,
    routes,
    dispose,
  }
}
