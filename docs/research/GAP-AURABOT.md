# dsh-bot × Aurabot 全量对标报告

> 快照：2026-11-06（Asia/Shanghai）。
> Aurabot：`aureth-labs/dsh-aurabot-qq`，`dd1911f`，v1.2.0，MIT。
> dsh-bot：`reina0721/dsh-bot`，`a195ce5`，v0.10.0，MIT。
> 本文是差距清单 + 里程碑计划；**不把设计当成已实现**。状态以「代码 + 测试 + 受控真机验证」为准。

## 0. 一句话结论

Aurabot 领先的是**产品外壳 + DSH 原生运行时**；dsh-bot 领先的是**认知内核 + 模型协议广度**。最大的结构性差距不是少几个功能，而是：

1. **DSH Agent 运行时仍是受限接入**——已有可选的每聊天 Session、oneshot 回退和仅主人私聊的 3 个当前会话 QQ 工具，但没有媒体工具、子智能体、后台任务、定时任务执行面；
2. **没有访问控制**——没有主人、白名单、权限档位与统一出站闸门，不能安全地放进真实群；
3. **媒体/内容仍是受限层**——已有 M4-b 媒体与默认关闭的 B站公开搜索/热门/详情，但没有自动收集/语境选图、生图、RVC、B站评论/分享；QQ空间因授权/ToS 未实现，模块市场与备份升级仍是空白。

因此本项目的路线不是「按功能数量抄 Aurabot」，而是：**保留认知内核与模型协议的优势，补齐 DSH 原生运行时、安全底座、媒体与产品壳**，以 `parity matrix` 逐项验收。

## 1. 量化对照

| 项 | Aurabot v1.2.0 | dsh-bot v0.10.0 |
|---|---|---|
| 宿主源码 | 24,721 行 / 220 个 js 文件 | 10,806 行 / 44 个 js 文件 |
| 面板 | 5,102 行，约 25 个功能页 + 设置子页 | 单文件面板，13 个顶层标签（含媒体/内容/模块） |
| 测试 | 117 个测试文件 / 20,024 行 | 22 个测试文件 / 5,471 行 / 157 项（153 通过、4 项 live 跳过） |
| 关键模块 | `chat/hub.js` 2,448；`features/memory.js` 2,629；`purpose/engine.js` 2,287；`core/modules.js` 865 | `cognition/index.js` 546；`cognition/pipeline.js` 523；`core/config.js` 1,115 |
| 运行时 | 每聊天 DSH Session + 4 个 preset + 按会话挂工具 | 一次性 LLM；无 Session/工具 |
| 内置模块目录 | 17 个（voice / song / stickers / imagegen / memory / mood / diary / bili / qzone-social / purpose / pet / qq-api / qq-tools / video / contacts / profile / speakup） | 无模块内核 |
| 面板页面 | 概览/连接/人格/权限/聊天/模型/语音/表情包/生图/空间/主动/桌宠/心情与记忆/人物记忆/翻唱/B站/抖音/小黑盒/本地接口/安全/市场/已安装/备份/关于/日志 | 概览/连接/消息/媒体/内容/模块/配置/人格/模型/系统设置/认知/日志/关于 |
| 社区 | 425★ / 65 fork | 新仓库 |

计数口径：GitHub API + 浅克隆源码 + `node --test` 实跑；页面按 `client/client.js` 的 page id；模块按 `src/modules/` 目录。

## 2. 三层差距

| 层 | Aurabot | dsh-bot | 性质 |
|---|---|---|---|
| 运行时 | `sessionController.create({workspaceId, agentPreset})`；每聊天一个 Session；`agent.ctx.tools.register` 按会话挂工具；`agent.followup/steer` 驱动回合 | `llm.stream()` 一次性调用；回复由本地 pipeline 拼 prompt | 结构性 |
| 产品壳 | 权限页、媒体页、空间/B站页、模块市场、备份升级、25 页面板 | 只有连接/消息/人格/模型/认知/日志/设置 | P0–P4 |
| 生态 | 模块内核（热重载/替换/隔离）+ 市场 + API/类型/教程 + 117 测试文件 | 单体；只有 `ctx.provide` 服务接缝 | P4 |

