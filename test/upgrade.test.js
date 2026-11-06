import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUpgradeService } from '../src/ops/upgrade.js'
import { DEFAULTS, CONFIG_GROUPS, normalizeConfig } from '../src/core/config.js'

const release = (tag, extra = {}) => ({ tag_name: tag, draft: false, prerelease: tag.includes('-'), published_at: '2026-11-06T00:00:00Z', html_url: `https://github.com/reina0721/dsh-bot/releases/tag/${tag}`, ...extra })
function setup({ currentVersion = '0.10.0', releases = [release('v0.11.0')], options = {}, fetcher } = {}) {
  let calls = []
  const config = { ops: { upgrade: { enabled: true, ...options } } }
  const service = createUpgradeService({
    getConfig: () => config, currentVersion,
    fetchImpl: async (...args) => { calls.push(args); return fetcher ? fetcher(...args) : { ok: true, json: async () => releases } },
  })
  return { service, config, calls }
}

test('upgrade: default disabled status and check never use network', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('network forbidden') }
  try {
    const service = createUpgradeService({ getConfig: () => ({}), currentVersion: '0.10.0' })
    assert.deepEqual(service.status(), { enabled: false, channel: 'stable', repo: 'reina0721/dsh-bot', current: '0.10.0', cached: null, checkedAt: null })
    await assert.rejects(service.check(), /升级检查未启用/)
    service.dispose()
    assert.equal(calls, 0)
  } finally { globalThis.fetch = originalFetch }
})

