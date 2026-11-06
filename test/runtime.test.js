import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAgentRuntime, PRIVATE_PRESET, SOCIAL_PRESET } from '../src/runtime/agent.js'

function fakeEnv({ reply = '你好呀', emitText = true, delay = 0, onFollowup = null } = {}) {
  const listeners = new Set()
  const agents = new Map()
  const created = []
  const workspaces = []
  const contexts = new Map()
  const inbox = []
  let seq = 0

  const registryAgents = { get: (id) => agents.get(id) || undefined }
  const registry = {
    list: () => workspaces,
    async create(path, title) {
      const ws = { id: `ws-${workspaces.length + 1}`, path, title }
      workspaces.push(ws)
      return ws
    },
  }

  function emit(session, event) {
    for (const fn of listeners) fn(session, event)
  }

  function makeAgent(sessionId) {
    const agent = {
      id: sessionId,
      session: { id: sessionId, append() {} },
      ctx: {
        systemPrompt: {
          context(spec) {
            contexts.set(sessionId, spec)
            return () => contexts.delete(sessionId)
          },
        },
        tools: { register: () => () => {} },
      },
      followup(message) {
        inbox.push({ sessionId, message })
        if (onFollowup) {
          onFollowup({ agent, message, emit })
          return
        }
        setTimeout(() => {
          emit(agent.session, { type: 'turn/start', turn: 1 })
          if (emitText) {
            emit(agent.session, {
              type: 'assistant/message', turn: 1, step: 1,
              message: { role: 'assistant', content: [{ type: 'text', text: reply }], source: { kind: 'model' } },
            })
          }
          emit(agent.session, { type: 'turn/end', turn: 1, reason: { kind: 'stop' } })
        }, delay)
      },
      steer() {},
    }
    agents.set(sessionId, agent)
    return agent
  }

  const controller = {
    async create({ workspaceId, agentPreset }) {
      const sessionId = `session-${++seq}`
      created.push({ sessionId, workspaceId, agentPreset })
      makeAgent(sessionId)
      return { sessionId }
    },
    async resolveAgent(sessionId) {
      const agent = agents.get(sessionId)
      return agent ? { agent } : { error: { code: 'NOT_FOUND', message: 'missing' } }
    },
    async rename() {},
  }

  const ctx = {
    get(name) {
      if (name === 'sessionController') return controller
      if (name === 'workspaceRegistry') return registry
      if (name === 'agents') return registryAgents
      if (name === 'systemPrompt') return undefined
      return undefined
    },
    on(name, fn) {
      if (name !== 'session/event') return () => {}
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }

  return { ctx, created, workspaces, contexts, inbox, agents, controller, registry, emit }
}

function config(extra = {}) {
  return {
    botQQ: '999999',
    access: { mode: 'allowlist', ownerQQ: '10001', ownerName: '主人', private: [], groups: [], auditSize: 100 },
    runtime: { engine: 'agent', workspaceDir: '', replyTimeoutMs: 1000 },
    cognition: { dryRun: false },
    ...extra,
  }
}

function withRuntime(t, { envOptions, cfg } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-runtime-'))
  const env = fakeEnv(envOptions)
  const runtime = createAgentRuntime({
    ctx: env.ctx,
    getConfig: () => cfg || config(),
    dataRoot: dir,
    logger: null,
  })
  t.after(() => {
    runtime.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  return { runtime, env, dir }
}

test('runtime：engine=oneshot 时不可用，compose 直接返回 RUNTIME_INACTIVE', async (t) => {
  const { runtime } = withRuntime(t, { cfg: config({ runtime: { engine: 'oneshot' } }) })
  assert.equal(runtime.engine(), 'oneshot')
  assert.equal(runtime.active(), false)
  const result = await runtime.compose({ turn: { chatType: 'private', chatId: '10001', senderId: '10001' }, system: 's', user: 'u' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'RUNTIME_INACTIVE')
})

test('runtime：agent 引擎创建 Session、挂上下文、取最终回复并复用会话', async (t) => {
  const { runtime, env } = withRuntime(t)
  assert.equal(runtime.available(), true)
  assert.equal(runtime.active(), true)
  const turn = { chatType: 'private', chatId: '10001', senderId: '10001' }
  const first = await runtime.compose({ turn, system: '认知上下文-A', user: '在吗' })
  assert.equal(first.ok, true)
  assert.equal(first.text, '你好呀')
  assert.equal(env.created.length, 1)
  assert.equal(env.created[0].agentPreset, PRIVATE_PRESET)
  assert.ok(env.workspaces.length >= 1)
  assert.equal(env.inbox.length, 1)
  assert.equal(env.inbox[0].message.role, 'user')
  assert.ok(env.contexts.has(first.sessionId), '应挂载 systemPrompt.context')
  const contextSpec = env.contexts.get(first.sessionId)
  assert.equal(contextSpec.text(), '认知上下文-A')

  const second = await runtime.compose({ turn, system: '认知上下文-B', user: '再问一句' })
  assert.equal(second.ok, true)
  assert.equal(second.sessionId, first.sessionId)
  assert.equal(env.created.length, 1, '同一聊天复用 Session')
  assert.equal(env.contexts.get(first.sessionId).text(), '认知上下文-B')

  const summary = runtime.summary()
  assert.equal(summary.active, true)
  assert.equal(summary.sessions, 1)
  assert.equal(summary.stats.composes, 2)
  assert.equal(summary.stats.ok, 2)
})

test('runtime：主人私聊用 private preset，群聊与他人私聊用 social preset', async (t) => {
  const { runtime, env } = withRuntime(t)
  await runtime.compose({ turn: { chatType: 'private', chatId: '10002', senderId: '10002' }, system: 's', user: 'u' })
  await runtime.compose({ turn: { chatType: 'group', chatId: '20001', senderId: '10001' }, system: 's', user: 'u' })
  assert.deepEqual(env.created.map((item) => item.agentPreset), [SOCIAL_PRESET, SOCIAL_PRESET])
  assert.equal(env.created.length, 2)

  const { runtime: ownerRuntime, env: ownerEnv } = withRuntime(t)
  await ownerRuntime.compose({ turn: { chatType: 'private', chatId: '10001', senderId: '10001' }, system: 's', user: 'u' })
  assert.equal(ownerEnv.created[0].agentPreset, PRIVATE_PRESET)
})

test('runtime：工具调用中间文本不作为回复，最终 assistant 文本生效', async (t) => {
  const envOptions = {
    onFollowup({ agent, emit }) {
      setTimeout(() => {
        emit(agent.session, { type: 'turn/start', turn: 1 })
        emit(agent.session, {
          type: 'assistant/message', turn: 1, step: 1,
          message: { role: 'assistant', content: [{ type: 'text', text: '我先查一下' }, { type: 'tool-call', id: 'c1', name: 'web_fetch', arguments: '{}' }], source: { kind: 'model' } },
        })
        emit(agent.session, {
          type: 'assistant/message', turn: 1, step: 2,
          message: { role: 'assistant', content: [{ type: 'text', text: '查到了：是 42。' }], source: { kind: 'model' } },
        })
        emit(agent.session, { type: 'turn/end', turn: 1, reason: { kind: 'stop' } })
      }, 0)
    },
  }
  const { runtime } = withRuntime(t, { envOptions })
  const result = await runtime.compose({ turn: { chatType: 'group', chatId: '1', senderId: '2' }, system: 's', user: 'u' })
  assert.equal(result.ok, true)
  assert.equal(result.text, '查到了：是 42。')
})

test('runtime：无最终文本返回 EMPTY_REPLY；超时返回 TIMEOUT', async (t) => {
  const { runtime: emptyRuntime } = withRuntime(t, { envOptions: { emitText: false } })
  const empty = await emptyRuntime.compose({ turn: { chatType: 'group', chatId: '1', senderId: '2' }, system: 's', user: 'u' })
  assert.equal(empty.ok, false)
  assert.equal(empty.error, 'EMPTY_REPLY')

  const { runtime: slowRuntime } = withRuntime(t, { envOptions: { onFollowup() {} } })
  const slow = await slowRuntime.compose({ turn: { chatType: 'group', chatId: '1', senderId: '2' }, system: 's', user: 'u' })
  assert.equal(slow.ok, false)
  assert.equal(slow.error, 'TIMEOUT')
})

test('runtime：具体模型不可用（缺少服务）时 active=false，compose 回退', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-runtime-off-'))
  const runtime = createAgentRuntime({
    ctx: { get: () => undefined, on: () => () => {} },
    getConfig: () => config(),
    dataRoot: dir,
  })
  t.after(() => { runtime.dispose(); rmSync(dir, { recursive: true, force: true }) })
  assert.equal(runtime.available(), false)
  assert.equal(runtime.active(), false)
  const result = await runtime.compose({ turn: { chatType: 'private', chatId: '1', senderId: '1' }, system: 's', user: 'u' })
  assert.equal(result.error, 'RUNTIME_INACTIVE')
})

test('runtime：并发 compose 在同一 Session 上串行，不互相抢 pending', async (t) => {
  const { runtime, env } = withRuntime(t)
  const turn = { chatType: 'group', chatId: '9', senderId: '2' }
  const [a, b] = await Promise.all([
    runtime.compose({ turn, system: 's1', user: 'u1' }),
    runtime.compose({ turn, system: 's2', user: 'u2' }),
  ])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  assert.equal(env.created.length, 1)
  assert.equal(env.inbox.length, 2)
  assert.equal(env.inbox[0].message.content[0].text, 'u1')
  assert.equal(env.inbox[1].message.content[0].text, 'u2')
})

import { composeReply, buildComposePrompt } from '../src/cognition/analysis.js'

test('composeReply：runtime 可用时优先 Agent，失败回退一次性 LLM', async () => {
  const llm = {
    calls: [],
    async complete(payload) {
      this.calls.push(payload)
      return { ok: true, text: 'LLM 回复', tokens: 12, route: { provider: 'p', model: 'm' } }
    },
  }
  const turn = { chatType: 'private', chatId: '10001', text: '你好', senderId: '10001' }
  const base = { turn, person: { displayName: '小明' }, persona: { profile: { displayName: '小鱼' }, style: { verbosity: 0.5 } }, decision: { action: 'reply' }, analysis: { intent: 'chat' }, llm, config: { cognition: { llm: { temperature: 0.7 } } } }

  const agentRuntime = { active: () => true, compose: async () => ({ ok: true, text: 'Agent 回复', sessionId: 's1' }) }
  const viaAgent = await composeReply({ ...base, runtime: agentRuntime })
  assert.equal(viaAgent.ok, true)
  assert.equal(viaAgent.text, 'Agent 回复')
  assert.equal(viaAgent.route.kind, 'agent')
  assert.equal(llm.calls.length, 0)

  const failingRuntime = { active: () => true, compose: async () => ({ ok: false, error: 'TIMEOUT' }) }
  const viaFallback = await composeReply({ ...base, runtime: failingRuntime })
  assert.equal(viaFallback.ok, true)
  assert.equal(viaFallback.text, 'LLM 回复')
  assert.equal(viaFallback.runtimeError, 'TIMEOUT')
  assert.equal(llm.calls.length, 1)

  const inactive = await composeReply({ ...base, runtime: { active: () => false } })
  assert.equal(inactive.ok, true)
  assert.equal(inactive.text, 'LLM 回复')
  assert.equal(llm.calls.length, 2)
})

test('buildComposePrompt：人格、记忆、对方消息与内部机制禁令都在 prompt 里', () => {
  const prompt = buildComposePrompt({
    turn: { chatType: 'group', text: '今天吃什么' },
    person: { displayName: '小红' },
    persona: { profile: { displayName: '小鱼', personality: '温和' }, style: { verbosity: 0.5 } },
    memories: [{ memory: { summary: '她喜欢面食' } }],
    decision: { action: 'reply', reason: '自然回应' },
    analysis: { intent: 'chat', replyGoal: '自然回应' },
  })
  assert.match(prompt.system, /小鱼/)
  assert.match(prompt.system, /她喜欢面食/)
  assert.match(prompt.user, /小红/)
  assert.match(prompt.user, /今天吃什么/)
  assert.match(prompt.user, /不要提及/)
})
