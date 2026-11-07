import { normalizeConfig } from '../core/config.js'

// 每次读取当前规范化快照；固定路径和 normalizer 的固定字段共同阻止秘密/其它配置泄漏。
export function createLegacyConfig({ getConfig, assertActive }) {
  return Object.freeze({
    section(path) {
      assertActive()
      if (arguments.length !== 1 || path !== 'cognition.reminders') throw new Error('只允许读取 cognition.reminders')
      try {
        const reminders = getConfig?.()?.cognition?.reminders
        return structuredClone(normalizeConfig({ cognition: { reminders } }).config.cognition.reminders)
      } catch { throw new Error('提醒配置读取失败') }
    },
  })
}
