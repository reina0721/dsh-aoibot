# M7-a/M7-b/M7-c/M7-d/M7-f/M7-g/M7-h/M7-i/M7-j/M7-k/M7-l/M7-m/M7-n 对标审计、用户豁免与临时 profile smoke

快照日期：2026-11-06（UTC）。**并非全量对齐（not full parity）**。本页读取当前仓库的 [§3.x 能力矩阵](research/GAP-AURABOT.md#3-能力矩阵)，不把计划、静态计数或本机 API smoke 当成真实 QQ/媒体/外部服务证据；M7-b 已按 2026-11-06 用户批准将 #16/#47/#52/#55/#59 标为 exempt；后续又批准 #42/#49/#50（RVC/抖音小黑盒/桌宠）豁免，并更新固定主人命令的实际边界。M7-c 更新 #44/#46：默认关闭的兼容生图/edits、本地 API/面板与主人图片命令，仍为 partial，未验证真实 provider/QQ。**exemptions are explicit user decisions, not implementation evidence**（豁免是明确用户决定，不是实现证据）。准确范围与理由见 [GAP §8.1](research/GAP-AURABOT.md#81-用户批准豁免)；不豁免 #44（生图/改图）或其他差距，不改变本机-only/CSRF 行为。

M7-n 更新 #14：默认空的 `cognition.permissions.deniedCommands`，严格数组/小写命令名、去重/最多100/非法项 issue、string-list 配置字段。身份检查后、内置与模块派发前拦截，小写解析避免大小写绕过；主人固定提示、非主人静默，不调用处理服务/handler 或写配置；未知命令与帮助保持原样。仅离线配置/fake 服务测试，没有所有服务/工具的逐项 allow/deny 矩阵或统一审批，API/直接服务/Agent 工具及模块同进程代码不覆盖。#14 仍 partial，remaining 47，#31/#42/#49/#50 不变。

M7-m 更新 #48：默认关闭的公开评论与离线分享，view 获取 aid 后读 reply 第一页，置顶优先、rpid 去重、limit 默认 10/上限 20、纯文本正文 500 Unicode 字符；新增主人命令、两个 GET 路由与内容页 BV 查询。分享仅离线校验并生成固定域名链接，不验证视频存在。仅 fake fetch/宿主/mock UI 测试，无 Cookie/WBI/登录/字幕/发布评论/新增 Agent 工具或依赖，真实 B站未验证。#48 仍 partial，37 partial / 3 none、remaining 47，#31/#42/#49/#50 不变。

M7-l 更新 #8/#40：默认关闭的主人本地一次/重复固定文本提醒，owner/当前聊天/Unicode/时间/限额/防重；每次最多 20 条，统一 outbound 访问/限频/leak guard/dry-run，延迟安全重试、不补错过次数、自调度不重叠/dispose、异步固定原人格。新增 reminders 人格数据组与三个主人命令；无 DSH jobs/长任务/LLM 执行/任意代码或外部任务调用/提醒 HTTP 或管理面板。真实定时器与 QQ 未验证，仅离线测试；#8/#40 从 none 改为 partial，37 partial / 3 none，remaining 47，#31/#42/#49/#50 不变。

M7-f 更新 #31：默认关闭的 OpenAI 兼容 embeddings 重排词法候选；同步词法保留，错误回退，不重复强化。只有 fake provider/假 embedder 离线测试，无本地模型/独立 reranker/向量数据库/全库向量召回，真实 provider 未验证；#31 仍 partial，其余状态与豁免不变。

M7-g 更新 #29：当前人格 facet（含 group-scope 群印象）可编辑内容/置信度/可选状态；关系卡可在原作用域内手动调整 API 返回的 10 维，显式保存变化项，既有后端记录 source=ui 历史。仅 UI 与 mock 面板测试，无新增端点/Agent 工具/自动审批；无独立人物说话方式编辑器或 Aurabot 专用人物/群档案导入，无本轮浏览器 V，#29 仍 partial。

M7-h 更新 #30：通用 JSON/JSONL 新增时间轴事件导入（默认仍为记忆），事件时间必填、独立存储/幂等 ID、当前人格及 scope 隔离；面板种类选择与 event 筛选。仅合成数据/离线服务、API 与面板测试；无 Aurabot 专用迁移或真实旧档案样本，#30 保持 partial，#31/#42/#49/#50 状态不变。

M7-k 更新 #45：本地文件上传/列表 API 与媒体页文件区，固定 files 目录、媒体/文件双开关、安全 basename≤120、严格规范 base64、解码大小与 15 MiB JSON 体积上限、realpath/符号链接检查和 wx 防覆盖；最新 500 项、全部合格文件总字节数、客户端预检/防重/错误/刷新。仅离线服务/fake 宿主/mock 面板证据；无文件发送/删除/下载面板，发送仍用主人 `/file`，真实 QQ 未验证。#45 仍 partial，#31/#42/#49/#50 不变，remaining 47。

M7-j 更新 #3/#15：十种已知通知（含群名/头衔/精华/离线文件）校验/去重写当前人格时间轴；好友/群请求只存 pending，主人列表与 approve/reject 固定 confirm，服务复核身份/开关/状态，固定请求 action、并发防重及原人格完成写入。flag 不进公共列表/回复/日志，备注和通知文本限长/去控制字符/已知密钥脱敏；新增 requests 人格数据组。仅合成事件/fake 网关证据，无自动审批/审批面板/新增请求 API/Agent 工具，无通用审批/逐项权限或 PII 检测，真实 QQ 未验证；#3/#15 仍 partial，#31/#42/#49/#50 不变，remaining 47。

M7-i 更新 #15：默认启用 + redact 的本地出站文本密钥规则，可选 block，100k UTF-16 单元上限，dry-run 也检查，leakBlocked 计数；安全页只读 enabled/action，没有扫描内容/密钥。仅离线规则/fake 网关/配置与 mock 面板证据；无统一审批/逐项权限、PII/熵检测或媒体/文件扫描，可能误报/漏报，跨段/跨消息及独立发送路径不覆盖。#15 仍 partial，#31/#42/#49/#50 不变，remaining 47。

## 临时 profile smoke 证据

M7-d 更新 #30：通用 JSON/JSONL 经面板/API 导入当前人格记忆，本地处理、限额/作用域校验与幂等去重。#30 仍 partial；无 Aurabot 专用迁移、向量或时间轴事件导入，无真实旧档案样本验证。#31/#44 保持 partial；#42/#49/#50 后续获用户豁免。

2026-11-06 实际运行 `DSH_BIN=/opt/dsh/bin/dsh PATH=/opt/dsh/bin:$PATH npm run smoke:temp`：临时 `web` profile 启动成功，`health/status/config/modules/media/status/backup/upgrade` 全部返回 `ok:true`，创建并列出一次本地备份，退出码 0，临时目录已清理；未连接 QQ、未请求 B站/GitHub/媒体 provider。摘要见 [m7-smoke.json](assets/m7-smoke.json)（已移除 token 与临时路径）。

## 复现与计数口径

在仓库根目录执行（Node 24，无新增 npm 依赖）：

```sh
npm run check:parity
npm run --silent check:parity -- --json
npm test
npm run check:docs
```

[审计脚本](../scripts/parity-audit.mjs)仅解析 3.x 的六列矩阵；保留代码片段内的竖线，以豁免开头的状态（忽略 Markdown 强调）优先归一为 exempt；其他按部分 → 受限 → 无 → 领先 → 有的优先级归一为 partial / limited / none / leading / has，注释中的“未获豁免”不算批准。结构问题（重复编号、格式错误、非 has 项（含 exempt）缺目标）使 CLI 返回 1；剩余差距本身不导致失败。空白、破折号目标视为缺目标。

源码为 src/**/*.js 的普通文件数与物理行数（末行无换行也计一行）；测试为 test/**/*.test.js，声明按正则 `^test(?:\.\w+)?\(` 静态计数。声明数包含 skip/todo，忽略缩进声明且不展开循环；与执行用例数不是同一口径。两者均不跟随符号链接。

下方快照由 `formatReport({ ...summarize(parseMatrix(markdown)), source: countSource(root), tests: countTests(root) })` 生成。可用 `node scripts/parity-audit.mjs > /tmp/dsh-parity-report.md` 重新生成并替换快照（当前结构检查通过，返回 0）。矩阵旧量化章节是历史快照，不用于本次计数。

当前实跑审计退出码为 **0**：61 行、无重复编号、无格式错误、非 has 项均有目标。先前 #2、#24、#33、#34、#35、#37 的目标为 —，已补为许可复核/领先无缺口说明。剩余表排除 6 个 has 与 8 个 exempt，共 47 项（其中 6 个 leading），不应理解为 47 个缺失功能。按目标列开头的显式里程碑分组；跨里程碑组合保留，无明确里程碑或明确排除范围的目标列归入“未分配里程碑”，不从已交付状态推断未来里程碑。

<!-- parity-snapshot:start -->
# 对标审计（并非全量对齐 / not full parity）

矩阵 61 项；has: 6，partial: 37，none: 3，limited: 1，leading: 6，exempt: 8。
剩余 47 项（排除 has/exempt，包括领先项；不等于缺失功能数）。
源码：66 个 JS 文件 / 16836 行。
测试静态计数：46 个文件 / 10152 行 / 436 个顶层 test 声明；包含 skip，不代表执行结果。

结构检查：通过；重复编号 0，格式错误 0，非 has（含 exempt）缺目标 0。

## M1

| # | 能力 | 状态 | 目标 |
|---|---|---|---|
| 6 | 每聊天 DSH Session | partial | M1 剩余：真机验证/工具面 |
| 8 | 后台任务/定时任务 | partial | M1：无 DSH jobs/长任务/LLM 任务执行/提醒面板，真实定时器与 QQ 未验证 |
| 9 | 会话内插话/steer/typing | none | M1 |
| 10 | 按聊天选模型 | partial | M1 剩余：agent Session 模型 |
| 11 | QQ 内命令 | partial | M1 剩余：`/sing` 等媒体命令 |
| 12 | 主人/私聊白名单/群白名单 | partial | M1 剩余：工具级权限 |
| 13 | 权限档位 | none | M1 |

## M1 / M2

| # | 能力 | 状态 | 目标 |
|---|---|---|---|
| 7 | 工具/MCP/子智能体 | partial | M1/M2 |

## M1 / M3

| # | 能力 | 状态 | 目标 |
|---|---|---|---|
| 40 | 定时/后台任务 | partial | M1/M3：仅本地主人提醒；无 DSH jobs/长任务/LLM 执行/提醒 HTTP 或面板；真实定时器/QQ 未验证 |

## M2

| # | 能力 | 状态 | 目标 |
|---|---|---|---|
| 3 | QQ 事件面 | partial | M2：真实 QQ 兼容性、未知/扩展通知与 meta 认知未验证或未覆盖 |
| 15 | 审批/危险确认/leak guard | partial | M2：无统一审批/逐项权限；无 PII/熵或媒体/文件扫描，可能误报/漏报；独立发送路径不覆盖 |
| 22 | 合并转发展开/拍一拍/表情回应/通知 | partial | M2 剩余 |

## M2 / M5

| # | 能力 | 状态 | 目标 |
|---|---|---|---|
| 14 | 逐项权限 | partial | M2 剩余/M5：仅命令 deny-list，无所有服务/工具逐项 action allow/deny 矩阵或统一审批；新动作不挂 Agent |

## M2-b

| # | 能力 | 状态 | 目标 |
|---|---|---|---|
| 20 | 群 admission | partial | M2-b：话题相关度/接梗 |

## M2-b / M4

| # | 能力 | 状态 | 目标 |
|---|---|---|---|
| 21 | 分条回复/引用/@/表情 | partial | M2-b/M4 |

## M3

| # | 能力 | 状态 | 目标 |
|---|---|---|---|
| 27 | 记忆类型 | partial | M3 |
| 28 | 每日整理/空闲提炼 | partial | M3 剩余：批次/重试/保留 |
| 29 | 人物档案/群印象/相处经验/说话方式 | partial | M3 剩余：无独立人物说话方式编辑器、无 Aurabot 专用人物/群档案导入；未做本轮真实浏览器验证 |
| 32 | 跨平台身份 | none | M3 |
| 36 | 真实外部知识源 | partial | M3 |
| 39 | 主动搭话 | partial | M3 |

## M3 / M5

| # | 能力 | 状态 | 目标 |
|---|---|---|---|
| 38 | 目的引擎/计划 | partial | M3 剩余/M5 |

## M4

| # | 能力 | 状态 | 目标 |
|---|---|---|---|
| 4 | 消息段与富媒体解析 | partial | M4 |
| 25 | 心情/情绪 | leading | M4 |

## M5-a

| # | 能力 | 状态 | 目标 |
|---|---|---|---|
| 51 | 模块内核/热重载/替换/隔离 | limited | M5-a：无进程/VM 沙箱、依赖解析或文件监视 |
| 53 | 扩展 API/类型/教程/模拟测试 | partial | M5-a：本地 JS only，无 SDK/类型包 |
| 54 | 外部知识源/动作注册 | partial | M5-a：仅明确 API，发送仍强制走 outbound |

## M6 / M7

| # | 能力 | 状态 | 目标 |
|---|---|---|---|
| 60 | 用户手册/模块教程/测试覆盖 | partial | M6/M7 |

## M7

| # | 能力 | 状态 | 目标 |
|---|---|---|---|
| 2 | SnowLuma 检测/读取 | partial | M7：许可边界复核（维持只读） |
| 30 | 时间轴/回忆日志/导入旧档案 | partial | M7：无 Aurabot 专用档案迁移或向量导入；无真实旧档案样本验证 |
| 31 | 语义检索/embedding | partial | M7：仅兼容 embeddings；无本地模型/独立 reranker/向量数据库/全库向量召回；真实 provider 未验证 |
| 44 | 图片收发/视觉/生图/改图 | partial | M7：真实 provider/QQ 生图改图未验证；不获取返回 URL，只支持 OpenAI 兼容 edits，无 mask/其他编辑后端；无普通图片发送面板/任意本地路径 |
| 46 | 本地接口（TTS/生图/识别脚本） | partial | M7：无本地识别脚本桥/任意本地路径/新图片上传下载接口；不抓 provider 返回 URL，只支持兼容 edits；真实 provider/QQ 未验证，面板/API 不自动发送 |
| 61 | 真机 QQ/媒体验证 | partial | M7 |

## 未分配里程碑

| # | 能力 | 状态 | 目标 |
|---|---|---|---|
| 23 | QQ 动作工具 | partial | 新增仅命令：昵称、名片/群名、管理员、禁言（0–30 天）/全禁、踢人、当前会话精华/撤回、媒体根内文件；无逐项权限矩阵/任意 action 透传/Agent 新工具；get_msg 缺归属则拒绝；真实 QQ 管理/资料/文件动作未验证 |
| 24 | 人格编辑/切换 | leading | 已领先（无缺口） |
| 33 | 未知检测/学习任务/claims | leading | 已领先（无缺口） |
| 34 | 信念修正 | leading | 已领先（无缺口） |
| 35 | 技能/习惯/元认知 | leading | 已领先（无缺口） |
| 37 | 候选效用/bandit/结果归因 | leading | 已领先（无缺口） |
| 41 | TTS/语音条/ASR | partial | 无自动语音策略、多音色编排、RVC/翻唱或 Agent 工具；待真机 |
| 43 | 表情包 | partial | 不自动收集、缩放转码、语境/情绪选择或接商城 |
| 45 | 文件发送/接收 | partial | 无文件发送/删除/下载面板；上传/列表需 media.enabled/files.enabled，主人发送另需 qqAdmin.enabled/access；真实 QQ 文件兼容性未验证 |
| 48 | B 站浏览/评论/分享 | partial | 仅公开评论/离线分享；无登录/WBI/字幕/发布评论，真实接口未验证 |
| 56 | 设置向导 | partial | 无独立向导/自动修复；模块始终人工待检查，媒体只检查字段，不验密钥/服务；无 API 鉴权变更，仍依赖 DSH 本机信任边界；未做真实浏览器 V |
| 57 | 备份/恢复 | partial | 复制 SQLite 前停写，恢复后重启；无在线一致性/整目录事务、云端上传下载、自动恢复或迁移 |
| 58 | 升级检查/beta 通道 | partial | beta 仅放宽预发布过滤；无后台/自动更新、下载/安装、token；未认证每 IP 60 req/h；无真实 GitHub V |
<!-- parity-snapshot:end -->

## 证据入口与边界

| 范围 | 当前代码 / 自动化证据 | 尚不能证明 |
|---|---|---|
| 审计工具 | [parity-audit.mjs](../scripts/parity-audit.mjs)、[11 个 fixture/计数/CLI 测试](../test/parity-audit.test.js) | 功能等价性、真实 QQ 验收 |
| M7-n 操作员命令禁用 | [config.test.js](../test/config.test.js)、[commands.test.js](../test/commands.test.js)：默认/数组/名称/去重/100上限/issue/字段；内置与模块、大小写、非主人静默、无处理服务调用/配置写入、未知命令/帮助/动态更新 | 仅离线 fake 服务；不覆盖 API/直接服务/Agent 工具/模块同进程代码；无所有服务/工具逐项 allow/deny 矩阵或统一审批；#14 仍 partial、remaining 47 |
| M1/M2 运行时与交互 | [runtime/agent.js](../src/runtime/agent.js)、[runtime.test.js](../test/runtime.test.js)、[access.test.js](../test/access.test.js)、[reply-split.test.js](../test/reply-split.test.js)、[runtime-qq-tools.test.js](../test/runtime-qq-tools.test.js) | 全量工具、权限矩阵、任务系统、真实 QQ |
| M3 认知 / M7-d/M7-h 导入 | [cognition](../src/cognition)、[consolidation.test.js](../test/consolidation.test.js)、[purpose.test.js](../test/purpose.test.js)、[timeline.test.js](../test/timeline.test.js)、[archive-import.test.js](../test/archive-import.test.js)、[API](../test/e2e.test.js)/[面板](../test/panel.test.js) | 真实 embedding provider、全库向量召回/向量数据库、本地模型/独立 reranker、目的执行器、Aurabot 专用迁移、向量导入、真实旧档案样本 |
| M7-m B站公开评论/分享 | [bilibili.test.js](../test/bilibili.test.js)、[commands.test.js](../test/commands.test.js)、[e2e.test.js](../test/e2e.test.js)、[panel.test.js](../test/panel.test.js)：合成响应/fake 宿主/mock UI，评论去重/限额/纯文本/默认关闭/离线分享/HTTP/超时/风控 | 真实 B站/QQ/浏览器；无登录/WBI/字幕/发布评论；#48 仍 partial |
| M7-l 主人本地提醒 | [reminders.test.js](../test/reminders.test.js)、[commands.test.js](../test/commands.test.js)：默认关闭/owner/scope/时间/Unicode/重复与限额、一次/重复成功、安全失败重试、最多20/不重叠/dispose、人格复制/删除/切换、真实 outbound 闸门、命令及 cognition 重启持久化；全部使用 fake 时间/网关 | 真实定时器/QQ；无 DSH jobs、长任务、LLM 任务执行、提醒 HTTP/管理面板；#8/#40 仅 partial |
| M7-k 本地文件上传/列表 | [media.test.js](../test/media.test.js)、[API](../test/e2e.test.js)、[面板](../test/panel.test.js)：临时文件/base64/大小/名称/开关/符号链接/固定目录/强制重名防覆盖/排序总量/上传错误/渲染刷新 | 无文件发送/删除/下载面板；真实 QQ 文件兼容性与本轮真实浏览器未验证，#45 仍 partial |
| M7-j 通知/主人请求审批 | [notices.test.js](../test/notices.test.js)、[commands.test.js](../test/commands.test.js)、[actions.test.js](../test/actions.test.js)、[集成测试](../test/cognition-integration.test.js)：通知映射/时间轴/去重、待办/公共投影、owner/开关/确认、并发/人格切换与静态错误 | 真实 QQ 事件/请求 action；未知/扩展通知与 meta 认知、通用审批/逐项权限、PII 检测、审批队列面板；#3/#15 仍 partial |
| M7-i 出站文本防泄漏 | [leak-guard.test.js](../test/leak-guard.test.js)、[outbound.test.js](../test/outbound.test.js)、[panel.test.js](../test/panel.test.js)：本地规则、重叠/上限、配置回退、访问/限频/dry-run、错误隐私与只读状态 | 统一审批/逐项权限、PII/熵检测、媒体/文件及独立发送路径、跨段/跨消息密钥；可能误报/漏报，未做真实 QQ/浏览器验证；#15 仍 partial |
| M7-g 人物/群印象与关系编辑 | [client.js](../client.js)、[panel.test.js](../test/panel.test.js) 新增 6 项；mock API、原作用域/差量保存、Unicode/数值校验、取消/禁用/失败/刷新 | 本轮真实浏览器验证、独立人物说话方式编辑器、Aurabot 专用人物/群档案导入；既有后端 UTF-16 截断未改；#29 仍 partial |
| M7-f 可选 embedding 重排 | [embeddings.test.js](../test/embeddings.test.js)、[memory.test.js](../test/memory.test.js)、[集成测试](../test/cognition-integration.test.js)；默认零调用、校验/超时/缓存/隐私、词法回退与并发写保护 | 真实 provider、本地模型、独立 reranker、向量数据库、全库向量召回；#31 仍 partial |
| M4 媒体 | [media](../src/media)、[media.test.js](../test/media.test.js)、[stickers.test.js](../test/stickers.test.js) | 真实网关/媒体 provider、RVC、生图、自动语境选图 |
| M5 内容与模块 | [bilibili.test.js](../test/bilibili.test.js)、[modules.test.js](../test/modules.test.js)、[模块文档](MODULES.md) | 真实 B站、QQ空间授权、模块市场或进程沙箱 |
| M6 运维与面板 | [backup.test.js](../test/backup.test.js)、[upgrade.test.js](../test/upgrade.test.js)、[panel.test.js](../test/panel.test.js)、[API 路由](../src/http/routes.js) | 在线 SQLite 一致性、真实 GitHub、自动升级、迁移、真实浏览器验收 |
| M7-b 主人 QQ 管理命令 | [qq-actions.test.js](../test/qq-actions.test.js)、[commands.test.js](../test/commands.test.js)、[actions.test.js](../test/actions.test.js)、[media.test.js](../test/media.test.js)；fake 网关/本地临时文件，默认关、owner/access/确认/当前会话/realpath 闸门 | 真实 QQ 管理/资料/文件动作尚未验证；消息查询缺归属则拒绝；无新增 Agent 工具/任意 action 透传/媒体根外文件 |
| M7 本机宿主 smoke | [smoke-temp-profile.sh](../scripts/smoke-temp-profile.sh) 与下方实际结果 | QQ 登录/收发、外部模型、B站/GitHub 或全量 parity |

## 临时 profile smoke

```sh
npm run smoke:temp
# DSH 不在 PATH 时指定可执行文件；若 DSH 需要 pnpm，也应将已有工具加入 PATH：
DSH_BIN=/opt/dsh/bin/dsh PATH=/opt/dsh/bin:$PATH npm run smoke:temp
```

脚本总是用 mktemp 创建新 DSH_HOME，忽略调用方的 live home，并将 DSH_BOT_DATA_DIR 固定在临时 home 下；profile 名称是 web，但不会操作原有 web profile。先执行 `dsh --profile web --dump-config`，在插件启动前写入 `plugins-data/dsh-bot/config.json` 为 `{"enabled":false}`，再用 `dsh plugin --profile web add "$ROOT"` 安装本地工作区。包管理仅允许离线缓存，禁用 DSH 遥测，不下载 npm 依赖；缓存或已有包管理工具不足时会失败，不自动补装。

宿主以 `dsh web --no-open --host 127.0.0.1 --port <free>` 后台启动，最多等 30 秒获取日志 URL/token，随后最多等 30 秒等插件健康；curl 限制为 HTTP 回环地址、绕过代理、不跟随重定向。令牌只用于本机启动握手，不输出到摘要。只查询插件前缀 `/onebot-qq/api` 下的 `/health`、`/status`、`/config`、`/modules`、`/media/status`、`/backup`、`/upgrade`，逐个断言 ok:true；验证 status.version 非空、dataDir 指向临时目录、config.enabled:false、upgrade.enabled:false。随后 POST `/backup/create`，验证 item.id 并再次查询备份列表确认存在。结束时停止后台进程并清理临时目录；不会调用 connect、媒体测试、B站或升级检查接口。

成功证据是单行 JSON（npm 自身可能在前面打印命令横幅）：ok、profile、temporary、version、dataDir、enabled、upgradeEnabled、endpoints、backupId。失败时返回非零，JSON 包含 ok:false、stage、exitCode，并清理目录。启动日志不输出，避免泄露 token。

本次实际执行：默认 `npm run smoke:temp` 退出 **1**，原因为 PATH 中无 dsh，stage=preflight；使用上面的 DSH_BIN/PATH 命令，已有 DSH **0.2.2-rc.1**，最终脚本实跑退出 **0**，输出如下（该临时目录已清理；不是长期可用的备份）：

```json
{"ok":true,"profile":"web","temporary":true,"version":"0.10.0","dataDir":"/tmp/dsh-bot-smoke.pupxsN/home/plugins-data/dsh-bot","enabled":false,"upgradeEnabled":false,"endpoints":["health","status","config","modules","media/status","backup","upgrade"],"backupId":"20261106T092811073Z-b7d12ac7"}
```

M7-c 本次 `npm test` 实跑退出 **0**：331 项，327 通过、0 失败、4 跳过（live 模型测试）。静态 304 个声明与执行 331 项的差异来自循环/缩进等声明形式。`npm run check:docs` 实跑退出 **0**，本地文档链接与当前命名检查通过；`npm run check:parity` 实跑退出 **0**，快照已按 #44/#46 的 M7-c 状态/目标更新。M7-c 测试使用 fake fetch/FormData、临时 PNG 和 fake QQ 网关；生成/编辑 API 只落盘，不自动发送。上述 smoke 是先前记录，仅证明关闭 QQ 的临时宿主/API 启动与本地备份路径；本次未运行真实 provider/QQ，不宣称真实图片生成/编辑已验证或全量对齐。

M7-d 本次 `npm test` 实跑退出 **0**：346 项，342 通过、0 失败、4 跳过（live 模型测试）。新增 12 项导入服务/配置/人格隔离测试，以及 API 和面板测试；验证通用 JSON/JSONL、去重、作用域/限额、时间戳和日志隐私。`npm run check:docs` 与 `npm run check:parity` 均退出 **0**；快照由本次 parity 命令输出更新，#30 保持 partial，#31/#44 保持 partial，#42/#49/#50 后续获用户豁免。本次仅离线合成数据与 fake 宿主测试，未运行真实旧档案或新增真实 DSH/浏览器验证。


M7-f 本次最终 `npm test` 实跑退出 **0**：380 项，376 通过、0 失败、4 跳过（既有 live 模型测试）。较 M7-d 新增 34 项运行用例，覆盖 fake fetch 请求/auth/超时/向量校验/LRU/cosine/日志隐私、异步重排与回退不重复写入、同步词法不变、默认零 embedding 网络及 pipeline await；等待期间切换人格、删除记忆、并发检索也有回归测试。`npm run check:docs` 与 `npm run check:parity` 均退出 **0**；快照已刷新，仍为 6 has / 35 partial / 5 none / 1 limited / 6 leading / 8 exempt，47 remaining。#31 保持 partial，#42/#49/#50 的 exempt 及其他状态不变。无新增依赖或真实 provider/QQ 验证；只实现 OpenAI 兼容 embeddings 对词法候选重排，无本地模型/独立 reranker/向量数据库/全库向量召回。


M7-g 本次最终 `npm test` 实跑退出 **0**：386 项，382 通过、0 失败、4 跳过（既有 live 模型测试）；新增 6 项面板测试，面板单独运行 37 项全部通过。覆盖人物/群印象编辑的 Unicode/置信度/状态校验、保留原人物/作用域与删除、关系全部 10 维和差量提交、显式保存/取消、保存期间禁用与重复提交保护、失败 toast/草稿保留及刷新；所有新增 API 请求均 mock，不访问真实网关或外部服务。`npm run check:docs` 与 `npm run check:parity` 均退出 **0**；快照为源码 63 个 JS 文件 / 16074 行，测试 43 个文件 / 8439 行 / 350 个顶层声明，矩阵仍为 6 has / 35 partial / 5 none / 1 limited / 6 leading / 8 exempt，47 remaining。#29 仍 partial（无独立人物说话方式编辑器/Aurabot 专用人物或群档案导入）；其余状态和豁免不变。仅改 UI、测试与文档，未改后端或 `cordis.patch.yml`、未新增依赖/Agent 工具/自动审批、不自动发送 QQ；既有 UTF-16 截断保留，未新增真实浏览器或 QQ 验证，架构视觉无须重生成。


M7-h 本次最终 `npm test` 实跑退出 **0**：396 项，392 通过、0 失败、4 跳过（既有 live 模型测试）。新增 10 个顶层测试声明，并扩展既有记忆导入面板用例；覆盖时间轴 JSON 数组/包装/单项/JSONL、必填时间与无效/未来时间回退、Unicode/标题/字段白名单、限额、作用域/人物/时间身份与幂等不覆盖、当前人格隔离/持久化/统计/复制/删除、事件默认聚合/分页/筛选、面板种类选择/结果标签及本地 API。面板单独 38 项全通过；最终导入/面板/人格作用域专项 61 项全通过。`npm run check:docs` 与 `npm run check:parity` 均退出 **0**；生成快照为源码 63 个 JS 文件 / 16114 行，测试 43 个文件 / 8657 行 / 360 个顶层声明。矩阵仍为 6 has / 35 partial / 5 none / 1 limited / 6 leading / 8 exempt，47 remaining；#30 保持 partial，#31/#42/#49/#50 的矩阵行逐字未改。无新依赖、外部调用或真实 QQ 发送，未改 `cordis.patch.yml`；只有通用合成事件，无 Aurabot 专用迁移、向量导入、真实旧档案样本或本轮浏览器验证。


M7-i 本次最终 `npm test` 实跑退出 **0**：409 项，405 通过、0 失败、4 跳过（既有 live 模型测试），耗时 77733.699328 ms。新增 13 个顶层测试声明，并扩展既有安全页面板用例；覆盖全部密钥模式/正常文本、重叠计数与脱敏、不变性/非文本保留、block、100k 单项/合计上限、截断 PEM/重复前缀、静态无匹配值错误、动态配置/默认回退/禁用、仅类别次数日志、outbound 访问/限频先行、dry-run 扫描与网关错误隐私。首次专项 66 项全部通过；此后增加了同一规则用例内的通用 key 标点样本，完整套件通过。`npm run check:docs` 与 `npm run check:parity` 均退出 **0**；快照为源码 64 个 JS 文件 / 16251 行，测试 44 个文件 / 8836 行 / 373 个顶层声明。矩阵仍为 6 has / 35 partial / 5 none / 1 limited / 6 leading / 8 exempt，47 remaining；#15 仍 partial，#31/#42/#49/#50 的矩阵行逐字未改。无新依赖、外部调用、自动审批或真实 QQ/浏览器验证，未改 `cordis.patch.yml`。仅逐段文本密钥规则，无统一审批/逐项权限、PII/熵检测或媒体/文件扫描，可能误报/漏报；跨段/跨消息与独立发送路径不覆盖。


M7-j 本次最终 `npm test` 实跑退出 **0**：425 项，421 通过、0 失败、4 跳过（既有 live 模型测试），耗时 70843.219057 ms。新增 16 个顶层测试声明；首次 notices/actions/commands 专项 48 项全通过。覆盖十种通知映射/字段/时间轴/确定性去重/未知和无效输入，好友/群请求存储/列表/flag 去重/无自动动作，owner/配置/boolean/长度/confirm/访问控制，固定 OneBot 参数，成功/失败公共投影和日志隐私，并发只调用一次及人格切换完成写入、请求数据统计/复制/删除，accepted/暂停分流与零网关动作。`npm run check:docs`、`npm run check:parity` 均退出 **0**，快照由本次审计生成。矩阵仍为 6 has / 35 partial / 5 none / 1 limited / 6 leading / 8 exempt，47 remaining；#3/#15 保持 partial，#31/#42/#49/#50 矩阵行逐字不变。无新依赖、外部调用、真实 QQ 发送或自动审批，未改 `cordis.patch.yml`；没有审批队列面板/新增请求 REST API/Agent 工具，也没有通用审批/逐项权限或 PII 检测，真实 QQ 事件/审批动作未验证。

M7-k 本次最终 `npm test` 实跑退出 **0**：436 项，432 通过、0 失败、4 跳过（既有 live 模型测试），耗时 82416.139695 ms。新增 11 个顶层测试声明；最终媒体专项 21 项全通过，面板专项 40 项全通过。覆盖本地上传/列表、规范严格 base64 与空数据/大小/文件名/扩展名、总开关与文件开关、固定目录和文件/目录符号链接、并发重名及强制时间戳/UUID 碰撞不覆盖、最新 500 项与全部合格文件总量、超过旧 1 MiB 请求体的上传及固定 15 MiB 入口上限、客户端预检/读取失败/防重/错误/禁用/渲染/刷新。`npm run check:docs`、`npm run check:parity` 均退出 **0**；快照为源码 65 个 JS 文件 / 16505 行，测试 45 个文件 / 9430 行 / 400 个顶层声明。矩阵仍为 6 has / 35 partial / 5 none / 1 limited / 6 leading / 8 exempt，47 remaining；#45 仍 partial，#31/#42/#49/#50 矩阵行逐字不变。无新依赖、外部调用、QQ 发送或真实浏览器验证，未改 `cordis.patch.yml`；无文件发送/删除/下载面板，发送仍使用主人 `/file`，真实 QQ 文件兼容性未验证。


M7-l 本次最终 `npm test` 退出 **0**：450 项，446 通过、0 失败、4 跳过（既有 live 模型测试），耗时 82872.955249 ms；新增 14 个顶层测试声明。最终 reminders/commands/config 专项 50 项全通过。覆盖默认关闭、owner/scope、Unicode/一次时间/重复间隔/限额/防重、一次与重复发送/跳过错过次数、安全失败延迟重试、20 条上限/不重叠/取消/dispose、人格统计/复制/删除及 await 后写原人格、真实 outbound 访问/限频/leak guard/dry-run、命令校验与 cognition 重启持久化且零 LLM 调用；时间与网关均为 fake。

`npm run check:docs` 最终退出 **0**；首次运行因扫描 `.agents/worktrees` 内既有嵌套仓库的旧名/归档链接失败，检查器现跳过 `.agents`/`.codex` 元数据目录，与既有 `.git`/`.ctx` 排除一致，不修改嵌套仓库。`npm run check:parity` 退出 **0**，快照为源码 66 个 JS 文件 / 16699 行，测试 46 个文件 / 9753 行 / 414 个顶层声明。矩阵为 6 has / 37 partial / 3 none / 1 limited / 6 leading / 8 exempt，remaining 47；只将 #8/#40 从 none 改为 partial，#31/#42/#49/#50 矩阵行逐字不变。无新增依赖、自动审批、任意代码/外部任务调用、LLM 任务执行或提醒 HTTP/管理面板；未改 `cordis.patch.yml`、未提交。没有真实定时器/QQ 验证，也没有 DSH jobs 或长任务执行。


M7-m 本次最终 `npm test` 退出 **0**：463 项，459 通过、0 失败、4 跳过（既有 live 模型测试），耗时 75447.70083 ms；新增 13 个顶层测试声明。服务/命令/面板专项 84 项全部通过，新增 REST 专项 1 项通过。覆盖视频 aid/shareUrl、完整 BV 校验、公开评论置顶/去重/API 顺序/楼中楼/Unicode 限长/limit/空结果、缺 aid/异常数据、两阶段 HTTP/非零 code/网络与正文超时、真实 AbortSignal 超时、离线分享、默认关闭零请求、主人限制及面板防重/纯文本/错误/重试；全部网络响应来自 fake fetch，不访问真实 B站。

审计快照为源码 66 个 JS 文件 / 16794 行，测试 46 个文件 / 10029 行 / 427 个顶层声明；矩阵 6 has / 37 partial / 3 none / 1 limited / 6 leading / 8 exempt，remaining 47。#48 仍 partial，仅公开评论与离线分享；#31/#42/#49/#50 矩阵行逐字不变。默认关闭、无 Cookie/WBI/登录/字幕/发布评论/新增 Agent 工具或依赖，分享不验证视频存在；真实 B站/QQ/浏览器未验证。未改 `cordis.patch.yml`、未提交；只保留本任务源码、测试与文档改动，无仓库内生成文件。

M7-n 本次最终 `npm test` 退出 **0**：472 项，468 通过、0 失败、4 跳过（既有 live 模型测试未配置 key），耗时 71014.21497 ms；新增 9 个顶层测试声明，配置/命令专项 49 项全部通过。覆盖默认空列表、严格数组/名称/长度/去重/100上限/issue/配置字段，内置 QQ 管理/生图/配置/记忆命令无服务调用或配置写入，模块命令与大小写无法绕过、非主人静默、未列入/公开模块/未知命令/帮助保持原行为，以及动态策略更新。首次专项因深合并吞掉非法数组类型而漏报 issue，已改为直接校验该原始字段，随后专项及完整测试通过。

`npm run check:docs` 与 `npm run check:parity` 均退出 **0**。审计快照为源码 66 个 JS 文件 / 16836 行，测试 46 个文件 / 10152 行 / 436 个顶层声明；矩阵仍为 6 has / 37 partial / 3 none / 1 limited / 6 leading / 8 exempt，remaining 47。#14 仍 partial，仅新增命令 deny-list；无所有服务/工具逐项 allow/deny 矩阵或统一审批，不覆盖 API、直接服务、Agent 工具及模块同进程代码。#31/#42/#49/#50 矩阵行逐字不变。无新增依赖或外部调用，未改 `cordis.patch.yml`、未提交；仅保留本任务源码/测试/文档改动，无仓库内生成文件。
