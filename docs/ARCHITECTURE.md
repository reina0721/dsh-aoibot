# dsh-onebot-qq · 架构与实现契约

> 本文件是团队协作的**唯一接口契约**。实现者必须严格遵守模块边界与 API 形状；
> 需要变更契约时先改本文件并在任务板说明。

## 1. 目标

为 DSH 构造一个 QQ 接入插件：通过 **OneBot v11** 协议连接 **NapCat / SnowLuma / Lagrange /
LLOneBot** 等 QQ 网关地址，提供：

- 连接管理（WS 收事件 + HTTP 调接口、自动重连、账号核验）；
- 事件规范化与缓冲（消息/通知/请求/元事件）；
- 消息与查询动作（发私聊/群聊、好友/群列表、登录信息等）；
- **完整的网页 UI 面板**（DSH Web 客户端插件）与**持久化配置**；
- 不写死任何算法参数：所有可调参数进入 `config.json`，带默认值，可在面板修改/重置。

本插件只做「QQ 感知与执行接入层」。人格、记忆、认知、防抖等由后续插件在本层之上构建。

## 2. 代码位置

```
packages/dsh-onebot-qq/
├── package.json          # bundle + dsh.client 清单（Lead 维护）
├── cordis.patch.yml      # 插入 onebot-qq 行（Lead）
├── client.js             # 浏览器半边：侧栏入口 + 整页面板（panel-dev）
├── icon.svg / locale/*   # 展示元数据（Lead）
├── src/
│   ├── host.js           # 插件入口 apply(ctx, rowConfig)（Lead）
│   ├── core/store.js     # 数据目录 / 原子 JSON 读写（Lead，移植自 aurabot MIT）
│   ├── core/redact.js    # 密文脱敏（Lead，移植自 aurabot MIT）
│   ├── core/logger.js    # 分级日志 + 环形缓冲（Lead，移植自 aurabot MIT）
│   ├── core/config.js    # DEFAULTS / 读取 / 校验 / 保存（Lead）
│   ├── core/events.js    # 规范化事件环形缓冲 + 统计（Lead）
│   ├── onebot/client.js  # OneBot v11 客户端：HTTP+WS、重连、echo（Lead，移植自 aurabot MIT）
│   ├── gateway/
│   │   ├── normalize.js  # 原始事件 → 规范化事件（gateway-dev）
│   │   ├── manager.js    # 连接生命周期 / 账号核验 / 热应用配置（gateway-dev）
│   │   ├── actions.js    # OneBot action 包装（gateway-dev）
│   │   └── snowluma.js   # SnowLuma 安装检测 + 读 its OneBot 配置（gateway-dev）
│   └── http/routes.js    # /onebot-qq/api/* REST 路由（Lead）
├── test/
│   ├── helpers/mock-onebot.js  # 假 OneBot v11 网关（verify-dev，移植自 aurabot MIT）
│   ├── helpers/fake-dsh.js     # 最小假 DSH ctx（verify-dev）
│   ├── e2e.test.js             # 宿主插件端到端（verify-dev）
│   └── *.test.js               # 单元测试（各模块 owner）
├── scripts/verify-plugin.ps1   # 安装到临时 profile + 无头启动 + 探活（verify-dev）
└── docs/…                      # USER-MANUAL / CONFIG / RESEARCH / VERIFICATION
```

## 3. 关键契约

### 3.1 配置（src/core/config.js）

- 配置文件：`$DSH_HOME/plugins-data/dsh-onebot-qq/config.json`（可用 `DSH_ONEBOT_QQ_DATA_DIR` 覆盖，测试用）。
- `DEFAULTS` 必须包含**所有**可调参数（重连退避、超时、重试、事件过滤、缓冲容量、日志级别等）。
- 读取时与 DEFAULTS 深合并；未知字段保留（向前兼容）；类型/取值非法时回退默认值并记录 warning。
- `loadConfig()` / `saveConfig(next)` / `resetConfig()` / `normalizeConfig(raw)` / `publicConfig(cfg)`。
- 保存用原子写（临时文件 + rename）。

