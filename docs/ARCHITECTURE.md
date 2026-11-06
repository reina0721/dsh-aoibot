# dsh-bot · 架构与实现契约

> 本文件描述当前模块边界与接口契约。接口变更需同步更新本文、测试及用户文档。

## 1. 目标

为 DSH 构造一个 QQ 接入插件：通过 **OneBot v11** 协议连接 **NapCat / SnowLuma / Lagrange /
LLOneBot** 等 QQ 网关地址，提供：

- 连接管理（WS 收事件 + HTTP 调接口、自动重连、账号核验）；
- 事件规范化与缓冲（消息/通知/请求/元事件）；
- 消息与查询动作（发私聊/群聊、好友/群列表、登录信息等）；
- **完整的网页 UI 面板**（DSH Web 客户端插件）与**持久化配置**；
- 不写死任何算法参数：所有可调参数进入 `config.json`，带默认值，可在面板修改/重置。

本插件同时提供「QQ 感知与执行接入层」与内置认知内核（v0.4+）：接入层保持无状态边界，长期人格/人物/关系/记忆/
策略/学习状态由 `src/cognition/**` 管理，UI 通过认知服务查询/命令。

## 2. 代码位置

```
dsh-bot/
├── package.json          # bundle + dsh.client 清单
├── cordis.patch.yml      # 插入 onebot-qq 行
├── client.js             # 浏览器半边：侧栏入口 + 整页面板
├── icon.svg / locale/*   # 展示元数据
├── src/
│   ├── host.js           # 插件入口 apply(ctx, rowConfig)
│   ├── core/store.js     # 数据目录 / 原子 JSON 读写（移植自 aurabot MIT）
│   ├── core/redact.js    # 密文脱敏（移植自 aurabot MIT）
│   ├── core/logger.js    # 分级日志 + 环形缓冲（移植自 aurabot MIT）
│   ├── core/config.js    # DEFAULTS / 读取 / 校验 / 保存
│   ├── core/events.js    # 规范化事件环形缓冲 + 统计
│   ├── onebot/client.js  # OneBot v11 客户端：HTTP+WS、重连、echo（移植自 aurabot MIT）
│   ├── gateway/
│   │   ├── normalize.js  # 原始事件 → 规范化事件
│   │   ├── manager.js    # 连接生命周期 / 账号核验 / 热应用配置
│   │   ├── actions.js    # OneBot action 包装
│   │   └── snowluma.js   # SnowLuma 安装检测 + 读 its OneBot 配置
│   └── http/routes.js    # /onebot-qq/api/* REST 路由
├── test/
│   ├── helpers/mock-onebot.js  # 假 OneBot v11 网关（移植自 aurabot MIT）
│   ├── helpers/fake-dsh.js     # 最小假 DSH ctx
│   ├── e2e.test.js             # 宿主插件端到端
│   └── *.test.js               # 单元测试（各模块 owner）
├── scripts/verify-plugin.ps1   # 安装到临时 profile + 无头启动 + 探活
└── docs/…                      # 用户指南、开发契约、研究与历史归档
```

## 3. 关键契约

### 3.1 配置（src/core/config.js）

- 配置文件：`$DSH_HOME/plugins-data/dsh-bot/config.json`（可用 `DSH_BOT_DATA_DIR` 覆盖，测试用）。
- `DEFAULTS` 必须包含**所有**可调参数（重连退避、超时、重试、事件过滤、缓冲容量、日志级别等）。
- 读取时与 DEFAULTS 深合并；未知字段保留（向前兼容）；类型/取值非法时回退默认值并记录 warning。
- `loadConfig()` / `saveConfig(next)` / `resetConfig()` / `normalizeConfig(raw)` / `publicConfig(cfg)`。
- 保存用原子写（临时文件 + rename）。

### 3.2 Gateway Manager（src/gateway/manager.js）

