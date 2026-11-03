# 架构决策记录（DECISIONS）

## ADR-001 单 bundle 内建立 platform / cognition 边界，不拆新包

- 决定：认知内核放在 `src/cognition/`，由 `src/host.js` 组装；对外 `ctx.provide('onebotCognition', service)`。
- 理由：现有 desktop 安装是单 plugin + 单 client bundle；拆包会改变安装/升级路径并增加当前风险。内部边界通过接口、纯模块、独立存储保证；未来可无损拆出。
- 代价：文件较多但都在一个包；用 lint/test 约束边界（cognition 不得 import gateway 内部实现，只接收规范化事件/发送回调）。

## ADR-002 SQLite + FTS5 + JSON fallback

- 决定：`node:sqlite`（WAL、事务）为默认；无 sqlite 时 JSON fallback。
- 理由：关系/图/事件/trace 需要事务和查询；不引入第三方依赖。向量检索仅作可选 seam，默认 lexical+关联图。
- 代价：同步 API 阻塞；用小事务、WAL、后台队列、性能测试控制。

## ADR-003 LLM 是语义投影器，不是状态容器

- 决定：长期状态全部在 DB；每次只投影选中的上下文；LLM 负责语义分析/生成/摘要/证据抽取。
- 理由：goal-context 明确禁止巨型 Prompt 冒充认知；可测试、可降级、可审计。
- 代价：需要结构化 schema/解析/降级；两阶段调用增加延迟，用本地 fast path 与预算抵消。

## ADR-004 LLM 路由继承 DSH 默认，不复制 API Key

- 决定：默认 `ctx.agentDefaultModel.currentSelection()`；可配置固定路由；无 LLM 时 degraded。
- 理由：用户已在 DSH 配置模型/额度；避免第二套密钥。`ctx.get('llm')` 无注入要求，不存在时降级。

## ADR-005 安全默认

- 群聊默认仅 @/回复/唤醒词/命令触发；ambient 需显式开启。
- 主动行为默认关闭，开启后受安静时段/日预算/关系门槛限制。
- 外部学习仅公共知识，预算/来源/许可受限；私人原文不出现在搜索 query。
- 运行时 Bot 不自动安装插件/改代码/扩权；能力缺口只生成提案。

## ADR-006 记忆遗忘不等于删除

- 决定：模拟遗忘 = 检索权重/状态衰减；显式删除/保留策略才清 DB。UI 明确区分。
- 理由：goal-context §19 要求；同时满足用户数据删除权。

## ADR-007 单写者、事件溯源、可回滚

- 决定：认知状态只由 cognition service 写；平台/UI 不直接改表；关键变化写 state_transitions/audit；迁移前备份。
- 理由：避免平台事件与认知更新竞争；支持审计/回滚/重启恢复。

## ADR-008 v0.4 能力边界

- 实现：轮次、注意力、人物/关系、人格/情绪、记忆/撤回、信念/未知、策略/结果、主动、学习(首版)、技能、元认知、UI。
- 受限/后续：视频/语音完整理解、全平台知识源、长期生产验证、自主改代码/装插件。
- 状态严格按覆盖矩阵；不因有 UI 标「已验证」。
