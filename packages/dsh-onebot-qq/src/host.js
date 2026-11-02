// dsh-onebot-qq 插件入口（宿主半边）。
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
import { createEventStore } from './core/events.js'
import { loadConfig, saveConfig, defaultConfig, refreshSecrets } from './core/config.js'
import { dataDir } from './core/store.js'
import { createGatewayManager } from './gateway/manager.js'
import { normalizeEvent } from './gateway/normalize.js'
import { createRoutes } from './http/routes.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = (() => {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  } catch (error) {
    return { version: '0.0.0' }
  }
})()
const VERSION = PKG.version
export const PLUGIN_ID = 'dsh-onebot-qq'

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

  const getConfig = () => configState.current

  const events = createEventStore({ getConfig, log: eventLog })

  /** WS 原始事件 → 规范化 → 缓冲 → 广播给 DSH 插件事件总线。 */
  function onEvent(raw) {
    try {
      const normalized = normalizeEvent(raw, getConfig())
      if (!normalized) return
      const pushed = events.push(normalized)
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

  /** 保存配置并热应用（端点变化时 gateway 内部自动重连）。 */
  function setConfig(next) {
    const previous = configState.current
    const result = saveConfig(next)
    configState.current = result.config
    refreshSecrets(result.config)
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
      events.dispose()
    } catch (error) {}
    log.info('插件已卸载，连接已关闭')
  }

  try {
    ctx.effect(() => dispose, 'onebot-qq: 收尾')
  } catch (error) {
    // 测试替身环境下没有 ctx.effect；由调用方负责清理
  }

  log.info(`dsh-onebot-qq v${VERSION} 已加载；数据目录 ${dataDir()}`)

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
    logger,
    routes,
    dispose,
  }
}