## 3. 能力矩阵

状态：**有**、**部分**、**无**、**领先**（dsh-bot 相对 Aurabot 更强）。
目标：`M1` 运行时+权限、`M2` 群聊交互、`M3` 记忆/心情/目的、`M4` 媒体、`M5` 社交内容+模块、`M6` 运维/UI/安全、`M7` 审计发布。

### 3.1 连接与感知

| # | 能力 | Aurabot | dsh-bot | 状态 | 目标 |
|---|---|---|---|---|---|
| 1 | OneBot v11 正向 WS + HTTP | 有 | 有；三种鉴权、握手超时、重连退避、账号核验缓冲 | **有** | — |
| 2 | SnowLuma 检测/读取 | 检测、启停、只注入机器人号 | 只读 `detectInstall`/`readOneBotEndpoint` | 部分（受限是许可要求） | — |
| 3 | QQ 事件面 | 撤回/禁言/进退群/管理员/精华/名片/头衔/群名/加好友/拍一拍/表态/请求 | message/notice/request/meta 基础 + 撤回 | 部分 | M2 |
| 4 | 消息段与富媒体解析 | 合并转发展开、临时会话、群文件、待办、相册、骰子/猜拳、位置/名片、分享/音乐 | 文本/图片/表情/引用/forward 元数据；合并转发可展开；其余未解析 | 部分（M2-b） | M4 |
| 5 | 原始事件落盘与脱敏 | 有 | 有（JSONL + SQLite + redact） | **有** | — |

### 3.2 会话运行时

| # | 能力 | Aurabot | dsh-bot | 状态 | 目标 |
|---|---|---|---|---|---|
| 6 | 每聊天 DSH Session | `sessionController` + preset + 映射文件 | `src/runtime/agent.js`：Session 映射、preset、followup、超时、oneshot 回退 | 部分（M1-b） | M1 剩余：真机验证/工具面 |
| 7 | 工具/MCP/子智能体 | 按会话挂载；`aurabot-subagent` | private preset 内置 fs/fs-search/web；full/主人私聊另挂 3 个当前会话 QQ 工具；无 MCP/子智能体 | 部分（M5-b） | M1/M2 |
| 8 | 后台任务/定时任务 | jobs + schedule + 长任务 preset | 无 | **无** | M1 |
| 9 | 会话内插话/steer/typing | `agent.steer` + `set_input_status` | 无 | 无 | M1 |
| 10 | 按聊天选模型 | `chatModels`（私聊/群/单聊） | `cognition.modelRouting`：私聊/群默认 + 会话覆盖；`/model` 写回 | 部分（M1-c，仅认知 LLM） | M1 剩余：agent Session 模型 |
| 11 | QQ 内命令 | `/silent` `/active` `/quiet` `/chatty` `/model` `/sing` `/remember` `/status` | `/status` `/quiet` `/active` `/model` `/remember` `/forget` `/help`；非主人静默 | 部分（M1-c） | M1 剩余：`/sing` 等媒体命令 |

### 3.3 权限与安全

| # | 能力 | Aurabot | dsh-bot | 状态 | 目标 |
|---|---|---|---|---|---|
| 12 | 主人/私聊白名单/群白名单 | `ownerQQ` + `allow.private/groups` | `access.mode=open/allowlist`、主人 + 私聊/群白名单、入口闸门、审计/计数 | 部分（M1-a） | M1 剩余：工具级权限 |
| 13 | 权限档位 | full / social / chat；preset 按档位 | 无 | 无 | M1 |
| 14 | 逐项权限 | 改资料/文件/群管/点歌/生图/抖音/小黑盒；执行前复核 | 当前仅主人 + 当前会话约束；无逐项 action 权限矩阵 | 部分（M2-b） | M2 剩余/M5 |
| 15 | 审批/危险确认/leak guard | `security/approval`、`danger`、`leak-guard` | 无 | 无 | M2 |
| 16 | 本机-only/CSRF/可信反代/远端访问 | 默认只许回环 + CSRF + 反代配置 | 依赖 DSH 本机服务，无显式防护 | 部分 | M6 |
| 17 | dryRun/试运行 | 有 | 有（`cognition.dryRun`） | **有** | 统一到 outbound |
| 18 | 统一出站闸门 | 执行层兜底 | `cognition/outbound.js`：访问 → 限频 → dryRun → 发送；pipeline/proactivity 统一 | **有**（M1-a） | — |

