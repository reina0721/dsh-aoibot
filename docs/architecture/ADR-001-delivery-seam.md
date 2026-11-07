# ADR-001：分层、核心边界与可插拔交付

状态：已批准架构方向；本次仅实现 Phase 0 + Phase 1，交 DSH 审查。

## 决策与范围

采用模块化单体（modular monolith）：维持一个进程、一个发行包和既有部署方式，以明确的内部契约逐步分层，不拆微服务。本次先刻画既有行为，再抽离内部 DeliveryPlan/Executor seam。默认消息行为不变，不升级版本、不发布、不部署。

边界按职责划分：

| 层 | 职责与约束 |
| --- | --- |
| core | 稳定契约、配置规范化、网关投递、访问控制、频率限制与 leak guard；认知负责分析、决策与生成正文，pipeline 保有统计、pending、结果归因与轮次记录。当前安全闸门仍由 `src/cognition/outbound.js` 持有，不在本阶段迁移。 |
| builtin | 随包交付、由项目维护的可选策略或能力，未来可通过核心契约提供回复布局等 egress policy；本阶段不新增或修改模块。 |
| external | 外部作者维护的扩展，沿用既有模块加载与能力边界；未来接入交付策略也必须通过核心执行与安全闸门。本阶段不增加扩展 API。 |

回复分条、首条引用、群聊 @ 和条间等待属于 egress policy：它们将已经生成的正文映射为平台消息，不参与认知分析或回复内容决策。长期可作为 builtin 策略交付。当前 `splitReply(text, { maxChars, maxParts })` 仍留在 `src/cognition/reply-split.js`，由内部纯 builder 复用，不在本次移入模块。

## Phase 0：既有行为契约

重构前先运行 `test/pipeline-delivery.test.js`，锁定以下语义；引入 seam 后对默认/core/planner 重用同一组断言：

- 空正文直接 markSent；dry-run 同时增加一次统计，无实际投递。启用分条时纯空白产生零条，历史返回 `SEND_FAILED`；关闭分条时保留原始空白。
- `cognition.reply.*` 原键、默认值与规范化保持不变。分条沿用原 maxChars/maxParts 算法，剩余正文并入最后一条。
- 引用和 @ 只附在第一条，每条都有 text；默认引用最后一条原消息，支持内部 noReplySegment。私聊不 @，缺少引用 ID 或 senderId 时不添加对应段。
- 每条经 outbound；仅第一条携带 decisionId，source 为 pipeline，dryRun 为 true 或 null。没有 outbound 时保留原 sendDirect 路径与第一条 mark 行为。
- 首条失败返回失败以及 error/blocked/reason；后续失败立即停止，保留已发送部分并返回成功及实际条数。不重试、不补发、不撤回。
- 首条 dryRun 立即返回 `{ ok: true, dryRun: true, messageId: '' }`，无 sent/pending/逐条回调；后续 dryRun 停止并保留前面实际发送的结果。
- 仅条与条之间等待，不在最后一条后等待；返回首个非空 messageId、最后一次成功 result 和实际发送 parts。
- 每次真实成功投递记录 turnAggregator 和 cognition-sent 调用；结束时累计 stats.sent、一次 noteGroupReply，并写一次 pending。现有 ctxEmit 是空函数，本次保持其运行行为；测试仅在加载副本内记录调用，不增加生产导出。

## Phase 1：DeliveryPlan/Executor 契约

`src/delivery/plan.js` 的 `buildReplyPlan({ text, turn, decision, replyCfg = {}, replyTo = '', source = 'pipeline', decisionId = '' })` 是纯函数，不读配置、不做 I/O，不改输入。显式 replyTo 优先，否则取 turn 最后一条 messageId；decisionId 优先使用显式非空值，否则取 decision.id。

```js
{
  source, decisionId,
  target: { chatType, chatId },
  parts: [{ segments: [/* reply / at / text */], delayAfterMs: 0 }],
  meta: { planner: 'core', fallback: false }
}
```

delayAfterMs 表示该条成功后、下一条开始前的等待，最后一条为 0。空正文生成空 parts，由 pipeline 保留原空正文处理。`validateDeliveryPlan(plan)` 返回布尔值，拒绝非法 target、空 parts、超过 10 条、非数组或空 segments、非法消息段与非有限/负数 delay，不在诊断中输出正文或密钥。`buildFallbackPlan` 生成一条原正文的纯 text，无引用/@/等待，meta.fallback 为 true；无可用正文时生成空 parts。

`src/delivery/executor.js` 的 `executeDeliveryPlan` 接受 plan、deliver、可选 fallbackDeliver、sleep、onPartSent、onPartFailed。plan 可以是已构建值或同步 builder；同步 builder 使规划异常也能在 I/O 前回退。额外的 text/turn/source/decisionId 是调用方提供的回退上下文；dryRun 可为 true/null 或逐条求值函数，以保留运行中配置读取。

执行器按顺序调用 `deliver({ chatType, chatId, segments, decisionId, source, dryRun })`，只有首条带 plan.decisionId；缺少 deliver 时使用 fallbackDeliver 兼容原 sendDirect，投递失败后绝不改走 fallbackDeliver。规划抛错或校验失败时，以独立上下文构造并校验单条纯文本回退计划，仍经过同一投递函数；没有可用正文或目标时返回 `{ ok: false, error: 'EMPTY_MESSAGE' }`，不输出原规划异常。

真实成功逐条同步调用 `onPartSent({ messageId, index, parts })`；失败调用 `onPartFailed({ delivered, index, parts })`。index 从 0 开始，回调 parts 是计划总条数，返回 parts 是已真实发送条数。执行器不认识 policy、pending、统计和 turnAggregator。返回字段及出现条件保留既有语义：成功为 ok/messageId/result/parts，首条 dryRun 为 ok/dryRun/messageId，首条投递失败为 ok/error/blocked/reason。传输层及业务回调异常按旧行为传播，不将已发生的 I/O 当作规划失败重发。

pipeline 保留原循环为 `sendDecisionCore`；`sendDecisionPlanner` 使用新契约，并在调用方维护原统计与归因副作用。非投递逻辑保持原状。

## 回滚与后续边界

内部配置 `cognition.delivery.engine` 只接受 `core|planner`，默认 core，非法值规范化为 core。不增加 CONFIG_GROUPS 字段或面板入口。显式配置 planner 才启用新路径；恢复 core 即切回旧实现，后续发送生效，无存储迁移。所有 `cognition.reply.*` 配置继续生效。

本次明确不实现模块配置 schema、builtin-reply-delivery、ingress coordinator 或 splitter 模块迁移；不修改模块、`cordis.patch.yml` 或 `.archify/`。不增加依赖，不宣称新增 parity 能力。后续阶段单独提交 DSH 审查批准。

验证仅使用离线单元/集成测试、文档/parity 检查、发行包构建与独立包校验，不进行 live 或浏览器验证。打包仅供本地检查，不代表发布；真实 QQ 兼容性仍需后续独立验收。
