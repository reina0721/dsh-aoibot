# 模型协议与模型网关（MODEL-GATEWAY）

> 版本：`dsh-onebot-qq@0.6.0`（模型层自 v0.5.0 起）。本文描述统一模型协议层、直连 provider、DSH 路由、密钥/安全边界、
> REST API、UI 与验证方式。实现代码：`packages/dsh-onebot-qq/src/model/`。

## 1. 为什么需要这一层

认知内核需要**语义分析与最终表达**，但不能把模型选择锁死在 GPT/Claude/DeepSeek 某一家，也不能只依赖
DSH 当前会话的模型路由。模型网关把「协议」与「厂商」分开：

- **协议**决定请求/响应的线格式：OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、
  Gemini generateContent、Ollama Chat。
- **provider** 决定端点、认证、header、模型列表、超时/重试和预设；同一协议可以接任意兼容网关。
- **路由**决定认知调用 DSH 还是直连，以及失败时如何回退。

长期人格/记忆/关系等状态仍在认知 SQLite；模型层只做请求/响应和连接健康，不持有认知状态。

## 2. 架构

```text
cognition pipeline
  -> cognition/llm.js
     -> DSH adapter          ctx.get('llm').stream()
     -> model gateway       src/model/gateway.js
          -> protocol adapter
             openai-completions
             openai-responses
             anthropic-messages
             gemini-generate-content
             ollama-chat
          -> HTTP/SSE/NDJSON + auth + timeout + retry + redaction
```

- `src/model/**` 不 import QQ 网关/认知模块；只依赖 Node 内置 `fetch`、配置、日志、redact。
- 宿主通过 `createModelGateway({ dataRoot, env })` 创建，注入 `createCognition({ models })` 和 routes。
- `ctx.provide('onebotModels', gateway)` 可供其它 DSH 插件复用。

## 3. 协议矩阵

| 协议 | 默认请求路径 | 认证 | 流格式 | 说明 |
|---|---|---|---|---|
| `openai-completions` | `{base}/chat/completions` | `Authorization: Bearer` | SSE `data:` | 覆盖 OpenAI、vLLM、LM Studio、多数中转站；可配 `max_tokens`/`max_completion_tokens` |
| `openai-responses` | `{base}/responses` | Bearer | SSE `response.*` | OpenAI Responses；Command Code 等也支持 |
| `anthropic-messages` | `{base}/v1/messages`（预设可覆盖 `/messages`） | 默认 `x-api-key` + `anthropic-version` | SSE `content_block_delta` | 官方 Claude 与 Anthropic 兼容代理 |
| `gemini-generate-content` | `{base}/models/{model}:generateContent` / `:streamGenerateContent?alt=sse` | `x-goog-api-key` | SSE JSON | 原生 Gemini，不是 OpenAI 兼容层 |
| `ollama-chat` | `{base}/api/chat` | 无 | NDJSON | 本地 Ollama |

所有适配器输出统一事件：

```js
{ type: 'text-delta', text }
{ type: 'reasoning-delta', text }
{ type: 'usage', usage: { input, output, total } }
{ type: 'finish', reason: { kind: 'stop'|'max-tokens'|'tool-calls'|'aborted'|'error', raw } }
```

`complete()` 汇总为：

```js
{ ok: true, text, reasoning, usage, finish, route, latencyMs }
```

只有可见 `text` 非空才算成功；只有 thinking/reasoning、空文本、bad JSON 都会降级，不伪造回复。

## 4. 内置预设

预设只填端点/协议/认证/header 默认值，**不绑定模型列表**；模型可自动发现或手动填写，且可覆盖所有字段。

