# 模块：内置与外部

模块架构 v2 使用统一目录、清单、API 与生命周期：

| 来源 | 代码来源 | 启停 | 重载 | 可写目录（api.dir） |
|---|---|---|---|---|
| 内置（builtin） | 随 dsh-bot 发布的静态受信任注册表，不扫描包内目录 | 可以 | 不可以 | `<数据目录>/modules/.builtin/<id>/` |
| 外部（external） | 操作员安装到 `<数据目录>/modules/<id>/` 的本地 JS | 清单允许时可以 | 可以 | 模块目录 |

内置 ID 必须以 `builtin-` 开头，外部模块禁止使用此前缀。内核扫描外部目录时跳过 `.builtin`。Phase 4 已把回复交付规划迁入内置模块；没有远程安装、上传、marketplace 或网络下载模块代码。

> **安全警告：模块是与 dsh-bot 同进程运行的任意本地代码。** `permissions` 只限制下面这套稳定 API，不是操作系统沙箱；模块仍可能直接使用 Node.js 能力。只安装你已经审查并信任的代码，模块目录的写权限也应只给受信任的操作员。

## 安装与清单

把完整外部模块目录复制到 `<数据目录>/modules/<id>/`，然后重启插件，或调用重载 API 并指定 id。已发现的模块可以在面板「模块」页重载；面板刷新只读取当前目录列表，不重新扫描文件系统。仓库的 `examples/modules/echo/` 是最小示例，但示例目录本身不会被自动加载。

每个外部模块必须有 `module.json`；内置清单来自静态注册表，不读取清单文件：

```json
{
  "id": "echo",
  "name": "Echo",
  "version": "1.0.0",
  "description": "回显命令示例",
  "entry": "index.js",
  "apiVersion": 1,
  "requires": [],
  "permissions": ["commands", "events", "storage"],
  "enabled": true
}
```

- `id` 必填，匹配 `^[a-z0-9][a-z0-9_-]{0,63}$`，外部需与目录名一致。
- `entry` 必填，只能是模块目录内的相对 `.js` 或 `.mjs` 文件；路径遍历和符号链接逃逸会被拒绝。
- `name`、`version`、`description` 可选。
- `permissions` 是权限字符串数组，默认空数组；未知权限会令模块进入 error。
- `apiVersion` 可选，默认 `1`，目前只支持数字 `1`。
- `requires` 可选，默认 `[]`，最多 16 个有效模块 ID；不能重复或依赖自身。可跨内置/外部来源依赖，只表示本机模块依赖，不解析版本或下载依赖。
- 外部 `enabled` 默认 `true`；`false` 是硬上限，面板/API 不能覆盖，`canToggle=false`。操作员必须编辑清单并重载。
- `source`、`builtin`、`canReload`、`canToggle` 是加载器输出，清单中的同名值无效。

## 内置示例与状态

随包提供 `builtin-sample`（内置示例，1.0.0），`permissions: ["commands","storage"]`、`requires: []`。默认关闭且不调用 import/setup，没有默认消息行为。启用后仅主人可用 `/module-sample`，读取 `api.config.get().message` 回复，默认「内置示例模块已启用。」；示例申请 storage 权限，但不主动写入 data.json。内置模块不能直接重载；依赖协调可以用缓存代码重新运行 setup，生命周期内不再次调用 lazy import。

另外随包提供默认启用的 `builtin-reply-delivery`（回复交付，1.0.0），仅申请 `delivery:plan`，没有模块配置 schema、`api.config` 或面板「配置」按钮。它通过核心传入的 `replyCfg` 读取现有 `cognition.reply.*`，保留分条、首条引用、群聊 @、条间等待与末条合并余文。新安装 `/modules` 有两个内置模块：回复交付 loaded，示例 disabled。

`<数据目录>/modules/state.json` 的原子持久化格式：

```json
{ "disabled": ["echo"], "enabled": ["builtin-sample"] }
```

兼容旧的 `{disabled}`，文件缺失或损坏按空状态处理。外部有效状态为 `manifestEnabled && !disabled.has(id)`，enabled 列表不能越过清单上限。内置先看 disabled（关闭），再看 enabled（开启），否则使用静态描述符的 defaultEnabled。启停操作先成功持久化新状态，再变更内存与运行资源；写入失败返回安全错误，原运行状态保持。此状态在重启后保留。

