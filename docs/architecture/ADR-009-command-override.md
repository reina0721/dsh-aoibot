# ADR-009：内置模块受保护命令覆盖

- 状态：已接受（Phase 10，有限范围）
- 日期：2026-11-07

## 背景与决定

提醒命令目前由核心 commands.js 分发，模块 registerCommand 拒绝所有受保护名称。未来迁移需要内置模块在启用时取得原命令名，停用时保留核心回退。本阶段只建立覆盖 API，不迁出提醒/媒体、不新增生产模块、配置、UI、REST、依赖或版本变化，生产 registry 仍为三个内置模块。

命令服务扩展为 `registerCommand(name,handler,{ownerOnly=true,allowProtected=false}={})`。受保护名称仅在 allowProtected 严格为 true 时允许；名称继续规范化为小写并验证格式，handler 必须为函数。已有 externalCommands 注册始终拒绝，不支持覆盖栈、抢占或优先级。覆盖与普通模块命令共用同一 Map，handle 中已有的模块分支优先于核心分支。

模块 API 扩展为 `api.registerCommand(name,handler,{ownerOnly=true,overrideBuiltin=false}={})`，新增已知权限 commands:override。覆盖选项仅对加载器认定为 builtin 且同时有 commands 与 commands:override 的模块生效；overrideBuiltin 严格为 true 才请求覆盖，内核验证后传 allowProtected:true。外部或缺权限调用抛错，setup 中未捕获的错误进入模块 error 并清理已有资源；不会拖垮宿主。外部可声明此已知权限但无法调用覆盖选项，manifest 伪造 source/builtin 不改变加载器身份。未显式开启时，受保护名称仍被拒绝；普通外部命令契约保持。稳定 API 权限不构成同进程 Node.js 沙箱。

## 安全与回复路径

覆盖沿用模块命令默认 ownerOnly:true，即使操作员原来有核心只读命令权限，也不能执行默认仅主人的覆盖；内置模块可以明确设置 ownerOnly:false。名称规范化后依旧检查 cognition.permissions.deniedCommands，主人收到固定禁用提示、其他人静默，不调用 handler。

现有模块分支在 handler 前缺少通用会话访问检查。为受保护名称的覆盖增加 canSendTo 检查，拒绝时返回 ACCESS_DENIED 且无 handler 副作用；访问服务缺失、抛错同样拒绝。这项前置检查仅作用于覆盖，普通外部命令行为不变；操作员原有只读访问闸门也保留。

handler 收到原有 `{turn,parsed,args}`，返回字符串或 `{reply}`；回复使用既有 send → DeliveryService → executor → outbound，source 为 command，仍经过访问控制、频率上限和 leak guard。旧调用者未注入 delivery 时保持 outbound 兼容路径。handler 异常返回固定命令执行失败文案；发送拒绝保留既有错误结果，不重试也不触发核心实现，避免重复副作用。核心特定业务开关、参数校验及审批逻辑不会在覆盖期间自动执行，未来迁移模块须保留所需业务规则；此 API 不代替它们。

## 生命周期与回退

命令服务 disposer 比较注册对象身份后删除，幂等且不会移除以后注册的同名命令。模块内核照旧收集到 runtime.disposers；停用、setup 失败、事件失败隔离、依赖禁用/重载和内核 dispose 都注销覆盖，旧 runtime 不可再次注册。内置模块不直接 reload，依赖重载时使用新 runtime 重新 setup。已经开始的异步 handler 不强制取消或等待结束。

无覆盖注册时，下一次命令使用原核心分支，包括其现有配置开关与安全规则。模块默认关闭、停用、初始化失败或清理完成都不删除/改写核心实现。回退发生在后续分发查不到注册时，不发生在同一次模块执行失败后。本阶段不增加生产模块来取得任何命令，所有生产命令仍由既有核心实现执行。

## 验证与限制

只使用测试内置描述符覆盖 /status；断言模块 handler 执行而核心 summary 不执行，回复经过真实 DeliveryService。覆盖服务显式 opt-in/严格 true、大小写、重复注册、幂等与旧 disposer 身份、默认 ownerOnly（含操作员）、显式公开、动态 deniedCommands、会话允许/拒绝、访问服务缺失/异常、回复拒绝/handler 错误不重试。外部伪造来源、直接传 allowProtected、缺少 commands 或 commands:override 都不能取得受保护名称；普通外部命令不变。

生命周期测试覆盖停用/重启用、部分 setup 失败、同 setup 重复注册失败、竞争模块注册失败不移除先前覆盖、事件隔离、依赖重载/禁用、内核 dispose 与旧 API 撤销。既有 E2E 与面板测试继续断言三个生产内置模块。运行 npm test、npm run check:docs、npm run check:parity、npm run pack:release、npm run check:package 与 git diff --check；本地检查和打包不代表 live QQ 验收、推送、部署或发布。

这是未来提醒迁移的前置 API，没有提醒/媒体提取、恢复、重试或投递保证，也没有新的配置或 UI 入口。
