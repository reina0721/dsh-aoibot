# M7-a/M7-b 对标审计、用户豁免与临时 profile smoke

快照日期：2026-11-06（UTC）。**并非全量对齐（not full parity）**。本页读取当前仓库的 [§3.x 能力矩阵](research/GAP-AURABOT.md#3-能力矩阵)，不把计划、静态计数或本机 API smoke 当成真实 QQ/媒体/外部服务证据；M7-b 已按 2026-11-06 用户批准将 #16/#47/#52/#55/#59 标为 exempt，并更新固定主人命令的实际边界。**exemptions are explicit user decisions, not implementation evidence**（豁免是明确用户决定，不是实现证据）。准确范围与理由见 [GAP §8.1](research/GAP-AURABOT.md#81-用户批准豁免)；不豁免 #42/#44/#49/#50 或其他差距，不改变本机-only/CSRF 行为。

## 临时 profile smoke 证据

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

当前实跑审计退出码为 **0**：61 行、无重复编号、无格式错误、非 has 项均有目标。先前 #2、#24、#33、#34、#35、#37 的目标为 —，已补为许可复核/领先无缺口说明。剩余表排除 6 个 has 与 5 个 exempt，共 50 项（其中 6 个 leading），不应理解为 50 个缺失功能。按目标列开头的显式里程碑分组；跨里程碑组合保留，无明确里程碑或明确排除范围的目标列归入“未分配里程碑”，不从已交付状态推断未来里程碑。

<!-- parity-snapshot:start -->
# 对标审计（并非全量对齐 / not full parity）

矩阵 61 项；has: 6，partial: 35，none: 8，limited: 1，leading: 6，exempt: 5。
剩余 50 项（排除 has/exempt，包括领先项；不等于缺失功能数）。
源码：61 个 JS 文件 / 15566 行。
测试静态计数：40 个文件 / 7286 行 / 293 个顶层 test 声明；包含 skip，不代表执行结果。

结构检查：通过；重复编号 0，格式错误 0，非 has（含 exempt）缺目标 0。

## M1

| # | 能力 | 状态 | 目标 |
|---|---|---|---|
| 6 | 每聊天 DSH Session | partial | M1 剩余：真机验证/工具面 |
| 8 | 后台任务/定时任务 | none | M1 |
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
| 40 | 定时/后台任务 | none | M1/M3 |

## M2

| # | 能力 | 状态 | 目标 |
|---|---|---|---|
| 3 | QQ 事件面 | partial | M2 |
| 15 | 审批/危险确认/leak guard | partial | M2：无统一审批/逐项权限/leak guard；仅固定主人命令确认 |
| 22 | 合并转发展开/拍一拍/表情回应/通知 | partial | M2 剩余 |

## M2 / M5

| # | 能力 | 状态 | 目标 |
|---|---|---|---|
| 14 | 逐项权限 | partial | M2 剩余/M5：无逐项 action 权限矩阵/统一审批；新动作不挂 Agent |

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
| 29 | 人物档案/群印象/相处经验/说话方式 | partial | M3 剩余 |
| 30 | 时间轴/回忆日志/导入旧档案 | partial | M3 剩余 |
| 31 | 语义检索/embedding | partial | M3 |
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

## M5

| # | 能力 | 状态 | 目标 |
|---|---|---|---|
| 42 | 翻唱/RVC | none | M5（可豁免） |
| 49 | 抖音/小黑盒 | none | M5（可豁免） |
| 50 | 桌宠 | none | M5（可豁免） |

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
| 44 | 图片收发/视觉/生图/改图 | partial | 无普通图片发送面板/命令、生图/改图或真机验证 |
| 45 | 文件发送/接收 | partial | 无文件面板；media.enabled/files.enabled 与 qqAdmin.enabled 必须开启；网关兼容性未实机验证 |
| 46 | 本地接口（TTS/生图/识别脚本） | partial | 无脚本桥、生图/改图接口或任意本地路径入口 |
| 48 | B 站浏览/评论/分享 | partial | 无评论/分享/字幕/登录态；真实接口待验 |
| 56 | 设置向导 | partial | 无独立向导/自动修复；模块始终人工待检查，媒体只检查字段，不验密钥/服务；无 API 鉴权变更，仍依赖 DSH 本机信任边界；未做真实浏览器 V |
| 57 | 备份/恢复 | partial | 复制 SQLite 前停写，恢复后重启；无在线一致性/整目录事务、云端上传下载、自动恢复或迁移 |
| 58 | 升级检查/beta 通道 | partial | beta 仅放宽预发布过滤；无后台/自动更新、下载/安装、token；未认证每 IP 60 req/h；无真实 GitHub V |
<!-- parity-snapshot:end -->

## 证据入口与边界

| 范围 | 当前代码 / 自动化证据 | 尚不能证明 |
|---|---|---|
| 审计工具 | [parity-audit.mjs](../scripts/parity-audit.mjs)、[11 个 fixture/计数/CLI 测试](../test/parity-audit.test.js) | 功能等价性、真实 QQ 验收 |
| M1/M2 运行时与交互 | [runtime/agent.js](../src/runtime/agent.js)、[runtime.test.js](../test/runtime.test.js)、[access.test.js](../test/access.test.js)、[reply-split.test.js](../test/reply-split.test.js)、[runtime-qq-tools.test.js](../test/runtime-qq-tools.test.js) | 全量工具、权限矩阵、任务系统、真实 QQ |
| M3 认知 | [cognition](../src/cognition)、[consolidation.test.js](../test/consolidation.test.js)、[purpose.test.js](../test/purpose.test.js)、[timeline.test.js](../test/timeline.test.js) | 向量检索、目的执行器、导入旧档案 |
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

M7-b 本次 `npm test` 实跑退出 **0**：320 项，316 通过、0 失败、4 跳过（live 模型测试）。静态 293 个声明与执行 320 项的差异来自循环/缩进等声明形式。`npm run check:docs` 实跑退出 **0**，本地文档链接与当前命名检查通过；上述 smoke 仅证明关闭 QQ 的临时宿主/API 启动与本地备份路径，不宣称全量对齐。
