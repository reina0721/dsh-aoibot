# 配置说明（CONFIG）

本文列出 `dsh-onebot-qq` 的**全部配置项**：路径、类型、默认值、取值范围、作用，以及配置文件位置、
保存/热应用规则和环境变量。配置项来源是 `src/core/config.js` 的 `DEFAULTS`（默认值）与
`CONFIG_GROUPS`（面板字段表）；面板表单完全按 `CONFIG_GROUPS` 数据驱动渲染。

> 结论先行：**没有任何写死的算法参数**。重连退避、超时、重试、核验缓冲、事件过滤、缓冲容量、
> 日志级别、面板刷新间隔……都可以在 `config.json` 或面板「配置」页修改；保存即热应用。

## 1. 配置文件位置

| 用途 | 路径 |
|---|---|
| 默认数据目录 | `$DSH_HOME/plugins-data/dsh-onebot-qq/`（`$DSH_HOME` 默认 `~/.dsh`） |
| 配置文件 | `<数据目录>/config.json` |
| 事件落盘（可选） | `<数据目录>/events.jsonl`（`events.persist.enabled=true` 时） |
| 日志落盘（可选） | `<数据目录>/logs/<area>-<day>.log`（`logging.persist.enabled=true` 时） |

在 Windows 上默认就是：

```
C:\Users\<你>\.dsh\plugins-data\dsh-onebot-qq\config.json
```

### 环境变量覆盖

| 变量 | 作用 |
|---|---|
| `DSH_HOME` | DSH 主目录，默认 `~/.dsh`；数据目录默认是 `<DSH_HOME>/plugins-data/dsh-onebot-qq` |
| `DSH_ONEBOT_QQ_DATA_DIR` | **直接覆盖本插件的数据目录**（测试、便携部署、隔离验证用；设置后 `DSH_HOME` 不再参与拼路径） |
| `SNOWLUMA_DIR` | `snowluma.autoDetect` 探测安装目录时的候选之一（等价于额外填了一个 `snowluma.dir`） |

`scripts/verify-plugin.ps1` 就是靠 `DSH_ONEBOT_QQ_DATA_DIR` 把验证用的配置写到 `verify-out/plugin-data/`，
不污染你的真实数据。

## 2. 读取、校验与保存规则

- **读取**：`config.json` 不存在时用 `DEFAULTS` 生成一份并写盘（让你能找到文件在哪）；
  存在时与 `DEFAULTS` 深合并后逐字段校验，缺失字段补默认值。
- **校验**：每个字段都有类型/取值校验。非法值**回退默认值**，并在保存/读取结果里给出可读的
  `issues`（面板会展示）。例如地址协议不合法会被清空并提示；数字会 clamp 到范围内；枚举值不认识
  会回退默认；数组会去重、去空、限制条数。
- **保存**：面板保存时按**全量配置**写回（`GET /config` 拿到当前配置 → 改几项 → `POST /config/save`）。
  宿主会重新规范化，然后原子写盘（先写临时文件再 rename），读方永远不会看到半个文件。
- **版本**：`version` 是内部字段（当前为 `1`）；配置版本与当前版本不一致时会补齐默认值并给出提示。
- **未识别字段**：不会进入持久化配置（以 `DEFAULTS` / `CONFIG_GROUPS` 为准）；升级插件后新增字段
  会自动补默认值。
- **热应用**：保存后立即生效，不需要重启 DSH。不同配置项的影响见 §5。

## 3. 配置项总表

「面板」列表示是否在 Web 面板的「配置」页出现（全部字段都可以直接写 `config.json`）。

### 3.1 基本（`basic`）