## 入口导出

入口导出异步或同步的 `setup(api)`，可以是 named export 或 default export。`.mjs` 始终按 ESM 加载；`.js` 遵循 Node.js 最近的 `package.json` `type` 规则（数据目录中通常是 CommonJS，可用 `exports.setup = ...`）。`setup` 可返回 cleanup 函数：

```js
export async function setup(api) {
  const off = api.on('message', (event) => api.log.debug('message', event.message?.text))
  return () => off()
}
```

## 权限与 API

所有模块始终可读 `api.id`、`api.name`、`api.version`、`api.dir`、只读 `api.source`（builtin/external）、`api.builtin`、只读 `api.permissions` 和模块子 logger `api.log`。缺少权限时调用对应 API 会抛出明确错误；若发生在 setup，模块会进入 error，不会拖垮宿主。

| 权限 | API | 行为 |
|---|---|---|
| `events` | `api.on(name, handler)` | 监听 `message`、`notice`、`request`、`meta_event` 或 `any`；收到规范化事件记录 |
| `commands` | `api.registerCommand(name, handler, { ownerOnly=true })` | 注册 `/name`；handler 收到 `{turn, parsed, args}`，返回字符串或 `{reply}`；不能覆盖内置/其它模块命令 |
| `send:text` | `api.sendText({chatType, chatId, text})` | 通过统一 outbound 以 `source: module:<id>` 发送，仍受访问控制和频率限制 |
| `cognition:read` | `api.cognition` | 只读暴露 `snapshot`、`overview`、`memories`、`personDetail`、`relationshipsList`、`timeline` |
| `knowledge` | `api.registerKnowledgeSource(source)` | 注册认知知识源，重载/停用时自动移除 |
| `capabilities` | `api.registerCapability(name, impl)` | 注册认知 capability，重载/停用时自动移除 |
| `delivery:plan` | `api.delivery.registerPlanner(descriptor)` | 仅内置模块；注册唯一 format 规划器，返回生命周期 disposer；外部或缺权限调用抛错 |
| `storage` | `api.storage` | `get(key,fallback)`、`set(key,value)`、`delete(key)`、`all()`；均为异步 |

外部存储写入模块目录的 `data.json`；内置存储写入 `<数据目录>/modules/.builtin/<id>/data.json`，从不写包内源码。两者都校验目录与文件的 realpath 包含关系，写操作串行且使用原子替换，序列化后最多 1 MiB。模块应 `await` 所有存储写入。备份包含 modules/state.json 与 .builtin 数据；恢复后应重启插件。

## 回复交付规划（Phase 4）

`delivery:plan` 是已知权限，但稳定 API 仅允许加载器标记为 builtin 的模块注册。外部模块即使声明该权限或在 manifest 伪造 source/builtin，调用也会抛错；setup 中调用则进入 error。权限不是 Node.js 沙箱。

```js
api.delivery.registerPlanner({
  id: 'builtin-reply-delivery', stage: 'format', order: 0,
  plan({ text, turn, replyCfg, replyTo, source, decisionId }) {
    // 同步返回 DeliveryPlan，核心负责校验和执行。
  },
})
```

内部 `createDeliveryRegistry()` 提供 register/resolve/remove/list；描述符 id 必须非空且唯一，stage 仅允许 format，最多一个注册项，order 为有限数（省略为 0）。当前没有多阶段排序或外部规划器。register 返回幂等 disposer，内核保存并在停用、dispose、setup 失败、事件隔离或依赖重载清理时移除；已停止的 API 不能重新注册。内置模块本身不直接重载，依赖重载会清理后用缓存代码重新 setup。

核心只传入 `{text,turn,replyCfg,replyTo,source,decisionId}`；replyCfg 是现有 `cognition.reply` 的副本，noReplySegment 已映射为 quote:false，不提供全局配置访问。规划器不发送消息，返回 Phase 1 DeliveryPlan（target、parts 中的 segments/delayAfterMs、source、decisionId、meta），所有发送仍经过 executor 和 outbound 的访问控制、频率上限及 leak guard。

内部开关 `cognition.delivery.engine` 接受 auto/core/planner，默认 auto，不增加全局配置 UI 字段：