```js
export function createGatewayManager({ getConfig, log, onEvent }) {
  // onEvent(rawOneBotEvent) —— WS 收到 OneBot 事件时回调（由 host 负责 normalize + 入缓冲）
  return {
    ready,                    // Promise，初次启动完成（未启用时立即 resolve）
    start(), stop(), restart(),
    applyConfig(prev, next),  // 热应用：端点/enabled/账号等变化时内部重启；过滤器变化只更新
    call(action, params, opts), // OneBot action 透传（失败抛 Error，带可读 message）
    probe(overrideEndpoint),  // 只走 HTTP 探测 get_login_info，不改连接状态
    detectGateway(),          // { snowluma: {...}, endpoint: { httpUrl, wsUrl, ... } }（只读）
    snapshot(),               // 同步状态快照，形状见 §3.4
    actions,                  // createActions() 的产物
    dispose(),
  }
}
```

- WS 优先收事件；`wsUrl` 未配置时仍可用 HTTP（轮询不做，仅状态提示）。
- 连上后（若 `verification.enabled`）调用 `get_login_info` 核验：与 `botQQ` 一致 → `loginCheck:'ok'`；
  不一致按 `accountCheck` 策略 `warn`（只警告）/ `enforce`（断开并暂停自动重连，等待用户处理）/ `off`。
- 核验期间的原始事件先暂存（上限可配），核验通过后按序补发；失败则丢弃。
- 重连参数全部来自配置：`reconnect.minDelayMs/maxDelayMs/factor/jitterRatio/enabled`。
- 所有日志走注入的 `log`，token 必须脱敏。

### 3.3 事件规范化（src/gateway/normalize.js）

```js
export function normalizeEvent(raw, cfg) -> null | {
  seqless: true,
  kind: 'message'|'notice'|'request'|'meta_event'|'unknown',
  time, selfId, postType, subType,
  message?: { id, chatType:'private'|'group', chatId, sender:{userId,nickname,card,role}, text,
              segments:[…], mentions:[{userId,name}], images:[{url,file,summary}],
              replyId, rawMessage, messageFormat },
  notice?: { type, subType, ...关键字段 },
  request?: { type, subType, ... },
  meta?: { type, subType, ... },
  raw,  // 原始事件（可截断，见 cfg.events.rawMaxBytes）
}
```
- 过滤（events.filters）在 **events.push** 前完成：`ignoreUsers`、`ignoreGroups`、消息子类型开关、kind 开关、`includeSelfMessages`。
- 访问控制（`core/access.js`）在 `events.push` **之前**：`allowlist` 下非主人/非白名单消息直接丢弃，不落 raw、不聚合、不回复；审计只存元数据。
- 不伪造字段：平台没给的信息留空，不使用「推测」值。

### 3.4 状态快照（snapshot()，REST `GET /status` 的主体）

```js
{
  state: 'stopped'|'connecting'|'connected'|'disconnected'|'unconfigured'|'paused',
  configured: boolean,
  endpoint: { mode:'onebot'|'snowluma', wsConfigured, httpConfigured, wsUrlSafe, httpUrlSafe },
  connectedAt, lastDisconnectAt, lastError, reconnects, loginAttempts,
  login: { userId, nickname } | null,
  loginCheck: 'pending'|'ok'|'mismatch'|'error'|'off'|'unknown',
  expectedBotQQ, accountCheck,
  snowluma: { installed, dir, endpointFound } | null,
}
```

### 3.5 REST API（src/http/routes.js，前缀 `/onebot-qq/api`）

所有响应 JSON：成功 `{ ok:true, ... }`；失败 `{ ok:false, message }`（HTTP 200，面板统一处理）。