### 3.4 群聊与表达

| # | 能力 | Aurabot | dsh-bot | 状态 | 目标 |
|---|---|---|---|---|---|
| 19 | 轮次聚合/防抖/硬截止 | 有 | 有（完整度、软/硬截止、命令快路径） | **有** | — |
| 20 | 群 admission | 点名必回、话题相关度、概率插话、防刷屏、连续发言自知 | addressed/probability/all + 冷却/分钟上限 + 连续未点名接话上限 | 部分（M2-a） | M2-b：话题相关度/接梗 |
| 21 | 分条回复/引用/@/表情 | 有 | 分条 + 引用 + 群聊 @ 可配；表情/语音未接 | 部分（M2-a） | M2-b/M4 |
| 22 | 合并转发展开/拍一拍/表情回应/通知 | 有 | 合并转发展开、拍一拍回应、表情表态归因；其他通知类型未处理 | 部分（M2-b） | M2 剩余 |
| 23 | QQ 动作工具 | 改资料/群管/文件/点赞/撤回/精华等 | 4 个主人命令；仅主人私聊 Session 挂 3 个固定当前会话工具（额外文本/点赞/戳），social/group 注册 0 个 | 部分（M5-b） | 无资料编辑/群管/文件/撤回/精华/通用 action bus；真机待验 |

### 3.5 人格与情绪

| # | 能力 | Aurabot | dsh-bot | 状态 | 目标 |
|---|---|---|---|---|---|
| 24 | 人格编辑/切换 | 人格卡 Markdown（可多份、按节编辑、面板切换） | 多人格库、切换/复制/删除/导入；**人格级认知数据隔离** | 领先（隔离深度） | — |
| 25 | 心情/情绪 | 关键词或模型判心情；影响语气/表情/语音/回复速度 | OCC 评价 → PAD/离散；惯性/衰减/调节/外显阈值 | 领先（但未影响媒体） | M4 |
| 26 | 人格注入 | `@deepseek-ai/dsh-persona` + `{{aurabot_persona}}` | `{{dshbot_persona}}` / rules 变量 + private/social preset | **有**（M1-b） | — |

### 3.6 记忆、人物与关系

| # | 能力 | Aurabot | dsh-bot | 状态 | 目标 |
|---|---|---|---|---|---|
| 27 | 记忆类型 | 本地索引 + 原话/梗概/事实分层 + 人物/群档案 | 工作/情景/语义/情绪/社会/程序 + FTS5 | 部分 | M3 |
| 28 | 每日整理/空闲提炼 | 有；预算/批次/重试/保留 | 每日 04:00 巩固 + 按作用域 LLM 反思；手动触发；私聊隔离 | 部分（M3-b） | M3 剩余：批次/重试/保留 |
| 29 | 人物档案/群印象/相处经验/说话方式 | 有页面、可编辑、按聊天隔离 | person/relationship 数据有，UI 只有条数；目的已有独立页 | 部分 | M3 剩余 |
| 30 | 时间轴/回忆日志/导入旧档案 | 有 | 轮次/记忆/决策只读时间轴；无导入旧档案 | 部分（M3-c） | M3 剩余 |
| 31 | 语义检索/embedding | 可选，默认关 | 只有 seam，未接真实向量 | 部分 | M3 |
| 32 | 跨平台身份 | 有 | 无 | 无 | M3 |

### 3.7 学习、信念与知识

