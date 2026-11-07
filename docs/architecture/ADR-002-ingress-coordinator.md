# ADR-002：原始事件入站协调器

状态：已批准架构计划的 Phase 2；基于 Phase 1（`a56fe49`），仅抽离入站编排。

## 决策与边界

新增 `src/ingress/coordinator.js`，导出 `createIngressCoordinator({ access, cognition, events, modules, ctx, normalizeEvent, getConfig, logger })`，返回 `{ handleRaw }`。依赖全部由宿主注入；不增加依赖、定时器、全局状态、配置或对外扩展 API。

`host.js` 保留 gateway 的 `onEvent(raw)` 回调，将其实现委托给协调器。构造发生在 access/cognition/events/modules 已创建之后、gateway 创建之前；`modules.start()`、提示词变量注册、`modulesReady`、`gateway.ready` 和连接启动的相对顺序保持原样。协调器使用原 `plugin` 子 logger，保留原日志级别与文案。

协调器只负责调用顺序和异常隔离。access 决定访问权限；gateway normalizer 转换事件形状；event store 决定过滤、缓冲与计数；cognition 负责 raw 归档与 observe；module kernel 负责模块；ctx 负责事件广播。所有规则、输入对象和公开载荷继续由原服务拥有。

## 顺序与错误边界

1. `access.decideRaw(raw)`；拒绝时 debug 并返回，不执行归档、规范化或任何后续步骤。
2. `cognition.ingestRaw(raw)`；同步失败仅 warning，继续规范化。
3. `normalizeEvent(raw, getConfig())`；null 直接返回，raw 已归档。
4. `events.push(normalized)`；不在协调器重复过滤或记账。
5. `cognition.observe(pushed.record || normalized, { accepted: pushed.accepted, reason: pushed.reason || '' })`；同步失败仅 warning。
6. `pushed.accepted` 为 false 时 debug 原 reason 并返回，不分发、不广播。
7. `modules.dispatch(pushed.record).catch(...)`；调用同步发生，不等待其 Promise 完成；拒绝仅 warning。
8. `ctx.emit?.('onebot-qq/event', pushed.record)`；与模块和 observe 使用同一个 record 引用，同步失败仅 warning。
9. 以上未局部捕获的同步异常由外层 warning 并结束处理，不抛入 gateway。包括 access、配置读取、normalize、push 和 dispatch 同步异常；dispatch 同步异常仍会跳过广播。ingestRaw、observe、emit 继续沿用同步调用，不增加 await 或 Promise 拒绝处理。

因此过滤前 raw 与 observe 都保留，模块异步执行与广播互不等待；不增加重试、排队、去重、重新发送或新日志。

## 内部 envelope 与公开载荷

每次 `handleRaw` 创建一个仅属于该调用的上下文：

```js
{
  version: 1,
  platform: 'onebot',
  raw, normalized, // 内部引用，不复制或附加到公共事件/hook
  accepted: false,
  reason: '',
  correlationId: '',
}
```

规范化后 correlationId 按 `message.id`、`notice.messageId`、`notice.flag`、`request.flag` 的顺序取第一个非 null/undefined 值，只保留字符串/数字原值；没有就留空。通知/请求没有稳定标识时不组合 user/group/time，不使用 event store 的 seq，也不生成随机 ID。请求 flag 可能敏感，关联值仅在内部返回，不增加日志或公共 hook 参数。

同步返回 `{ accepted, reason, correlationId }` 供内部测试与调用方判断，host 忽略它。accepted 表示 event store 接受情况；之后模块或广播失败不改变已接受事实。拒绝和过滤使用原 reason，无法识别为 `unrecognized`，接受前外层异常为 `error`。返回值不含 raw、normalized、整个 envelope 或配置。

规范化对象与 `onebot-qq/event` 的形状完全不变，不追加 version/platform/correlationId 等字段。既有 normalizer 本来就包含按配置截断的 `raw`；为保持行为对等，本阶段保留它，不宣称消除了原有事件中的 raw 或秘密。协调器不再复制原始输入或配置密钥到公开事件、模块参数或 observe 元数据。

## 验证与限制

`test/ingress.test.js` 以注入 fake 锁定拒绝、无法规范化、过滤、接受的调用顺序、对象引用、配置读取、非阻塞模块分发、各错误边界和关联 ID；另以既有 normalizer 验证 raw 字段契约。原宿主 e2e 继续覆盖真实组装、连接准备与过滤行为。运行全部单元/集成测试、文档/parity 检查、本地双格式打包及独立包校验、diff 空白检查。

不修改 UI、面板、module kernel、交付 seam、reply-split、`cordis.patch.yml` 或 `.archify/`。不改变 parity 矩阵、不升级版本、不发布、不部署；未做真实 QQ 或浏览器验收。本次无统计 API 或持久化 envelope。

## 回滚

回退 Phase 2 的单个提交即可恢复 `host.onEvent` 原内联实现并删除协调器、专用测试与本次文档变更；保留 Phase 1 的 DeliveryPlan/Executor。没有配置、数据格式或存储迁移，不需要数据回滚。后续 schema、模块策略或交付拆分继续单独审查，不能借本协调器改变入站语义。

相关契约：[架构 §3.3](../ARCHITECTURE.md#33-入站协调与事件规范化srcingresscoordinatorjssrcgatewaynormalizejs)、[Phase 1 ADR](ADR-001-delivery-seam.md)。