| Method | Path | 说明 |
|---|---|---|
| GET | `/status` | 状态快照 + 统计 + 最近事件(条数可配) + `access` 摘要 |
| GET | `/access/stats` | 访问控制模式、名单数量、计数与最近审计 |
| POST | `/access/check` | body `{ chatType, chatId, senderId }`，返回判定与中文原因 |
| GET | `/config` | `{ config, defaults, groups, dataDir, version }`（含面板字段表） |
| POST | `/config/save` | body `{ config }` 全量保存，返回规范化后的 config 与 issues |
| POST | `/config/reset` | 恢复默认值 |
| POST | `/connect` / `/disconnect` / `/reconnect` | 连接控制 |
| POST | `/probe` | body 可选覆盖端点；只测试 HTTP `get_login_info` |
| GET | `/gateway/detect` | SnowLuma 检测 + 端点解析结果 |
| GET | `/login-info` | 实时 `get_login_info` |
| GET | `/friends` / `/groups` | 列表 |
| POST | `/send` | `{ chatType:'private'\|'group', chatId, message }`（string 或段数组） |
| POST | `/action` | `{ action, params }` 透传（受 `security.allowRawAction` 限制） |
| GET | `/events?since=&limit=` | 事件缓冲 |
| POST | `/events/clear` | 清空事件缓冲 |
| GET | `/logs?since=&limit=` | 日志环形缓冲 |
| POST | `/logs/clear` | 清空日志 |
| GET | `/health` | 轻量探活 |

### 3.6 客户端面板（client.js）

- 形式：`window.__ModuleLoader__.load({ id: 'dsh-bot', factory(require) {...} })`，
  工厂返回 `{ inject:['slots','theme'], apply(ctx) }`；`id` 必须等于包名。`theme` 是客户端 ui-theme
  公开服务（`getTheme/setTheme` + `theme/change`），用于系统设置页切换 DSH 全局主题；`package.json`
  的 `dsh.client.inject` 必须与之一致。
- 注册：
  - `ctx.slots.register({ name:'sidebar.panellist', id:'onebot-qq', order: 20, label: () => 'QQ 连接' }, Icon)`
  - `ctx.slots.register({ name:'main', key:'onebot-qq' }, Panel)`
  - 通过 `ctx.slots.inject(...)` 注册（参考 aurabot `client/client.js` 末尾写法）。
- 只经 `/onebot-qq/api/*` 读写宿主，不直接碰 QQ。
- 样式/动效分为三层，均由**同一个** `<style>` 注入（`STYLE_ID = dsh-bot-panel-style`）：
  - `TOKEN_CSS`：唯一允许十六进制色值的区块。显式声明 console-web 的浅色/暗色调色板、4 套强调色 +
    `inherit`（跟随 DSH 主题）、密度/字号/内容宽度/对比度映射、圆角/阴影/字重/动效时长变量；暗色通过
    `body[data-ds-dark-theme] .ob-root` 覆盖，强调色通过 `data-accent`、对比度通过 `data-contrast` 覆盖。
  - `MOTION_CSS`：唯一允许 `@keyframes` 与 `animation:` 的区块。实现语义配方 `content.enter` /
    `content.swap`（设置分类切换仅淡入） / `viewport.reveal` / `feedback.enter+exit` / `progress.trickle` /
    状态脉冲；`data-motion="reduced|off"` 与 `prefers-reduced-motion` 统一降级为 0.01ms。
  - `PANEL_CSS`：布局/组件类，只消费 `--ob-*` 变量；不写裸色值、不写裸字重（字重走
    `--ob-weight-*` 令牌）、不声明动画。
- 外观偏好全部来自 `ui.*` 配置（`accent/contrast/density/fontScale/contentWidth/motion/pageTransition`），
  根节点以 `data-*` 属性声明语义；客户端不写死默认值。**主题不进入 `ui.*`**：它由 DSH `theme` 偏好持有，
  设置页只调用 `setTheme` 并订阅 `theme/change`，避免两份主题源。
- **持久设置壳（config/settings）**：页头、全局标签栏、左侧分类导航不在被替换的内容容器内；
  分类切换只替换右侧 `.ob-settings-pane`（`key=active` + `ob-swap-in` 淡入），不重挂载壳、不滚动整页。
  `配置`/`系统设置` 顶层进入时强制 `ob-enter-fade`（不受 `ui.pageTransition` slide 配方影响）。