| # | 能力 | Aurabot | dsh-bot | 状态 | 目标 |
|---|---|---|---|---|---|
| 33 | 未知检测/学习任务/claims | 无显式 | 有（unknowns/tasks/claims/预算/暂停） | **领先** | — |
| 34 | 信念修正 | 无显式 | logit 证据更新、冲突 disputed、用户纠正 | **领先** | — |
| 35 | 技能/习惯/元认知 | 无显式 | 13 技能、熟练度/迁移/退化；Brier/校准/insight | **领先** | — |
| 36 | 真实外部知识源 | B站/空间等真实网络 | Wikipedia/OpenAlex/GitHub/RSS 接口 + fake 测试 | 部分 | M3 |

### 3.8 策略、主动与目的

| # | 能力 | Aurabot | dsh-bot | 状态 | 目标 |
|---|---|---|---|---|---|
| 37 | 候选效用/bandit/结果归因 | 模块化 hooks + 群聊策略 | Beta 后验、效用、限频、沉默、撤回专项 | **领先** | — |
| 38 | 目的引擎/计划 | `purpose/engine.js` 2,287 行，目标/计划/执行 | goal/plan/intent CRUD、优先级/进度/步骤、少量注入、`/purpose`、面板；无执行器 | 部分（M3-a） | M3 剩余/M5 |
| 39 | 主动搭话 | 醒着时间/频率/白名单/晚安心情 | 安静时段/日预算/关系门槛/退避/dryRun | 部分 | M3 |
| 40 | 定时/后台任务 | 有 | 无 | 无 | M1/M3 |

### 3.9 媒体

| # | 能力 | Aurabot | dsh-bot | 状态 | 目标 |
|---|---|---|---|---|---|
| 41 | TTS/语音条/ASR | edge-tts / CosyVoice / GPT-SoVITS / HTTP；QQ PTT 文本/DSH STT | OpenAI 兼容 ASR/TTS；record 转写；TTS 落 MP3/base64 发送；`/tts` 默认 300 字；面板只落盘测试；默认关闭 | 部分（M4-b） | 无自动语音策略、多音色编排、RVC/翻唱或 Agent 工具；待真机 |
| 42 | 翻唱/RVC | 网易云→分离→RVC→混音 | 无 | 无 | M5（可豁免） |
| 43 | 表情包 | 收集/尺寸/去重/打标/按语境发/商城 | 面板手动上传；PNG/JPG/JPEG/GIF/WebP；默认 5 MiB/张、200 张；SHA-256 去重；人工标签；`/sticker [标签]` 随机发 | 部分（M4-b） | 不自动收集、缩放转码、语境/情绪选择或接商城 |
| 44 | 图片收发/视觉/生图/改图 | 有 | 入站下载；OpenAI 兼容 Vision 描述进上下文/记忆；base64 出站；媒体面板预览表情包并按 ID 取图 | 部分（M4-b） | 无普通图片发送面板/命令、生图/改图或真机验证 |
| 45 | 文件发送/接收 | 有 | 白名单扩展名下载；OneBot 群/私聊文件上传动作与服务 | 部分（M4-a） | 无面板/命令；网关兼容性未实机验证 |
| 46 | 本地接口（TTS/生图/识别脚本） | 有 | `/media/status|test|tts`；表情包列表/base64 上传/标签/删除/按 ID 取图；不接受任意路径 | 部分（M4-b） | 无脚本桥、生图/改图接口或任意本地路径入口 |

### 3.10 社交内容

| # | 能力 | Aurabot | dsh-bot | 状态 | 目标 |
|---|---|---|---|---|---|
| 47 | QQ 空间日记/评论/好友动态 | 有 | **未实现**：需要 QQ 登录授权，且需单独审查平台授权与 ToS；面板明确提示 | 无（需授权，未获豁免） | M6/M7 或用户确认豁免 |
| 48 | B 站浏览/评论/分享 | 有（WBI/字幕/热评） | 默认关闭的公开搜索/热门/BV 基本信息、`/bili`、REST 与内容页；无 Cookie/WBI | 部分（M5-b） | 无评论/分享/字幕/登录态；真实接口待验 |
| 49 | 抖音/小黑盒 | 社区模块 | 无 | 无 | M5（可豁免） |
| 50 | 桌宠 | 有（Electron 客户端） | 无 | 无 | M5（可豁免） |

