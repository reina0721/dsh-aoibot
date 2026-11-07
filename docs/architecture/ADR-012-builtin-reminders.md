# ADR-012：内置提醒 Provider、命令接管与单所有者交接

- 状态：已接受（Phase 13）
- 日期：2026-11-07
- 前置：[ADR-010](ADR-010-provider-composition.md)、[ADR-011](ADR-011-reminder-repository.md)

## 决定

新增默认启用的 builtin-reminders，无模块配置，提供 reminders。权限为 providers:register、scheduler、reminders:service、config:read、commands、commands:override、access:check、delivery:send。继续使用 cognition.reminders 的五字段只读配置，enabled 默认 false；生产内置模块总数为四个。

提醒业务规则提为 src/reminders/service.js，核心兼容服务和模块共用；精确解析、回复与错误映射提为 src/reminders/commands.js。模块 add/list/cancel/tick 仅经 reminderRepository，固定原人格 reminder kind；核心保留原 store/outbound 适配及主人校验。模块私有操作只从 ownerOnly:true 的命令入口调用，主人/deniedCommands/会话访问由 command service 统一执行；模块副作用前再次 api.access.canSend，返回文本仍由 command service 的 send 交付。三个覆盖被移除即恢复核心，help 不重复显示受保护命令。

新增内置 access:check / api.access.canSend，调用既有 access，缺失/异常返回 allowed:false。delivery:send / api.delivery.send 仅向 DeliveryService 提交一个原文 text part，不拆分/引用/@，不直连网关；默认 source:module:<id>，只有 builtin-reminders 可显式使用 reminder。无额外出站参数、访问豁免或 gateway 回退。新权限外部声明在导入前拒绝，provider 仍只能内置注册；permissions 不是进程沙箱。

## 所有权与停止

注册表 subscribe 返回幂等 disposer，成功增删通知冻结的 name/moduleId；无 provider 对象/秘密，监听器同步抛错和 Promise 拒绝独立隔离。旧 register/remove/list 身份语义保持。

host 等待 modulesReady，通过串行 syncReminderOwnership 与订阅协调：有 provider 时先 await cognition.stopReminders，再 start provider；无 provider 时先 await 旧 provider.stop，再 start core。start 失败先尽力 stop 部分启动资源再核心回退，同次注册不循环重试，重新注册可尝试。每次 await 后确认当前注册版本，变更时重新选择；核心 start/stop 幂等，无 provider 的安装只启动一次核心调度器。

服务 stop 立即清 timeout 并改变 generation，禁止下一条发送和旧回调重新排 timer；返回当前 tick 的排空 Promise。当前已提交发送完成后正常写回，再退出循环。内核清理 provider 先 await stop，然后撤销 API、清理 timer/命令/注册；因此停用或依赖重载不会先撤销仓库而丢失成功状态。host 在停止旧所有者完成前不启动新所有者，避免同进程双调度器。

宿主 dispose 保持同步幂等，先调用 stop({dispose:true})，内置实现立即 dispose、清 timer 并禁止后续写回，随后可关闭数据库；不等待外部网络完成。等待中的 start 在卸载后完成会再 stop。provider 接口仍只要求 start/stop，最终停止选项为可选内部约定。错误 provider 的 stop 抛错/拒绝仅记录固定日志尽力清理，无法证明其无遗留资源。

## 数据与 tick

无迁移、双写或 module_store 副本。仓库既有方法保持；新增 all(status='active') 返回指定状态完整业务投影（扫描上限 100 万），让默认最多 1000 活跃提醒的防重/额度检查覆盖 50 条以外，并先过滤聊天再取命令列表上限。没有任意 predicate、事务回调、kind/路径/人格参数。

capture() 在端口内部固定调用时的 persona scope，返回冻结仓库及 isCurrent()，不暴露原始 kind/persona/base。方法仍检查 runtime；停止、失败及清理后撤销。tick 在 await 后向原人格写回，若当前人格已改变不再处理剩余候选。核心适配器采用相同规则。

单一自调度 timeout，tick 无重叠，先按 nextAt/id 排序取最早 20 条。重复成功从完成时刻 now + interval 推进；失败保留 active，白名单错误或 SEND_FAILED，至少 max(60,minIntervalSeconds) 秒后重试；dry-run ok 计成功。等待前后比较完整业务快照，不复活删除行，不覆盖取消/替换。默认值、文本/目标/时间/间隔/额度/重复检查、原行字段及提醒人格复制/删除/统计/备份均保持兼容。

## 验证与限制

覆盖注册通知/异常隔离、默认与空 provider、运行期停用/接管/失败回退/快速变更、同步卸载与迟到 start、命令恢复、精确文案/业务数据对等、50 条外防重/按聊天限量、最早 20 条、重复/失败/dryRun、不重叠、停止排空与 timer 清理、人格切换、取消/删除/替换、仓库捕获撤销、访问与真实 outbound 闸门、外部权限/注册拒绝、e2e 四模块及独立包加载。

运行 npm test、check:docs、check:parity、pack:release、check:package 和 git diff --check；打包仅本地验证，无推送、部署、发布或版本变化。未改配置/UI、cordis.patch.yml、.archify/、媒体或依赖。

交接等待时长取决于现有发送完成/超时；发送不能撤回。网关超时、进程崩溃或最终同步卸载后重试仍可能重复，无跨进程 exactly-once/分布式锁。到期及状态查询仍扫描现有本地存储，不新增索引。无提醒 REST/UI、DSH jobs、LLM/任意任务执行，真实 QQ/定时投递未验收，既有 parity 范围不扩张。
