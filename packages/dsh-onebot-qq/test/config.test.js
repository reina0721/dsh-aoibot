// 配置规范化 / 字段表一致性 / 日志脱敏开关的单元测试。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULTS, CONFIG_GROUPS, normalizeConfig, getPath } from '../src/core/config.js'
import { createLogger } from '../src/core/logger.js'

test('字段表与 DEFAULTS 不漂移：每个面板字段的 default 都等于 DEFAULTS 里的值', () => {
  const drift = []
  for (const group of CONFIG_GROUPS) {
    for (const field of group.fields) {
      const actual = getPath(DEFAULTS, field.path)
      const expected = field.default
      const same = JSON.stringify(actual) === JSON.stringify(expected)
      if (!same) drift.push(`${field.path}: DEFAULTS=${JSON.stringify(actual)} group.default=${JSON.stringify(expected)}`)
    }
  }
  assert.deepEqual(drift, [], 'DEFAULTS 与 CONFIG_GROUPS 必须一致（面板与后端共用同一份默认值）')
})

test('normalizeConfig：非法 wsUrl 也会产生可读 issue（不再静默清空）', () => {
  const { config, issues } = normalizeConfig({
    onebot: { wsUrl: 'ftp://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000' },
  })
  assert.equal(config.onebot.wsUrl, '', '非法协议应回退为空')
  assert.equal(config.onebot.httpUrl, 'http://127.0.0.1:3000')
  assert.ok(issues.some((issue) => issue.includes('ws:') || issue.includes('协议')), '应记录 wsUrl 的 issue：' + JSON.stringify(issues))
})

test('normalizeConfig：probeMs 下限与字段表一致（1000）', () => {
  const field = CONFIG_GROUPS.flatMap((group) => group.fields).find((item) => item.path === 'timeouts.probeMs')
  const { config } = normalizeConfig({ timeouts: { probeMs: 500 } })
  assert.equal(field.min, 1000)
  assert.equal(config.timeouts.probeMs, 1000, '500 应被 clamp 到下限 1000')
})

test('normalizeConfig：非法枚举/类型回退默认值', () => {
  const { config } = normalizeConfig({
    gateway: 'unknown',
    accountCheck: 'boom',
    onebot: { httpAuth: 'magic' },
    logging: { level: 'verbose' },
    reconnect: { factor: 99, jitterRatio: -1 },
  })
  assert.equal(config.gateway, DEFAULTS.gateway)
  assert.equal(config.accountCheck, DEFAULTS.accountCheck)
  assert.equal(config.onebot.httpAuth, DEFAULTS.onebot.httpAuth)
  assert.equal(config.logging.level, DEFAULTS.logging.level)
  assert.equal(config.reconnect.factor, 5)
  assert.equal(config.reconnect.jitterRatio, 0)
})

test('normalizeConfig：ui 外观/动效偏好合法值保留、非法枚举回退默认', () => {
  const ok = normalizeConfig({
    ui: { accent: 'blue', density: 'comfortable', fontScale: 'large', contentWidth: 'auto', motion: 'reduced', pageTransition: 'fade-up' },
  })
  assert.deepEqual(ok.config.ui, {
    refreshMs: DEFAULTS.ui.refreshMs,
    eventPageSize: DEFAULTS.ui.eventPageSize,
    logPageSize: DEFAULTS.ui.logPageSize,
    accent: 'blue',
    density: 'comfortable',
    fontScale: 'large',
    contentWidth: 'auto',
    motion: 'reduced',
    pageTransition: 'fade-up',
  })

  const bad = normalizeConfig({
    ui: { accent: 'magenta', density: 'huge', fontScale: 'xl', contentWidth: 'full', motion: 'sometimes', pageTransition: 'zoom' },
  })
  assert.equal(bad.config.ui.accent, DEFAULTS.ui.accent)
  assert.equal(bad.config.ui.density, DEFAULTS.ui.density)
  assert.equal(bad.config.ui.fontScale, DEFAULTS.ui.fontScale)
  assert.equal(bad.config.ui.contentWidth, DEFAULTS.ui.contentWidth)
  assert.equal(bad.config.ui.motion, DEFAULTS.ui.motion)
  assert.equal(bad.config.ui.pageTransition, DEFAULTS.ui.pageTransition)
})

test('logger：logging.redact=true 脱敏，redact=false 时按原样记录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ob-log-'))
  process.env.DSH_ONEBOT_QQ_DATA_DIR = dir
  try {
    const raw = 'Authorization: Bearer abcdefgh12345678'
    const redacting = createLogger({ getConfig: () => ({ logging: { level: 'debug', bufferSize: 50, redact: true } }) })
    redacting.child('t').info(raw)
    assert.equal(redacting.recent({ limit: 10 }).items.at(-1).text.includes('abcdefgh12345678'), false)

    const plain = createLogger({ getConfig: () => ({ logging: { level: 'debug', bufferSize: 50, redact: false } }) })
    plain.child('t').info(raw)
    assert.equal(plain.recent({ limit: 10 }).items.at(-1).text, raw)
  } finally {
    delete process.env.DSH_ONEBOT_QQ_DATA_DIR
    rmSync(dir, { recursive: true, force: true })
  }
})
