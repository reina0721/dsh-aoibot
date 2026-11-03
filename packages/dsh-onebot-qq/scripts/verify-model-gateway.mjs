// 独立模型协议连通测试（不需要 DSH）。
// 用法：
//   $env:OPENCODE_GO_API_KEY = '...'
//   node scripts/verify-model-gateway.mjs
// key 只从环境变量读取，不写盘、不打印。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createModelGateway } from '../src/model/gateway.js'

const key = process.env.OPENCODE_GO_API_KEY || ''
const out = { ok: false, checks: [], skipped: [], live: {} }
const dir = mkdtempSync(join(tmpdir(), 'dsh-model-verify-'))
const gw = createModelGateway({ dataRoot: dir, env: process.env, logger: { child: () => ({ debug() {}, info() {}, warn() {} }) } })

function check(name, ok, detail = '') {
  out.checks.push({ name, ok: Boolean(ok), detail: String(detail || '').slice(0, 500) })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`)
}

try {
  check('registry/presets', gw.list().presets.length >= 10, `presets=${gw.list().presets.length}`)
  check('registry/protocols', gw.list().protocols.length >= 5, `protocols=${gw.list().protocols.length}`)

  // 公开发现不需要 key。
  try {
    const openrouter = await gw.discover('openrouter')
    check('discovery/OpenRouter', openrouter.models.length > 10, `models=${openrouter.models.length}`)
  } catch (error) {
    // 没配置 OpenRouter provider 时先建一个临时 provider。
    gw.saveProvider({ id: 'openrouter', preset: 'openrouter', name: 'OpenRouter', models: [] })
    const openrouter = await gw.discover('openrouter')
    check('discovery/OpenRouter', openrouter.models.length > 10, `models=${openrouter.models.length}`)
  }
  gw.saveProvider({ id: 'commandcode', preset: 'commandcode', name: 'Command Code', models: [] })
  try {
    const cc = await gw.discover('commandcode')
    check('discovery/CommandCode', cc.models.length > 10, `models=${cc.models.length}; note=supported_endpoints filtered`)
  } catch (error) {
    check('discovery/CommandCode', false, error.message)
  }

  if (!key) {
    out.skipped.push('OPENCODE_GO_API_KEY 未设置，跳过 OpenCode 真实调用')
    check('OPENCODE_GO_API_KEY', false, 'missing (live OpenCode checks skipped)')
  } else {
    gw.saveProvider({ id: 'opencode-openai', preset: 'opencode-go', name: 'OpenCode Go OpenAI', models: [{ id: 'deepseek-v4.1-flash' }] })
    const openaiStream = await gw.test({ provider: 'opencode-openai', model: 'deepseek-v4.1-flash' })
    check('OpenCode/OpenAI/stream', openaiStream.ok, `${openaiStream.protocol || ''} ${openaiStream.latencyMs || 0}ms ${openaiStream.code || ''}`)
    out.live.openai = { ok: openaiStream.ok, latencyMs: openaiStream.latencyMs, usage: openaiStream.usage, previewLength: String(openaiStream.textPreview || '').length }

    gw.saveProvider({ id: 'opencode-openai-ns', preset: 'opencode-go', name: 'OpenCode Go OpenAI NS', stream: false, models: [{ id: 'deepseek-v4.1-flash' }] })
    const nonStream = await gw.complete({ provider: 'opencode-openai-ns', model: 'deepseek-v4.1-flash', system: 'Return only OK.', messages: [{ role: 'user', content: 'Reply with exactly: OK' }], maxTokens: 64 })
    check('OpenCode/OpenAI/non-stream', Boolean(nonStream.text?.trim()), `finish=${nonStream.finish?.kind || ''}`)
    out.live.openaiNonStream = { ok: Boolean(nonStream.text?.trim()), usage: nonStream.usage }

    gw.saveProvider({ id: 'opencode-anthropic', preset: 'opencode-go-anthropic', name: 'OpenCode Go Anthropic', models: [{ id: 'qwen3.8-flash' }] })
    const anthropicResult = await gw.test({ provider: 'opencode-anthropic', model: 'qwen3.8-flash' })
    check('OpenCode/Anthropic/stream', anthropicResult.ok, `${anthropicResult.protocol || ''} ${anthropicResult.latencyMs || 0}ms ${anthropicResult.code || ''}`)
    out.live.anthropic = { ok: anthropicResult.ok, latencyMs: anthropicResult.latencyMs, usage: anthropicResult.usage, previewLength: String(anthropicResult.textPreview || '').length }

    const discovered = await gw.discover('opencode-openai')
    check('OpenCode/discovery', discovered.models.length > 5, `models=${discovered.models.length}`)
    out.live.discovery = discovered.models.length
  }

  out.ok = out.checks.every((item) => item.ok || /skipped/.test(item.detail))
  console.log(JSON.stringify(out, null, 2))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

if (!out.ok) process.exitCode = 1
