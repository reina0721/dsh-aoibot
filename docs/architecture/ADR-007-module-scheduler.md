# ADR-007：内置模块生命周期调度器

- 状态：已接受（Phase 8，有限范围）
- 日期：2026-11-07

## 背景与决定

未来提醒和媒体迁移需要一个随模块生命周期清理的调度契约。先在模块内核提供一次性 timer API，避免功能模块各自保存原生 timer、在停用或重新 setup 后执行旧回调。本阶段不提取或迁移现有提醒/媒体功能，不改变生产 registry 的三个内置模块，也不增加配置、UI、REST 或依赖。

## 权限与 API

共享 manifest 将 scheduler 识别为已知权限。仅加载器标记 builtin 且声明该权限的模块获得冻结的 api.scheduler；其它模块没有该属性，外部清单伪造 builtin/source 无效。permissions 只限制稳定 API，任意同进程本地代码仍可自行使用 Node.js，不构成沙箱。

- setTimeout(fn,delayMs) 同步返回冻结的 {id,dispose}。fn 必须为函数，delayMs 为数字整数，含边界 0–2,592,000,000 ms（30 天），不做类型转换；0 也异步执行。失效 runtime、非法参数或超过每模块当前 runtime 64 个活跃 timer 时同步抛错。
- id 使用随机 UUID 字符串，不接受调用者指定身份，不包含网关/用户/聊天 ID，不暴露原生 timer handle；Map 只在创建它的 runtime 内查找，因此不同模块与不同 generation 不能互相取消。
- clearTimeout(id) 清除原生 timer 并删除注册，存在返回 true，否则 false。dispose() 执行同一取消操作且幂等；触发/取消/停止后均返回 false，不要求 runtime 仍 active。

## 调度与生命周期

runtime.timers Map 保存注册和原生 handle，使用全局 setTimeout/clearTimeout。Node 单次延迟最大安全值为 2,147,483,647 ms，小于 30 天；按 performance.now() 的单调截止时间分段，单次不超过该上限，每次唤醒计算剩余时间。既避免溢出后立即执行，也避免事件循环迟到后再等待完整剩余分段；系统时间调整不改变截止时间，实际执行可以迟到。

每次原生回调先检查内核未 dispose、runtime active、record/runtime 与目录记录仍为当前 generation，以及同 id 注册仍存在。未到截止时间继续分段；到期先删除注册、释放额度，再无参数调用 fn。返回的 Promise 拒绝和同步异常独立捕获，不停止模块、不影响其它 timer。日志只含固定文案和经过清单验证的模块 ID，不读取异常 message/stack 或输出回调/payload/聊天 ID；logger 抛错也被隔离。

disposeRuntime 首先使 runtime 无效、从 record 脱离，清除全部原生 timer 和 Map，然后执行原有逆序 disposers/cleanup 与存储 drain。停用、setup 失败、事件隔离、依赖重载/禁用和内核 dispose 共用这一路径。已取消或旧 generation 的迟到回调无操作，不能触发用户函数或重建 timer；旧 API 不能注册。内置模块继续禁止直接 reload，依赖重载后的 setup 创建新 runtime。

## 限制

只有一次性 timer，没有 interval、cron、持久化、重启恢复、重试或准点/恰好一次投递保证。64 的额度只计算尚未开始的注册，不限制已经开始的异步回调并发。已经开始的异步工作不被强制取消，也不在模块清理时等待；模块负责其在途工作的取消与结果归属。未来提醒/媒体迁移需单独设计状态与投递语义；本阶段没有实际功能迁移或新增模块。

## 验证

仅用测试内置描述符声明 scheduler 权限，不修改生产 registry。测试覆盖真实全局 timer、0/正延迟、30 天分段/迟到、参数与额度边界、触发/取消后额度释放、模块/runtime ID 隔离、权限缺失和外部伪造拒绝、停用/重新启用/依赖重载/失败/dispose 清理、原生迟到回调无操作、同步/异步异常和安全日志（含 logger 失败）。现有 E2E 与包验证继续要求 builtin=3。

运行 npm test、npm run check:docs、npm run check:parity、npm run pack:release、npm run check:package 与 git diff --check。离线检查与本地打包不代表真实 QQ/live 验收、发布或部署；版本保持不变。