### 3.11 模块与扩展

| # | 能力 | Aurabot | dsh-bot | 状态 | 目标 |
|---|---|---|---|---|---|
| 51 | 模块内核/热重载/替换/隔离 | `core/modules.js` + 快照 + 出错隔离 | M5-a 本地 kernel：manifest、权限、启停/重载、cleanup、错误隔离 | **受限实现** | M5-a：无进程/VM 沙箱、依赖解析或文件监视 |
| 52 | 模块市场/社区库 | 有 | 无 | 无 | M5 |
| 53 | 扩展 API/类型/教程/模拟测试 | API.md + `.d.ts` + MODULE-TUTORIAL | M5-a 稳定 JS API + `docs/MODULES.md` + real dynamic-module tests；无 `.d.ts` | 部分 | M5-a：本地 JS only，无 SDK/类型包 |
| 54 | 外部知识源/动作注册 | 模块 API | 权限门控 knowledge/capability 注册 + command/event/sendText/storage；无通用动作总线 | 部分 | M5-a：仅明确 API，发送仍强制走 outbound |

### 3.12 运维、UI、文档与测试

| # | 能力 | Aurabot | dsh-bot | 状态 | 目标 |
|---|---|---|---|---|---|
| 55 | 面板页数 | 约 25 个功能页 | 13 个标签（含媒体、内容、模块） | 部分 | M6 |
| 56 | 设置向导 | 有 | 连接步骤（地址→连接→核验） | 部分 | M6 |
| 57 | 备份/恢复 | zip 备份 + 恢复 + 迁移 | 只有 SQLite backup | 部分 | M6 |
| 58 | 升级检查/beta 通道 | 有 | 无 | 无 | M6 |
| 59 | 工作区迁移/离峰省钱 | 有 | 无 | 无 | M6 |
| 60 | 用户手册/模块教程/测试覆盖 | 用户手册 + 模块教程 + 117 测试文件 | 正式文档更全但用户手册浅；22 测试文件 | 部分 | M6/M7 |
| 61 | 真机 QQ/媒体验证 | 有用户群与实机路径 | mock + 探针；真实媒体未验 | 部分 | M7 |

## 4. dsh-bot 的相对优势（不要为了对标丢掉）

1. **认知状态是一等公民**：情绪、人格、关系、信念、技能、策略、元认知都有独立表与演化规则；Aurabot 是心情 + 记忆 + 群策略。
2. **人格级认知数据隔离**：多人格库 Aurabot 也有，但 dsh-bot 把记忆/人物/关系/情绪/策略按 `persona_<id>:` 命名空间隔离，并支持按组复制/导入/导出。
3. **模型协议广度**：OpenAI Chat/Responses、Anthropic、Gemini、Ollama + OpenCode Go/Command Code/OpenRouter 预设 + 自定义 base/header/auth。
4. **OneBot 细节与网络健壮性**：3 种鉴权、握手超时、指数退避、账号核验缓冲、FTS5 降级。
5. **工程可审计性**：实现状态、覆盖矩阵、决策记录、历史验证。

## 5. 结构性差距：为什么必须先做 DSH Session 运行时

### 5.1 现状数据流

```
QQ → OneBot 网关 → host.onEvent → normalize → events → cognition.observe
  → pipeline：turn → 人物/关系/情绪 → 记忆检索 → 分析 → 策略 → compose（llm.stream）
  → gateway.actions.sendMessage
```

问题：
- 每次分析/生成都是独立一次性调用，无法使用 DSH 的工具、MCP、附件、子智能体、后台任务、定时任务。
- 没有 Session，就没有「同一聊天的长上下文/工具轨迹/插话/审批」这些 Aurabot 已经产品化的能力。
- 回复只能靠本地拼 prompt，人格/记忆注入与 DSH 的原生 Persona 体系重复。

