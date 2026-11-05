# OneBot v11 接入生态核实报告（NapCat / SnowLuma / Lagrange / LLOneBot）

> 供 `dsh-bot` 实现评审与 README / USER-MANUAL 引用；结论均带原始出处。
>
> - 核实时间：2026-11-02（America/New_York），版本号为当日抓取快照。
> - 核实方式：GitHub REST API（仓库/release/源码）、`raw.githubusercontent.com`、官方文档站抓取；本会话 `web_search` 无 API key，未使用搜索摘要。
> - 图例：✅ 已核实（源码或文档原文）｜🟡 部分核实（文档有、未实机验证）｜❓ 未核实。

## 0. 结论速览

| # | 待核对问题 | 结论 | 关键依据 |
| --- | --- | --- | --- |
| 1 | 四家网关是否都走 OneBot v11 正向 WS + HTTP | ✅ 是；插件只需填地址 + token，不下载/不启动/不注入网关 | [OneBot v11 转发 WS](https://github.com/botuniverse/onebot-11/blob/master/communication/ws.md)、[NapCat](https://napneko.github.io/config/basic)、[SnowLuma](https://snowluma.github.io/zh/docs/guide/configuration)、[LLOneBot](https://luckylillia.com/guide/config) |
| 2 | `onebot.httpAuth` 默认 `bearer` 是否被支持 | ✅ 兼容；NapCat 与 SnowLuma 源码都接受 `Authorization: Bearer` 与 `?access_token=` | [NapCat http-server.ts](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/network/http-server.ts)、[SnowLuma utils.ts](https://github.com/SnowLuma/SnowLuma/blob/main/packages/onebot/src/network/utils.ts) |
| 3 | `header-token`（`X-Access-Token`）是否标准 | ❌ 规范未定义；NapCat、SnowLuma 源码均不识别，只能作"特定实现调试选项" | [OneBot 鉴权规范](https://github.com/botuniverse/onebot-11/blob/master/communication/authorization.md) |
| 4 | 示例端口 `ws 3001` / `http 3000` 是否合理 | ✅ 命中 NapCat、SnowLuma、LLOneBot 三家默认；Lagrange.OneBot 为 `8081` / `8083` | [NapCat](https://napneko.github.io/config/basic)、[SnowLuma](https://snowluma.github.io/zh/docs/guide/configuration)、[LLOneBot](https://luckylillia.com/guide/config)、[Lagrange](https://lagrangedev.github.io/Lagrange.Doc/v1/Lagrange.OneBot/Config/) |
| 5 | 重连 `2s→30s ×2 jitter0.2` 是否合理 | ✅ 合理，无需改（§5.1/§5.3） | 网关心跳 30s、自带重连间隔 5s 量级 |
| 6 | 超时 `30s / 10s / 10s` | 🟡 方向正确；`connectMs` 实际未被使用、`probeMs 8000` 偏长（§5.1） | [client.js](../../src/onebot/client.js)、[manager.js](../../src/gateway/manager.js) |

## 1. OneBot v11 标准（✅ 全部来自规范原文）

### 1.1 事件结构

所有事件带 `time`（int64）、`self_id`（收到事件的机器人 QQ 号）、`post_type`；`post_type` ∈ `message` / `notice` / `request` / `meta_event`。[来源](https://github.com/botuniverse/onebot-11/blob/master/event/README.md)

消息事件公共字段：`message_type`、`sub_type`、`message_id`、`user_id`、`message`、`raw_message`、`font`、`sender`；群消息另有 `group_id`、`anonymous`。`sub_type` 取值：

| `message_type` | `sub_type` 可能值 |
| --- | --- |
| `private` | `friend`（好友）、`group`（群临时会话）、`other` |
| `group` | `normal`（正常）、`anonymous`（匿名）、`notice`（系统提示） |

`sender`（规范强调"尽最大努力提供"，**不保证字段存在或正确**）：私聊含 `user_id`/`nickname`/`sex`/`age`；群聊另有 `card`/`area`/`level`/`role`（`owner`/`admin`/`member`）/`title`。[来源](https://github.com/botuniverse/onebot-11/blob/master/event/message.md)

⚠️ 实现含义：`normalize.js` 不能在 `sender` 缺失时报错，也不能仅凭 `role` 判权限（[normalize.js](../../src/gateway/normalize.js)）。

### 1.2 消息格式 `message_format`：`string` | `array`

- 配置项 `event.message_format` 默认 `string`；`array` 表示消息段数组，**事件的 `message` 字段类型随之变化**。[来源](https://github.com/botuniverse/onebot-11/blob/master/event/README.md)
- 数组格式：`[{"type":"text","data":{"text":"..."}}, ...]`；纯文本也是 `text` 段，**数组格式不需要任何转义**。[来源](https://github.com/botuniverse/onebot-11/blob/master/message/array.md)
- 字符串格式即 CQ 码，如 `[CQ:face,id=178]看看我刚拍的照片[CQ:image,file=123.jpg]`。[来源](https://github.com/botuniverse/onebot-11/blob/master/message/string.md)

实测：三家网关默认都上报 `array`（NapCat `messagePostFormat:"array"`、SnowLuma `messageFormat:"array"`、LLOneBot `messageFormat:"array"`），插件必须"默认 array、可回退 string"；`normalize.js` 已按 `raw.message_format === 'array'` 分流。

### 1.3 CQ 码转义（仅字符串格式需要）

| 场景 | `&` | `[` | `]` | `,` |
| --- | --- | --- | --- | --- |
| 消息纯文本 | `&amp;` | `&#91;` | `&#93;` | 不转义 |
| CQ 码参数值内部 | `&amp;` | `&#91;` | `&#93;` | `&#44;` |

原文与示例见 [字符串格式 §转义](https://github.com/botuniverse/onebot-11/blob/master/message/string.md)。实体形式为 `&#91;` / `&#93;` / `&#44;` / `&amp;`；工程实现应先转 `&` 再转其它，否则二次转义。

### 1.4 核心 action、参数与返回

调用由 `action` + `params` 组成；`message` 参数可为字符串、消息段数组或单个消息段；`_async` 后缀表示异步（`status: async`、`retcode: 1`），`_rate_limited` 后缀表示排队限速。[来源](https://github.com/botuniverse/onebot-11/blob/master/api/README.md)

| action | 关键参数 | 响应 `data` |
| --- | --- | --- |
| `send_private_msg` | `user_id`、`message`、`auto_escape=false` | `{ message_id }` |
| `send_group_msg` | `group_id`、`message`、`auto_escape=false` | `{ message_id }` |
| `get_login_info` | 无 | `{ user_id, nickname }` |
| `get_friend_list` | 无 | `[{ user_id, nickname, remark }]` |
| `get_group_list` | 无 | `[{ group_id, group_name, member_count, max_member_count }]` |
| `get_group_member_info` | `group_id`、`user_id`、`no_cache=false` | 成员对象（含 `card`/`role`/`join_time`） |
| `delete_msg` | `message_id` | 无（`data: null`） |
| `get_msg` | `message_id` | `{ time, message_type, message_id, real_id, sender, message }` |

逐条来自 [公开 API](https://github.com/botuniverse/onebot-11/blob/master/api/public.md)。插件账号核验用 `get_login_info` 的 `user_id`+`nickname`，与 [manager.js](../../src/gateway/manager.js) 一致。

### 1.5 响应信封 `{status, retcode, data}`

```json
{ "status": "ok", "retcode": 0, "data": { "id": 123456, "nickname": "滑稽" } }
```

- `status`：`ok`（成功，`retcode=0`）、`async`（已提交，`retcode=1`）、`failed`（失败，非 0/1）；`data` 对无返回操作与异步调用为 `null`。
- HTTP 状态码：未带 token → 401；token 不符 → 403；Content-Type 不支持 → 406；正文错 → 400；action 不存在 → 404；其余无论成败均 200。
- 正向 WS 回包结构与 HTTP 相同，只是状态码差异挪进 `retcode`（1400/1401/1403/1404 ↔ 400/401/403/404），并原样带回 `echo`。

[来源：HTTP 响应](https://github.com/botuniverse/onebot-11/blob/master/communication/http.md)、[WS 回包](https://github.com/botuniverse/onebot-11/blob/master/communication/ws.md)

⚠️ 直接约束：**不能只认 `status === 'ok'`**（`async` 也是受理），`retcode === 0` 才等价成功；`client.js` 用 `status==='ok' || retcode===0` 判定，兼容实现差异（[client.js](../../src/onebot/client.js)）。

### 1.6 正向 WebSocket：路径与鉴权

- 路径 `/api`（只调 API）、`/event`（只推事件）、`/`（两者皆可，Universal）；数据全为 JSON。参考实现默认 `ws.enable=false`、`host=0.0.0.0`、`port=6700`。[来源](https://github.com/botuniverse/onebot-11/blob/master/communication/ws.md)
- 鉴权：配置 access token 后请求需带 `Authorization: Bearer <token>`；**无法改请求头时**可用 `?access_token=<token>` 代替。[来源](https://github.com/botuniverse/onebot-11/blob/master/communication/authorization.md)
- 浏览器型 WS 客户端无法自定义握手头，故 query 传 token 是规范认可的降级路径；本插件 `wsUrl` 追加 `?access_token=` 合规，Bearer 头是规范首选。
- `X-Access-Token`：**规范全文没有该头**，属第三方框架习惯；本次核实的 NapCat、SnowLuma 源码都不读取。

### 1.7 HTTP API 鉴权

路径 `/:action`（如 `POST /send_private_msg`），支持 GET/POST，参数可走 query、urlencoded 或 JSON（JSON 必须 `Content-Type: application/json`）；鉴权同为 `Authorization: Bearer` 或 `?access_token=`，配置项 `auth.access_token` 默认空。[来源](https://github.com/botuniverse/onebot-11/blob/master/communication/http.md)、[鉴权](https://github.com/botuniverse/onebot-11/blob/master/communication/authorization.md)

## 2. NapCat（✅ 版本与配置均核实）

### 2.1 版本与文档入口

- 仓库 `NapNeko/NapCatQQ`（2026-11-02 快照 12,196 stars），最新正式版 **v4.18.42**（2026-10-30）。[仓库](https://github.com/NapNeko/NapCatQQ)｜[Releases](https://github.com/NapNeko/NapCatQQ/releases/latest)
- 官方文档镜像：`napneko.github.io`、`doc.napneko.icu`、`napcat.napneko.icu`、`napneko.pages.dev`、`napcat.top`（[README](https://github.com/NapNeko/NapCatQQ/blob/main/README.md)）；本文正文取自 GitHub Pages 镜像，如 [基础配置](https://napneko.github.io/config/basic)、[安全](https://napneko.github.io/other/security)。

### 2.2 如何开启"正向 WS"与 HTTP 服务端

NapCat 把网络分四类，并明确 **WebSocket 服务端 = 正向 WS**（双向：推事件 + 接 API 调用），HTTP 服务端 = 接受调用并回应。[来源](https://napneko.github.io/config/basic)

1. **WebUI（推荐）**：登录 WebUI → 网络配置 → 新建 WebSocket 服务端 / HTTP 服务端 → 勾选"保存时启用"。WebUI 默认 `0.0.0.0:6099`（被占用自动 +1），登录 token 见启动日志或 `webui.json`（`host`/`port`/`token`/`loginRate`）。
2. **改文件（文档注明"非常不推荐"）**：`config/onebot11_<QQ号>.json`；v4.5.3 起可载入 `config/onebot11.json` 作默认模板。

[来源](https://napneko.github.io/config/basic)

### 2.3 默认端口、路径与 token

| 服务 | 默认 `port` | 默认 `host` | 鉴权字段 | 备注 |
| --- | --- | --- | --- | --- |
| HTTP 服务端 | `3000` | `0.0.0.0` | `token: ""` | `enable: false`、`messagePostFormat: "array"` |
| WebSocket 服务端（正向 WS） | `3001` | `0.0.0.0` | `token: ""` | `enable: false`、`heartInterval: 30000` |

[来源](https://napneko.github.io/config/basic)｜仓库开发示例（`127.0.0.1`、`enable:true`）见 [onebot11.json](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-develop/config/onebot11.json)

- 命名规则：`<name>_<uin>.json` 为账号级、`<name>.json` 为默认模板（源码 `getConfigPath()`）。[来源](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-core/helper/config-base.ts)
- 路径：WS 服务端**不强制路径**——`/api` 仅用于 API 调用，其它路径（含 `/`）都会推事件，故插件连 `ws://127.0.0.1:3001` 即可。[来源](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/network/websocket-server.ts)

### 2.4 鉴权实现（源码级）

- HTTP：取 `Authorization` 中 `Bearer ` 之后部分或 query `access_token`，任一等于 token 即通过，否则 403 `{"message":"token verify failed!"}`。[来源](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/network/http-server.ts)
- WS：同样比对 query `access_token` 与 `Authorization: Bearer`，失败发 `status=failed, retcode=1403` 后断开。[来源](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/network/websocket-server.ts)
- 结论：**`httpAuth: 'bearer'` 与 NapCat 完全兼容**；`query` 亦可用，但 token 进 URL 更易落日志。

### 2.5 本插件需要做什么

用户在 NapCat 开启服务端并设 token 后，插件只填 `onebot.wsUrl`（`ws://127.0.0.1:3001`）、`onebot.httpUrl`（可选，`http://127.0.0.1:3000`）与对应 token。插件不下载、不安装、不注入 NapCat，也不读它的配置（[THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)）。同理，正向 WS 的 echo 回包也由 WS 承载，属于标准 `/` 通用连接行为。

### 2.6 安全提醒（官方原文）

**"如果采用服务端工作模式且未配置鉴权，将应用暴露在公网环境中会带来严重安全风险。"** `v4.8.106` 以下 WebUI 默认弱密码 `napcat`，之后改为启动随机生成并打印日志/私聊机器人号。[来源](https://napneko.github.io/other/security)

## 3. SnowLuma（✅ 配置、鉴权、许可依据均核实）

### 3.1 版本与文档

- 仓库 `SnowLuma/SnowLuma`（3,477 stars），最新版 **v2.3.4**（2026-11-02）；自述把 QQ 原生会话转换为 **OneBot v11** 动作与事件，经 WebSocket / HTTP / WebUI / SDK / MCP 暴露。[仓库](https://github.com/SnowLuma/SnowLuma)｜[Releases](https://github.com/SnowLuma/SnowLuma/releases)
- 文档：[配置参考](https://snowluma.github.io/zh/docs/guide/configuration)、[接入说明](https://snowluma.github.io/zh/docs/guide/connect-bot)、[动作参考](https://snowluma.github.io/zh/docs/api)；WebUI 默认 `http://localhost:5099`（`runtime.json` 的 `webuiPort`）。

### 3.2 配置文件位置与结构

| 文件 | 作用 |
| --- | --- |
| `config/onebot.json` | 全局默认（所有账号基线） |
| `config/onebot_<uin>.json` | 账号级覆盖；`mode:"snapshot"` 时为整份快照、不再叠加全局 |
| `config/runtime.json` | 进程级：`webuiPort`（默认 5099）、`hookAutoLoad`（默认 false） |

[来源](https://snowluma.github.io/zh/docs/guide/configuration)｜常量 `CONFIG_DIR='config'`、`onebot_<uin>.json`、快照标记见 [config.ts](https://github.com/SnowLuma/SnowLuma/blob/main/packages/onebot/src/config.ts)

网络适配器字段（`networks.httpServers[]` / `networks.wsServers[]`）：

| 字段 | httpServers | wsServers | 说明 |
| --- | --- | --- | --- |
| `name` | `http-default` | `ws-default` | 同类型内唯一，热重载按 (kind,name) 寻址 |
| `enabled` | `true` | `true` | 设 false 保留配置但不启动；**是 `enabled` 不是 `enable`** |
| `host` | 文档 `0.0.0.0`；源码 `127.0.0.1` | 同左 | 两者不一致，见 §3.6 |
| `port` | `3000` | `3001` | 被占用时改配置或做端口映射 |
| `path` | `/` | `/` | API / WS 路径前缀 |
| `accessToken` | 自动生成（32 字节随机 base64url） | 同左 | HTTP 与 WS 可各自不同 |
| `messageFormat` | `array` | `array` | 事件消息格式 |
| `reportSelfMessage` | `false` | `false` | true 时收到自身消息（`post_type=message_sent`） |
| `role` | — | `Universal` | `Api`/`Event`/`Universal`（大写驼峰） |

[来源](https://snowluma.github.io/zh/docs/guide/configuration)｜默认值工厂 `makeDefaultOneBotConfig()` 见 [config.ts](https://github.com/SnowLuma/SnowLuma/blob/main/packages/onebot/src/config.ts)。监听端口还可用环境变量 `SNOWLUMA_ONEBOT_HTTP_PORT` / `SNOWLUMA_ONEBOT_WS_PORT` 覆盖（仅内存生效，不写回）。

### 3.3 鉴权（文档 + 源码双核实）

- 文档原文："鉴权：`Authorization: Bearer <token>` 或 `?access_token=`。Token 在 WebUI 或 `config/onebot.json` / `onebot_<uin>.json` 里。HTTP 和 WS 可能各有各的 token。"[来源](https://snowluma.github.io/zh/docs/guide/connect-bot)
- 源码 `isAuthorized(request, token, allowRawToken)`：`Authorization === "Bearer <token>"` 通过；`allowRawToken` 时裸 token 也通过（HTTP 传 true、WS 传 false）；否则回退 query `access_token`。[来源](https://github.com/SnowLuma/SnowLuma/blob/main/packages/onebot/src/network/utils.ts)
- 失败行为：HTTP 返回 401 + `{status:"failed", retcode:1401, wording:"unauthorized"}`（[http-server-adapter.ts](https://github.com/SnowLuma/SnowLuma/blob/main/packages/onebot/src/network/http-server-adapter.ts)）；WS 以 `1008 invalid access token` 关闭（[ws-server-connections.ts](https://github.com/SnowLuma/SnowLuma/blob/main/packages/onebot/src/network/ws-server-connections.ts)）。
- 正向地址：`http://127.0.0.1:3000/`、`ws://127.0.0.1:3001/`。[来源](https://snowluma.github.io/zh/docs/guide/connect-bot)

### 3.4 "只读、不下载/不启动/不注入"的许可依据（重要）

- `EULA.md` 5.4：除事先取得书面授权外，不得将专有组件**并入第三方安装包或 Docker 镜像、通过自动化脚本部署**，或用于商业用途。[来源](https://github.com/SnowLuma/SnowLuma/blob/main/EULA.md)
- `LICENSE` 为"源码可见非商业许可"，不是 OSI 开源；商业使用、公开发布修改版/衍生版需书面授权。[来源](https://github.com/SnowLuma/SnowLuma/blob/main/LICENSE)｜[README 使用边界](https://github.com/SnowLuma/SnowLuma/blob/main/README.md)

因此 `gateway: 'snowluma'` 只做一件事：**读用户自己安装并运行的 SnowLuma 的 `config/onebot*.json` 取地址与 token**；不下载、不解压、不启动进程、不注入 hook、不改其配置。这是许可要求，不是"暂时不做"。

### 3.5 多账号规则

- 每账号一份 `config/onebot_<uin>.json` 覆盖全局 `config/onebot.json`；`mode:"snapshot"` 的账号配置不叠加全局。[来源](https://snowluma.github.io/zh/docs/guide/configuration)
- 官方会清理"幽灵账号"：`cleanupInvalidPerUinConfigs()` 只处理匹配 `onebot_<digits>.json` 的文件，仅删除 `isRealUin` 校验失败者（如 11 位以上、时间戳形状的垃圾 uin，issue #162），正常账号不受影响。[来源](https://github.com/SnowLuma/SnowLuma/blob/main/packages/onebot/src/config.ts)
- 本插件对应项：`snowluma.dir`（含 `index.mjs` 与 `config/`）、`snowluma.uin`（指定账号文件，留空自动扫描）、`snowluma.autoDetect`（[config.js](../../src/core/config.js)）。

### 3.6 交叉核对：参考实现 `auraBot` 的偏差

参考 `.refs/dsh-aurabot-qq/src/snowluma/manager.js` 的 `readOneBotEndpoint()`：读 `onebot.json` + `onebot_<uin>.json`、取 `networks.httpServers`/`wsServers` 的 `host`/`port`/`path`/`accessToken`，并把 `0.0.0.0`、`::` 归一化为 `127.0.0.1`——与 SnowLuma 源码一致。两处需注意：

1. 它用 `x.enable !== false` 判启用，实际字段是 **`enabled`**；`enable` 恒为 `undefined`，该判断等于"永远启用"，移植时应改读 `enabled`。
2. `host` 默认值文档（`0.0.0.0`）与源码工厂（`127.0.0.1`）不一致；无论取哪个，读取端都应将 `0.0.0.0`/`::` 归一化为回环地址再拼 URL。

[来源：配置参考](https://snowluma.github.io/zh/docs/guide/configuration)｜[config.ts](https://github.com/SnowLuma/SnowLuma/blob/main/packages/onebot/src/config.ts)

## 4. Lagrange.OneBot 与 LLOneBot（✅ 文档核实）

### 4.1 Lagrange.OneBot

- 仓库 `LagrangeDev/Lagrange.Core`（3,008 stars，默认分支 `master` 为 **V2**）。README 说明 V1 已 sunset 并移入 `v1` 分支；V2 面向 Bot 推荐 **Lagrange.Milky**（Milky 协议），**未提及 OneBot**。[来源](https://github.com/LagrangeDev/Lagrange.Core/blob/master/README.md)
- `v1` 分支仍含完整 `Lagrange.OneBot/`（动作、事件、配置齐备）。[来源](https://github.com/LagrangeDev/Lagrange.Core/tree/v1/Lagrange.OneBot)
- v1 文档（首次运行自动生成 `appsettings.json`）的 `Implementations[]` 支持：`ForwardWebSocket`（`127.0.0.1:8081`）、`Http`（`*:8083`）、`ReverseWebSocket`（`8080`，`Suffix:/onebot/v11/ws`）、`HttpPost`（`8082`）。[来源](https://lagrangedev.github.io/Lagrange.Doc/v1/Lagrange.OneBot/Config/)
- 版本现状：releases 最近一条是 `nightly` 预发布（2025-08-02），无稳定 latest。[来源](https://github.com/LagrangeDev/Lagrange.Core/releases)

结论：Lagrange.OneBot 同样走 OneBot v11 正向 WS + HTTP，但端口是 8081/8083 且属 v1 体系，文档应把它列为"需手改端口"的网关。

### 4.2 LLOneBot（现名 LLBot / LuckyLilliaBot）

- 仓库 `LLOneBot/LLOneBot` 已重命名，GitHub API 返回 `full_name = LLOneBot/LuckyLilliaBot`（3,701 stars），最新版 **v8.3.2**（2026-10-12）；支持 OneBot 11 / Satori / Milky，文档站 `luckylillia.com`。[仓库](https://github.com/LLOneBot/LuckyLilliaBot)｜[文档](https://luckylillia.com/guide/config)
- 配置：`bin/llbot/data/config_<QQ号>.json`（未登录前可改 `default_config.json`），WebUI 默认 `http://localhost:3080`。
- `ob11` 段默认：正向 WS `port 3001`、HTTP 服务端 `port 3000`、`messageFormat:"array"`、`token:""`、`onlyLocalhost:true`；文档明确 **token 用于 `Authorization: Bearer <Token>`**。[来源](https://luckylillia.com/guide/config)

### 4.3 四家对照表

| 网关 | 协议 | 正向 WS 默认端口 | HTTP 服务端默认端口 | 鉴权方式 | 配置位置 |
| --- | --- | --- | --- | --- | --- |
| NapCat v4.18.42 | OneBot v11 | `3001` | `3000` | Bearer 或 `?access_token=` | `config/onebot11_<uin>.json` / WebUI |
| SnowLuma v2.3.4 | OneBot v11 | `3001` | `3000` | Bearer 或 `?access_token=` | `config/onebot.json` + `onebot_<uin>.json` |
| Lagrange.OneBot（v1） | OneBot v11 | `8081` | `8083` | `AccessToken`（Bearer） | `appsettings.json` |
| LLOneBot v8.3.2 | OneBot 11 / Milky / Satori | `3001` | `3000` | Bearer | `bin/llbot/data/config_<QQ>.json` |

## 5. 默认值核对与建议（只提建议，不改代码）

核对对象：[config.js](../../src/core/config.js) 的 `DEFAULTS`。"建议"列优先级：P0 = 正确性/安全，P1 = 体验，P2 = 可选。

### 5.1 逐项核对

| 配置项 | 当前默认 | 核对结论 | 建议 |
| --- | --- | --- | --- |
| `onebot.httpAuth` | `bearer` | ✅ NapCat 取 `authorization.split('Bearer ').pop()`；SnowLuma 先比 `Bearer <token>`；LLOneBot 文档亦为 Bearer | **保持 `bearer`**；`header-token` 文案改"非标准，仅特定网关"（P1） |
| `httpAuth: query` | 非默认 | ✅ 规范认可的降级方式，NapCat/SnowLuma 均支持；token 会进 URL | 保留，帮助文本提示"注意日志脱敏"（P1） |
| `wsToken` 传输 | 拼 `?access_token=` | ✅ 规范认可；两家 WS 握手都读 query 与 Bearer | 维持；将来支持握手头可优先 Bearer（P2） |
| `reconnect.minDelayMs` | `2000` | ✅ 回环断线毫秒级可恢复；NapCat WS 客户端 `reconnectInterval:5000`、Lagrange `ReconnectInterval:5000` | 保持；出现"断线风暴"再调 3000–5000（P2） |
| `reconnect.maxDelayMs` | `30000` | ✅ 与网关心跳 30s（NapCat `heartInterval:30000`）同量级 | 保持 |
| `reconnect.factor` | `2` | ✅ 2→4→8→16→30s，约 60s 封顶，符合指数退避 | 保持 |
| `reconnect.jitterRatio` | `0.2` | ✅ ±20% 足以错开多实例/多账号重连 | 保持 |
| `timeouts.callMs` | `30000` | 🟡 普通 action 足够；大群 `get_group_member_list`、上传/下载可能超 30s | 保持 30s，文档注明慢场景可调大（P1） |
| `timeouts.connectMs` | `10000` | 🟡 创建 `WebSocket` 后无握手超时；截至 2026-11-02 工作树，该配置在 `src/` 内未被读取使用 | 补握手计时或文档不宣称生效（P0，二选一） |
| `timeouts.verifyMs` | `10000` | ✅ `get_login_info` 轻量，10s 足够容错 | 保持 |
| `timeouts.probeMs` | `8000` | 🟡 用于连通性探测（[manager.js](../../src/gateway/manager.js)），回环 8s 偏长、拖慢报错 | 建议 2000–3000（P1，UI 可改） |
| `maxRetries` + `retryDelaysMs` | `3` + `[1000,3000,5000]` | ✅ 仅传输层重试、超时不重试，避免重复发消息，符合 OneBot 非幂等发送语义 | 保持；文档写明"业务错误不重试"（P2） |
| 示例端口 `3001`/`3000` | placeholder | ✅ 命中 NapCat / SnowLuma / LLOneBot 三家默认 | 补一句"Lagrange.OneBot 常用 8081/8083"（P1） |
| `gateway` | `'onebot'` | ✅ 默认"连已有地址"最安全，SnowLuma 模式属显式选择 | 保持 |
| `accountCheck` | `'warn'` | ✅ 不阻断，符合"提示为主"的定位 | 保持 |
| `verification.enabled`+`bufferSize` | `true` / `100` | ✅ 核验期缓冲、通过后补发；100 条对本地网关足够 | 保持 |
| `events.includeSelfMessages` | `true` | 🟡 可收，但三家默认 `reportSelfMessage:false`，网关不开就收不到自身上报 | 文档写清需网关开启（P1）；`normalize.js` 已把 `message_sent` 归一为 `message`，不改默认 |
| `events.kinds`/`messageSubTypes` | 全 `true` | ✅ 覆盖 1.1 的 `post_type` 四类与 `private`/`group` | 保持；噪声大时用户可关 `meta_event` |
| `logging.redact`/`allowRawAction` | `true` / `false` | ✅ 安全方向正确 | 保持 |

### 5.2 `httpAuth` 默认值是否需要调整

**不需要调整默认值**：NapCat（[源码](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/network/http-server.ts)）与 SnowLuma（[源码](https://github.com/SnowLuma/SnowLuma/blob/main/packages/onebot/src/network/utils.ts)）都把 `Authorization: Bearer` 作为首选路径，规范也以 Bearer 为主方案、query 为降级（[规范](https://github.com/botuniverse/onebot-11/blob/master/communication/authorization.md)）。需要改的是**文案**：`header-token` 不是 OneBot v11 的一部分，UI 帮助应写"非标准（部分第三方实现用 `X-Access-Token`）；NapCat / SnowLuma 请用 bearer"。

### 5.3 超时/重连整体判断

- 重连参数（2s 起、×2、30s 封顶、±20% 抖动）与各网关"30s 心跳 / 5s 重连间隔"匹配，**无需调整**。
- 真正要动的是实现细节而非默认常量：`connectMs` 未生效、`probeMs` 偏长（见 §5.1）。
- 文档（非代码）可给出"慢网/大群"覆盖值：`callMs: 60000`、`probeMs: 3000`，让用户按需改，而不是调大默认。

## 6. 安全基线（本机接入必备）

### 6.1 只走回环

- 网关监听地址优先 `127.0.0.1`：NapCat 文档示例默认 `0.0.0.0`（[基础配置](https://napneko.github.io/config/basic)），SnowLuma 文档表 `0.0.0.0`、源码工厂 `127.0.0.1`（[配置参考](https://snowluma.github.io/zh/docs/guide/configuration)），LLOneBot 有 `onlyLocalhost:true`（[配置](https://luckylillia.com/guide/config)）——**默认并不都安全，必须显式确认**。
- 不要把 `3000/3001/6099/5099/3080` 映射到公网；跨机用 SSH 隧道或内网互信，而不是 `0.0.0.0`。
- NapCat 官方警告："服务端工作模式且未配置鉴权，暴露公网会带来严重安全风险。"（[来源](https://napneko.github.io/other/security)）

### 6.2 token 与日志

- HTTP 与 WS 分别设 token（SnowLuma 默认各自随机生成；NapCat 两个服务各有 `token` 字段）；用 ≥32 字符随机串，不复用 QQ 密码。
- 需要脱敏的内容：`Authorization` 头、`?access_token=`（query 模式）、配置里的 token、一次性 WebUI 密码/二维码票据。
- 插件侧 `wsToken`/`httpToken` 为 `secret` 类型，`logging.redact=true` 时注册进脱敏器（[config.js](../../src/core/config.js)）；仍建议优先 Bearer，避免 token 进 URL。
- `events.persist` 默认关闭是对的；`rawMaxBytes` 只防内存膨胀，不防敏感信息，导出/落盘前需人工确认。

### 6.3 联通 checklist

- [ ] 网关已启动且 QQ 已登录（`get_login_info` 返回预期 QQ 号）
- [ ] 已开启"WebSocket 服务端（正向 WS）"或"HTTP 服务端"并"保存时启用"
- [ ] 监听地址为 `127.0.0.1`（至少确认不是公网可达）
- [ ] token 已设强随机值并填入插件对应字段
- [ ] `wsUrl` 可连通（101 或明确的 token 校验错误）
- [ ] `POST /get_login_info` 带 Bearer 返回 `status: ok`
- [ ] 填 `botQQ` 后出现"核验通过"日志（`accountCheck` 建议先用 `warn`）
- [ ] 杀掉网关进程，确认按 2s→30s 退避重连且不刷屏
- [ ] `security.allowRawAction` 保持关闭；日志中看不到 token 原文

## 7. 未核实 / 待确认

1. **`X-Access-Token` 的生态支持范围**：规范无此头、NapCat/SnowLuma 源码不识别；是否有其它主流实现支持，❓ 未核实。
2. **SnowLuma `host` 默认值最终产物**：文档表 `0.0.0.0` vs 源码工厂 `127.0.0.1`，🟡 未在运行实例上确认实际生成的 `onebot_<uin>.json`。
3. **NapCat WebUI 新建服务端的字段默认值**：仅据文档文字与仓库示例，🟡 未实机点击（不同 4.x 版本 UI 可能有差异）。
4. **各网关 action 级超时/限速**：只核实心跳（NapCat 30000、LLOneBot 60000）与重连间隔，具体单 action 超时 ❓ 未核实。
5. **Lagrange.OneBot 维护状态**：V2 主线已无 OneBot、仅 v1 分支保留，releases 只有 nightly；官方是否声明停止演进 ❓ 未核实。
6. **SnowLuma `role` 非 `Universal` 时的事件推送细节**（如 `Api` 是否推事件）❓ 未核实，当前只按 `Universal` 接入。
7. **QQ 官方对第三方协议端的风控政策**：不在本报告范围，❓ 未核实；使用前自行评估账号风险。

## 8. 核实方法与可复现命令

`web_fetch` 对 `raw.githubusercontent.com` 因 DNS 解析到非公网地址被拒，故全部改用 PowerShell 抓取：

```powershell
$h = @{ 'User-Agent' = 'dsh-research-bot/1.0'; 'Accept' = 'application/vnd.github+json' }
Invoke-RestMethod -Uri 'https://api.github.com/repos/NapNeko/NapCatQQ/releases/latest' -Headers $h
Invoke-RestMethod -Uri 'https://api.github.com/repos/SnowLuma/SnowLuma/contents/packages/onebot/src/config.ts' -Headers $h
Invoke-RestMethod -Uri 'https://raw.githubusercontent.com/botuniverse/onebot-11/master/communication/ws.md'
Invoke-WebRequest -Uri 'https://napneko.github.io/config/basic' -UseBasicParsing
Invoke-WebRequest -Uri 'https://snowluma.github.io/zh/docs/guide/configuration' -UseBasicParsing
```

版本快照：NapCat `v4.18.42`（2026-10-30）、SnowLuma `v2.3.4`（2026-11-02）、LLOneBot `v8.3.2`（2026-10-12）、Lagrange.Core 最近 release 为 `nightly` 预发布（2025-08-02）。后续版本以各仓库 Releases 为准。
