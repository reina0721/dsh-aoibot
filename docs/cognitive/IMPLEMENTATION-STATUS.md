# 实现状态（功能基线 v0.10.0）

0.10.0 调整命名、仓库及发布体系；以下功能基线以 v0.10.0 代码与测试为准。与 Aurabot 的全量差距与里程碑见 [GAP-AURABOT](../research/GAP-AURABOT.md)。

> 本文按「真实代码 + 真实测试」核对，不用设计文档冒充完成。
> 状态：**I** 已实现、**T** 有自动化测试、**V** 真实 DSH/浏览器验证、**L** 受限实现、**N** 尚未实现。
> 基线：`dsh-bot@0.10.0` 未发布分支，308 个测试（304 通过、4 项 live 需 key）；认知 + 模型协议 + 人格工作台/群聊参与 + 多人格库 + 人格级认知数据 + 人格导入/模型自检 + M4-a/M4-b 媒体与表情包 + M5-a 本地模块 + M5-b QQ Agent 工具/B站公共内容 + M6-a 本地目录备份/恢复 + M6-b 安全页/上线清单/手动升级检查 + M7-a 对标审计/临时 profile smoke；真实 DSH 探针 + 认知/模型/人格 UI 证据见
> [历史验证报告](https://github.com/reina0721/dsh-bot/blob/main/docs/archive/VERIFICATION.md) §4.2/§4.3/§4.4/§4.5/§4.6/§4.7。

| 领域 | 状态 | 实际模块 | 已做到 | 边界/未覆盖 |
|---|---|---|---|---|
| 感知与轮次 | I/T/V | `src/cognition/turn.js` | 每 `(chatType,chatId,senderId)` 聚合；完整度评分；软/硬截止；命令/超时快路径；撤回通知；跨重启恢复；消息去重；`selfId` 防循环 | 多用户同时插话的「注意力分配」只做了点名/回复门控，没有独立打分模块；编辑事件未完整接入 |
| 注意力 | L/T | `turn.js` + `pipeline` | 群聊仅点名/回复/唤醒词/命令；群 ambient 默认不决策；回复/情绪/关系/记忆参与候选效用 | 没有独立 `attention.js` 的 salience 评分、话题切换/多人优先级队列；后续版本目标 |
| 人格编辑/群聊参与/多人格 | I/T/V | `persona.js`、`analysis.js`、`pipeline.js`、`77-persona.js` | 多份独立 persona 记录 + activeId；create/duplicate/switch/delete；文本 profile 与数值人格同源持久化并注入 prompt；顶层人格库 + Prompt 预览；群聊 addressed/probability/all；冷却/分钟上限；lastTurn/groupSkipped 诊断；名字唤醒 | 当前是全局 active 人格，未做按群绑定；群聊 all 的 token 成本随群活跃度增长；文本人设不能覆盖安全硬边界；未做关键词/欢迎/管理命令插件 |
| 人格级认知数据 | I/T/V | `persona-scope.js`、`cognition/index.js`、`77-persona.js` | 非全局 kind 存到 `persona_<id>:` 命名空间；旧数据迁移到 self；人格页查看 8 组条数；按组单向复制到当前人格；删除人格清理数据 | 复制是覆盖式、非实时共享；全局 setting/turn/raw_event/LLM 用量不隔离；跨人格合并需要逐组复制 |
| 人格导入/模型自检 | I/T/V | `persona.js`、`llm.js`、`routes.js`、`scripts/import-aoi-persona.mjs` | `persona-import@1` JSON 一次性导入并激活；Aoi 转换脚本；DSH 一次性调用修复；`/cognition/llm/test` 返回真实 route/错误/延迟；真实 probe 私聊+群聊各一条 Aoi 回复 | 未移植 Aoi 的完整五层 CRDE/brain 适配器；外部包无 LICENSE，不转载原文；DSH route 需宿主有对应 API key |
| 工作记忆 | I/T | `memory.workingSet` | 每个 chat 的当前 turn/人物/意图/决策 | 容量与时间淘汰是简单裁剪，不是完整 Baddeley 模型 |
| 人格 | I/T/V | `persona.js`、`pipeline.maybeEvolvePersona` | 12 维特质 + 表达风格 + 价值边界；锁定项；单次/短期证据不剧变；24h 门控慢演化（≥5 结果样本、受每日上限） | 演化证据仍较粗（平均结果/未知量），未做完整长期模拟 |
| 情绪 | I/T/V | `emotion.js` | OCC 评价→PAD/离散；惯性、衰减、调节、外显阈值；疲劳/压力影响有效技能 | 评价主要来自 LLM 分析或本地启发式，无真实生理信号；不声称主观体验 |
| 人物画像 | I/T/V | `person.js` | Person/identity/facet；fact/self_report/observation/inference/hypothesis；scope/confidence/status/outdated/disputed；修正/删除/导出 | 身份合并/拆分是规则+scope，没有强实体消歧；群成员网络未单独建模 |
| 关系 | I/T/V | `relationships.js` | 10 维有向关系；全局/群/私聊作用域；惯性、冲突升快降慢、修复、单轮上限；历史事件 | 长期衰减未在每次读取时强制应用；群体氛围/多人关系网络为 v0.5 |
| 记忆 | I/T/V | `memory.js` | 工作/情景/语义/情绪/社会/程序；重要性/显著性；FTS 中文+英文检索；关联 2 跳；检索公式；巩固；遗忘（降权）≠删除；隐私隔离；时间/访问衰减 | 默认词法+图关联，embedding 只是可选接缝未接入真实向量库；长期巩固策略是阈值启发式 |
| 信念/未知 | I/T | `beliefs.js`、`knowledge.js` | 概率化信念、证据 logit 更新、冲突 `disputed`、用户纠正；未知检测/学习任务/claims | 信念候选依赖 LLM 返回；本地无法可靠抽命题；未知到信念的自动桥接有限 |
| 策略/行为 | I/T/V | `policy.js`、`pipeline.js` | 候选动作效用；关系/情绪/人格/技能约束；沉默/等待是一等动作；上下文 Beta 后验 + 探索；限频；结果归因（用户继续/纠正/情绪）；撤回专项（未看见内容不假装看见）；主动行为默认关且有安静时段/日预算/退避 | 没有显式目标树/规划器；复杂多步任务规划仍交给 DSH agent 层；proactive 的实际模型调用未在真实探针验证（无凭据） |
| 学习 | I/T/L | `knowledge.js`、`sources` | 未知→任务→多来源→带引用 claim；来源可注册；预算/暂停/重试/取消；默认只检测，自动外部检索显式开启 | 未做 real-world 多源冲突自动裁决的完整回归；Wikipedia/OpenAlex/GitHub 网络调用在测试中用 fake source；真实网络未逐源验证 |
| 技能 | I/T/V | `skills.js` | 13 项初始技能；成功/失败/不用/压力/迁移；有效熟练度独立于人格/情绪/关系 | 技能参数是手工先验，未从长期真实成功数据拟合 |
| 元认知 | I/T | `meta.js` | 决策/结果/校准 Brier/沉默率/能力缺口/有限 insight | 反思只记录 bounded insight，不自动改代码/权限；无完整自我模型 |
| 主动行为 | I/T/L | `proactivity.js` | 默认关闭；安静时段、日预算、关系门槛、退避、dryRun、决策记录 | 真实 LLM/发送路径未在带凭据的探针上验证；群主动默认关闭 |
| 目的系统 | I/T | `cognition/purpose.js`、pipeline、面板「目的」 | goal/plan/intent；优先级/进度/步骤/作用域；少量注入 compose；`/purpose` 增删改；面板 CRUD | 不执行工具/不自动发消息；无计划执行器 | M3 剩余 |
| 时间轴 | I/T | `cognition/timeline.js`、认知「时间轴」页 | 轮次/记忆/决策合并、倒序、before 分页、type/scope 过滤；只读 | 无导入旧档案；无编辑 | M3 剩余 |
| 每日整理/反思 | I/T | `cognition/consolidation.js`、记忆页按钮 | 04:00 调度、按作用域巩固、可选 LLM 反思、只压缩已有记忆、私聊隔离 | 无批次/重试/保留策略；无时间轴；反思最多 2 个作用域/次 | M3 剩余 |
| 合并转发/拍一拍/表态/QQ 动作 | I/T | `gateway/forward.js`、`commands.js`、`cognition/qq-actions.js`、`runtime/qq-tools.js` | 合并转发展开、拍一拍回应+冷却、表情表态归因、4 个主人命令；主人私聊 Session 运行时挂 3 个固定当前会话 QQ 工具，发送仍走 outbound | social/group 不挂工具；无资料编辑/群管/文件/精华/撤回/通用 action bus；真实 QQ 未验证 | M5-b 受限完成 |
| 回复分条/引用/@/防刷屏 | I/T | `cognition/reply-split.js`、`pipeline.sendDecision` | 长回复分条、段落/句末优先、最多条数合并、分条间隔；引用与群聊 @ 可配；连续未点名接话上限 | 分条失败不回滚；QQ 工具边界见动作行 | M2-b |
| DSH Session 运行时 | I/T | `runtime/agent.js`、`runtime/qq-tools.js`、`cordis.patch.yml` | 每聊天 Session、private/social preset、followup/event、超时/串行、oneshot 回退；仅 full/主人私聊挂 3 个 QQ 工具，注册失败隔离并可 dispose | 默认 oneshot；social/group 0 个 QQ 工具；未真机 V | M1/M5-b 受限完成 |
| QQ 命令/按聊天模型 | I/T | `cognition/commands.js`、`cognition/llm.js` | `/status` `/quiet` `/active` `/model` `/remember` `/forget` `/help`（主人）；`modelRouting` 按会话覆盖；/model 写回配置 | 非主人静默；无 `/sing`；只影响认知 LLM，不改变 agent Session 模型 | M1 剩余：agent 真机 smoke |
| 访问控制/统一出站 | I/T | `core/access.js`、`cognition/outbound.js` | `open`/`allowlist`、主人 + 私聊/群白名单、入口闸门（不落 raw/不聚合）、统一出站（访问→限频→dryRun→发送）、审计/计数、概览卡片与 `/access/*` | 无逐项工具权限/审批（M2）；allowlist 未做真机 V 验证；默认 open 以兼容升级 | M1 剩余：DSH Session 运行时 |
| 隐私/删除 | I/T/V | `memory.js`、`person.js`、`index.deletePerson` | 私聊/群聊作用域隔离；secret 不进 LLM（平台层）；导出；删除人物级联画像/关系/记忆；原始事件镜像可关 | 没有多用户权限模型；DSH 本地单用户认证 |
| 存储 | I/T/V | `store.js` | `node:sqlite` WAL + FTS5 + 事务/回滚/备份；JSON fallback；schema version；原始 JSONL；WAL checkpoint | 迁移只有 v1；跨大版本升级需补迁移脚本 |
| 模型协议 | I/T/V | `src/model/**` | OpenAI Chat/Responses、Anthropic、Gemini、Ollama 统一适配；OpenCode Go/Command Code/OpenRouter 预设；自定义 base/header/auth；流式/发现/重试/安全；真实 OpenCode OpenAI+Anthropic 通过；真实认知直连 analysis+compose 成功 | 工具调用/多模态未实现；Azure/Bedrock/Vertex/OAuth 未纳入；Command Code/OpenRouter 无 live chat key；Gemini/Ollama 仅 mock |
| 可观测 | I/T/V | `pipeline` traces、`overview`、UI | 每阶段 trace、决策候选、计数、API/UI、暂停/演练 | 没有完整分布式追踪/指标导出 |
| 多模态/媒体（M4-a/M4-b） | I/T/L | `src/media/index.js`、`src/media/stickers.js`、`commands.js`、媒体面板、`gateway/actions.js` | 默认关闭外部媒体；Vision/ASR/TTS 与图片/语音/文件收发；表情包限 PNG/JPG/JPEG/GIF/WebP、默认 5 MiB/张和 200 张、SHA-256 去重/人工标签；安全按 ID 取图；`/tts` `/say` `/sticker` 与媒体面板 | 不自动收集/语境选图/缩放转码，无商城、Agent 媒体工具、自动语音策略、RVC、生图/改图；文件上传依赖网关；尚无真实 QQ/provider V |
| 本地模块（M5-a） | I/T/L | `src/modules/kernel.js`、`commands.js`、模块面板 | 本地 manifest、权限门控、异步 setup/cleanup、热重载/启停、命令/规范化事件/1 MiB JSON 存储、只读认知注册、统一 outbound 发送、错误隔离与路径/符号链接逃逸检查 | 模块仍是同进程任意代码，不是沙箱；无远程安装、依赖解析、签名、自动更新、文件监视、marketplace 或 `.d.ts`；未做真实第三方模块 V |
| B站公共内容（M5-b） | I/T | `src/content/bilibili.js`、`commands.js`、内容面板 | 默认关闭；公开搜索/热门/BV 详情；`/bili`、2 个 REST 路由与结果卡；标题/作者/播放/时长/链接规范化 | 无 Cookie/WBI、评论/分享/字幕；QQ空间因授权/ToS 未实现；真实 B站未验证 |
| 本地备份/恢复（M6-a） | I/T/L | `src/ops/backup.js`、REST、备份面板 | 目录快照（无 zip）；默认配置/模型/认知/模块/表情包，可选根内全部媒体；200 MiB/5000 文件/10 份，原子发布/可选清理、路径/符号链接/hash 校验、默认暂存、allowRestore 门控与恢复前备份 | 含密钥需保护；复制 SQLite 前必须停写，恢复后重启；不保证在线一致性或整目录事务；不删除未列出的文件；无加密/云端/自动恢复/迁移（版本检查见 M6-b），未做真实数据恢复 V |
| 对标审计/临时 profile smoke（M7-a） | I/T/V | `scripts/parity-audit.mjs`、`scripts/smoke-temp-profile.sh`、`docs/PARITY-AUDIT.md` | 矩阵结构审计/JSON 输出/源码与测试静态计数；临时 DSH profile 启动、关闭 QQ、查询健康/状态/配置/模块/媒体/备份/升级并创建一次备份、清理；实际 smoke 通过 | 不是全量对齐；不替代真实 QQ/媒体/GitHub 验证；矩阵仍有 55 项非 has | M7 剩余 |
| 安全页/上线清单/升级检查（M6-b） | I/T/L | `src/ops/upgrade.js`、REST、`SecurityPage` | 15 个顶层标签；只读访问/危险面、最近 5 条审计、6 项上线清单；默认关闭的手动 GitHub 检查，最近 10 条内 stable/beta 过滤、版本比较、内存缓存/force、超时/真实错误；GET 状态零网络 | beta 仅放宽预发布过滤；模块审核始终人工提醒，媒体只检查字段；无后台/自动更新、下载/安装、token、云端、工作区迁移或离峰省钱；API 鉴权不变，依赖 DSH 本机信任边界；未做真实 GitHub/浏览器 V |
| 群体网络 | N | — | 关系有 group scope | 成员角色/群体氛围/多人冲突/群体规范是 v0.5 |
| 显式目标与规划 | N | — | 策略按候选效用选择动作 | 没有长期目标树、计划执行、失败重规划；当前由 DSH agent 层提供规划，认知内核不假装拥有 |
| 生产 Web 学习 | L | `knowledge.js` | DSH web 搜索/抓取优先，公共 API 兜底 | 真实网络与来源条款/限速只做了接口与假源测试 |

## 与「完整认知架构」的差距

v0.4 完成的是**可运行的认知核心 + 可验证的长期状态 + 管理 UI**，v0.5 补上**统一模型协议与直连**，v0.6 补上**人格工作台、群聊参与与诊断**；不是终点：

1. **独立注意力/显著性模块**、群体网络、显式目标规划、真实向量记忆、真实图像理解属于 v0.5；
2. **真实长期模拟**（数周/数月）尚未跑；人格/情绪/关系/记忆的长期稳定性只有单元/短场景证据；
3. **真实有凭据的 LLM 端到端**：探针 profile 无模型凭据，验证了降级不伪造；桌面 profile 的
   `agentDefaultModel` 路由在有凭据时可用，但未在自动化里消耗真实 token 做回归；
4. **真实 QQ 网关**未接入（本机无账号）；协议用 mock 覆盖；
5. 文档中的设计矩阵（`COVERAGE-MATRIX.md`）部分模块名是目标态，实际合并/命名以本表与代码为准。

这些边界不会用「已实现」掩盖；下一阶段按 `CAPABILITY-MAP.md` 的清单推进。