### 3.2 Gateway Manager（src/gateway/manager.js）

```js
export function createGatewayManager({ getConfig, log, onEvent }) {
  // onEvent(rawOneBotEvent) —— WS 收到 OneBot 事件时回调（由 host 负责 normalize + 入缓冲）
  return {
    ready,                    // Promise，初次启动完成（未启用时立即 resolve）
    start(), stop(), restart(),
    applyConfig(prev, next),  // 热应用：端点/enabled/账号等变化时内部重启；过滤器变化只更新
    call(action, params, opts), // OneBot action 透传（失败抛 Error，带可读 message）
    probe(overrideEndpoint),  // 只走 HTTP 探测 get_login_info，不改连接状态
    detectGateway(),          // { snowluma: {...}, endpoint: { httpUrl, wsUrl, ... } }（只读）
    snapshot(),               // 同步状态快照，形状见 §3.4
    actions,                  // createActions() 的产物
    dispose(),
  }
}
```

- WS 优先收事件；`wsUrl` 未配置时仍可用 HTTP（轮询不做，仅状态提示）。
- 连上后（若 `verification.enabled`）调用 `get_login_info` 核验：与 `botQQ` 一致 → `loginCheck:'ok'`；
  不一致按 `accountCheck` 策略 `warn`（只警告）/ `enforce`（断开并暂停自动重连，等待用户处理）/ `off`。
- 核验期间的原始事件先暂存（上限可配），核验通过后按序补发；失败则丢弃。
- 重连参数全部来自配置：`reconnect.minDelayMs/maxDelayMs/factor/jitterRatio/enabled`。
- 所有日志走注入的 `log`，token 必须脱敏。

### 3.3 事件规范化（src/gateway/normalize.js）

```js
export function normalizeEvent(raw, cfg) -> null | {
  seqless: true,
  kind: 'message'|'notice'|'request'|'meta_event'|'unknown',
  time, selfId, postType, subType,
  message?: { id, chatType:'private'|'group', chatId, sender:{userId,nickname,card,role}, text,
              segments:[…], mentions:[{userId,name}], images:[{url,file,summary}],
              replyId, rawMessage, messageFormat },
  notice?: { type, subType, ...关键字段 },
  request?: { type, subType, ... },
  meta?: { type, subType, ... },
  raw,  // 原始事件（可截断，见 cfg.events.rawMaxBytes）
}
```
- 过滤（events.filters）在 **events.push** 前完成：`ignoreUsers`、`ignoreGroups`、消息子类型开关、kind 开关、`includeSelfMessages`。
- 不伪造字段：平台没给的信息留空，不使用「推测」值。

### 3.4 状态快照（snapshot()，REST `GET /status` 的主体）

```js
{
  state: 'stopped'|'connecting'|'connected'|'disconnected'|'unconfigured'|'paused',
  configured: boolean,
  endpoint: { mode:'onebot'|'snowluma', wsConfigured, httpConfigured, wsUrlSafe, httpUrlSafe },
  connectedAt, lastDisconnectAt, lastError, reconnects, loginAttempts,
  login: { userId, nickname } | null,
  loginCheck: 'pending'|'ok'|'mismatch'|'error'|'off'|'unknown',
  expectedBotQQ, accountCheck,
  snowluma: { installed, dir, endpointFound } | null,
}
```

### 3.5 REST API（src/http/routes.js，前缀 `/onebot-qq/api`）

所有响应 JSON：成功 `{ ok:true, ... }`；失败 `{ ok:false, message }`（HTTP 200，面板统一处理）。

