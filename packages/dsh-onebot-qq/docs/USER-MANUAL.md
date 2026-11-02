# dsh-onebot-qq 用户手册

本手册面向「已经能打开 DeepSeek Harness（DSH）Web，想把 QQ 接进来」的用户。
安装细节与全部配置项分别见 [README](../README.md) 与 [CONFIG.md](CONFIG.md)。

> 本插件只连接**你已经运行并登录好的** OneBot v11 网关（NapCat / SnowLuma / Lagrange.OneBot /
> LLOneBot），不下载、不安装、不启动、不注入任何网关。网关怎么装、怎么登录 QQ 不在本文范围。

## 目录

1. [安装到 DSH](#1-安装到-dsh)
2. [准备 QQ 网关](#2-准备-qq-网关)
3. [在面板里填地址与 token](#3-在面板里填地址与-token)
4. [面板六个标签](#4-面板六个标签)
5. [常见问题](#5-常见问题)
6. [本地自测（没有 QQ 网关也能跑通）](#6-本地自测没有-qq-网关也能跑通)
7. [安全与隐私](#7-安全与隐私)
8. [卸载与数据清理](#8-卸载与数据清理)

---

## 1. 安装到 DSH

### 1.1 环境要求

- DSH `>= 0.2.0 < 0.3.0`（官方安装包自带 Electron 运行时；本插件不需要额外 Node 依赖）
- 一个 QQ 网关（见第 2 节）；没有也可以先用第 6 节的假网关自测

### 1.2 方式 A：在 DSH 内用插件管理器安装

1. 打开 DSH Web。
2. 打开插件管理（`plugin_manager` / 插件页），选择安装本地插件目录：`<仓库>\packages\dsh-onebot-qq`。
3. 重启对应 profile 的 DSH 进程（网页半边的 `client.js` 只在启动时加载）。
4. 刷新 DSH Web 页面，左侧栏出现「QQ 连接」即安装成功。

### 1.3 方式 B：命令行安装（推荐给开发者）

`dsh` 的 `plugin` 子命令把参数转发给 pnpm；**profile 名紧跟 `--profile`**。

```powershell
$dsh = "C:\Users\<你>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"

# 1) 把插件安装进某个 profile（例如 web）
& $dsh plugin --profile web add "C:\path\to\dsh-bot\packages\dsh-onebot-qq"

# 2) 启动该 profile；profile 是位置参数，不是 --profile
& $dsh web
```

启动后控制台会打印带 token 的页面地址，例如：

```
dsh web: http://127.0.0.1:PORT/?token=XXXXXXXX
```

浏览器打开这个地址（token 在 URL 里，别只复制 `http://127.0.0.1:PORT/`，否则会 401）。

> 想装到独立 profile、不污染日常环境：
>
> ```powershell
> & $dsh --profile onebot-qq-demo --from-default-profile web --dump-config   # 从 web 模板建 profile
> & $dsh plugin --profile onebot-qq-demo add "C:\path\to\packages\dsh-onebot-qq"
> & $dsh onebot-qq-demo --port 3199 --no-open
> ```
>
> 卸载：`& $dsh plugin --profile onebot-qq-demo remove dsh-onebot-qq`。

安装是否成功可以从三个地方确认：

- profile 的 `package.json` → `dsh.profile.bundles` 里有 `dsh-onebot-qq`；
- DSH 启动日志里没有 `dsh-onebot-qq` 相关报错；
- `GET http://127.0.0.1:<port>/onebot-qq/api/health` 返回 `{"ok":true,...}`。

---

## 2. 准备 QQ 网关

各家网关都要做两件事：**登录 QQ**，**开启 OneBot v11 的「WebSocket 服务端」（正向 WS）**，
可选再开「HTTP 服务端」。本插件只需要地址和 token，不需要在网关里填任何回调地址（不是反向 WS）。

### 2.1 NapCat（推荐，已验证 v4.18.x）

1. 安装并登录 NapCat（QQ 已登录、机器人号在线）。
2. 打开 NapCat WebUI（默认 `http://127.0.0.1:6099`，登录 token 见启动日志或 `webui.json`）。
3. 进入「网络配置」：
   - 新建 **WebSocket 服务端**（即正向 WS）：默认端口 `3001`，监听地址建议 `127.0.0.1`，
     建议设置 `token`（随机长串），勾选「保存时启用」。
   - 可选：新建 **HTTP 服务端**：默认端口 `3000`，同样建议 `127.0.0.1` + token。
     HTTP 只用于调用发送等接口；不建也能用（全部走 WS）。
4. 保存并重启/重载 NapCat 网络配置。
5. 记下：`ws://127.0.0.1:3001`、`http://127.0.0.1:3000`、两个 token（若都设置了）。

> 不同 4.x 小版本的 WebUI 文案略有差异，认准「WebSocket 服务端 / 正向 WS」而不是「WebSocket 客户端」。
> 官方文档：<https://napneko.github.io/config/basic>
> 安全警告：不要将未鉴权的 3000/3001/6099 暴露到公网，见 <https://napneko.github.io/other/security>。

### 2.2 SnowLuma（已验证 v2.3.x，本插件只读配置）

1. 自行安装并启动 SnowLuma，登录 QQ。
2. 在 SnowLuma 自己的配置/WebUI 中开启 OneBot 网络，记下端口与 token：
   - 全局：`config/onebot.json`；账号级覆盖：`config/onebot_<uin>.json`（`mode:"snapshot"` 时不叠加全局）；
   - 网络在 `networks.httpServers[]` / `networks.wsServers[]`，字段：`enabled`、`host`、`port`、
     `path`、`accessToken`、`role`（用 `Universal`）；
   - 默认端口通常 `ws 3001` / `http 3000`，token 默认自动生成。
3. 本插件有两种用法：
   - **SnowLuma 地址读取模式**（网关类型选 `snowluma`）：填 SnowLuma 安装目录（含 `index.mjs` 与
     `config/`）即可自动读出地址与 token；也可填账号 UIN 指定读哪个 `onebot_<uin>.json`。
   - **手动地址模式**（网关类型选 `onebot`）：按 2.1 的方式直接填 `ws://127.0.0.1:3001` 与 token。
4. 重要边界：本插件**只读** SnowLuma 的配置文件，**不启动、不注入、不修改** SnowLuma
   （其 EULA 限制自动化部署，见 `THIRD_PARTY_NOTICES.md`）。SnowLuma 的安装、登录、升级由你自己负责。
5. 文档：<https://snowluma.github.io/zh/docs/guide/configuration>、
   <https://snowluma.github.io/zh/docs/guide/connect-bot>

### 2.3 Lagrange.OneBot（v1 分支）

- 走 OneBot v11 正向 WS + HTTP；v1 默认 `ForwardWebSocket 127.0.0.1:8081`、`Http *:8083`。
- `appsettings.json` 的 `Implementations[]` 里开启 `ForwardWebSocket`/`Http`，`AccessToken` 即 token。
- 注意端口与 NapCat/SnowLuma 不同，填地址时改成 `ws://127.0.0.1:8081`、`http://127.0.0.1:8083`。
- 文档：<https://lagrangedev.github.io/Lagrange.Doc/v1/Lagrange.OneBot/Config/>

### 2.4 LLOneBot（v8.x）

- 配置在 `bin/llbot/data/config_<QQ号>.json` 的 `ob11` 段；WebUI 默认 `http://localhost:3080`。
- 默认正向 WS `3001`、HTTP `3000`、`messageFormat:"array"`、`token:""`（**务必自己设 token**）。
- token 走 `Authorization: Bearer <Token>`。
- 文档：<https://luckylillia.com/guide/config>

### 2.5 四家对照

| 网关 | 协议 | 正向 WS 默认端口 | HTTP 默认端口 | 鉴权 | 默认配置位置 |
|---|---|---|---|---|---|
| NapCat v4.18.x | OneBot v11 | 3001 | 3000 | `Authorization: Bearer` 或 `?access_token=` | `config/onebot11_<uin>.json` / WebUI |
| SnowLuma v2.3.x | OneBot v11 | 3001 | 3000 | `Authorization: Bearer` 或 `?access_token=` | `config/onebot.json` + `onebot_<uin>.json` |
| Lagrange.OneBot（v1） | OneBot v11 | 8081 | 8083 | `AccessToken`（Bearer） | `appsettings.json` |
| LLOneBot v8.3.x | OneBot 11 / Milky / Satori | 3001 | 3000 | Bearer | `bin/llbot/data/config_<QQ>.json` |

---

## 3. 在面板里填地址与 token

侧栏「QQ 连接」→「连接」标签（或「配置」→「连接地址」），逐项填写：

| 字段 | 必填 | 说明 |
|---|---|---|
| 网关类型 | 是 | 「连接已有 OneBot v11 地址」= 只连你填的地址；「从 SnowLuma 安装目录自动读取地址」= 只读 SnowLuma 配置 |
| WebSocket 地址 | 是* | `ws://127.0.0.1:3001`；用于实时收事件。*只填 HTTP 时插件能发消息但收不到事件 |
| HTTP 地址 | 否 | `http://127.0.0.1:3000`；用于调用发送/查询接口；留空则所有调用走 WS |
| WS access token | 否 | 网关 WebSocket 服务端的 token（NapCat/SnowLuma 可能和 HTTP 不同） |
| HTTP access token | 否 | 网关 HTTP 服务端的 token |
| HTTP token 携带方式 | 否 | 默认 `bearer`（`Authorization: Bearer <token>`，NapCat/SnowLuma 标准做法）；`query` = `?access_token=`；`header-token` 非标准、仅特定实现 |
| 机器人 QQ 号 | 建议 | 连上后用 `get_login_info` 核验；留空则只展示登录信息、不拦截 |
| 账号不一致时 | 否 | `off` 不检查 / `warn` 只警告（默认、推荐）/ `enforce` 断开并暂停自动重连 |

操作：

1. 点「保存」（或 Ctrl+S）。配置会写入数据目录并**热应用**：端点/账号类改动自动重连。
2. 点「连接」。也可以用「探测」按钮先只走 HTTP 试一次 `get_login_info`，不改连接状态。
3. 「概览」应显示：状态 `已连接`、登录账号（QQ 号 + 昵称）、账号核验 `通过`。
4. 状态不对时先看「日志」标签，再对照第 5 节排查。

只配 WS 或只配 HTTP 的行为：

| 配置 | 状态 | 能力 |
|---|---|---|
| 只配 WS | connected | 收事件 + 调接口（走 WS echo） |
| 只配 HTTP | disconnected（`lastError` 会说明收不到事件） | 能调接口/发消息，但**收不到实时事件**；不做轮询 |
| 都没配 | unconfigured | 需要先填地址 |

SnowLuma 读取模式：网关类型选 `snowluma`，填安装目录（也可点「检测」自动探测）→ 插件只读
`config/onebot*.json` 里的 `networks.*` 取地址与 token；读不到会回退到你手填的地址并在日志里说明原因。
注意 SnowLuma 的 EULA 限制自动化部署，本插件不会启动/注入它。

---

## 4. 面板六个标签

### 概览

- 连接状态、登录账号、账号核验结果、最近错误；
- 事件统计（收到 / 接受 / 丢弃 / 缓冲占用）、日志统计；
- 最近事件列表（消息/通知等，按事件类型着色）。

### 连接

- 地址与 token 表单（与「配置」页同源，保存即热应用）；
- 网关类型、SnowLuma 检测、「探测」按钮（只测 HTTP `get_login_info`）；
- 连接 / 断开 / 重连按钮；状态轮询间隔取 `ui.refreshMs`（500–60000ms clamp）。
- 账号核验结果（`pending` / `ok` / `mismatch` / `error` / `off`）与期望 QQ 号。

### 消息

- 发送表单：私聊 / 群聊切换、目标 QQ/群号、文本内容 → 调用 `POST /send`；
- 好友列表 / 群列表（点「刷新」拉取，可点击带入发送表单）；
- 事件流查看器：增量拉取 `GET /events`，可清空（`POST /events/clear`）。

### 配置

- 按分组（基本 / 连接地址 / SnowLuma / 超时与重试 / 事件 / 日志 / 界面 / 安全）渲染全部字段；
- 字段由宿主 `GET /config` 的 `groups` 数据驱动，客户端不写死默认值；
- 保存（Ctrl+S）、撤销改动、恢复默认；有未保存改动时标签上有 dirty 标记；
- 保存失败/非法值回退会在面板上给出可读提示（宿主返回的 `issues`）。

### 日志

- 日志等级过滤（debug/info/warn/error）+ 增量拉取（`GET /logs?since=&level=`）；
- 清空日志（`POST /logs/clear`）；
- 连接失败、token 校验失败、账号不一致、重连退避过程都在这里。

### 关于

- 插件版本、REST API 版本、数据目录、许可证、接口前缀。

---

## 5. 常见问题

### 5.1 点「连接」没反应 / 状态停在 disconnected

按顺序检查：

1. 网关是否真的在监听：`Test-NetConnection 127.0.0.1 -Port 3001`（或 `Get-NetTCPConnection -LocalPort 3001`）。
2. 地址协议是否正确：WS 必须以 `ws://` 或 `wss://` 开头，HTTP 必须 `http://`/`https://`；
   填错协议会被配置校验回退为空，并在保存结果里给出 issue。
3. 网关开的是「WebSocket 服务端（正向 WS）」还是「WebSocket 客户端（反向 WS）」？
   本插件连的是**正向 WS**；网关里的「反向 WS」需要填回调 URL，不适用于本插件。
4. 是否只填了 HTTP？只填 HTTP 时状态是 `disconnected` 且日志说明「无法实时接收事件」，
   发消息仍可用；要收事件请开正向 WS。
5. 看「日志」：`连不上 QQ 网关（…）：ECONNREFUSED` = 端口/地址不对；
   `HTTP 401` = token 不对（见 5.3）；`code 1008` / `1403` = WS 握手 token 校验失败。

### 5.2 账号核验 mismatch

`get_login_info` 返回的 QQ 号与「机器人 QQ 号」不一致。

- 改「机器人 QQ 号」为网关实际登录的号，或改成网关登录该号；
- 策略：`warn` 只告警、照常连接（推荐先用这档确认）；`enforce` 会断开 WS 并进入 `paused`，
  修好配置后需要手动点「重连」；
- `off` 完全不核验（不推荐，容易发错账号的消息）。

### 5.3 token 401 / 403 / WS 握手失败

- WS token 和 HTTP token 可能不是同一个：NapCat、SnowLuma 分别配置，逐个核对；
- 优先用默认 `bearer`（NapCat/SnowLuma 都支持）；只有网关明确不支持请求头时才用 `query`
  （token 会出现在 URL/日志里，安全性差）；
- `header-token`（`X-Access-Token`）不是 OneBot v11 标准，NapCat/SnowLuma 不读它；
- 改了 token 记得保存后点「重连」；
- 日志里的 token 会被自动替换成 `***`，这是正常的脱敏。

### 5.4 端口被占用

- 网关端口（3000/3001/8081/8083）被占用：在网关里改端口，或关掉占用进程；
  查占用：`Get-NetTCPConnection -LocalPort 3001 -State Listen | Select OwningProcess`；
- DSH Web 端口（默认 3080/6099 之外的随机端口，或你显式 `--port` 指定的）被占用：
  `dsh web --port <其它端口>`；
- DSH 插件本身不额外监听端口，REST 接口挂在 DSH Web 的 `/onebot-qq/api/*` 下。

### 5.5 已连接但收不到事件

- 确认网关推送的是 OneBot v11 事件（不是 Milky/Satori 等其它协议）；
- 看「配置 → 事件」：`events.enabled`、`events.kinds.*`、`events.messageSubTypes.*` 是否被关掉；
  `events.ignoreUsers` / `ignoreGroups` 是否把发消息的人/群过滤了；
- 刚连上的一瞬间在账号核验：核验期间事件先缓冲（上限 `verification.bufferSize`），
  核验通过后按序补发；核验失败（`enforce`）会丢弃缓冲；
- 群消息被过滤时「概览」的「已丢弃」计数与原因会增长，可据此判断。

### 5.6 SnowLuma 检测不到 / 读不到地址

- 安装目录必须是解压后的 SnowLuma 根目录（里面有 `index.mjs` 和 `config/`）；
- 路径含中文会导致 SnowLuma 无法运行（插件会提示），请用纯英文路径；
- 没有任何 `config/onebot_<uin>.json` 且全局 `onebot.json` 没开网络时读不到，属正常；
  可在 SnowLuma 里开启 OneBot 网络，或直接用手填地址模式；
- 注意 `enabled` 字段（不是 `enable`）为 `false` 的服务端不会被使用。

### 5.7 侧栏没有「QQ 连接」/ 面板空白

- 插件安装后必须**重启 DSH 进程**（网页半边在启动时加载）；
- 确认安装的 profile 就是当前启动的 profile；
- 打开 DSH Web 的带 token 地址（`?token=...`），否则页面会 401；
- 打开浏览器开发者工具 Console 看 `dsh-onebot-qq` 的 client 加载错误。

### 5.8 如何重置配置

- 面板「配置」→「恢复默认」；
- 或直接删除数据目录里的 `config.json` 后重启插件/DSH。

---

## 6. 本地自测（没有 QQ 网关也能跑通）

仓库自带一个内存版假 OneBot v11 网关，用于人工把面板点一遍（不是真实 QQ）：

```powershell
node packages/dsh-onebot-qq/scripts/mock-gateway.mjs
# 可选参数：--port 6700 --token mock-token-abcdef --self-id 20000002 --nickname 测试机器人 --no-heartbeat
```

启动后会打印地址与 token（默认固定端口 `6700`）：

```
WS 地址   : ws://127.0.0.1:6700
HTTP 地址 : http://127.0.0.1:6700
token     : mock-token-abcdef
机器人 QQ : 20000002
```

在面板「连接」里填：

| 字段 | 值 |
|---|---|
| 网关类型 | 连接已有 OneBot v11 地址 |
| WebSocket 地址 | `ws://127.0.0.1:6700` |
| HTTP 地址 | `http://127.0.0.1:6700` |
| WS / HTTP access token | `mock-token-abcdef` |
| 机器人 QQ 号 | `20000002` |

保存 → 连接 → 核验应显示 `ok`、昵称「测试机器人」。

用假网关的 `_mock` 控制端点（浏览器直接打开或 `curl`/`Invoke-RestMethod`）验证面板：

```powershell
$mock = 'http://127.0.0.1:6700'

# 看连接数 / 收到多少调用 / 推了多少事件
Invoke-RestMethod "$mock/_mock/state"

# 推一条私聊消息（「消息」页事件流应出现）
Invoke-RestMethod "$mock/_mock/push" -Method Post -ContentType 'application/json' `
  -Body '{"type":"private","userId":10001,"message":"你好"}'

# 推一条群消息
Invoke-RestMethod "$mock/_mock/push" -Method Post -ContentType 'application/json' `
  -Body '{"type":"group","groupId":30001,"userId":10001,"message":"群消息"}'

# 模拟「账号不一致」：让网关返回别的 QQ 号，再点重连
Invoke-RestMethod "$mock/_mock/config" -Method Post -ContentType 'application/json' `
  -Body '{"loginUserId":"99999999"}'
# 验证完改回来
Invoke-RestMethod "$mock/_mock/config" -Method Post -ContentType 'application/json' `
  -Body '{"loginUserId":"20000002"}'

# 模拟核验慢（观察核验缓冲）
Invoke-RestMethod "$mock/_mock/config" -Method Post -ContentType 'application/json' `
  -Body '{"loginDelayMs":800}'

# 看网关收到了哪些 action（发消息后应有 send_private_msg / send_group_msg）
Invoke-RestMethod "$mock/_mock/calls"
```

验证账号不一致的两种策略：把 `botQQ` 保持 `20000002`，`loginUserId` 改成 `99999999` 后重连：
`accountCheck=warn` 应显示「账号不一致」但保持连接；`accountCheck=enforce` 应进入 `paused` 且 WS 断开。

假网关按 `Ctrl+C` 退出。它只是测试替身，不要用于真实 QQ。

---

## 7. 安全与隐私

- **只连回环地址**：网关建议监听 `127.0.0.1`，不要把 3000/3001/6099/5099/3080 暴露到公网。
  需要跨机访问时用 SSH 隧道或内网互信，不要 `0.0.0.0` 直连公网。
- **token 要强随机**（≥32 字符），不要复用 QQ 密码；WS/HTTP 分别设置。
- **优先 Bearer**：`query` 模式会把 token 放进 URL，容易进日志/代理记录。
- 插件侧：token 字段为 `secret` 类型；日志、错误消息、状态快照里的 token 一律替换为 `***`
  （`logging.redact` 默认开启）；状态快照只暴露脱敏后的地址。
- 事件落盘（`events.persist`）默认关闭；开启后消息内容会写到数据目录，注意磁盘与隐私。
- 原始 action 透传（`security.allowRawAction`）默认关闭，仅调试时临时打开。
- 本插件不做任何联网上报；QQ 数据只在本机 DSH 进程与你的网关之间流动。

---

## 8. 卸载与数据清理

```powershell
# CLI 卸载（同时移除依赖与 bundle 层）
dsh plugin --profile <profile> remove dsh-onebot-qq

# 删除插件数据（配置 / 事件落盘 / 日志）
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\plugins-data\dsh-onebot-qq"
```

如果设置了 `DSH_ONEBOT_QQ_DATA_DIR`，数据在它指向的目录里，等价删除即可。
卸载后重启 DSH，侧栏「QQ 连接」入口会消失。