| preset | protocol | base URL | 默认 env | 备注 |
|---|---|---|---|---|
| `openai` | openai-completions | `https://api.openai.com/v1` | `OPENAI_API_KEY` | 官方 |
| `openai-responses` | openai-responses | `https://api.openai.com/v1` | `OPENAI_API_KEY` | 官方 Responses |
| `anthropic` | anthropic-messages | `https://api.anthropic.com` | `ANTHROPIC_API_KEY` | 默认 x-api-key + version |
| `deepseek` | openai-completions | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` | 官方兼容端点 |
| `openrouter` | openai-completions | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | 可加 HTTP-Referer/X-Title |
| `opencode-go` | openai-completions | `https://opencode.ai/zen/go/v1` | `OPENCODE_GO_API_KEY`（fallback `OPENCODE_API_KEY`） | **必须**带 `x-opencode-session` |
| `opencode-go-anthropic` | anthropic-messages | `https://opencode.ai/zen/go` | 同上 | 默认 `x-api-key` + version + session |
| `commandcode` | openai-completions | `https://api.commandcode.ai/provider/v1` | `COMMAND_CODE_API_KEY`/`CMD_API_KEY` | Go 套餐无 API 权限（403） |
| `commandcode-anthropic` | anthropic-messages | 同上 | 同上 | Claude 模型走 `/messages` |
| `gemini` | gemini-generate-content | `https://generativelanguage.googleapis.com/v1beta` | `GEMINI_API_KEY`/`GOOGLE_API_KEY` | 原生 |
| `ollama` | ollama-chat | `http://127.0.0.1:11434` | 无 | 本地 |
| `custom` | 可选 | 空 | 空 | 任意兼容端点 |

端点事实来源（访问日期 2026-11-03）：

- OpenCode Zen/Go：<https://opencode.ai/docs/zen/>；
- Command Code Provider API：<https://commandcode.ai/docs/provider>；
- OpenRouter：<https://openrouter.ai/docs/quickstart>；
- OpenAI/Anthropic/Gemini/Ollama 官方 API 文档。

### 4.1 OpenCode Go 实测要点

- OpenAI 端点：`https://opencode.ai/zen/go/v1/chat/completions`；`Authorization: Bearer` + `x-opencode-session`。
- Anthropic 端点：`https://opencode.ai/zen/go/v1/messages`；`x-api-key` + `anthropic-version` + `x-opencode-session`。
- 两类端点缺 `x-opencode-session` 都返回 400 `MissingSessionID`；网关按会话自动生成。
- Go 套餐的 OpenAI/Anthropic 模型可用；实测 `deepseek-v4.1-flash`（OpenAI）与 `qwen3.8-flash`（Anthropic）
  均成功，包含非流式与 SSE 流式。
- 部分模型响应是 thinking-only（尤其 `max_tokens` 较小时）；网关不把 thinking 当可见回复，空文本返回
  `EMPTY_OUTPUT`，认知层不发送假回复。

### 4.2 Command Code 实测要点

- 端点：`https://api.commandcode.ai/provider/v1/chat/completions`、`/responses`、`/messages`、`/models`。
- OpenAI/Responses 用 Bearer；`/messages` 也接受 `x-api-key`。
- 模型列表公开；每个模型带 `supported_endpoints`，网关按当前 provider 协议过滤，避免把 Claude
  发到 `/chat/completions` 或把非 Anthropic 模型发到 `/messages`。
- **Go 套餐没有 API 权限**（403 `upgrade_required`）；需要 GOAT/Pro/Max/Team/Provider 等套餐。
- 本次没有 Command Code 的付费 key，因此做了公开模型发现与错误归一；聊天 completion 的 live 验证
  需要用户后续提供 key。

### 4.3 OpenRouter / Gemini / Ollama

- OpenRouter：`https://openrouter.ai/api/v1`，OpenAI 兼容；模型列表公开，聊天需要 key。
- Gemini：原生 `generateContent`，key 走 `x-goog-api-key`；没有内置模型列表的硬编码。
- Ollama：本地 `/api/chat`，NDJSON；无认证，可被自定义 base URL 指向局域网。

## 5. Provider 注册表

独立文件：`<dataDir>/models.json`（原子写 + `.bak`；不放进 `config.json`，因此 `/config` 不会返回密钥）。