### 5.2 目标数据流（M1）

```
QQ → 网关 → events → access（主人/白名单/档位）
  → turn 聚合 → runtime.sessionFor(chat)
  → agent.followup(message) / agent.steer(message)
  → DSH Agent（preset：private 带工具 / social 无本机工具）
  → session 事件 → 清洗/分条/引用 → outbound（access → 限频 → dryRun）→ 网关
  → 回合后：cognition 用 transcript 做结果归因/记忆写入
```

### 5.3 可用服务（DSH 0.2.2 已核实）

`ctx.agents`、`ctx.sessionController`、`ctx.workspaceRegistry`、`ctx.attachments`、`ctx.systemPrompt`、`ctx.speechToText`、`ctx.jobs`、`ctx.schedule`、`ctx.tools`（按 Agent scope）。

关键 API：
- `sessionController.create({ workspaceId, agentPreset })`
- `sessionController.resolveAgent(sessionId)` / `rename`
- `agent.followup(message)` / `agent.steer(message)`
- `agent.ctx.tools.register(...)` / `agent.ctx.systemPrompt.context(...)`
- `ctx.systemPrompt.variable(name, fn)`（人格/规则变量）

### 5.4 迁移路径

- **A（推荐）**：认知内核做「回合前状态提供者 + 回合后分析器」，回复由 Agent 生成；避免重复 compose 调用。
- **B（过渡）**：保留现有 analysis/policy，只用 Agent 做 compose；工具能力有限，但迁移风险小。

`runtime.engine: 'oneshot' | 'agent'` 默认 `oneshot`；没有 `sessionController` 时自动回退；用 fake 宿主单测 + 临时 profile 真机 smoke 通过后再翻默认。

### 5.5 风险

- DSH 0.2.x 内部 API 可能变：feature-detect + 回退 + 版本锁 `>=0.2 <0.3`。
- 每聊天一个 Session 的会话膨胀、备份/迁移、上下文成本。
- 自循环/重复回复：保留 turn 层 self 防护 + outbound 单一出口。
- 提示词缓存：状态注入放对话末尾，不破坏前缀。

## 6. 里程碑

| 里程碑 | 主题 | 关键交付 | 验收 |
|---|---|---|---|
| **M0（已完成）** | 视觉与矩阵 | Archify 装入 `web`；5 张视觉基线；本报告 | 见 §7 |
| **M1** | 运行时 + 权限 | Session/preset/映射/工具挂载/prompt 变量；access；outbound；命令；按聊天模型；回退 | 主人私聊有工具、群聊无本机工具、无重复回复、回退可用 |
| **M2** | 群聊交互 | 分条/引用/@/合并转发/拍一拍/表态/通知；群 admission/防刷屏；QQ 动作权限 | 群聊场景套件全绿 |
| **M3** | 记忆/心情/目的 | 每日整理、原话→梗概→印象、人物/群档案、时间轴、导入导出、容量、向量 seam；心情升级；目的引擎/主动 | 30 天模拟 + 面板可查改删 |
| **M4** | 媒体 | TTS/ASR/语音条、表情包、图片收发/视觉/生图、文件、本地接口 | 真机发出语音/表情/图；看图回答 |
| **M5** | 社交内容 + 模块 | 空间/B站/抖音/小黑盒/桌宠/翻唱（可豁免）；模块内核/市场/API/热重载/模拟 | 模块可装/换/热更新 |
| **M6** | 运维/UI/安全 | 备份恢复、升级提示、工作区迁移、离峰省钱、本机-only/CSRF/反代、审批/危险确认、向导、25 页 | 安全评审 + 向导 + 备份恢复 |
| **M7** | 审计发布 | parity matrix 关闭、性能/成本、真机验收、发布 | 所有行「实现」或「豁免」 |

## 7. M0–M3 交付（已完成部分）

