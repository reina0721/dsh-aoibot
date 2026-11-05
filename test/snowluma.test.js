// snowluma.js 单元测试：只读检测 + OneBot 地址读取 + 端点解析 + URL 脱敏。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  detectInstall,
  detectFirstInstall,
  readOneBotEndpoint,
  resolveEndpoint,
  detectGateway,
  safeUrl,
  listUinConfigs,
} from '../src/gateway/snowluma.js'

function tempDir(prefix = 'sl-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

function makeInstall(dir, version = '1.2.3') {
  writeFileSync(join(dir, 'index.mjs'), '// fake snowluma\n', 'utf8')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'snowluma', version }), 'utf8')
  mkdirSync(join(dir, 'config'), { recursive: true })
}

function writeOneBotConfig(dir, data, name = 'onebot.json') {
  mkdirSync(join(dir, 'config'), { recursive: true })
  writeFileSync(join(dir, 'config', name), JSON.stringify(data), 'utf8')
}

const GLOBAL_ONEBOT = {
  networks: {
    httpServers: [{ host: '0.0.0.0', port: 3000, accessToken: 'http-token-abc', enable: true }],
    wsServers: [{ host: '127.0.0.1', port: 3001, accessToken: 'ws-token-xyz', enable: true }],
  },
}

test('detectInstall：缺目录/缺 index.mjs/中文路径/正常安装', () => {
  assert.equal(detectInstall('').installed, false)
  const missing = detectInstall(join(tmpdir(), 'definitely-not-here-' + Date.now()))
  assert.equal(missing.installed, false)
  assert.match(missing.reason, /目录不存在/)

  const empty = tempDir('sl-empty-')
  try {
    const notThere = detectInstall(empty)
    assert.equal(notThere.installed, false)
    assert.match(notThere.reason, /index\.mjs/)
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }

  const chinese = detectInstall('C:\\SnowLuma\\中文目录')
  assert.equal(chinese.installed, false)
  assert.match(chinese.reason, /中文/)

  const ok = tempDir('sl-ok-')
  try {
    makeInstall(ok, '9.9.9')
    const result = detectInstall(ok)
    assert.equal(result.installed, true)
    assert.equal(result.version, '9.9.9')
    assert.match(result.entry, /index\.mjs$/)
  } finally {
    rmSync(ok, { recursive: true, force: true })
  }
})

test('detectFirstInstall：按候选顺序找到第一个装好的', () => {
  const good = tempDir('sl-first-')
  try {
    makeInstall(good)
    const result = detectFirstInstall({ configured: good, env: {} })
    assert.equal(result.installed, true)
    assert.equal(result.dir, good)
    assert.ok(Array.isArray(result.candidates) && result.candidates.length >= 1)
  } finally {
    rmSync(good, { recursive: true, force: true })
  }
  const none = detectFirstInstall({ configured: join(tmpdir(), 'nope-' + Date.now()), env: {} })
  assert.equal(none.installed, false)
  assert.match(none.reason, /没找到/)
})