- **系统设置即时保存**：`saveUiPatch(patch)` 以 `applyConfigPatch` 乐观更新 draft，随即进入串行队列
  `POST /config/save`；成功时用服务端规范化结果回写（仅在没有更新改动时覆盖 draft），设置页显示
  「保存中/已保存/失败重试」，不显示吸底 Savebar；`配置` 页仍保持显式保存 + dirty 提示。
- 无障碍与响应式：统一 `:focus-visible` 焦点环、tab 方向键/Home/End 导航、toast `aria-live`、
  reduced-motion 合规；190–390px 单列、tab/设置分类可横向滚动、无横向溢出；动效只使用
  opacity/transform/width，不动画高度或滚动容器。
- 标签页：**概览 / 连接 / 消息 / 配置 / 系统设置 / 日志 / 关于**。
- 配置页字段按分组渲染（左侧分组导航 + 右侧仅当前分组），支持保存、撤销、恢复默认、Ctrl+S；
  所有配置来自 `GET /config`，不得在客户端写死默认值。`ui` 分组只由系统设置页消费，配置页过滤掉。
- 未保存改动要有 dirty 提示（页头徽标 + 吸底保存条，仅配置页）；保存失败要有可读错误。

### 3.7 实现补充（gateway 实际形状，集成后核对）

- `probe(override?)`（`POST /probe`，body 可传 `{ httpUrl, httpToken, httpAuth, wsUrl, wsToken }` 覆盖端点）：
  只走 HTTP 调 `get_login_info`，返回
  `{ ok:boolean, url, httpStatus?, elapsedMs, login?:{userId,nickname}, message?, httpConfigured? }`。
  网络失败不抛异常，以 `ok:false` + 可读 `message` 返回；不改变连接状态。
- `detectGateway()`（`GET /gateway/detect`）返回
  `{ mode:'onebot'|'snowluma', source, endpoint:{mode,httpConfigured,wsConfigured,wsUrlSafe,httpUrlSafe,source},
     snowluma:{installed,dir,version,reason,read:{found,uin,files,sources,reason,httpConfigured,wsConfigured,httpUrlSafe,wsUrlSafe}|null},
     reason, candidates:[{dir,installed,reason}], downloadPage }`；两处 URL 均已脱敏，token 不回传。
- `snapshot()` 在 §3.4 之外还包含：
  `paused, desiredRunning, verification:{enabled,buffered,dropped},
   snowluma:{installed,dir,version,reason}|null, stats:{connects,disconnects,calls,failures,pending,wsState}`。
- 只配 HTTP（`wsUrl` 为空）时：`start()` 不建立 WS，`state='disconnected'` 且 `lastError` 说明无法实时收事件；
  HTTP 调用照常可用。两个地址都空时 `state='unconfigured'`。
- 账号核验：仅当 `verification.enabled && botQQ && accountCheck!=='off'` 时核验；
  `accountCheck='enforce'` 且不一致 → manager 内部 `client.stop()` 并置 `state='paused'`（不会自动重连，用户点「连接」恢复）；
  `warn` 只置 `loginCheck='mismatch'` 并补发缓冲事件；核验异常置 `loginCheck='error'` 同样补发事件。
- 事件交付顺序：WS 原始事件 → 核验缓冲（pending 时）→ `onEvent(raw)` → host 规范化 → `events.push`（过滤）
  → `ctx.emit('onebot-qq/event', record)`。

### 3.8 认知内核契约（v0.4+）

- 代码边界：`src/cognition/**` 不 import `src/gateway/**` 或 `src/http/**`；只接收规范化事件、raw 事件和发送回调。
  平台层不 import 认知内部模块，只通过 `createCognition()` 返回的服务接口交互。
- 宿主服务：`ctx.provide('onebotCognition', service)`；接口：
  `ready`、`ingestRaw(raw,meta)`、`observe(normalized,accepted)`、`snapshot()`、`overview()`、
  `persons/personDetail/memories/decisions/...`、`registerKnowledgeSource(src)`、`registerCapability(name,impl)`、
  `pause(reason)`、`resume()`、`dispose()`。