| engine | 有 format planner | 无 planner（含模块停用/初始化失败） |
|---|---|---|
| auto | 使用模块规划 | 使用 core 兼容布局，保留分条/引用/@/等待 |
| core | 始终使用 core 兼容布局 | 同左 |
| planner | 使用模块规划 | 单条纯文本回退 |

已选中的规划器抛错或返回无效计划时也回退为单条纯文本（无引用/@/等待），仅记录固定安全警告；回退仍过 outbound，不重试发送拒绝。空正文、纯空白处理、dryRun、部分成功、统计与归因保持既有语义。配置不迁移，不新增模块配置文件；停用后下一次发送重新解析 registry。详见 [ADR-003](architecture/ADR-003-reply-delivery-module.md)。

## 内置模块声明式配置（Phase 3）

只有受信任的内置 registry 描述符可以声明可选的 `config`，不能写在共享 manifest 中。外部 manifest 即使声明同名属性，也没有配置 API、运行时 `api.config` 或面板配置入口。未声明配置的内置模块同样没有这些能力。不接受 `secret`，配置字段只适合非秘密值；不把令牌或密码放入配置。

```js
config: {
  version: 1,
  fields: [
    { path: 'message', type: 'text', label: '示例回复', default: '内置示例模块已启用。', maxChars: 200, help: '主人使用 /module-sample 时发送的回复。' },
  ],
}
```

`version` 目前只支持数字 1。最多 32 个字段；`path` 必须唯一并匹配平面键 `^[a-z][a-zA-Z0-9_]{0,63}$`，不能用点路径；`label` 必须是非空字符串。支持可选 `help`、`placeholder`、`unit` 文本元数据，数字可带正数 `step` 供控件显示。所有默认值也经过完整类型与边界校验。

| 类型 | 服务端验证 | 省略 default 时 |
|---|---|---|
| `switch` | 严格 boolean | `false` |
| `text` / `textarea` | 字符串，Unicode 码点数 ≤ maxChars | `""` |
| `number` | 有限数字，可选 min/max（含边界） | `0` |
| `select` | 值属于 options；1–100 项 `{value,label?}`，value 为唯一字符串 | 第一项 value |
| `string-list` | 字符串数组，每项受 maxChars 限制，长度受 minItems/maxItems 限制 | `[]` |
| `number-list` | 有限数字数组，每项受 min/max 限制，长度受 minItems/maxItems 限制 | `[]` |

字符串 `maxChars` 默认 2000，可设 0–65536；列表 `minItems` 默认 0、`maxItems` 默认 100，可设 0–1000 且 minItems ≤ maxItems。类型默认值若不符合字段边界，描述符无效，需显式提供合法 default（例如 min 为 1 的 number）。更新的 `values` 必须是对象，拒绝未知键、类型转换及非法值；缺失字段填 schema 默认值，属于完整替换而不是合并旧值。

内核在启动发现内置模块时加载并验证配置，因此关闭时也可以读取/保存，且 `setup(api)` 一开始就能读到有效值；不会为此导入默认关闭模块的代码。文件为 `<数据目录>/modules/.builtin/<id>/config.json`，与模块 `data.json` 分离，从不写包内源码：

```json
{ "version": 1, "revision": 1, "values": { "message": "新的示例回复" } }
```

文件最多 64 KiB（包括 version/revision 和格式化 JSON），校验目录及文件 realpath 包含关系，在同目录写临时文件后原子替换，失败清理临时文件，保留当前内存值。缺失、损坏、超限或无法读取时使用全部默认值、revision 0，并通过安全日志和模块记录的 `configWarning` 提示，不因配置文件故障阻止 setup。回退不会自动改写文件，成功保存后清除警告。磁盘有效配置在重启时恢复；不监视手动文件修改，不提供 schema 迁移。

声明了配置的内置模块获得只读的 `api.config` 对象，无需另增 permission：

- `api.config.get()` 同步返回当前已校验值的深拷贝，调用者修改不会影响内核。
- `api.config.onChange(handler)` 注册监听，返回幂等 disposer。保存成功后传入新值的独立深拷贝；同步/异步 handler 错误仅安全记录，不让模块进入 error。通知不等待异步 handler，避免 handler 调用生命周期操作时互锁。
- 监听属于当前 setup 生命周期，停用、依赖重载引发的重新 setup、失败清理及 dispose 都会自动注销；已开始的异步 handler 不会被强制取消。