test('readOneBotEndpoint：全局 onebot.json 读出 http/ws 地址与 token', () => {
  const dir = tempDir('sl-read-')
  try {
    makeInstall(dir)
    writeOneBotConfig(dir, GLOBAL_ONEBOT)
    const result = readOneBotEndpoint(dir, '')
    assert.equal(result.found, true)
    assert.equal(result.httpUrl, 'http://127.0.0.1:3000')
    assert.equal(result.httpToken, 'http-token-abc')
    assert.equal(result.wsUrl, 'ws://127.0.0.1:3001')
    assert.equal(result.wsToken, 'ws-token-xyz')
    assert.deepEqual(result.files, ['onebot.json'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readOneBotEndpoint：onebot_<uin>.json 覆盖全局，mode=snapshot 时不叠全局', () => {
  const dir = tempDir('sl-uin-')
  try {
    makeInstall(dir)
    writeOneBotConfig(dir, GLOBAL_ONEBOT)
    writeOneBotConfig(dir, {
      mode: 'snapshot',
      networks: {
        httpServers: [{ host: 'localhost', port: 4000, accessToken: 'per-http', enable: true }],
        wsServers: [{ host: 'localhost', port: 4001, accessToken: 'per-ws', enable: true, path: '/ws' }],
      },
    }, 'onebot_10001.json')
    assert.deepEqual(listUinConfigs(dir), [{ file: 'onebot_10001.json', uin: '10001' }])

    const explicit = readOneBotEndpoint(dir, '10001')
    assert.equal(explicit.httpUrl, 'http://localhost:4000')
    assert.equal(explicit.wsUrl, 'ws://localhost:4001/ws')
    assert.equal(explicit.httpToken, 'per-http')

    const scanned = readOneBotEndpoint(dir, '')
    assert.equal(scanned.uin, '10001')
    assert.equal(scanned.httpToken, 'per-http')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readOneBotEndpoint：没有配置文件时 found=false 且给出原因', () => {
  const dir = tempDir('sl-none-')
  try {
    makeInstall(dir)
    const result = readOneBotEndpoint(dir, '')
    assert.equal(result.found, false)
    assert.match(result.reason, /没找到/)
    assert.equal(result.httpUrl, '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readOneBotEndpoint：禁用（enabled/enable=false）的服务端不会被误用', () => {
  const dir = tempDir('sl-disabled-')
  try {
    makeInstall(dir)
    writeOneBotConfig(dir, {
      networks: {
        httpServers: [{ host: '127.0.0.1', port: 3000, enabled: false, accessToken: 'x' }],
        wsServers: [{ host: '127.0.0.1', port: 3001, enable: false, accessToken: 'y' }],
      },
    })
    const result = readOneBotEndpoint(dir, '')
    assert.equal(result.found, false)
    assert.equal(result.httpUrl, '')
    assert.match(result.reason, /没有启用/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readOneBotEndpoint：SnowLuma 2.x 的 enabled 字段被识别', () => {
  const dir = tempDir('sl-enabled-')
  try {
    makeInstall(dir)
    writeOneBotConfig(dir, {
      networks: {
        httpServers: [{ host: '127.0.0.1', port: 3000, enabled: true, accessToken: 'ok' }],
        wsServers: [{ host: '127.0.0.1', port: 3001, enabled: true }],
      },
    })
    const result = readOneBotEndpoint(dir, '')
    assert.equal(result.found, true)
    assert.equal(result.httpUrl, 'http://127.0.0.1:3000')
    assert.equal(result.httpToken, 'ok')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('safeUrl：遮掉 access_token 与 userinfo，非法 URL 原样截断', () => {
  assert.equal(safeUrl('ws://127.0.0.1:3001/?access_token=secret'), 'ws://127.0.0.1:3001/?access_token=***')
  assert.equal(safeUrl('http://user:pass@127.0.0.1:3000/'), 'http://127.0.0.1:3000/')
  assert.equal(safeUrl(''), '')
  assert.equal(safeUrl('not a url'), 'not a url')
})

test('resolveEndpoint：onebot 模式直接用配置地址，监控状态脱敏', () => {
  const cfg = {
    gateway: 'onebot',
    onebot: { wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000', wsToken: 't', httpToken: '', httpAuth: 'bearer' },
    snowluma: { dir: '', uin: '', autoDetect: false },
  }
  const resolved = resolveEndpoint(cfg)
  assert.equal(resolved.mode, 'onebot')
  assert.equal(resolved.source, 'onebot')
  assert.equal(resolved.endpoint.wsUrl, 'ws://127.0.0.1:3001')
  assert.equal(resolved.safe.wsConfigured, true)
  assert.equal(resolved.safe.httpConfigured, true)
  assert.equal(resolved.snowluma, null)
})

test('resolveEndpoint：snowluma 模式读取安装配置；读不到时回退手填地址并给原因', () => {
  const dir = tempDir('sl-resolve-')
  try {
    makeInstall(dir)
    writeOneBotConfig(dir, GLOBAL_ONEBOT)
    const cfg = {
      gateway: 'snowluma',
      botQQ: '10001',
      onebot: { wsUrl: '', httpUrl: '', wsToken: '', httpToken: '', httpAuth: 'header-token' },
      snowluma: { dir, uin: '', autoDetect: false },
    }
    const resolved = resolveEndpoint(cfg)
    assert.equal(resolved.source, 'snowluma')
    assert.equal(resolved.endpoint.httpUrl, 'http://127.0.0.1:3000')
    assert.equal(resolved.endpoint.httpAuth, 'header-token')
    assert.equal(resolved.snowluma.installed, true)
    assert.equal(resolved.snowluma.read.found, true)

    const fallbackCfg = {
      gateway: 'snowluma',
      onebot: { wsUrl: 'ws://127.0.0.1:9999', httpUrl: '', wsToken: '', httpToken: '', httpAuth: 'bearer' },
      snowluma: { dir: join(tmpdir(), 'missing-' + Date.now()), uin: '', autoDetect: false },
    }
    const fallback = resolveEndpoint(fallbackCfg)
    assert.equal(fallback.source, 'onebot')
    assert.equal(fallback.endpoint.wsUrl, 'ws://127.0.0.1:9999')
    assert.match(fallback.reason, /回退/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('detectGateway：只读快照不含明文 token', () => {
  const dir = tempDir('sl-gateway-')
  try {
    makeInstall(dir)
    writeOneBotConfig(dir, GLOBAL_ONEBOT)
    const cfg = { gateway: 'snowluma', onebot: { httpAuth: 'bearer' }, snowluma: { dir, uin: '', autoDetect: false } }
    const detected = detectGateway(cfg)
    assert.equal(detected.mode, 'snowluma')
    assert.equal(detected.source, 'snowluma')
    assert.equal(detected.endpoint.httpConfigured, true)
    assert.equal(detected.snowluma.installed, true)
    const json = JSON.stringify(detected)
    assert.equal(json.includes('http-token-abc'), false)
    assert.equal(json.includes('ws-token-xyz'), false)
    assert.match(detected.downloadPage, /SnowLuma/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