- 单一写者：认知状态只由 cognition service 写；UI/API 通过 service 命令；平台事件不得直接改表。
- 存储：`node:sqlite` WAL + FTS5；原始事件 JSONL；无 sqlite 时 JSON fallback。schema/migration 见
  `docs/cognitive/DATA-MODEL.md`。
- LLM：DSH 路由仍用 `ctx.get('llm').stream()`；直连路由走 `src/model` 模型网关（OpenAI/Responses/Anthropic/Gemini/Ollama），
  路由继承 `agentDefaultModel`、固定配置或模型页 selected；无可用模型时社交回复进入 degraded，不伪造认知。
  DSH 一次性调用使用顶层 `system` + identity-free user `messages`，并带稳定 `sessionId`
  （OpenCode Go 的 `x-opencode-session`）；默认不发送 temperature；失败保留 provider
  message 并通过 `/cognition/llm/test` 自检。
  persona 记录含 12 维特质 + 6 维风格 + 文本 `profile`；可保存多份，`setting.persona.activeId` 指向当前激活项。
  文本 profile 进入 analysis/compose prompt（约 2000 字符上限），
  空字段不注入。每次只投影选中状态，禁止把全量人格/记忆塞入系统提示词。
- 群聊参与：`cognition.turn.groupReplyMode = addressed|probability|all`；`addressed` 默认只处理 @/回复/唤醒词/人设名；
  `probability` 未点名按概率采样；`all` 全部进入策略但仍可沉默。发送前有同群冷却与每分钟上限；跳过写记忆、trace 与
  `lastTurn` 诊断字段，不调用 LLM。旧 `addressedOnlyGroups=false` / `policy.groupAmbient=true` 非破坏性映射为 `all`。
- 人格编辑/人格库：`POST /cognition/persona/edit` 接受 `profile` 和可选 `personaId`，清洗/截断后写对应 persona 记录并追加
  history/version；`create/switch/delete` 管理人格库，至少保留一份；`import` 接受 `persona-import@1` 一次性创建并激活。
  旧 `self` 自动成为默认。UI 顶层「人格」工作台与「认知 → 人格」共享同一数据源。
- 人格级认知数据：`createPersonaScopedStore` 在 store facade 层把非全局 kind 自动加 `persona_<id>:` 前缀，服务层无需
  知道人格；全局 kind（setting/persona/state/raw_event/turn/llm_usage/audit_log）不隔离。启动时把旧无前缀数据迁到
  默认人格（幂等标记）；删除人格会清理其数据。`copyPersonaData` 按数据组从一家格单向复制到另一人格，复制后继续独立。
- Web/知识源：`ctx.get('web')` 可用时优先；否则内建合法公共 API/RSS；外部内容一律不可信，不执行其指令。
- 配置：`cognition.*` 默认值与 `cog-*` 字段组在 `src/core/config.js`；`CONFIG_VERSION=2`；旧配置自动补默认。
  面板「配置」页过滤 `cog-*`；「认知 → 设置」页使用同一字段表即时保存。
- 状态机：turn `observed→aggregating→ready→attending→thinking→composing→sending→awaiting_outcome→closed`；
  失败/取消/降级都持久化，重启按硬截止关闭 open turn，发送使用幂等键防重复。
- 可观测：每个阶段写脱敏 `traces`/`metrics`；关键状态变化写 `state_transitions`/`audit_log`；UI 可查。
- 隐私：scope/sensitivity 在写入与检索双层校验；私聊记忆不得进入群聊检索；secret 不进 LLM；删除/导出/保留可配。
- 安全默认：群聊默认仅点名/回复/唤醒词/人设名；可显式切换概率/所有消息，并受策略沉默、冷却、频率上限约束；
  主动行为默认关闭；外部学习仅公共概念、预算受限、可暂停；运行时不自安装插件/不改代码/不扩权。