```json
{
  "version": 1,
  "selected": { "provider": "opencode-go", "model": "deepseek-v4.1-flash" },
  "fallback": [{ "provider": "openai", "model": "..." }],
  "providers": [{
    "id": "opencode-go",
    "preset": "opencode-go",
    "name": "OpenCode Go",
    "protocol": "openai-completions",
    "baseUrl": "https://opencode.ai/zen/go/v1",
    "requestPath": "/chat/completions",
    "modelsPath": "/models",
    "auth": { "type": "bearer", "header": "Authorization", "prefix": "Bearer " },
    "apiKey": "",
    "apiKeyEnv": "OPENCODE_GO_API_KEY",
    "headers": {},
    "sessionHeader": "x-opencode-session",
    "models": [{ "id": "deepseek-v4.1-flash", "label": "DeepSeek V4.1 Flash" }],
    "timeoutMs": 45000,
    "stream": true,
    "maxRetries": 1,
    "enabled": true
  }]
}
```

- ID 规则：`[a-z0-9][a-z0-9._-]{0,63}`，创建后不可改。
- 密钥优先级：`apiKeyEnv` 环境变量 > `apiKeyEnvFallbacks` > 已保存 `apiKey`；都没有则 `NO_KEY`。
- 密钥字段只在本地文件；API 只返回 `hasApiKey`/`apiKeySource`/`apiKeyHint`（后四位）。
- `headers` 里的 `Authorization`/`api-key`/`token` 值在 API 返回时显示为 `***`，保存时 `***` 表示保持原值。
- 模型列表最多 500；provider 最多 32；headers 最多 50。

## 6. 认证与安全

- 认证模式：`bearer`、`x-api-key`、`header`（自定义名/前缀）、`none`。
- 默认 header：`content-type: application/json`；流式 `accept: text/event-stream`。
- 禁止 header：`host`、`content-length`、`connection`、`transfer-encoding`、`keep-alive`、
  `proxy-authorization`；拒绝 CRLF。
- `fetch` 使用 `redirect: 'manual'`：端点返回 3xx 直接报配置错误，不跨源转发认证头。
- 只允许 http/https；禁止 URL 内嵌用户名/密码；非 loopback 的 http 在文档/UI 给出警告。
- 超时：默认 provider 45s；可配 1s–180s；流式读取有总大小上限。
- 重试：仅网络/408/429/5xx；流式只在首个可见文本前重试；`Retry-After` 尊重；连续 3 次失败熔断 30s。
- 错误统一：`NO_KEY`、`AUTH`、`FORBIDDEN`、`RATE_LIMIT`、`TIMEOUT`、`NETWORK`、`HTTP_ERROR`、
  `UPSTREAM`、`PROTOCOL`、`PROTOCOL_MISMATCH`、`EMPTY_OUTPUT`、`CONFIG`、`CIRCUIT_OPEN`。
- 日志/trace/API 错误均经过 `redact`；新增 `oc_sk_`、`sk-ant-`、`cmd_`、`oc_` 模式并注册实际 key。
- 模型内容视为**不可信外部数据**；不执行其中的指令，只作为生成/分析文本。

## 7. 路由模式

`cognition.llm.mode`：

| 模式 | 行为 |
|---|---|
| `auto`（默认） | 先 DSH 当前路由；DSH 不可用/失败时回退模型网关已选直连 |
| `dsh` | 只用 DSH |
| `fixed` | 只用 DSH 固定 `provider/model`（旧行为） |
| `direct` | 只用模型网关已选直连；`fallbackToDsh` 可再回退 DSH |
| `chain` | 按直连 `selected` + `fallback` 链尝试，最后回退 DSH |

- `auto` 保持向后兼容；想让 bot 用自己的模型，选 `direct` 或 `chain`。
- 每次尝试记录 provider/model/protocol/latency/error；最终失败返回 degraded，不伪造回复。
- `llm.status()` 暴露 `dsh`、`direct`、`selected`、`models` 和预算，认知概览页展示。

