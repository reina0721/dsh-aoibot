# ADR-010：Provider 注册表与提醒启动权收束

- 状态：已接受（Phase 11，基础设施范围）
- 日期：2026-11-07

## 背景与决定

核心提醒目前由 cognition.init 自动启动。未来内置提醒模块若自行启动调度器，会与核心重复运行。先建立受限 provider 组合入口，由宿主在模块加载完成后选择单一启动所有者；本阶段不迁出提醒或媒体，不新增生产 provider，生产内置模块仍为三个。

新增 src/extensions/providers.js 的 createProviderRegistry({logger})。注册表没有模块导入或服务业务逻辑；固定白名单只有 reminders。register(name,provider,{moduleId,source='builtin'}) 要求来源严格为 builtin、非空字符串 moduleId、非数组对象 provider、start/stop 函数和可选 status 函数。每个槽位仅一个 provider，同名和同 moduleId 重复均拒绝，不提供替换、优先级或覆盖栈。

get(name) 返回 provider 或 null；list() 返回仅含 name/moduleId/source 的新元数据对象，不暴露函数、内部注册对象或 status 结果；remove(moduleId) 返回是否移除。register 返回幂等且绑定注册对象身份的 disposer，旧 disposer 不会删除后续注册。注册、移除、list 均不调用 start/stop/status；生命周期方法由宿主或服务所有者负责。

## 模块边界

新增已知权限 providers:register。api.providers.register(name,provider) 先检查 runtime 活跃、权限和加载器确认的 builtin 来源，再把 record.id/source 传给宿主注入的 providerRegistry；不接受模块提供的身份。外部可以声明已知权限，但调用时拒绝，伪造 manifest.source/builtin 无效。缺注册表安全失败。权限仍只是同进程 API 边界，不构成任意 Node.js 代码沙箱。

注册 disposer 进入 runtime.disposers，停用、setup/事件失败、依赖禁用/重载和 kernel.dispose 时注销；旧 API 不可再注册。注销本身不停止已启动服务，也不触发热切换。本阶段没有生产模块取得提醒槽位。

## 启动、回退与清理

createCognition 保留提醒服务构造/初始化、命令接线、存储和 dispose，init 不再调用 reminders.start。新增 startReminders()，只在认知就绪且未激活时启动一次；卸载后不再激活。其它后台任务不受影响。独立/测试使用者显式启动提醒。

host 在模块内核前创建 providerRegistry，并注入内核。ready 只执行一次：await modulesReady，查找 reminders provider，有则 await provider.start，不启动核心；无 provider 则 cognition.startReminders。start 同步抛错或异步拒绝时，记录固定安全警告，先尽力 await provider.stop 清理部分初始化资源，再激活核心。stop 同步/异步失败隔离，不阻止核心回退，也不记录原始异常。之后等待 gateway.ready，按原 enabled 设置启停网关。

dispose 保持同步并增加幂等保护，先调用选中 provider.stop，再关闭 cognition；捕获同步异常和 Promise rejection，不等待异步 stop 完成。卸载早于模块就绪时不启动提醒或网关；在途 start 于卸载后结束时再次 stop，provider 需要能重复安全停止、取消自身在途工作并避免迟到副作用。核心提醒仍由 cognition.dispose 清理。

没有 provider 的默认安装只启动一次原核心调度器，reminders.enabled 仍默认关闭，提醒命令、配置、人格存储与出站闸门不变。业务关闭时仍与旧实现一样建立调度循环，tick 遵循业务开关。

## 验证与限制

新增注册校验/重复/身份绑定移除/元数据隔离测试，内置权限/外部来源拒绝、停用/失败/dispose 和旧 API 撤销测试。真实 host 配合 fake DSH 验证无 provider、provider 接管、同步/异步启动失败核心回退、停止失败、网关顺序、重复 ready/启动和卸载竞态；仅测试句柄使用 registry 注入假 provider，不增加生产模块。提醒集成测试显式激活，断言构造阶段无提醒定时器、持久化重启后投递和卸载停止。

运行 npm test、npm run check:docs、npm run check:parity、npm run pack:release、npm run check:package、git diff --check。本地打包检查不代表推送、发布、部署或真实 QQ/浏览器验收。

不做运行期重新组合、provider 健康监控、超时、重试或自动热切换；启动失败后的 stop 仅尽力而为，不能保证错误实现没有残留资源。异步 stop 完成前 cognition 可能已关闭，未来真实 provider 必须约束在途访问及停止语义。未来提醒提取仍需定义命令/存储所有权和运行期启停，本阶段只提供启动权边界。无配置、UI、依赖或版本变化。