内核 `getModuleConfig(id)` 返回 `{id,source:'builtin',schema,values,revision}` 深拷贝；`setModuleConfig(id,values,revision)` 与启停/重载/dispose 串行。POST 必须携带 GET 返回的非负整数 revision，过期返回 `MODULE_CONFIG_CONFLICT`；成功持久化后 revision 加 1、再更新内存和通知监听器，首次写入为 1。未知模块、外部模块及无配置模块统一拒绝。revision 用于同一内核中的乐观并发控制，不是跨进程文件锁；缺失/损坏回退后从 0 开始。


## 生命周期与故障隔离

- 启动先发现并校验全部目录，再分析 requires 图，最后导入有效且启用的模块。就绪节点中内置优先，其次按 ID 稳定排序。
- 缺失依赖或依赖环上的模块进入 `error`；下游进入 `blocked`。依赖被禁用、导入/setup/事件失败时，下游也会 blocked；无关模块继续工作。不会自动启用依赖，应先启用/修复依赖。
- 清理时先清理下游，再清理其依赖。外部重载会停止目标与所有间接依赖它的模块，重新读取目标清单并导入，按图恢复允许运行的下游；内置下游使用缓存代码。
- 停用清理 cleanup、命令、事件、知识源和 capability；重新启用按图恢复。操作串行执行，旧 runtime 的迟到事件错误不会覆盖新的状态。
- 事件 handler 异步执行；异常被隔离并记录，不向 OneBot 事件循环抛出。

## REST 与面板

以下路由均带 `/onebot-qq/api` 前缀，保留 HTTP 200 + JSON ok/message 约定：

| 路由 | 响应/行为 |
|---|---|
| `GET /modules` | `{ok:true,items,summary:{builtin,external}}`；summary 是目录数量，包含关闭/错误项 |
| `POST /modules/reload {id}` | 外部返回 `{ok:true,item}`；内置返回 `{ok:false,code:"MODULE_BUILTIN_RELOAD",message}` |
| `POST /modules/toggle {id,enabled}` | 两种来源均支持；清单上限返回 `MODULE_MANIFEST_DISABLED`，状态保存失败返回 `MODULE_STATE_WRITE_FAILED` |
| `GET /modules/config?id=<id>` | 仅声明配置的内置模块：`{ok:true,id,schema,values,revision}` |
| `POST /modules/config {id,values,revision}` | 校验、原子保存、通知后返回与 GET 相同形状；过期返回 `MODULE_CONFIG_CONFLICT` |

公开记录保留 id/name/version/description/permissions/enabled/status/error/loadedAt，新增 source/builtin/apiVersion/requires/canReload/canToggle/hasConfig/configWarning，不返回绝对路径。配置错误统一 `{ok:false,code,message}`：字段/revision 无效为 `MODULE_CONFIG_INVALID`，不可用为 `MODULE_CONFIG_UNAVAILABLE`，写入失败为 `MODULE_CONFIG_WRITE_FAILED`；消息不含存储绝对路径。status 可为 disabled/loading/loaded/error/blocked；动作 `ok:true` 表示请求处理完成，仍需检查 item.status 是否实际 loaded。

面板显示来源徽章、数量、依赖和 blocked/error，按 canReload/canToggle 控制按钮；内置隐藏重载，外部清单关闭时提示先编辑并重载。刷新重新读取列表，操作后按返回状态提示结果。没有安装、卸载或删除路由。

有配置的内置模块显示「配置」按钮，展开行内编辑区，按 schema.fields 复用既有 FieldRow/FieldControl；关闭状态也可编辑。GET 加载到本地草稿，保存携带 revision，成功后重新 GET；取消关闭并丢弃草稿。保存期间禁用控件，冲突或保存错误保留草稿并提示重新加载；重新加载丢弃当前草稿。外部和未声明配置的模块没有配置区。此能力独立于全局 `/config`，不涉及回复分条或交付规划迁移。

当前限制：没有依赖下载/安装、版本解析、签名、进程/VM 沙箱、远程仓库、自动更新、marketplace 或上传安装 UI。模块自己的文件变更不会被监视；需要手动点击重载或调用 API。