| 路径 | 类型 | 默认值 | 取值 / 范围 | 作用 | 面板 |
|---|---|---|---|---|---|
| `enabled` | switch | `true` | `true`/`false` | 插件加载后是否按当前配置自动连接；关闭后也可在面板手动「连接」 | ✅ |
| `gateway` | select | `"onebot"` | `onebot` / `snowluma` | 网关类型：`onebot` = 直接连你填的地址；`snowluma` = 只读 SnowLuma 安装目录的配置取地址 | ✅ |
| `botQQ` | text | `""` | 最长 32，自动去空白 | 机器人 QQ 号；非空时连上后调 `get_login_info` 核验账号，留空只展示不拦截 | ✅ |
| `accountCheck` | select | `"warn"` | `off` / `warn` / `enforce` | 核验不一致时的策略：不检查 / 只警告继续用 / 断开并暂停自动重连（`paused`） | ✅ |

### 3.2 连接地址（`endpoint`）

| 路径 | 类型 | 默认值 | 取值 / 范围 | 作用 | 面板 |
|---|---|---|---|---|---|
| `onebot.wsUrl` | text | `""` | `ws://` 或 `wss://` URL | 正向 WebSocket 地址，用于实时收事件（WS 也承载 action 的 echo 回包）；不合法会被清空 | ✅ |
| `onebot.httpUrl` | text | `""` | `http://` 或 `https://` URL | OneBot HTTP 服务端地址，用于调用发送/查询接口；留空则所有调用走 WS；不合法会清空并给 issue | ✅ |
| `onebot.wsToken` | secret | `""` | 最长 1024 | WS 的 access token；连接时以 `?access_token=` 附加到 wsUrl（规范认可的降级方式） | ✅ |
| `onebot.httpToken` | secret | `""` | 最长 1024 | HTTP 的 access token；携带方式见 `onebot.httpAuth` | ✅ |
| `onebot.httpAuth` | select | `"bearer"` | `bearer` / `header-token` / `query` | HTTP token 携带方式：`Authorization: Bearer`（标准、推荐）/ `X-Access-Token`（非标准）/ `?access_token=`（URL 参数） | ✅ |
| `reconnect.enabled` | switch | `true` | `true`/`false` | 断线后是否自动重连；关闭后断线停在 `disconnected` | ✅ |
| `reconnect.minDelayMs` | number | `2000` | 500–60000 ms | 首次重连等待时间 | ✅ |
| `reconnect.maxDelayMs` | number | `30000` | 1000–300000 ms | 重连等待上限 | ✅ |
| `reconnect.factor` | number | `2` | 1.1–5 | 每次重连失败后等待时间乘以该系数（指数退避） | ✅ |
| `reconnect.jitterRatio` | number | `0.2` | 0–1 | 等待时间抖动比例（0.2 = ±20%，避免多实例同时重连） | ✅ |

重连等待的实际值是 `clamp(minDelay × factor^失败次数, …, maxDelay)` 再叠加 ±`jitterRatio` 的随机抖动，
由 `src/onebot/client.js` 计算，全部取自以上配置。

### 3.3 SnowLuma 地址读取（`snowluma`）

| 路径 | 类型 | 默认值 | 取值 / 范围 | 作用 | 面板 |
|---|---|---|---|---|---|
| `snowluma.autoDetect` | switch | `true` | `true`/`false` | 自动在常见目录（`C:\SnowLuma`、`~/SnowLuma`、`%LOCALAPPDATA%\SnowLuma`、`Program Files` 等）与 `SNOWLUMA_DIR` 环境变量里找 SnowLuma | ✅ |
| `snowluma.dir` | text | `""` | 最长 1024 | SnowLuma 安装目录（含 `index.mjs` 与 `config/`）；含中文路径会提示不可用 | ✅ |
| `snowluma.uin` | text | `""` | 纯数字，最长 32 | 指定读取哪个账号的 `config/onebot_<uin>.json`；留空自动扫描所有 `onebot_*.json` | ✅ |

SnowLuma 模式只做**只读**解析：从 `config/onebot.json` 与 `config/onebot_<uin>.json` 的
`networks.httpServers[]` / `networks.wsServers[]` 读取 `enabled` / `host` / `port` / `path` / `accessToken`
（`0.0.0.0`/`::` 归一化为回环地址）。不下载、不启动、不注入、不修改 SnowLuma（其 EULA 限制自动化部署）。

