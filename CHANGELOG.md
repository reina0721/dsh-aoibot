# 变更记录

## 未发布

- M7-m：B站公开评论与离线分享（#48 仍 partial）。视频新增数字 aid/shareUrl；评论先查 view，再读公开 reply 第一页，limit 默认 10/上限 20、置顶优先、rpid 去重、纯文本正文最多 500 Unicode 字符、一层楼中楼样本。新增主人 `/bili comments BV号`、`/bili share BV号`、两个 GET 路由与内容页 BV 查询；完整 BV 校验、缺 aid/HTTP/超时/风控明确报错，分享仅生成链接且不验证视频存在。沿用默认关闭开关，无 Cookie/WBI/登录态/字幕/发布评论/缓存/新增 Agent 工具或依赖；仅离线测试，真实 B站未验证。remaining 47，#31/#42/#49/#50 不变。
- M7-l：新增默认关闭的主人本地提醒服务与 `/remind <秒|ISO时间> <文本>`、`/reminders`、`/forgetreminder <id>`。固定 1–500 Unicode 字符文本，当前私聊/群聊数字 ID；未来一次时间或 60–2592000 秒重复间隔，每人格默认最多 50 条活跃提醒、同作用域/文本/时间防重。每 tick 最多 20 条，经统一 outbound 访问/限频/leak guard/dry-run；重复提醒跳过错过次数，失败至少 60 秒后重试，只存固定安全错误。自调度不重叠、dispose 清理；await 后写原人格，取消/删除不会复活。新增 reminders/提醒人格统计/复制/删除组和配置字段；离线服务/命令/集成测试，无依赖、自动审批、任意代码/外部任务调用或 LLM 执行，无提醒 HTTP/面板。真实定时器与 QQ 未验证；#8/#40 从 none 改为 partial，remaining 47，#31/#42/#49/#50 不变。

- M7-k：媒体服务新增本地 `saveFile/listFiles`、`GET /media/files`、`POST /media/file/upload` 和媒体页「文件」上传/列表/刷新。要求媒体与文件开关；安全 basename≤120、文件扩展名白名单、非空严格规范 base64、解码大小上限、15 MiB JSON 请求体限制；固定 files 目录、根/目录 realpath 检查、拒绝目录及文件符号链接、wx 防覆盖。列表最新优先最多 500 项，totalBytes 统计所有合格文件。客户端预检大小/扩展名、上传防重与独立错误提示，保留既有媒体 UI。无文件发送/删除/下载面板，发送仍用主人 `/file 相对路径`；新增离线服务/安全/API/面板测试，无新依赖/外部调用/真实 QQ 发送，未改 cordis.patch.yml。#45 仍 partial，真实 QQ 未验证；#31/#42/#49/#50 及 remaining 47 不变。

- M7-j：十种已知 QQ 通知（含名片/群名/头衔/精华/离线文件）校验后写入当前人格时间轴，确定性去重；好友/群 add/invite 请求按 flag 去重，只存 pending。新增主人 `/requests`（最多 10 条）、`/approve ID confirm`、`/reject ID confirm`，服务复核 owner/开关/状态，仅调用固定请求 action，成功记录处理元数据、失败安全报错；无自动审批。flag 不进入公共列表/回复/日志，备注和通知文本复用已知密钥脱敏/去控制字符与长度上限。同 ID 并发防重，完成写入固定原人格；请求纳入人格数据统计/复制/删除。两个新开关默认启用，配置可热关闭；离线 fake 网关测试，无新增依赖/外部调用/请求 API/审批面板/Agent 工具。#3/#15 仍 partial（真实 QQ 未验证、无统一审批/逐项权限或 PII 检测），#31/#42/#49/#50 不变，remaining 47。

