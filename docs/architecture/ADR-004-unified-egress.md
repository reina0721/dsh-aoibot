# ADR-004：统一自动文本出站（Phase 5）

状态：已采纳。

## 背景与决定

回复 pipeline 已使用 DeliveryPlan 与 executeDeliveryPlan，但认知命令、模块 sendText、主动行为与 Agent qq_send_text 仍直接调用 outbound。新增核心 `src/delivery/service.js` 的 `createDeliveryService({outbound,sleep})`，将这些自动文本意图提交为单条 DeliveryPlan，复用既有执行器和 outbound 安全闸门；没有新依赖或配置。

生产 cognition 在 outbound 之后创建并暴露 `services.delivery`，注入 commands、proactivity 与 Agent runtime；runtime 继续传给 QQ tools，host 传给模块内核。四类入口有服务时优先使用 delivery；未注入时保留旧 outbound 路径供独立调用方和测试使用。proactivity 仅在 delivery/outbound 都不存在时保留原 legacy gateway/dryRun 路径。生产接线始终注入服务，不会走此兼容分支。

## 单条交付契约

`deliver({chatType,chatId,segments,text,source,decisionId,dryRun})` 优先使用显式 segments，否则把非空 text 包为 text 段；空消息安全拒绝。服务不解析 planner registry，不拆分文本，不添加引用或 @，不等待。source、首条 decisionId 和 dryRun 交给执行器转发，outbound 继续负责访问控制 → 频率上限 → leak guard → dryRun → gateway → 归因/计数。

服务合并 outbound 与执行器结果，保留 ok、messageId、result、dryRun、error、blocked、reason 等字段；有效单条计划返回 parts:1（包括 dryRun/拒绝，表示本服务的计划条数）。outbound 不可用时返回 `{ok:false,error:'OUTBOUND_UNAVAILABLE'}`，不抛出异常。服务没有 direct gateway fallback：缺少 outbound 时直连会绕过同一套安全闸门；outbound 拒绝后也不能改走 gateway 或重试。执行器和 outbound 本身的契约不改。

## 行为与边界

命令权限与返回语义、模块权限与来源 `module:<id>`、主动行为决策和预算、工具当前会话作用域均保持原行为。原回复 pipeline 继续通过现有规划器/执行器处理分条，保留统计、pending 与归因；本阶段不调整 planner、引用/@、分条、限频、重试、部分成功或 leak guard。

面板人工 `POST /send` 明确豁免，保留 direct gateway 路径。媒体/文件命令、提醒服务留待后续阶段；QQ like/poke 等非文本动作也不在本阶段范围内。本阶段没有版本升级、发布、部署或真实 QQ/浏览器验收。

## 验证

增加单条 text/segments、优先级、长文本不分条、无等待、首条 decisionId、配置/显式 dryRun、空消息、拒绝与缺失 outbound 测试。四类生产者覆盖注入优先级、不回退和旧 harness 兼容；源码断言锁定 cognition、runtime 与 host 的生产注入。保留既有宿主 e2e；验证 npm test、check:docs、check:parity、pack:release、check:package 和 git diff --check。