### 3.4 超时与重试（`timeouts`）

| 路径 | 类型 | 默认值 | 取值 / 范围 | 作用 | 面板 |
|---|---|---|---|---|---|
| `timeouts.callMs` | number | `30000` | 1000–120000 ms | 单个 OneBot action 调用超时；大群/上传等慢接口可调大 | ✅ |
| `timeouts.connectMs` | number | `10000` | 1000–120000 ms | WS 握手超时；超时会主动关闭并按重连策略重试 | ✅ |
| `timeouts.verifyMs` | number | `10000` | 1000–120000 ms | 账号核验 `get_login_info` 的超时（不重试） | ✅ |
| `timeouts.probeMs` | number | `3000` | 1000–60000 ms（面板步进 500） | 面板「探测」按钮 HTTP 调用的超时 | ✅ |
| `timeouts.maxRetries` | number | `3` | 0–10 | 网络层错误的重试次数（业务错误/超时不重试，避免重复发消息） | ✅ |
| `timeouts.retryDelaysMs` | number-list | `[1000,3000,5000]` | 每个 0–600000 ms，最多 20 项 | 第 1/2/3… 次重试前的等待；实际次数取 `maxRetries` 与该列表长度的较小值 | ✅ |
| `verification.enabled` | switch | `true` | `true`/`false` | 连上后是否用 `get_login_info` 核验登录账号 | ✅ |
| `verification.bufferSize` | number | `100` | 10–1000（整数） | 核验期间暂存事件的条数上限，核验通过后按序补发；溢出丢弃最早的并计数 | ✅ |

### 3.5 事件（`events`）

| 路径 | 类型 | 默认值 | 取值 / 范围 | 作用 | 面板 |
|---|---|---|---|---|---|
| `events.enabled` | switch | `true` | `true`/`false` | 是否接收并缓存事件；关闭后事件被丢弃（原因 `disabled`） | ✅ |
| `events.bufferSize` | number | `200` | 10–2000（整数） | 内存事件环形缓冲条数 | ✅ |
| `events.includeSelfMessages` | switch | `true` | `true`/`false` | 是否包含机器人自己发的消息（网关需开启自身上报才会收到） | ✅ |
| `events.kinds.message` | switch | `true` | `true`/`false` | 消息事件开关 | ✅ |
| `events.kinds.notice` | switch | `true` | `true`/`false` | 通知事件开关（撤回/戳一戳/群成员变化等） | ✅ |
| `events.kinds.request` | switch | `true` | `true`/`false` | 请求事件开关（加好友/加群） | ✅ |
| `events.kinds.meta_event` | switch | `true` | `true`/`false` | 元事件开关（心跳/生命周期；噪声大时可关） | ✅ |
| `events.messageSubTypes.private` | switch | `true` | `true`/`false` | 私聊消息开关 | ✅ |
| `events.messageSubTypes.group` | switch | `true` | `true`/`false` | 群聊消息开关 | ✅ |
| `events.ignoreUsers` | string-list | `[]` | 字符串数组，每项最长 64，最多 500，自动去重 | 忽略这些 QQ 号的消息/通知 | ✅ |
| `events.ignoreGroups` | string-list | `[]` | 同上 | 忽略这些群的消息 | ✅ |
| `events.rawMaxBytes` | number | `16384` | 1024–262144 bytes | 原始事件 `raw` 字段的截断上限（超出转成 `{__truncated,bytes,preview}`），防止超大消息撑爆内存 | ✅ |
| `events.persist.enabled` | switch | `false` | `true`/`false` | 事件是否追加写入 `events.jsonl` | ✅ |
| `events.persist.file` | text | `"events.jsonl"` | 文件名（非法字符替换为 `_`） | 事件落盘文件名 | ✅ |
| `events.persist.maxMB` | number | `32` | 1–512 MB | JSONL 文件超过该大小时轮转成 `.1`（只保留一份旧档） | ✅ |