- M7-i：新增本地出站文本 leak guard，默认启用 + redact，可选 block；识别高置信度 OpenAI/GitHub/AWS AKIA/Bearer/PEM 私钥和至少 16 字符的 api_key/apiKey 值，重叠合并、100k UTF-16 单元上限（超限整体脱敏/阻止）。访问/限频后、dry-run/网关前检查，block 返回 LEAK_BLOCKED 与 leakBlocked 计数，成功脱敏返回 leakGuard=redacted；日志只有类别/次数，网关异常不回显。配置安全组可改，安全页只读开关/策略，没有扫描内容/密钥；新增离线规则/出站/配置与 mock 面板测试。无新依赖/外部调用/自动审批，无 PII/熵或媒体/文件扫描，可能误报/漏报，不重组跨段/跨消息；人工发送/raw action 等独立路径不覆盖。#15 仍 partial（缺统一审批/逐项权限），#31/#42/#49/#50 不变，remaining 47。

- M7-h：通用旧档案导入新增 `kind=timeline`（默认仍为 memory），支持 events/timeline 等 JSON 数组包装与 JSONL；事件正文/标题/必填时间/作用域白名单规范化，独立 `timeline_event` 与确定性 `tle_` ID，幂等不覆盖。时间轴默认合并事件并支持 event 筛选，记忆页可选导入种类并显示结果种类；事件纳入人格数据统计/复制/删除。共用 cognition.import 限额，仅计数日志；新增离线服务、时间轴、面板与 API 回归。无新依赖、外部调用或 QQ 发送；#30 仍 partial（无 Aurabot 专用迁移、向量导入或真实旧档案样本），#31/#42/#49/#50 状态不变。
- M7-g：仅 UI 使用既有 API，人物页可内联编辑当前人格 facet 内容/置信度/active 或 disputed（含 group-scope 群印象，保留原作用域与删除）；关系页保留只读条，逐卡调整 API 返回的 10 维（-1–1），仅显式保存变化项，由后端记录 source=ui 历史。支持取消、保存期间禁用、防重复提交、失败 toast/草稿保留与刷新；新增 6 项 mock 面板测试。无后端/API/Agent 工具/自动审批变更，无新依赖、不发送 QQ；既有后端 UTF-16 截断仍保留。#29 仍 partial：无独立人物说话方式编辑器、无 Aurabot 专用人物/群档案导入，未做本轮真实浏览器验证。

- M7-f：新增默认关闭的 OpenAI 兼容 embeddings 与异步记忆重排；配置 Base URL/模型/密钥环境变量/0–1 权重，32 条批次、4000 字符、8–4096 维校验、超时/禁重定向及 2000 项内存 LRU。pipeline/主动任务 await，保留同步词法检索，失败词法回退且不重复强化。无新依赖、默认零 embedding 网络；离线 fake 测试，不含本地模型/独立 reranker/向量数据库或全库向量召回，真实 provider 未验证，#31 仍 partial。

- M7-e：更新 current-architecture / parity-roadmap 视觉（Archify 3.0.1，四门通过；不声称人工感知评审），新增发布检查表、回滚与声明边界。仍不宣称全量 parity。

- M7-d：新增 `archive-import.js`、`POST /cognition/import` 与认知记忆页「导入旧档案」。通用 JSON/JSONL 导入当前人格，默认 5 MiB/5000 项（可调低）；正文/作用域/人物/时间戳/类型白名单校验、确定性 ID 幂等去重、仅计数日志；新增 `cognition.import` 配置及离线服务/API/面板测试。不联网、不自动发送 QQ，无新依赖；无 Aurabot 专用迁移、向量或时间轴事件导入，无真实旧档案样本验证，#30 仍为部分实现。
- M7-c：默认关闭的 OpenAI 兼容生图/改图服务、`/draw` `/redraw` `/image` 主人命令、`/media/image/generate|edit` 和媒体页「生图/改图」。prompt 1–1000 字符、五档尺寸、限媒体大小的 PNG b64_json 落盘；不抓返回 URL，改图源限媒体根内相对路径/realpath/扩展名/大小；只支持兼容 edits。面板/API 不发送 QQ；命令先过 access，无新依赖，fake provider 自动化，真实 provider/QQ 未验证，#44/#46 仍为部分实现。
- M7-b：记录 2026-11-06 明确用户豁免（远端 API 鉴权、QQ空间、模块市场/远程安装、25 页级面板、迁移/离峰），审计新增 exempt 计数与目标校验；其他差距不变。豁免是用户决定，不是实现证据。
- 新增默认关闭、仅主人/当前会话的资料、群管、精华、撤回和媒体根内文件命令；独立 `cognition.qqAdmin` 配置，踢人强制 confirm、撤回默认确认，消息归属核实与根内 realpath 校验；破坏性动作记录简短元数据审计。仅命令、不新增 Agent 工具或任意 action 透传；真实 QQ 管理/资料/文件动作未验证。

