import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanText, redactText, guardSegments, createLeakGuard, MAX_TEXT_LENGTH } from '../src/core/leak-guard.js'
import { normalizeConfig } from '../src/core/config.js'

const key = 'sk-' + 'aB3_'.repeat(12)
const text = (value) => ({ type: 'text', data: { text: value } })
const fixtures = [
  ['openai', key],
  ...'pousr'.split('').map((prefix) => ['github', `gh${prefix}_` + 'a'.repeat(36)]),
  ['aws', 'AKIA' + 'A1'.repeat(8)],
  ['bearer', 'Authorization: bEaReR ' + 'Ab1_-.+/'.repeat(4) + '=='],
  ['private_key', '-----BEGIN RSA PRIVATE KEY-----\nABC123\n-----END RSA PRIVATE KEY-----'],
  ['private_key', '-----BEGIN PRIVATE KEY-----\nABC123\n-----END PRIVATE KEY-----'],
  ['private_key', '-----BEGIN EC PRIVATE KEY-----\nABC123\n-----END EC PRIVATE KEY-----'],
  ['api_key', 'api_key=' + 'a'.repeat(16)],
  ['api_key', 'apiKey: "' + 'a!@#$%^&*()_+=-?'.repeat(2) + '"'],
  ['api_key', '"apiKey": "' + 'a'.repeat(32) + '"'],
]

test('leak guard: all high-confidence patterns return only clean text and summaries', () => {
  for (const [kind, secret] of fixtures) {
    const result = scanText(`before ${secret} after`)
    assert.equal(result.matched, true, kind)
    assert.deepEqual(result.detections, [{ kind, count: 1 }])
    assert.ok(result.clean.includes('[REDACTED]'))
    assert.ok(!JSON.stringify(result).includes(secret))
    assert.equal(redactText(`before ${secret} after`, []), result.clean)
  }
})

test('leak guard: normal text and short examples remain unchanged', () => {
  for (const value of ['', '你好，明天见。', 'sk-example ghp_example AKIA api_key=short apiKey: 123456789012345', 'Bearer example', 'OPENAI_API_KEY is an environment variable name']) {
    assert.deepEqual(scanText(value), { clean: value, detections: [], matched: false })
  }
})

test('leak guard: repeated/overlapping matches count actual replacements', () => {
  const input = `${key} ${key} api_key=${key} Bearer ${key}`
  const result = scanText(input)
  assert.equal(result.clean, Array(4).fill('[REDACTED]').join(' '))
  assert.deepEqual(result.detections, [{ kind: 'openai', count: 2 }, { kind: 'api_key', count: 1 }, { kind: 'bearer', count: 1 }])
  assert.equal(scanText('-----BEGIN PRIVATE KEY-----\n' + key + '\n-----END PRIVATE KEY-----').clean, '[REDACTED]')
  // A match beginning before a PEM header must not leave the PEM body exposed.
  assert.equal(scanText('api_key=' + 'a'.repeat(20) + '-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----').clean, '[REDACTED]')
})

test('leak guard: non-text segments stay identical; no mutation; block returns no body', () => {
  const image = { type: 'image', data: { file: 'base64://' + key } }
  const input = [text(key), image, null, { type: 'record', data: { file: key } }]
  const result = guardSegments(input)
  assert.equal(result.segments[0].data.text, '[REDACTED]')
  assert.equal(result.segments[1], image)
  assert.equal(result.segments[3], input[3])
  assert.equal(input[0].data.text, key)
  assert.equal(result.blocked, false)
  const blocked = guardSegments(input, { action: 'block' })
  assert.equal(blocked.blocked, true)
  assert.deepEqual(blocked.segments, [])
  assert.ok(!JSON.stringify(blocked).includes(key))
  assert.equal(guardSegments([text('hello')], { action: 'block' }).blocked, false)
})

test('leak guard: length cap fails closed for whole text and aggregate segments', () => {
  assert.equal(scanText('x'.repeat(MAX_TEXT_LENGTH)).matched, false)
  const huge = 'x'.repeat(MAX_TEXT_LENGTH) + key
  assert.deepEqual(scanText(huge), { clean: '[REDACTED]', detections: [{ kind: 'input_too_long', count: 1 }], matched: true })
  assert.equal(guardSegments([text(huge)], { action: 'block' }).blocked, true)
  const aggregate = guardSegments([text('x'.repeat(60000)), text('x'.repeat(60000))])
  assert.deepEqual(aggregate.segments.map((segment) => segment.data.text), ['[REDACTED]', '[REDACTED]'])
  assert.deepEqual(aggregate.detections, [{ kind: 'input_too_long', count: 2 }])
  assert.equal(scanText('-----BEGIN PRIVATE KEY-----\n' + key).clean, '[REDACTED]')
  // Many incomplete PEM headers and generic labels stay within the bounded scan.
  assert.equal(scanText('-----BEGIN PRIVATE KEY-----'.repeat(3000)).clean, '[REDACTED]')
  assert.equal(scanText('api_key '.repeat(10000)).matched, false)
})

test('leak guard: validation errors never echo untrusted arguments', () => {
  for (const run of [() => guardSegments([text(key)], { action: key }), () => scanText({ toString() { throw new Error(key) } }), () => guardSegments(key), () => guardSegments([{ type: 'text', data: { text: { secret: key } } }])]) {
    assert.throws(run, (error) => !String(error).includes(key) && /^LEAK_GUARD_/.test(error.message))
  }
})

test('leak guard: live config, safe defaults/fallback, disabled pass-through, categories-only logs', () => {
  let config = {}, fail = false
  const logs = []
  const guard = createLeakGuard({ getConfig: () => { if (fail) throw new Error(key); return config }, logger: { warn: (...args) => logs.push(args) } })
  assert.equal(guard.enabled, true)
  assert.equal(guard.action, 'redact')
  assert.equal(guard.scan(key).clean, '[REDACTED]')
  assert.equal(guard.guard([text(key)]).segments[0].data.text, '[REDACTED]')
  config = { security: { leakGuard: { enabled: true, action: 'block' } } }
  assert.equal(guard.guard([text(key)]).blocked, true)
  config.security.leakGuard.enabled = false
  const segments = [text(key)]
  assert.equal(guard.guard(segments).segments, segments)
  assert.equal(guard.scan(key).clean, key)
  assert.ok(!JSON.stringify(logs).includes(key))
  assert.deepEqual(logs[0], ['leak_guard', [{ kind: 'openai', count: 1 }]])
  fail = true
  assert.equal(guard.guard(segments).segments[0].data.text, '[REDACTED]')
})

test('leak guard: config normalization defaults and valid/invalid settings', () => {
  assert.deepEqual(normalizeConfig({}).config.security.leakGuard, { enabled: true, action: 'redact' })
  assert.deepEqual(normalizeConfig({ security: { leakGuard: { enabled: false, action: 'block' } } }).config.security.leakGuard, { enabled: false, action: 'block' })
  const result = normalizeConfig({ security: { leakGuard: { enabled: 'bad', action: key } } })
  assert.deepEqual(result.config.security.leakGuard, { enabled: true, action: 'redact' })
  assert.ok(!JSON.stringify(result).includes(key))
})