**M0（视觉与矩阵）**
- Archify 安装与验证：见 [ARCHIFY.md](../ARCHIFY.md)。
- 视觉基线：见 [docs/visuals/README.md](../visuals/README.md)。
  - `current-architecture.html`、`target-architecture.html`
  - `message-lifecycle.html`、`turn-lifecycle.html`
  - `parity-roadmap.html`
- 全部 5 张图通过 `validate` + `deliver` + `check` + `browser-check`（Archify 3.0.1，Chrome for Testing 157）。
- 本文 + 文档校正。

**M1-a（访问控制 + 统一出站）**
- `src/core/access.js`：open/allowlist、主人/私聊/群白名单、入口判定、审计环形缓冲、计数。
- `src/cognition/outbound.js`：回复/撤回/主动行为统一出站；访问 → 频率 → dryRun → 发送；失败不重试。
- 配置 `access.*` 与「配置 → 访问控制」分组；概览访问控制卡片；`/access/stats`、`/access/check`。
- 测试：`test/access.test.js`、`test/outbound.test.js`、e2e allowlist 用例；默认 open 回归不变。
- 边界：逐项工具权限/审批、真机 allowlist 验证留到 M1 剩余 / M2。

**M1-b（DSH Session 运行时）**
- `src/runtime/agent.js`：`sessionController` + `workspaceRegistry` + `agents` 探测；`sessions.json` 映射；`dsh-bot-private` / `dsh-bot-social` preset；`agent.followup` + `session/event` 取最终 assistant 文本；每聊天串行、超时、失败回退 `oneshot`。
- `cordis.patch.yml` 增加两个 agent preset；`host.apply` 注册 `{{dshbot_persona}}` / `{{dshbot_rules_private}}` / `{{dshbot_rules_social}}`。
- 配置 `runtime.*`；概览「运行诊断」显示 engine/active/会话数；`/runtime/stats`、`/runtime/sessions`。
- 测试：`test/runtime.test.js`（Session 复用、preset 选择、工具中间文本丢弃、空回复/超时、并发串行、oneshot 回退）。
- 边界：默认 `oneshot`；未在真实 DSH Session 上做 live smoke；QQ 动作工具/命令/按聊天模型留到 M1 剩余。

**M1-c（QQ 命令 + 按聊天模型）**
- `src/cognition/commands.js`：`/status` `/quiet` `/active` `/model` `/remember` `/forget` `/help`；只处理 `/name args`，非主人静默；命令回复走 outbound。
- `cognition.modelRouting`：私聊/群默认 + `QQ号或群号=provider/model` 会话覆盖；`/model` 写回；provider 在直连列表则 direct，否则 DSH。
- 命令在 pipeline 的分析/策略前处理；`/quiet` `/active` 写回群聊参与/主动开关；`/remember` `/forget` 使用记忆服务。
- 测试：`test/commands.test.js`、`test/model-llm.test.js` 的按聊天覆盖用例。
- 边界：仅认知 LLM；agent Session 模型、`/sing` 等媒体命令留到后续。

**M3-c（时间轴）**
- `cognition/timeline.js`：turn/memory/decision 合并、倒序、before 分页、types/scope 过滤；API `/cognition/timeline`；认知「时间轴」页。
- 测试：`test/timeline.test.js`（排序/before/type/scope/空输入）。
- 边界：只读；无导入旧档案、无编辑。

**M3-a（目的系统）**
- `cognition/purpose.js`：goal/plan/intent，active/paused/done/abandoned；优先级/进度/步骤/截止/作用域；`promptContext` 限量注入 compose；`tick` 给建议不执行。
- `/purpose` 列表/新建/完成/放弃/暂停/恢复/进度；认知面板「目的」页 CRUD；API `/cognition/purpose*`。
- 测试：`test/purpose.test.js`、commands 用例、cognition 集成（目的注入/完成停止注入）。