- M7-a：新增 `check:parity` 矩阵审计、JSON 输出、源码/测试静态计数与结构检查；新增 `smoke:temp` 临时 DSH profile 冒烟脚本，启动前关闭 QQ 连接，仅请求本机状态 API 并创建一次本地备份，结束后清理。新增审计测试与当前差距/证据文档；不宣称全量对齐，不改变运行时行为。

- M6-b：新增「安全」顶层标签（共 15 个），只读展示访问控制/最近 5 条审计、危险面与上线检查清单；模块审核始终为人工提醒，媒体只检查配置字段完整性。新增默认关闭的手动 GitHub Releases 检查及 `/upgrade`、`/upgrade/check`，状态查询不联网；支持内存缓存、强制检查、版本比较与 stable/beta 过滤（仅最近 10 条、排除 draft）。不自动检查、更新、下载或安装，无 token 支持；未认证 API 每 IP 每小时 60 次。保持 DSH 本机信任边界，无 API 鉴权变更、工作区迁移或离峰省钱策略。

- M6-a：新增本地目录快照服务、备份 REST API 与「备份」页；默认包含配置/模型/认知/模块/表情包，可选全部本地媒体；200 MiB、5000 文件、保留 10 份（可配置），原子发布与按需清理。校验路径/符号链接/文件 hash，默认只暂存恢复；应用需 `ops.backup.allowRestore=true` 并先创建恢复前备份。备份含秘密；SQLite 必须停写后复制，恢复后重启。无 zip、云端传输、自动恢复或迁移；版本检查由 M6-b 单独提供。