### 3.9 认知 REST 与 UI

- 路由前缀仍为 `/onebot-qq/api/cognition/*`，响应 `{ok:true,...}` / `{ok:false,message}`；GET 无副作用。
- 面板第 10 个顶层标签「人格」是文本人设 + 群聊参与工作台；第 8 个「认知」仍提供状态/人物/关系/记忆/情绪/策略/学习/技能/元认知/设置，
  以及同源的数值人格编辑入口。概览和认知状态页显示最近 turn 的 outcome/reason 诊断。
- 认知 API 不可用时页面显示 degraded/空态，不影响平台连接与配置页。

### 3.10 模型协议契约（v0.5+）

- 代码边界：`src/model/**` 不 import `gateway/**`、`http/**`、`cognition/**`；只接收 provider 配置与请求，
  返回统一 `text-delta/reasoning-delta/usage/finish`。认知通过注入的 `models` 调用，平台不直接拼协议。
- 协议：`openai-completions`、`openai-responses`、`anthropic-messages`、`gemini-generate-content`、`ollama-chat`；
  厂商只是 preset，不是硬编码分支。
- 注册表：`<dataDir>/models.json`（原子写、`.bak`、0600 尽力）；API 只返回 `hasApiKey`/来源/后四位；
  `/config` 永不包含模型 key。
- 认证：bearer / x-api-key / 自定义 header / none；禁止跨源重定向转发认证头；错误/日志/trace 脱敏。
- 路由：`cognition.llm.mode = auto|dsh|fixed|direct|chain`；直连 selected + fallback，最后可回退 DSH；
  空文本、只有 reasoning、bad JSON 都不算成功。
- REST：`/onebot-qq/api/models/*`；UI 第 6 个顶层标签「模型」；详细矩阵见
  `docs/MODEL-GATEWAY.md`。

### 3.11 访问控制与统一出站

- `src/core/access.js`：`normalizeAccess` / `decideInbound` / `canSend` 纯函数；`createAccess` 负责配置读取、审计环形缓冲与计数。
- `src/cognition/outbound.js`：`deliver({ chatType, chatId, segments, decisionId, source, dryRun })` 是认知侧唯一自动发送入口；
  顺序为访问控制 → 频率上限 → dryRun → 发送 → `policy.markSent/markFailed`；只发一次，不自动重试。
- `pipeline.sendDecision`、撤回处理与 `proactivity` 全部走 outbound；面板 `POST /send` 是人工操作，保留独立路径。
- 默认 `access.mode='open'`，升级后行为不变；`allowlist` 才启用主人 + 白名单规则。

### 3.12 DSH Session 运行时（`src/runtime/agent.js`）

```js
createAgentRuntime({ ctx, getConfig, access, logger, dataRoot }) -> {
  available(), active(), engine(),
  levelFor(turn), presetFor(level),
  compose({ turn, system, user }),  // -> { ok, text, sessionId } | { ok:false, error }
  summary(), sessions(), dispose(),
}
```

- 服务探测：`ctx.get('sessionController')`、`workspaceRegistry`、`agents`、`systemPrompt`；缺一个则 `available=false`。
- `runtime.engine` 默认 `oneshot`；只有 `agent` 且服务齐全时 `active=true`，否则 `compose` 返回 `RUNTIME_INACTIVE`，调用方回退一次性 LLM。
- 会话映射：`<dataDir>/runtime/sessions.json`，key 为 `chatType:chatId`；preset/level 变化或恢复失败时新建。
- preset：主人私聊 `dsh-bot-private`（fs/fs-search/web 工具），群聊/他人私聊 `dsh-bot-social`（无本机工具）。
- 上下文：`agent.ctx.systemPrompt.context({ name, order, text })` 挂认知 system 文本；没有该 API 时退回把 system 前置到 user 消息。
- 回合：`agent.followup(UserMessage)`；监听 `session/event`，`assistant/message` 取无 tool-call 的文本，`turn/end` 结算；每聊天串行，超时返回 `TIMEOUT` 不强杀。
- 人格/规则：插件在 `host.apply` 注册 `dshbot_persona` / `dshbot_rules_private` / `dshbot_rules_social` 提示词变量，preset 只引用变量。
- 边界：M1 只替换 compose；analysis/policy/记忆仍由认知内核负责；QQ 动作工具、命令、按聊天模型在后续里程碑。

