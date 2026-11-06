# 模块：内置与外部

模块架构 v2 使用统一目录、清单、API 与生命周期：

| 来源 | 代码来源 | 启停 | 重载 | 可写目录（api.dir） |
|---|---|---|---|---|
| 内置（builtin） | 随 dsh-bot 发布的静态受信任注册表，不扫描包内目录 | 可以 | 不可以 | `<数据目录>/modules/.builtin/<id>/` |
| 外部（external） | 操作员安装到 `<数据目录>/modules/<id>/` 的本地 JS | 清单允许时可以 | 可以 | 模块目录 |

内置 ID 必须以 `builtin-` 开头，外部模块禁止使用此前缀。内核扫描外部目录时跳过 `.builtin`。没有核心功能迁移，也没有远程安装、上传、marketplace 或网络下载模块代码。

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

随包提供 `builtin-sample`（内置示例，1.0.0），`permissions: ["commands","storage"]`、`requires: []`。默认关闭且不调用 import/setup，没有默认消息行为。启用后仅主人可用 `/module-sample`，固定回复「内置示例模块已启用。」；示例申请 storage 权限，但不主动写入数据。内置模块不能直接重载；依赖协调可以用缓存代码重新运行 setup，生命周期内不再次调用 lazy import。

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
| `storage` | `api.storage` | `get(key,fallback)`、`set(key,value)`、`delete(key)`、`all()`；均为异步 |

外部存储写入模块目录的 `data.json`；内置存储写入 `<数据目录>/modules/.builtin/<id>/data.json`，从不写包内源码。两者都校验目录与文件的 realpath 包含关系，写操作串行且使用原子替换，序列化后最多 1 MiB。模块应 `await` 所有存储写入。备份包含 modules/state.json 与 .builtin 数据；恢复后应重启插件。


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

公开记录保留 id/name/version/description/permissions/enabled/status/error/loadedAt，新增 source/builtin/apiVersion/requires/canReload/canToggle，不返回绝对路径。status 可为 disabled/loading/loaded/error/blocked；动作 `ok:true` 表示请求处理完成，仍需检查 item.status 是否实际 loaded。

面板显示来源徽章、数量、依赖和 blocked/error，按 canReload/canToggle 控制按钮；内置隐藏重载，外部清单关闭时提示先编辑并重载。刷新重新读取列表，操作后按返回状态提示结果。没有安装、卸载或删除路由。

当前限制：没有依赖下载/安装、版本解析、签名、进程/VM 沙箱、远程仓库、自动更新、marketplace 或上传安装 UI。模块自己的文件变更不会被监视；需要手动点击重载或调用 API。

