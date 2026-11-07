# ADR-006：显式 DeliveryResult 状态与实际发送条数

- 状态：已接受（Phase 7，有限范围）
- 日期：2026-11-07

## 背景与决定

执行器原先将全部发送成功和后续分条失败都返回为 `ok:true`，调用方无法直接区分；DeliveryService 又把执行器结果覆盖为 `parts:1`，使单条拒绝和 dry-run 也被报告为已发送一条。本阶段为既有结果增加显式状态，并移除服务的固定条数覆盖，发送顺序、回调与实际 I/O 行为保持不变。

## 状态矩阵

`executeDeliveryPlan` 的正常返回包含 `status` 和 `parts`；`parts` 始终是已真实成功发送的条数。`failedPart` 与逐条回调的 `index` 一致，从 0 开始；回调中的 `parts` 仍是计划总条数。

| 情况 | status | ok | parts | 其它字段 |
| --- | --- | --- | --- | --- |
| 全部分条成功（含单条纯文本回退成功） | `sent` | `true` | 实际成功条数 | 保留首个非空 `messageId`、最后成功的 `result` |
| 首条 dry-run | `dry_run` | `true` | `0` | 保留 `dryRun:true`、`messageId:''` |
| 已发送后遇到 dry-run | `dry_run` | `true` | 此前实际成功条数 | 保留此前 `messageId`/`result`，不新增 `dryRun:true`，不标记失败 |
| 首条失败（含没有可用投递函数） | `failed` | `false` | `0` | 保留原 `error`/`blocked`/`reason`；缺错误码用 `SEND_FAILED` |
| 后续分条失败 | `partial` | `true` | 此前实际成功条数 | `partial:true`、`sentParts` 等于 `parts`、`failedPart` 为失败索引、`error:'PARTIAL_SEND'`；保留此前 `messageId`/`result` |
| 计划无效且纯文本回退仍无效 | `empty` | `false` | `0` | 保留 `error:'EMPTY_MESSAGE'`，不发送 |

DeliveryService 直接合并 outbound 与执行器结果，执行器的状态和实际条数优先；`ok`、`messageId`、`result`、`error`、`blocked`、`reason`、`dryRun` 仍按原语义保留。服务自身在发送前拒绝非法目标或缺少 outbound 时返回 `status:'failed', parts:0`，错误码仍为 `INVALID_TARGET` 或 `OUTBOUND_UNAVAILABLE`；空/无效正文返回 `status:'empty', error:'EMPTY_MESSAGE', parts:0`。有效单条真实成功为 `parts:1`，失败或 dry-run 为 `parts:0`。

## 兼容与发送边界

`ok` 保留兼容语义：部分发送仍为 `true`，即使同时有 `error:'PARTIAL_SEND'`；调用方如需识别完整成功，应检查 `status`。命令、模块、主动发送和工具继续使用原 `ok` 分支，模块 API 不变。

pipeline 直接透传执行器结果，继续按原 `ok`/`dryRun`/`parts` 更新统计、pending、群聊回复记录与逐条归因。后续 dry-run 不新增 `dryRun:true`，因此此前真实发送仍计入统计；首条 dry-run 仍只增加原有 dry-run 统计。pipeline 在调用执行器前对空正文、纯空白的历史提前返回保持原形状，不扩展为全 pipeline 的统一状态契约。

后续失败立即停止，保留已经发送的消息，不重试、不补发、不撤回、不回滚；规划回退仍只发生于发送前，不将 outbound 拒绝改走其它传输。传输与业务回调抛出的异常继续传播，不转成新状态或触发重发。后续失败的原始原因仍通过既有 `onPartFailed` 回调处理，返回结果只增加固定 `PARTIAL_SEND` 码，不复制原始异常。

## 后续 hardening

以下工作留待后续独立阶段：频率账本（rate ledger）与额度预留/结算、传输重试与幂等、leak guard 顺序调整、shutdown 时在途投递的等待/取消。当前限频记账、安全闸门顺序与 shutdown 行为均保持原状。本阶段不改 typing、媒体、提醒、规划器行为、配置或 UI，也不增加依赖。

## 验证

执行器测试覆盖完整成功、首条失败零条数、第二/第三条失败的部分结果与停止发送、首条/后续 dry-run、无效回退与异常传播；pipeline 对 default/auto/core/planner 及 legacy direct 路径断言新增结果字段，并保留统计/pending/群聊记录断言；服务覆盖成功、dry-run、拒绝、缺 outbound、非法目标与原 outbound 字段保留。

运行 `npm test`、`npm run check:docs`、`npm run check:parity`、`npm run pack:release`、`npm run check:package` 和 `git diff --check`。打包仅用于本地离线校验，不代表发布或真实 QQ 验收；版本与 parity 矩阵不变。