## 8. REST API

前缀：`/onebot-qq/api/models`。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/models` | 聚合列表：providers（打码）、selected、fallback、presets、protocols、health |
| GET | `/models/status` | 同轻量状态 |
| POST | `/models/provider` | 新增/更新 `{provider}`；`apiKey` 空=保持，`clearApiKey=true`=清除 |
| POST | `/models/provider/delete` | `{providerId}` |
| POST | `/models/provider/test` | `{providerId,model}`；最小真实请求，返回延迟/usage/文本预览/错误码 |
| POST | `/models/provider/discover` | `{providerId}`；拉取模型列表，不自动保存 |
| POST | `/models/provider/models` | `{providerId,models}`；确认发现的模型 |
| POST | `/models/select` | `{provider,model}` |
| POST | `/models/fallback` | `{fallback:[{provider,model}]}` |

返回示例：

```json
{
  "ok": true,
  "selected": { "provider": "opencode-go", "model": "deepseek-v4.1-flash", "resolved": true,
                "protocol": "openai-completions", "hasApiKey": true, "apiKeySource": "env" },
  "providers": [{ "id": "opencode-go", "hasApiKey": true, "apiKeyHint": "…tIe8", "models": [] }],
  "presets": [], "protocols": [], "health": {}
}
```

## 9. UI

第 6 个顶层标签「模型」（v0.6 起人格为第 5、模型为第 6）：

- 路由模式与 DSH/直连状态、直连回退开关、备用路由；
- provider 列表、预设新增、编辑/保存/删除；
- 协议、base URL、请求路径、模型列表路径、认证方式、环境变量、API key、headers、session header、
  模型 ID、超时、流式、重试；
- 测试、发现模型、设为直连、设为备用；
- 测试结果显示协议/model/延迟/tokens/文本预览/错误；密钥永不出现在 DOM/结果；
- 360px 单列，无横向溢出；浅/暗色复用 `--ob-*` 令牌。

认知 → 状态的「模型与预算」卡片展示 DSH 路由、直连 provider/model、协议和 token 预算，并提供
「管理模型」跳转。

## 10. 测试

```powershell
$node = "C:\Users\Run\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
Set-Location packages\dsh-onebot-qq

# 全部离线测试（live 测试自动 skip）
& $node --test test/*.test.js

# 真实 OpenCode Go（key 只在环境变量）
$env:OPENCODE_GO_API_KEY = '...'
& $node --test test/model-live.test.js
```

直播脚本：`scripts/verify-model-gateway.mjs`（无 DSH 依赖的独立连通测试；同样只读 env）。

覆盖：

- 五种协议请求/响应/流分块/usage/finish/错误；
- 认证 header、session header、path 拼接、非流式 JSON fallback；
- registry CRUD/原子写/密钥打码/env 优先级；
- gateway 重试/熔断/发现/`supported_endpoints` 过滤/缺 key；
- 认知 `direct/auto/chain/fixed` 路由与空输出降级；
- 真实 OpenCode Go OpenAI + Anthropic + 模型发现。

## 11. 已知边界

- 本版只做**文本**协议；工具调用执行、图像/音频/文件多模态、embedding、批量 API 未实现；
- Azure OpenAI（api-version/header）、AWS Bedrock（SigV4）、GCP Vertex（OAuth）、Codex/Copilot OAuth
  不在本版静态 key 模型内；可通过 DSH 路由或后续协议适配扩展；
- Command Code 需要付费套餐才有 Provider API；Go 套餐会 403；
- OpenCode Go Anthropic 的模型列表不区分端点，具体模型是否支持 `/messages` 需实测/按预设选择；
- OpenRouter 本版只适配其 OpenAI Chat Completions 端点，不做账户余额/用量管理；
- 密钥存储是本地文件明文（尽力 0600），生产环境优先 `apiKeyEnv`；建议定期轮换。
