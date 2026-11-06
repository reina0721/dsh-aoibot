# 本地模块

dsh-bot 的 M5-a 模块内核只加载操作员放入 `<数据目录>/modules/<id>/` 的本地 JavaScript。它没有 marketplace、上传界面或远程安装能力，也不会从网络下载模块代码。

> **安全警告：模块是与 dsh-bot 同进程运行的任意本地代码。** `permissions` 只限制下面这套稳定 API，不是操作系统沙箱；模块仍可能直接使用 Node.js 能力。只安装你已经审查并信任的代码，模块目录的写权限也应只给受信任的操作员。

## 安装与清单

把完整模块目录复制到 `<数据目录>/modules/<id>/`，然后重启插件，或在面板「模块」页点击重载。仓库的 `examples/modules/echo/` 是最小示例，但示例目录本身不会被自动加载。

每个模块必须有 `module.json`：

```json
{
  "id": "echo",
  "name": "Echo",
  "version": "1.0.0",
  "description": "回显命令示例",
  "entry": "index.js",
  "permissions": ["commands", "events", "storage"],
  "enabled": true
}
```

- `id` 必填，匹配 `^[a-z0-9][a-z0-9_-]{0,63}$`，并与目录名一致。
- `entry` 必填，只能是模块目录内的相对 `.js` 或 `.mjs` 文件；路径遍历和符号链接逃逸会被拒绝。
- `name`、`version`、`description` 可选。
- `permissions` 是权限字符串数组，默认空数组；未知权限会令模块进入 error。
- `enabled` 默认 `true`。面板/API 的停用状态保存在 `<数据目录>/modules/state.json`，优先于清单。

入口导出异步或同步的 `setup(api)`，可以是 named export 或 default export。`.mjs` 始终按 ESM 加载；`.js` 遵循 Node.js 最近的 `package.json` `type` 规则（数据目录中通常是 CommonJS，可用 `exports.setup = ...`）。`setup` 可返回 cleanup 函数：

```js
export async function setup(api) {
  const off = api.on('message', (event) => api.log.debug('message', event.message?.text))
  return () => off()
}
```

## 权限与 API

所有模块始终可读 `api.id`、`api.name`、`api.version`、`api.dir`、只读 `api.permissions` 和模块子 logger `api.log`。缺少权限时调用对应 API 会抛出明确错误；若发生在 setup，模块会进入 error，不会拖垮宿主。

| 权限 | API | 行为 |
|---|---|---|
| `events` | `api.on(name, handler)` | 监听 `message`、`notice`、`request`、`meta_event` 或 `any`；收到规范化事件记录 |
| `commands` | `api.registerCommand(name, handler, { ownerOnly=true })` | 注册 `/name`；handler 收到 `{turn, parsed, args}`，返回字符串或 `{reply}`；不能覆盖内置/其它模块命令 |
| `send:text` | `api.sendText({chatType, chatId, text})` | 通过统一 outbound 以 `source: module:<id>` 发送，仍受访问控制和频率限制 |
| `cognition:read` | `api.cognition` | 只读暴露 `snapshot`、`overview`、`memories`、`personDetail`、`relationshipsList`、`timeline` |
| `knowledge` | `api.registerKnowledgeSource(source)` | 注册认知知识源，重载/停用时自动移除 |
| `capabilities` | `api.registerCapability(name, impl)` | 注册认知 capability，重载/停用时自动移除 |
| `storage` | `api.storage` | `get(key,fallback)`、`set(key,value)`、`delete(key)`、`all()`；均为异步 |

模块存储写入同目录的 `data.json`，写操作串行且使用原子替换，序列化后最多 1 MiB。模块应 `await` 所有存储写入。


## 生命周期与故障隔离

- 启动时扫描每个模块目录；无效清单、导入错误、语法错误和 setup 错误都会以 `status: error` 出现在列表中。
- 重载会先运行旧 cleanup，并移除旧命令、事件处理器、知识源与 capability，再用带版本查询参数的动态 import 加载当前入口。
- 停用立即清理上述资源；重新启用会重新读取清单并加载。
- 事件 handler 异步执行；异常会被捕获并记录到模块状态，绝不会向 OneBot 事件循环抛出。
- `GET /onebot-qq/api/modules` 查看列表；`POST /modules/reload {id}` 重载；`POST /modules/toggle {id,enabled}` 启停（均带完整 API 前缀）。列表不会返回绝对路径。

当前限制：没有依赖安装、版本解析、签名、进程/VM 沙箱、远程仓库、自动更新、marketplace 或上传安装 UI。模块自己的文件变更不会被监视；需要手动点击重载或调用 API。