**M3-b（每日整理/反思）**
- `cognition/consolidation.js`：每日 04:00 调度 `memory.consolidateAll()`；按作用域 LLM 反思，只压缩已有记忆，写回同 scope（source=reflection）；私聊不跨聊/不写 global。
- 面板记忆页「整理/反思」；API `/cognition/consolidation*`；配置 `consolidation.*`。
- 测试：`test/consolidation.test.js`（scope 隔离、条数门槛、LLM 失败不写、调度时间、状态）。
- 边界：无时间轴、批次/重试/保留策略、人物档案编辑页、向量检索。

**M2-b（合并转发/拍一拍/表态/QQ 动作）**
- `gateway/forward.js` + `actions.getForwardMsg`：兼容 `id`/`message_id`，节点压平成 `发送者：内容`；pipeline 展开进 `turn.text` 并标记不可信。
- 拍一拍：只回应 `target_id==botQQ` 的 notify/poke，按用户冷却，走 outbound；表情回应按 messageId 归因为正向 outcome。
- `cognition/qq-actions.js`：点赞/拍回去/群信息/成员信息；`/like` `/poke` `/groupinfo` `/memberinfo` 仅主人、仅当前会话。
- 测试：`test/forward.test.js`、`test/qq-actions.test.js` + cognition 集成（展开进记忆、拍一拍冷却、表态 outcome）。
- 边界：改资料/群管/文件/精华/撤回等动作、agent 工具化仍未做。

**M2-a（回复分条/引用/@/防刷屏）**
- `src/cognition/reply-split.js` + `pipeline.sendDecision`：长回复按段落/句末切分，最多 `maxParts` 条，剩余内容并入最后一条；每条走 outbound，支持分条间隔。
- `cognition.reply.quote` / `atSender`：首条引用原消息、群聊 @ 发送者；配置默认引用开、@ 关。
- `cognition.turn.maxConsecutiveGroupReplies`：连续未点名接话上限，点名回复清零，与冷却/每分钟上限并存。
- 测试：`test/reply-split.test.js` + cognition 集成（分条内容不丢、reply/at 段、连续接话后点名仍回）。

## 8. 完成定义与豁免

**完成**：矩阵每一行满足其一：
1. dsh-bot 有等价实现，且有自动化测试或受控真机 smoke 证据；
2. 经用户明确同意列为非目标，并在本文件记录理由。

**豁免流程**：提出行号 → 说明为什么不做（定位/许可/成本）→ 用户确认 → 标记「豁免」并保留原因。
默认建议豁免：桌宠、RVC 翻唱、抖音/小黑盒；除非定位从「认知内核」转为「全功能陪伴产品」。

**验收纪律**：
- 没有证据不标「有」；`部分` 必须写清缺哪一半。
- 每个里程碑结束更新本文件与 `docs/visuals/`。
- 真机验证只在临时 profile、dryRun/白名单下进行，不打扰现有 `web` 机器人。

## 9. 复现与维护

```sh
# 计数（dsh-bot）
find src -name '*.js' | xargs wc -l | tail -1
ls test/*.test.js | wc -l
node --test "test/*.test.js"

# 计数（Aurabot，浅克隆）
git clone --depth 1 https://github.com/aureth-labs/dsh-aurabot-qq.git /tmp/aurabot
cd /tmp/aurabot && git rev-parse --short HEAD
find src -name '*.js' | xargs wc -l | tail -1

# 视觉重生成
bash scripts/archify-visuals.sh
```

Aurabot 证据入口：`README.md`（能力表/模块/安全/面板）、`docs/USER-MANUAL.md`（逐项用法）、`docs/DESIGN.md`（实现取舍）、`src/chat/access.js`（权限）、`src/chat/hub.js`（Session/工具）、`src/features/memory.js`（记忆）、`src/purpose/engine.js`（目的）、`cordis.patch.yml`（4 个 preset）。

dsh-bot 证据入口：`docs/cognitive/IMPLEMENTATION-STATUS.md`、`src/cognition/**`、`src/model/**`、`src/gateway/**`、`src/http/routes.js`、`client.js`、`test/**`。