| Method | Path | 说明 |
|---|---|---|
| GET | `/status` | 状态快照 + 统计 + 最近事件(条数可配) |
| GET | `/config` | `{ config, defaults, groups, dataDir, version }`（含面板字段表） |
| POST | `/config/save` | body `{ config }` 全量保存，返回规范化后的 config 与 issues |
| POST | `/config/reset` | 恢复默认值 |
| POST | `/connect` / `/disconnect` / `/reconnect` | 连接控制 |
| POST | `/probe` | body 可选覆盖端点；只测试 HTTP `get_login_info` |
| GET | `/gateway/detect` | SnowLuma 检测 + 端点解析结果 |
| GET | `/login-info` | 实时 `get_login_info` |
| GET | `/friends` / `/groups` | 列表 |
| POST | `/send` | `{ chatType:'private'\|'group', chatId, message }`（string 或段数组） |
| POST | `/action` | `{ action, params }` 透传（受 `security.allowRawAction` 限制） |
| GET | `/events?since=&limit=` | 事件缓冲 |
| POST | `/events/clear` | 清空事件缓冲 |
| GET | `/logs?since=&limit=` | 日志环形缓冲 |
| POST | `/logs/clear` | 清空日志 |
| GET | `/health` | 轻量探活 |

### 3.6 客户端面板（client.js）

- 形式：`window.__ModuleLoader__.load({ id: 'dsh-onebot-qq', factory(require) {...} })`，
  工厂返回 `{ inject:['slots','theme'], apply(ctx) }`；`id` 必须等于包名。`theme` 是客户端 ui-theme
  公开服务（`getTheme/setTheme` + `theme/change`），用于系统设置页切换 DSH 全局主题；`package.json`
  的 `dsh.client.inject` 必须与之一致。
- 注册：
  - `ctx.slots.register({ name:'sidebar.panellist', id:'onebot-qq', order: 20, label: () => 'QQ 连接' }, Icon)`
  - `ctx.slots.register({ name:'main', key:'onebot-qq' }, Panel)`
  - 通过 `ctx.slots.inject(...)` 注册（参考 aurabot `client/client.js` 末尾写法）。
- 只经 `/onebot-qq/api/*` 读写宿主，不直接碰 QQ。
- 样式/动效分为三层，均由**同一个** `<style>` 注入（`STYLE_ID = dsh-onebot-qq-panel-style`）：
  - `TOKEN_CSS`：唯一允许十六进制色值的区块。显式声明 console-web 的浅色/暗色调色板、4 套强调色 +
    `inherit`（跟随 DSH 主题）、密度/字号/内容宽度/对比度映射、圆角/阴影/字重/动效时长变量；暗色通过
    `body[data-ds-dark-theme] .ob-root` 覆盖，强调色通过 `data-accent`、对比度通过 `data-contrast` 覆盖。
  - `MOTION_CSS`：唯一允许 `@keyframes` 与 `animation:` 的区块。实现语义配方 `content.enter` /
    `content.swap`（设置分类切换仅淡入） / `viewport.reveal` / `feedback.enter+exit` / `progress.trickle` /
    状态脉冲；`data-motion="reduced|off"` 与 `prefers-reduced-motion` 统一降级为 0.01ms。
  - `PANEL_CSS`：布局/组件类，只消费 `--ob-*` 变量；不写裸色值、不写裸字重（字重走
    `--ob-weight-*` 令牌）、不声明动画。
- 外观偏好全部来自 `ui.*` 配置（`accent/contrast/density/fontScale/contentWidth/motion/pageTransition`），
  根节点以 `data-*` 属性声明语义；客户端不写死默认值。**主题不进入 `ui.*`**：它由 DSH `theme` 偏好持有，
  设置页只调用 `setTheme` 并订阅 `theme/change`，避免两份主题源。
- **持久设置壳（config/settings）**：页头、全局标签栏、左侧分类导航不在被替换的内容容器内；
  分类切换只替换右侧 `.ob-settings-pane`（`key=active` + `ob-swap-in` 淡入），不重挂载壳、不滚动整页。
  `配置`/`系统设置` 顶层进入时强制 `ob-enter-fade`（不受 `ui.pageTransition` slide 配方影响）。
- **系统设置即时保存**：`saveUiPatch(patch)` 以 `applyConfigPatch` 乐观更新 draft，随即进入串行队列
  `POST /config/save`；成功时用服务端规范化结果回写（仅在没有更新改动时覆盖 draft），设置页显示
  「保存中/已保存/失败重试」，不显示吸底 Savebar；`配置` 页仍保持显式保存 + dirty 提示。
