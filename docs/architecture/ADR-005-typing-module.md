# ADR-005：内置私聊 typing 生命周期模块

- 状态：已接受（Phase 6）
- 日期：2026-11-07

## 背景与决定

原 pipeline.handleTurn 在开启 cognition.typing.enabled 的私聊轮次前后直接调用 gateway 的输入状态动作。将行为迁入默认启用的 builtin-typing，核心只保留通用轮次生命周期 seam。原配置默认 false，UI 字段、路径和 normalizer 不变；不新增模块配置或模块配置 UI。

## 契约与依赖方向

核心 src/cognition/turn-hooks.js 的 createTurnHooks({logger}) 仅提供 register/start/end/list。register 要求非空唯一字符串 id，至少一个 handler，所有提供的 handler 必须为函数；返回幂等 disposer，旧 disposer 不删除同 id 的新注册。start 按注册顺序串行 await，end 逆序串行 await。每项同步/异步异常独立隔离；固定安全日志不含描述符、上下文、聊天 ID 或原始错误，logger 异常也被隔离。

host 在 cognition 创建前创建 turnHooks，将其传给 cognition → pipeline，同时将 turnHooks 和 gateway 注入 module kernel。核心不导入 modules/builtin/typing.js。模块仅通过内核提供的窄 API 使用服务：

- turn:lifecycle 对应 api.turn.register({id,onStart,onEnd})，要求 active、permission、builtin；注册 disposer 纳入 runtime 清理。
- status:write 对应 api.status.setInputStatus(userId,eventType)，同样要求 active、permission、builtin；仅调用注入的 gateway.actions.setInputStatus(String(userId),eventType)，保留网关参数校验、结果与异常，不提供通用 action、其它 gateway 回退或原始错误日志。

外部 manifest 可以识别这些权限，但不能调用上述 API；伪造 source/builtin 无效。permissions 仍只是稳定 API 边界，不是 Node.js 沙箱。

## 轮次语义与兼容

注入 registry 时，pipeline 构造唯一窄上下文 `{turn,settings:{typingEnabled:cfg().typing?.enabled===true}}`，先 await start，再 try return await processTurn，finally await end。结果和原始处理异常保持；命令提前返回也执行 end。private/config 检查属于模块，核心不判断 typing 条件。

builtin-typing 默认启用，只申请 turn:lifecycle 与 status:write，无 config schema。onStart/onEnd 只有在 settings.typingEnabled 严格等于 true 且 turn.chatType 等于 private 时，分别 await 状态 1/2；两处都吞掉错误，提示失败不影响处理，不向群聊发送状态。模块关闭时 hook 移除，即使配置开启也没有 typing；注入空 registry 或模块初始化失败时也没有内联回退。

仅 turnHooks=null（旧调用方/单测未注入）时保留原 inline typing，顺序、私聊检查、严格 true、缺动作跳过、finally 清理、错误吞掉和不记录异常均不变。该兼容路径不用于生产宿主。状态 API 自身透传 gateway 校验，只有 typing 模块负责尽力吞掉错误。

## 生命周期与限制

停用、setup 失败、依赖重载/禁用和 dispose 均清理 hooks 与原有监听器；重新启用重新注册，不重复保留旧 hook。已经开始的异步 handler 不被强制取消，start/end 各自按调用时的注册列表执行；没有额外超时、重试或跨轮次状态协调，沿用 best effort 行为。

仅迁移私聊 typing；媒体、提醒、其它能力、模块配置 UI、版本和 live 配置均不在本阶段范围。

## 验证

覆盖 registry 顺序/逆序、同步/异步异常与安全日志、disposer/重复 id/无 handler 校验；pipeline null/空 registry/有 hook、窄上下文、await 顺序、结果与原处理异常；默认模块、配置关闭/非 boolean/私聊/群聊、状态失败与生命周期清理；权限/active/外部伪造拒绝和 gateway 校验透传。保留旧 typing 集成测试，增加宿主 HTTP 模块目录（builtin=3）、启停和真实 mock OneBot 状态动作、面板无配置按钮与 tgz/zip 独立加载检查。

要求执行 npm test、npm run check:docs、npm run check:parity、npm run pack:release、npm run check:package、git diff --check。离线验证不代表真实 QQ/浏览器/live 验收，parity 矩阵保持原状。
