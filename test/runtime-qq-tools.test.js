import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createQqTools } from '../src/runtime/qq-tools.js'
import { createAgentRuntime } from '../src/runtime/agent.js'

function toolMap(options) {
  return new Map(createQqTools(options).map((tool) => [tool.name, tool]))
}

test('qq tools：schema 完整，动作只使用当前聊天作用域', async () => {
  const delivered = []
  const calls = []
  const tools = toolMap({
    chat: { chatType: 'private', chatId: '10001', senderId: '10001' },
    outbound: { async deliver(value) { delivered.push(value); return { ok: true, messageId: 'm1' } } },
    gateway: { actions: { async sendLike(...args) { calls.push(['like', ...args]) }, async friendPoke(...args) { calls.push(['poke', ...args]) } } },
  })
  assert.equal(tools.size, 3)
  for (const tool of tools.values()) {
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.parameters.additionalProperties, false)
    assert.ok(Array.isArray(tool.parameters.required))
    assert.doesNotMatch(JSON.stringify(tool.parameters), /minLength|maxLength|minimum|maximum/)
    assert.equal(tool.output.schema.type, 'object')
    assert.deepEqual(tool.output.render({}, { ok: true }), [{ type: 'text', text: '{"ok":true}' }])
  }
  await tools.get('qq_send_text').execute({ text: '额外消息' }, {})
  assert.deepEqual(delivered[0], { chatType: 'private', chatId: '10001', segments: [{ type: 'text', data: { text: '额外消息' } }], source: 'agent-tool' })
  await tools.get('qq_like_user').execute({ times: 3 }, {})
  await tools.get('qq_poke_user').execute({}, {})
  assert.deepEqual(calls, [['like', '10001', 3], ['poke', '10001']])
})

function runtimeEnv({ throwRegister = false } = {}) {
  const registered = []
  let disposed = 0
  const listeners = new Set()
  let agent
  const workspace = { id: 'w1', path: '/tmp/dsh-bot-test-workspace' }
  const ctx = {
    get(name) {
      if (name === 'workspaceRegistry') return { list: () => [workspace], create: async () => workspace }
      if (name === 'agents') return { get: () => agent }
      if (name === 'sessionController') return { create: async () => ({ sessionId: 's1' }), resolveAgent: async () => ({ agent }), rename: async () => {} }
    },
    on(name, fn) { if (name === 'session/event') listeners.add(fn); return () => listeners.delete(fn) },
  }
  agent = {
    session: { id: 's1' },
    ctx: {
      systemPrompt: { context: () => () => {} },
      tools: { register(tool) { if (throwRegister) throw new Error('boom'); registered.push(tool); return () => { disposed += 1 } } },
    },
    async followup() {
      queueMicrotask(() => {
        for (const fn of listeners) {
          fn(agent.session, { type: 'assistant/message', turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })
          fn(agent.session, { type: 'turn/end', turn: 1, reason: { kind: 'stop' } })
        }
      })
    },
    steer() {},
  }
  return { ctx, registered, disposed: () => disposed }
}

test('runtime：只给 full/private 注册三个工具，注册失败隔离，dispose 移除工具', async () => {
  for (const [turn, expected] of [
    [{ chatType: 'private', chatId: '10001', senderId: '10001' }, 3],
    [{ chatType: 'private', chatId: '10002', senderId: '10002' }, 0],
    [{ chatType: 'group', chatId: '20001', senderId: '10001' }, 0],
  ]) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-runtime-tools-'))
    const env = runtimeEnv()
    const runtime = createAgentRuntime({ ctx: env.ctx, dataRoot: dir, getConfig: () => ({ access: { ownerQQ: '10001' }, runtime: { engine: 'agent', workspaceDir: '/tmp/dsh-bot-test-workspace', replyTimeoutMs: 5000 } }) })
    const result = await runtime.compose({ turn, system: '', user: 'hi' })
    assert.equal(result.ok, true)
    assert.equal(env.registered.length, expected)
    runtime.dispose()
    assert.equal(env.disposed(), expected)
    rmSync(dir, { recursive: true, force: true })
  }
  const dir = mkdtempSync(join(tmpdir(), 'dsh-runtime-tools-fail-'))
  const env = runtimeEnv({ throwRegister: true })
  const runtime = createAgentRuntime({ ctx: env.ctx, dataRoot: dir, getConfig: () => ({ access: { ownerQQ: '10001' }, runtime: { engine: 'agent', workspaceDir: '/tmp/dsh-bot-test-workspace', replyTimeoutMs: 5000 } }) })
  assert.equal((await runtime.compose({ turn: { chatType: 'private', chatId: '10001', senderId: '10001' }, system: '', user: 'hi' })).ok, true)
  runtime.dispose()
  rmSync(dir, { recursive: true, force: true })
})