### 3.13 QQ 命令与按聊天模型

- `src/cognition/commands.js`：`parseCommand(text)` + `createCommandService()`；只处理 `/name args`，非主人静默忽略。
- 命令在 `pipeline.handleTurn` 的自循环检查之后、分析/策略之前处理；回复走 `outbound.deliver({ source:'command' })`，
  因此同样受访问控制与频率上限约束。
- `/quiet` `/active` 写回 `cognition.turn.groupReplyMode` 与 `cognition.proactivity.enabled`；`/model` 写
  `cognition.modelRouting.routes`（`chatId=provider/model`）；`/remember` `/forget` 调用记忆服务的 `remember` /
  `forgetMatching`，作用域是当前私聊或群。
- `src/cognition/llm.js`：`chatOverride(chat)` 解析 `modelRouting`，`buildAttempts(chat)` 把会话覆盖放在最前；
  provider 在直连注册表里 → `kind:'direct'`，否则 `kind:'dsh'`。`currentRoute(chat)` 供 `/model` 与面板诊断。
- 限制：只影响认知 LLM 路由；`agent` 引擎的 DSH Session 模型仍由 preset/DSH 选择，后续再通过 sessionController 选模型。

### 3.14 回复分条、引用/@ 与群聊防刷屏

- `src/cognition/reply-split.js`：`splitReply(text, { maxChars, maxParts })` 纯函数；优先段落/换行/句末标点，找不到才硬切；超过 `maxParts` 的剩余内容并入最后一条。
- `pipeline.sendDecision`：按 `cognition.reply` 配置分条；第一条可带 `reply`（引用）与 `at`（群聊 @）；每条都经过 `outbound.deliver`，因此访问控制/限频对每条生效；分条间隔 `delayMs`。
- 失败语义：第一条失败 → 整轮失败；后续条失败 → 已发部分保留，记录 `SEND_FAILED`，不回滚、不重发。
- 防刷屏：`cognition.turn.maxConsecutiveGroupReplies` 限制连续**未点名**接话；`noteGroupReply` 按是否点名维护计数（点名回复清零），`groupReplyAllowed` 超限返回 `consecutive_limit`，与冷却/每分钟上限并存。
- 边界：合并转发展开、拍一拍/表态、QQ 动作工具仍在 M2-b。

## 4. 数据目录

```
~/.dsh/plugins-data/dsh-bot/
├── config.json          # 配置（version 2，含 cognition.*）
├── models.json          # 模型 provider/selected/fallback（密钥不通过 API 回传）
├── events.jsonl         # 可选：事件持久化（events.persist=true 时）
├── logs/                # 可选：日志文件（logging.persist=true 时）
└── cognition/
    ├── cognition.sqlite # 认知长期状态（WAL + FTS5；JSON fallback 为 cognition.json）
    └── raw-events.jsonl # 过滤前原始事件镜像（可关/可限制保留）
```

## 5. 复用与许可

- `src/onebot/client.js`、`src/core/store.js`、`src/core/redact.js`、`src/core/logger.js`、
  `test/helpers/mock-onebot.js` 移植/改写自 **aureth-labs/dsh-aurabot-qq**（MIT）；
  在 `THIRD_PARTY_NOTICES.md` 中保留版权与许可声明，并在文件头注明来源。
- OneBot v11 协议规范：<https://github.com/botuniverse/onebot-11>。
- SnowLuma / NapCat 只作为「外部网关地址」接入，不内置、不分发、不自动部署。