过滤顺序（`src/core/events.js`）：`events.enabled` → 事件 kind 开关 → 消息子类型开关 →
`includeSelfMessages` → `ignoreUsers` → `ignoreGroups`。被丢弃的事件会按原因累计到
`GET /status` 的 `events.droppedReasons`（`disabled/kind/subType/self/ignoreUser/ignoreGroup/invalid`）。

### 3.6 日志（`logging`）

| 路径 | 类型 | 默认值 | 取值 / 范围 | 作用 | 面板 |
|---|---|---|---|---|---|
| `logging.level` | select | `"info"` | `debug` / `info` / `warn` / `error` | 日志级别；低于该级别的日志不进缓冲/不落盘 | ✅ |
| `logging.bufferSize` | number | `500` | 50–2000（整数） | 日志环形缓冲条数（面板「日志」增量拉取的数据源） | ✅ |
| `logging.persist.enabled` | switch | `false` | `true`/`false` | 是否按天写 `<数据目录>/logs/<area>-<day>.log` | ✅ |
| `logging.redact` | switch | `true` | `true`/`false` | 日志/错误文本脱敏开关；默认开启，关闭仅建议本机排障 | ✅ |

### 3.7 界面（`ui`）

| 路径 | 类型 | 默认值 | 取值 / 范围 | 作用 | 面板 |
|---|---|---|---|---|---|
| `ui.refreshMs` | number | `2000` | 500–60000 ms | 面板状态轮询间隔（客户端还会 clamp 到 500–60000） | ✅ |
| `ui.eventPageSize` | number | `50` | 10–500 | 「消息」页事件列表每页条数 | ✅ |
| `ui.logPageSize` | number | `100` | 10–500 | 「日志」页每页条数 | ✅ |

### 3.8 安全（`security`）

| 路径 | 类型 | 默认值 | 取值 / 范围 | 作用 | 面板 |
|---|---|---|---|---|---|
| `security.allowRawAction` | switch | `false` | `true`/`false` | 允许面板通过 `POST /onebot-qq/api/action` 透传任意 OneBot action；仅调试用，默认关闭 | ✅ |

### 3.9 内部字段

| 路径 | 类型 | 默认值 | 作用 | 面板 |
|---|---|---|---|---|
| `version` | number | `1` | 配置版本号，用于升级时补齐默认值；不要手改 | — |

## 4. 默认 `config.json` 全文

首次启动/恢复默认后写出的内容（也是 `GET /onebot-qq/api/config` 的 `defaults` 字段）：

```json
{
  "version": 1,
  "enabled": true,
  "gateway": "onebot",
  "botQQ": "",
  "accountCheck": "warn",
  "onebot": {
    "wsUrl": "",
    "httpUrl": "",
    "wsToken": "",
    "httpToken": "",
    "httpAuth": "bearer"
  },
  "snowluma": {
    "autoDetect": true,
    "dir": "",
    "uin": ""
  },
  "reconnect": {
    "enabled": true,
    "minDelayMs": 2000,
    "maxDelayMs": 30000,
    "factor": 2,
    "jitterRatio": 0.2
  },
  "timeouts": {
    "callMs": 30000,
    "connectMs": 10000,
    "verifyMs": 10000,
    "probeMs": 3000,
    "maxRetries": 3,
    "retryDelaysMs": [1000, 3000, 5000]
  },
  "verification": {
    "enabled": true,
    "bufferSize": 100
  },
  "events": {
    "enabled": true,
    "bufferSize": 200,
    "includeSelfMessages": true,
    "kinds": { "message": true, "notice": true, "request": true, "meta_event": true },
    "messageSubTypes": { "private": true, "group": true },
    "ignoreUsers": [],
    "ignoreGroups": [],
    "rawMaxBytes": 16384,
    "persist": { "enabled": false, "file": "events.jsonl", "maxMB": 32 }
  },
  "logging": {
    "level": "info",
    "bufferSize": 500,
    "persist": { "enabled": false },
    "redact": true
  },
  "ui": {
    "refreshMs": 2000,
    "eventPageSize": 50,
    "logPageSize": 100
  },
  "security": {
    "allowRawAction": false
  }
}
```