- 无障碍与响应式：统一 `:focus-visible` 焦点环、tab 方向键/Home/End 导航、toast `aria-live`、
  reduced-motion 合规；190–390px 单列、tab/设置分类可横向滚动、无横向溢出；动效只使用
  opacity/transform/width，不动画高度或滚动容器。
- 标签页：**概览 / 连接 / 消息 / 配置 / 系统设置 / 日志 / 关于**。
- 配置页字段按分组渲染（左侧分组导航 + 右侧仅当前分组），支持保存、撤销、恢复默认、Ctrl+S；
  所有配置来自 `GET /config`，不得在客户端写死默认值。`ui` 分组只由系统设置页消费，配置页过滤掉。
- 未保存改动要有 dirty 提示（页头徽标 + 吸底保存条，仅配置页）；保存失败要有可读错误。

### 3.7 实现补充（gateway 实际形状，集成后核对）

- `probe(override?)`（`POST /probe`，body 可传 `{ httpUrl, httpToken, httpAuth, wsUrl, wsToken }` 覆盖端点）：
  只走 HTTP 调 `get_login_info`，返回
  `{ ok:boolean, url, httpStatus?, elapsedMs, login?:{userId,nickname}, message?, httpConfigured? }`。
  网络失败不抛异常，以 `ok:false` + 可读 `message` 返回；不改变连接状态。
- `detectGateway()`（`GET /gateway/detect`）返回
  `{ mode:'onebot'|'snowluma', source, endpoint:{mode,httpConfigured,wsConfigured,wsUrlSafe,httpUrlSafe,source},
     snowluma:{installed,dir,version,reason,read:{found,uin,files,sources,reason,httpConfigured,wsConfigured,httpUrlSafe,wsUrlSafe}|null},
     reason, candidates:[{dir,installed,reason}], downloadPage }`；两处 URL 均已脱敏，token 不回传。
- `snapshot()` 在 §3.4 之外还包含：
  `paused, desiredRunning, verification:{enabled,buffered,dropped},
   snowluma:{installed,dir,version,reason}|null, stats:{connects,disconnects,calls,failures,pending,wsState}`。
- 只配 HTTP（`wsUrl` 为空）时：`start()` 不建立 WS，`state='disconnected'` 且 `lastError` 说明无法实时收事件；
  HTTP 调用照常可用。两个地址都空时 `state='unconfigured'`。
- 账号核验：仅当 `verification.enabled && botQQ && accountCheck!=='off'` 时核验；
  `accountCheck='enforce'` 且不一致 → manager 内部 `client.stop()` 并置 `state='paused'`（不会自动重连，用户点「连接」恢复）；
  `warn` 只置 `loginCheck='mismatch'` 并补发缓冲事件；核验异常置 `loginCheck='error'` 同样补发事件。
- 事件交付顺序：WS 原始事件 → 核验缓冲（pending 时）→ `onEvent(raw)` → host 规范化 → `events.push`（过滤）
  → `ctx.emit('onebot-qq/event', record)`。

## 4. 数据目录

```
~/.dsh/plugins-data/dsh-onebot-qq/
├── config.json     # 配置
├── events.jsonl    # 可选：事件持久化（events.persist=true 时）
└── logs/           # 可选：日志文件（logging.persist=true 时）
```

## 5. 复用与许可

- `src/onebot/client.js`、`src/core/store.js`、`src/core/redact.js`、`src/core/logger.js`、
  `test/helpers/mock-onebot.js` 移植/改写自 **aureth-labs/dsh-aurabot-qq**（MIT）；
  在 `THIRD_PARTY_NOTICES.md` 中保留版权与许可声明，并在文件头注明来源。
- OneBot v11 协议规范：<https://github.com/botuniverse/onebot-11>。
- SnowLuma / NapCat 只作为「外部网关地址」接入，不内置、不分发、不自动部署。