test('upgrade: stable/beta filter drafts and select highest version among ten releases', async () => {
  const releases = [release('v2.0.0', { draft: true }), release('v0.12.0-beta.2'), release('v0.10.0'), release('v0.11.0')]
  const { service, calls, config } = setup({ releases })
  const stable = await service.check()
  assert.deepEqual(stable, { ok: true, enabled: true, channel: 'stable', current: '0.10.0', latest: 'v0.11.0', updateAvailable: true, publishedAt: '2026-11-06T00:00:00Z', url: 'https://github.com/reina0721/dsh-bot/releases/tag/v0.11.0' })
  assert.equal(calls[0][0], 'https://api.github.com/repos/reina0721/dsh-bot/releases?per_page=10')
  assert.match(calls[0][1].headers['user-agent'], /^dsh-bot\//)
  assert.equal(calls[0][1].headers.referer, 'https://github.com/reina0721/dsh-bot')
  assert.ok(calls[0][1].signal instanceof AbortSignal)
  assert.equal(calls[0][1].headers.authorization, undefined)
  config.ops.upgrade.channel = 'beta'
  assert.equal(service.status().cached, null)
  assert.equal(service.status().checkedAt, null)
  const beta = await service.check()
  assert.equal(beta.latest, 'v0.12.0-beta.2')
  assert.equal(beta.channel, 'beta')
  assert.equal(calls.length, 2)
})

test('upgrade: numeric components, v-prefix and prerelease ordering', async () => {
  const cases = [
    ['v1.2.3', '1.2.3', false], ['1.2.3', 'v1.2.2', false],
    ['1.9.9', 'v1.10.0', true], ['1.99.99', '2.0.0', true], ['1.2.3', '1.2.4', true],
    ['1.2.3-beta.2', 'v1.2.3-beta.10', true], ['1.2.3-beta.10', '1.2.3-beta.2', false],
    ['1.2.3-beta', '1.2.3-beta.1', true], ['1.2.3-1', '1.2.3-alpha', true],
    ['1.2.3-alpha', '1.2.3-beta', true], ['1.2.3-rc.1', '1.2.3', true],
    ['1.2.3', '1.2.3-rc.1', false],
  ]
  for (const [currentVersion, tag, expected] of cases) {
    const { service } = setup({ currentVersion, releases: [release(tag)], options: { channel: 'beta' } })
    assert.equal((await service.check()).updateAvailable, expected, `${currentVersion} → ${tag}`)
  }
})

test('upgrade: cache/force/expiry, notes bounded, configuration scopes cache, copies protect cache', async () => {
  const { service, config, calls } = setup({ releases: [release('v0.11.0', { body: 'a'.repeat(2100) })] })
  const result = await service.check()
  assert.equal(result.notes.length, 2000)
  const first = service.status()
  assert.ok(Number.isFinite(Date.parse(first.checkedAt)))
  result.latest = 'mutated'
  first.cached.latest = 'mutated'
  assert.equal((await service.check()).latest, 'v0.11.0')
  service.status()
  assert.equal(calls.length, 1)
  await service.check({ force: true })
  assert.equal(calls.length, 2)
  config.ops.upgrade.cacheMinutes = 0
  await service.check()
  assert.equal(calls.length, 3)
  config.ops.upgrade.cacheMinutes = 60
  config.ops.upgrade.repo = 'other/project'
  assert.equal(service.status().cached, null)
  await service.check()
  assert.equal(calls.length, 4)
  assert.match(calls[3][0], /repos\/other\/project\//)
  config.ops.upgrade.enabled = false
  await assert.rejects(service.check(), /升级检查未启用/)
  assert.equal(calls.length, 4)
})

test('upgrade: HTTP, fetch, invalid response, empty release and bad version fail honestly without caching', async () => {
  const cases = [
    [{ fetcher: async () => ({ ok: false, status: 403 }) }, /GitHub HTTP 403/],
    [{ fetcher: async () => { throw new Error('offline') } }, /offline/],
    [{ fetcher: async () => { throw new DOMException('timeout', 'TimeoutError') } }, /超时/],
    [{ fetcher: async () => ({ ok: true, json: async () => { throw new Error('bad JSON') } }) }, /bad JSON/],
    [{ releases: {} }, /响应格式不合法/],
    [{ releases: [] }, /未找到可用 release/],
    [{ releases: [release('v1.0.0-beta.1')] }, /未找到可用 release/],
    [{ releases: [release('next')] }, /版本号不合法/],
    [{ releases: [release('v1.2.3.4')] }, /版本号不合法/],
    [{ releases: [release('1.2.3-', { prerelease: false })] }, /版本号不合法/],
    [{ currentVersion: 'invalid' }, /版本号不合法/],
    [{ options: { repo: '../project' } }, /仓库不合法/],
    [{ options: { repo: 'owner/..' } }, /仓库不合法/],
    [{ options: { channel: 'nightly' } }, /通道不合法/],
    [{ options: { repo: ['owner/project'] } }, /仓库不合法/],
  ]
  for (const [options, expected] of cases) {
    const { service } = setup(options)
    await assert.rejects(service.check(), expected)
    assert.equal(service.status().cached, null)
    assert.equal(service.status().checkedAt, null)
  }
  const { service, calls } = setup()
  await assert.rejects(service.check({ force: 'yes' }), /force 必须是 boolean/)
  assert.equal(calls.length, 0)
})

test('upgrade: timeout aborts an in-flight injected request', async () => {
  const { service } = setup({ options: { timeoutMs: 5 }, fetcher: async (_, { signal }) => new Promise((resolve, reject) => {
    // Keep the loop alive: AbortSignal.timeout uses an unref'ed timer.
    const timer = setTimeout(resolve, 1000)
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
  }) })
  await assert.rejects(service.check(), /超时/)
})

test('upgrade: config defaults, panel fields and normalization survive config saves', () => {
  assert.deepEqual(normalizeConfig({}).config.ops.upgrade, DEFAULTS.ops.upgrade)
  const raw = { enabled: true, channel: 'beta', repo: 'owner/project', timeoutMs: 3000, cacheMinutes: 5 }
  assert.deepEqual(normalizeConfig({ ops: { upgrade: raw } }).config.ops.upgrade, raw)
  const cfg = normalizeConfig({ ops: { upgrade: { channel: 'nightly', repo: 'https://evil.example/path', timeoutMs: -1, cacheMinutes: -5 } } }).config.ops.upgrade
  assert.equal(normalizeConfig({ ops: { upgrade: { repo: ['owner/project'] } } }).config.ops.upgrade.repo, DEFAULTS.ops.upgrade.repo)
  assert.equal(cfg.channel, 'stable')
  assert.equal(cfg.repo, 'reina0721/dsh-bot')
  assert.equal(cfg.timeoutMs, 1000)
  assert.equal(cfg.cacheMinutes, 0)
  const paths = CONFIG_GROUPS.flatMap((group) => group.fields).map((field) => field.path)
  for (const name of Object.keys(raw)) assert.ok(paths.includes('ops.upgrade.' + name))
})