## 5. 保存后哪些改动会触发重连

`src/gateway/manager.js` 的 `applyConfig(prev, next)` 会比较一个「需要重建连接」的键集合：

| 配置 | 保存后的行为 |
|---|---|
| `enabled`、`gateway`、`botQQ`、`accountCheck`、`verification.enabled` | 需要重建连接（正在运行时自动重连） |
| `onebot.*`（wsUrl/httpUrl/wsToken/httpToken/httpAuth） | 需要重建连接 |
| `snowluma.*`（autoDetect/dir/uin） | 需要重建连接 |
| `reconnect.*`、`timeouts.*`、`events.*`、`logging.*`、`ui.*`、`security.*`、`verification.bufferSize` | **不重连**，各模块每次使用时现取配置，立即生效 |
| `enabled: false` → `true`（保存时） | 自动建立连接（与「启用并自动连接」字段语义一致） |
| `enabled: false` | 断开连接并停止自动重连 |

说明：

- 连接相关改动在「正在运行」时会重启连接；如果当前是手动断开/停止状态，只更新配置，等下一次「连接」。
- 从 `enabled: false` 改为 `true` 并保存时，会自动开始连接（不必再点「连接」）。
- 过滤规则、缓冲容量等改动立即生效，不需要重连，也不会丢已有连接。
- 端点地址非法时会被清空并给出 `issues`，此时连接会因「没有地址」而停止（状态 `unconfigured`）。

## 6. 安全相关

- `onebot.wsToken` / `onebot.httpToken` 以 `secret` 类型存储；日志、错误消息、`GET /status` 的
  `endpoint.wsUrlSafe` / `httpUrlSafe`、`GET /gateway/detect` 都不输出明文 token，日志里出现
  token 会替换成 `***`（`src/core/redact.js`）。
- `logging.redact`（默认 `true`）：日志/错误文本脱敏开关；关闭后日志按原样记录，仅建议在本机排障时临时关闭。
- HTTP token 优先用默认 `bearer`；`query` 会把 token 放进 URL，容易进代理/网关日志，仅在网关不支持
  请求头时使用。
- 网关建议只监听 `127.0.0.1`；不要把 OneBot 端口暴露到公网。详见
  [USER-MANUAL.md §7](USER-MANUAL.md#7-安全与隐私)。

## 7. 建议覆盖值（按需，不是默认）

| 场景 | 建议 |
|---|---|
| 大群 `get_group_member_list`、文件上传等慢接口 | `timeouts.callMs: 60000` |
| 希望探测/连接失败更快报错 | `timeouts.probeMs: 2000`～`3000`（默认已是 3000） |
| 网关在慢机器上握手慢 | `timeouts.connectMs: 15000` |
| 断线风暴 / 网关重启频繁 | `reconnect.minDelayMs: 3000`～`5000` |
| 多开 DSH/多账号同时重连 | 保持 `reconnect.jitterRatio: 0.2`（±20% 抖动） |
| 事件噪声大（只看消息） | 关 `events.kinds.meta_event`，或开 `events.ignoreGroups` |
| 只想保存消息用于分析 | 开 `events.persist.enabled`，把 `events.persist.maxMB` 调到 128～512 |
| 排障 | `logging.level: debug`（调试完记得改回，避免日志缓冲被刷满） |

以上都只是「建议值」，默认值按回环 + 单账号场景选取，已在 NapCat/SnowLuma 生态调研中核对
（见 [RESEARCH-onebot-ecosystem.md §5](RESEARCH-onebot-ecosystem.md#5-默认值核对与建议只提建议不改代码)）。