- M5-b：主人私聊 DSH Session 运行时挂载 3 个当前会话 QQ 工具（额外文本、点赞、戳一戳；群查询保留 /groupinfo /memberinfo 命令），注册失败隔离且卸载时清理；不含通用 action bus、资料编辑、群管、精华或文件工具。
- M5-b：新增默认关闭的 B站公共内容服务、主人 `/bili` 命令、搜索/热门 REST API 与「内容」页；仅使用无需 Cookie/WBI 的公开接口，不含评论/分享。QQ空间因需要 QQ 登录授权及服务条款审查明确不实现；真实 B站/QQ 验证待办。
- M5-a：新增仅限本地的模块内核：manifest 与权限门控、动态加载/热重载/启停、错误隔离、模块命令/规范化事件/1 MiB JSON 存储、只读认知接缝、统一 outbound 文本发送、REST API 与「模块」面板；模块需由操作员复制到数据目录，不含上传、远程下载、依赖安装、沙箱或 marketplace。
- M4-a：新增默认关闭的媒体基础层：受大小/扩展名限制的图片、语音、文件入站下载，OpenAI 兼容 Vision/ASR/TTS，base64 图片/语音发送、OneBot 群/私聊文件上传，以及 `/media/status|test|tts` API；不含媒体面板、表情包市场、RVC 或生图。
- M4-b：新增本地表情包库（PNG/JPG/JPEG/GIF/WebP、5 MiB/张、200 张、SHA-256 去重、人工标签）、安全的上传/列表/按 ID 取图 API、媒体面板，以及主人命令 `/tts` `/say` `/sticker`；仍不含自动收集/语境选图、商城、RVC、生图或 Agent 媒体工具。
- 安装 Archify 视觉层（`@tt-a1i/archify-dsh@1.0.0`，内含 Archify 3.0.1）到当前 `web` profile；新增 `docs/ARCHIFY.md` 记录版本、验证、限制与回滚。
- 新增 `docs/visuals/`：当前架构、目标架构、消息生命周期、轮次状态机、里程碑路线图 5 张可交互 HTML，附 candidate JSON 与 finalize/browser-check 证据。
- 新增 `docs/research/GAP-AURABOT.md`：与 Aurabot v1.2.0 的量化对照、14 域 parity matrix、M1–M7 路线图与完成定义。
- 校正 `IMPLEMENTATION-STATUS`（0.10.0 / 157 项）、`CAPABILITY-MAP`（目标态模块名）、`THIRD_PARTY_NOTICES`（Aurabot 复用范围 + Archify 声明）、文档导航与 README 入口。
- M3-c：时间轴只读聚合（轮次/记忆/决策，before/type/scope 过滤）+ 认知「时间轴」页。
- M3-a：目的系统（goal/plan/intent；CRUD/优先级/进度/步骤/作用域；少量注入 compose；`/purpose` 命令；认知「目的」页）。
- M3-b：每日记忆整理与按作用域 LLM 反思（04:00 调度；只压缩已有记忆；面板「整理/反思」；`/cognition/consolidation/run`）。
- M2-b：合并转发展开（`get_forward_msg` 兼容 id/message_id），展开内容进入轮次与记忆并标记不可信。
- M2-b：拍一拍回应（按用户冷却、只回应拍机器人）、表情回应记正向 outcome。
- M2-b：QQ 动作命令 `/like` `/poke` `/groupinfo` `/memberinfo`（仅主人、仅当前会话）。
- M2-a：长回复分条（`cognition.reply.split/maxChars/maxParts/delayMs`），优先段落/句末标点，内容不截断。
- M2-a：回复引用可配（`reply.quote`）、群聊 @ 发送者可配（`reply.atSender`）；每条分条都经过 outbound。
- M2-a：新增连续未点名接话上限（`turn.maxConsecutiveGroupReplies`），点名回复清零；与冷却/每分钟上限并存。
- M1-c：新增 QQ 命令（`/status` `/quiet` `/active` `/model` `/remember` `/forget` `/help`，仅主人；非主人静默）。
- M1-c：新增 `cognition.modelRouting`（私聊/群默认 + 会话覆盖）与 `/model` 写回；provider 在直连列表时走 direct，否则 DSH。
- M1-c：`/quiet` `/active` 写回群聊参与与主动开关；`/remember` `/forget` 使用记忆服务的 remember/forgetMatching。
- M1-b：新增可选 DSH Session 运行时（`runtime.engine=agent`）：每聊天 Session、`dsh-bot-private`/`dsh-bot-social` preset、`agent.followup` + `session/event` 取最终回复、超时/串行、oneshot 自动回退。
- M1-b：bundle patch 新增两个 agent preset；host 注册 `{{dshbot_persona}}` / `{{dshbot_rules_private}}` / `{{dshbot_rules_social}}` 提示词变量。
- M1-b：概览运行诊断显示 engine/active/会话数；新增 `/runtime/stats`、`/runtime/sessions`；默认仍为 oneshot。
- M1-a：新增访问控制（`access.mode=open|allowlist`、主人 QQ、私聊/群白名单、审计环形缓冲）与 `/access/stats`、`/access/check`。
- M1-a：认知侧自动消息统一走 `src/cognition/outbound.js`（访问 → 频率 → dryRun → 发送），pipeline 与主动行为不再各自直连发送。
- M1-a：概览页新增访问控制卡片；配置页新增「访问控制」分组；`allowlist` 下被拒消息不落 raw、不聚合、不回复。
- M0 仅为文档与环境变更，不改 dsh-bot 运行时代码；运行时/权限从 M1 开始。

- 添加真实 DSH 桌面概览截图、合成数据演示流程与脱敏验证摘要。
- 添加 image 模型生成的宣传横幅和方形分享图，记录素材来源及提示词。
- 更新 README、文档导航与已发布的 GitHub 下载入口说明。

## 0.10.0

- 项目、插件、界面和包统一为 dsh-bot，插件移至仓库根目录。
- 数据目录改为 plugins-data/dsh-bot，覆盖变量改为 DSH_BOT_DATA_DIR；旧数据需手动迁移。
- 保留 OneBot API 路径与事件契约。
- 建立分层文档、GitHub Release 安装包、校验文件和跨平台安装脚本。
- 新增离线测试、文档检查和发布产物检查流程。
- 兼容 Node 22.13 未编译 FTS5 的 SQLite：保留数据库与事务，检索使用词法匹配。

历史功能与验证材料见 [归档](docs/archive/README.md)。
