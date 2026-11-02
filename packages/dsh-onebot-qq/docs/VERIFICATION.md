# dsh-onebot-qq · 验证报告（VERIFICATION）

本文件记录 2026-11-02 在**真实 DeepSeek Harness** 环境里对本插件的完整验证，包括静态检查、
单元/集成测试、真实 DSH 安装与启动验证、浏览器端面板实际渲染，以及发现并修复的问题。

- DSH 版本：`0.2.1-rc.3`（`dsh --version`）
- 运行环境：Windows / PowerShell；Node `v24.21.0`（DSH 自带运行时，原生 `fetch` + `WebSocket`）
- 插件版本：`dsh-onebot-qq@0.1.0`
- 真实 QQ 网关：本机没有可登录的 NapCat / SnowLuma 实例，因此连接链路的对端使用**协议兼容的
  OneBot v11 mock 网关**（`test/helpers/mock-onebot.js`，HTTP + WS + token 校验 + 主动推事件）；
  真实网关侧的协议事实见 [RESEARCH-onebot-ecosystem.md](RESEARCH-onebot-ecosystem.md)。

## 0. 结论速览

| 验证项 | 结果 |
|---|---|
| 全部 JS `node --check`（宿主 + 网页半边 + 测试 + 脚本） | ✅ 通过 |
| 单元 / 集成测试 `node --test test/*.test.js` | ✅ **70 / 70 通过**（7 个测试文件） |
| 真实 DSH 安装 + 无头启动 + REST 探活 + boot 图校验（`scripts/verify-plugin.ps1`） | ✅ **RESULT: PASS**（临时 profile `onebot-qq-verify`，端口 3199，可重复运行） |
| 真实 DSH 实例端到端联调（mock 网关 → 面板 REST → 连接/核验/事件/发送/断开） | ✅ **16 / 16 全过** |
| 浏览器端面板真实渲染（Chrome headless + puppeteer，1440×900 与 360×800） | ✅ 侧栏入口 + 6 标签 + 数据驱动配置 + 连接态核验全部可见，无控制台错误 |
| 安装进当前桌面 profile 并生效 | ✅ 见 §7（`plugin_manager` 安装结果） |
| 已知缺陷 | 发现并修复 1 个会导致客户端插件无法激活的致命缺陷（§6.1），并有回归测试锁定 |

截图（本目录 `docs/verification/`）：

| 文件 | 内容 |
|---|---|
| `overview-connected.png` | 已连接状态：`已连接` 徽标、登录账号 `冒烟机器人 (20000002)`、`核验通过`、事件/日志统计、最近消息 |
| `connect-tab.png` | 「连接」标签：端点、脱敏 URL、连接/探测/重连控制 |
| `overview-stopped.png` | 未配置状态：可读空态 + 「去连接」引导 + 最近错误 |
| `config-tab.png` | 「配置」标签：全部字段由服务端 `groups` 字段表渲染（8 种控件） |
| `logs-tab.png` | 「日志」标签：增量拉取的真实网关生命周期日志 |
| `narrow-360px.png` | 360px 窄宽单列布局，`scrollWidth == clientWidth`（无横向溢出） |

## 1. 静态检查

```powershell
$node = "C:\Users\Run\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
Get-ChildItem packages\dsh-onebot-qq\src -Recurse -Filter *.js | ForEach-Object { & $node --check $_.FullName }
& $node --check packages\dsh-onebot-qq\client.js
& $node --check packages\dsh-onebot-qq\scripts\mock-gateway.mjs
# 全部 exit 0
```

## 2. 单元 / 集成测试（node:test，无第三方依赖）

```powershell
cd packages\dsh-onebot-qq
& $node --test test/*.test.js
# ℹ tests 70 / pass 70 / fail 0
```

| 测试文件 | 数量 | 覆盖 |
|---|---|---|
| `test/normalize.test.js` | 9 | CQ 码/消息段解析、@/图片/引用、notice/request/meta、不伪造缺失字段、raw 截断 |
| `test/actions.test.js` | 7 | 消息段转换、群/私聊 action 映射、id 参数、校验错误、raw 透传 |
| `test/snowluma.test.js` | 11 | 安装探测、`onebot.json` / `onebot_<uin>.json` 读取、`enabled`/`enable` 兼容、URL 脱敏、端点解析回退 |
| `test/gateway.test.js` | 10 | WS 连接、账号核验 ok/warn/enforce、核验期事件缓冲、probe、send、disconnect、重复 start、`enabled:false→true` 自动连接 |
| `test/config.test.js` | 5 | 字段表与 DEFAULTS 不漂移、非法 wsUrl 产生 issue、probeMs clamp、非法枚举回退、`logging.redact` 开关 |
| `test/panel.test.js` | 19 | module loader 注册形状、apply 注册两个 slot、纯函数、六标签渲染冒烟、样式契约、**`exports.Config` 回归锁定** |
| `test/e2e.test.js` | 9 | fake DSH 挂载真实 `src/host.js`：health/status/config、save 热应用、reset、非法值 issues、核验 ok/warn/enforce、缓冲、事件过滤、send、disconnect、logs |

## 3. 真实 DSH 安装 / 启动验证

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File packages\dsh-onebot-qq\scripts\verify-plugin.ps1
# RESULT: PASS   （profile: onebot-qq-verify，port 3199，结束后自动清理）
```

脚本做的事（全部 PASS，逐项见 `verify-out/SUMMARY.txt` 与 `verify-result.json`）：

1. 校验 CLI / 版本 / 包名 / `client.js` 存在 / 端口空闲；
2. 删除旧临时 profile，从 `web` 模板重建（不触碰 `desktop` profile）；
3. `dsh plugin --profile onebot-qq-verify add <插件目录>` 安装（本地 link，无网络依赖）；
4. 无头启动 `dsh onebot-qq-verify --port 3199 --no-open`；
5. 轮询 `GET /onebot-qq/api/health`、`/status`、`/config`，确认 `DSH_ONEBOT_QQ_DATA_DIR` 隔离生效、
   `config.json` 落盘、字段表可读；
6. 从 boot 日志解析带 token 的 URL 拉取首页，确认 `__DSH_BOOT__` 含 `dsh-onebot-qq` 行且其
   `client.js` 被 DSH 服务；
7. `taskkill /T /F` 清理进程、删除临时 profile。连续运行两次均 PASS（幂等）。

> 注意：第 6 步只能证明「客户端插件被编排进 boot 图」，不能证明它激活成功——
> 浏览器端激活与渲染由第 4 节的 puppeteer 验证覆盖（这正是 §6.1 缺陷被漏掉的地方）。

## 4. 真实 DSH + mock 网关 + 浏览器端到端

在临时 profile（`lead-probe`，端口 3198）启动真实 DSH，另一个进程运行 `startMockOneBot()`
（HTTP + WS + token），通过插件 REST API 完成全链路；随后用 puppeteer 打开
`http://127.0.0.1:3198/?token=…` 检查面板真实 DOM。

端到端断言（16/16）：

| # | 断言 | 结果 |
|---|---|---|
| 1 | `GET /onebot-qq/api/health` → `ok:true apiVersion:1` | ✅ |
| 2 | `GET /config` 含 `config` + `defaults` + `groups`（8 组）且字段含 `path/type` | ✅ |
| 3 | `POST /config/save` 保存 ws/http/token/botQQ 并回读一致 | ✅ |
| 4 | `POST /probe` HTTP 调 `get_login_info` 返回 mock 账号 | ✅ |
| 5 | `POST /connect` 被接受 | ✅ |
| 6 | mock 收到 WS 连接（`wsClients=1`） | ✅ |
| 7 | 账号核验 `loginCheck=ok`，昵称/QQ 正确 | ✅ |
| 8 | `GET /status` 的 gateway 快照不含明文 token | ✅ |
| 9 | `GET /logs` 中 token 已脱敏 | ✅ |
| 10 | mock 主动推私聊消息 → `GET /events` 出现规范化事件（`chatType/chatId/sender/text`） | ✅ |
| 11 | `POST /send` 群聊返回 `message_id` | ✅ |
| 12 | mock 收到 `send_group_msg`，`group_id` 与文本消息段正确 | ✅ |
| 13 | `GET /logs` 有可读日志（连接/核验/保存） | ✅ |
| 14 | `POST /disconnect` 后 mock WS 客户端数归零 | ✅ |
| 15 | `POST /config/reset` 恢复默认 | ✅ |
| 16 | 断开/重置后 `GET /status` 状态与配置一致 | ✅ |

浏览器端（Chrome 143 headless + puppeteer-core，对同一真实 DSH 页面）：

- 侧栏出现「QQ 连接」，点击后整页面板渲染，页面无 `Failed to load plugins`；
- 六个标签 `概览 / 连接 / 消息 / 配置 / 日志 / 关于` 全部存在且可切换；
- 配置页字段完全来自 `GET /config.groups`（开关/文本/密钥/数字/下拉/列表/多行文本均可见）；
- 连接态：顶部徽标 `已连接`，登录账号与「核验通过」可见，事件列表显示 mock 推送的消息；
- 窄屏 360×800：单列布局，`document.scrollWidth == document.clientWidth`（无横向溢出）；
- 控制台除 DSH 自身的 `[deepseek-account] account read failed`（与插件无关）外无错误。

## 5. 复用与配置化核对

- **复用现有轮子**：OneBot 客户端、store/redact/logger、SnowLuma 只读解析、mock 网关、fake DSH、面板
  结构与主题 token 用法均复用/改写自 `aureth-labs/dsh-aurabot-qq`（MIT）与 DeepSeek Harness，明细和
  许可证全文见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。运行时不引入任何第三方依赖。
- **不写死算法参数**：重连退避/抖动、连接/调用/核验/探测超时、重试次数与间隔、事件缓冲容量、
  过滤规则、日志等级/容量、面板刷新间隔、账号核验策略等全部来自 `config.json`；
  代码里只有协议常量与安全下限（如 `Math.max(1000, …)` 的 clamp）。
- **默认值持久化 + UI 可改**：`DEFAULTS` 集中在 `src/core/config.js`，首次加载即写出
  `$DSH_HOME/plugins-data/dsh-onebot-qq/config.json`；面板配置页由 `CONFIG_GROUPS` 数据驱动，
  可保存/撤销/恢复默认/Ctrl+S，`config.test.js` 锁定「字段表 default == DEFAULTS」不漂移。
- **功能都有 UI 与配置**：连接管理、账号核验、事件流、好友/群列表、消息发送、日志、SnowLuma 检测、
  探测、原始 action 调试开关，全部有对应面板页或配置项。

## 6. 发现并修复的问题

### 6.1 致命：`client.js` 导出名为 `Config` 的组件导致客户端插件无法激活

- **现象**：插件装进真实 DSH 后，boot 页显示 `Failed to load plugins / dsh-onebot-qq: failed`，
  `verify-plugin.ps1` 的「boot 图含 client.js」断言仍然是 PASS（它只看 HTML，不执行 JS）。
- **根因**：DSH 客户端 Cordis 用 `runtime.Config` 作为插件的**配置 schema** 槽位：
  `if (!runtime.Config) return config; runtime.Config["~standard"].validate(config)`。
  面板原先导出 `exports.Config = Config`（配置页 React 组件），它 truthy 但不是 Standard Schema，
  于是激活时抛 `TypeError: Cannot read properties of undefined (reading 'validate')`，
  fiber 直接 FAILED（该错误被 Cordis 内部 logger 吞掉，普通 console 看不到；最终用 CDP
  `Debugger.setPauseOnExceptions` 才抓到完整栈）。
- **修复**：配置页组件导出名改为 `ConfigTab`，并在注释中记录原因；`test/panel.test.js` 增加回归用例
  「`module.exports` 不能有 `Config` 属性且 `ConfigTab` 是函数」，防止再次踩坑。
- **验证**：修复后同一真实 DSH 页面侧栏出现「QQ 连接」、六个标签全部渲染（§4 截图）。

### 6.2 其他修复（来自集成自查与队友报告）

| 问题 | 修复 |
|---|---|
| 已连接时再点「连接」，状态被打回 `connecting` 且不会恢复（WS `onopen` 不会再来） | `manager.startWithResolved()` 检测已连接时只补做缺失核验，不重建连接；`gateway.test.js` 加回归用例 |
| 非法的 `onebot.wsUrl` 被静默清空、`issues` 为空 | 给 `normalizeUrl` 补 `report` 回调；`config.test.js` 断言 issue 存在 |
| 面板 `probeMs` 下限 500 与服务端 clamp 1000 不一致 | 统一为 1000 |
| `logging.redact` 字段存在但未生效 | `logger.js` 读取该开关；关闭时按原样记录（仅建议排障） |
| `enabled:false` 起步时保存 `enabled:true` 不会自动连接 | `applyConfig()` 在 `prev.enabled===false` 时自动 `restart()`；`gateway.test.js` 覆盖 |
| SnowLuma 2.x 的 `enabled` 字段（旧实现读 `enable` 恒真） | 同时兼容 `enabled` / `enable`，并只采纳启用中的服务端；`snowluma.test.js` 覆盖 |
| `timeouts.connectMs` 配置未生效 | OneBot 客户端增加 WS 握手超时定时器，超时主动 close 并按重连策略调度 |
| `header-token` 是 OneBot v11 规范外的鉴权方式 | 面板文案标注「非标准，仅特定网关」；默认保持 `bearer`（NapCat/SnowLuma 首选） |

## 7. 安装进当前 DSH profile

- 当前 GUI（`http://127.0.0.1:60932`）属于 `desktop` profile。验证完成后通过 DSH 的插件管理
  （`plugin_manager` / `dsh plugin add`）把本包安装/链接进 `desktop` profile；
  安装结果与「是否需要刷新页面 / 重启 DSH」以安装工具返回的 `application` 字段为准。
- 插件数据目录为 `$DSH_HOME/plugins-data/dsh-onebot-qq/`；验证过程中产生的临时连接配置已在
  每次联调结束时通过 `POST /config/reset` 恢复默认，不会把 mock 地址留在你的配置里。

## 8. 局限与未覆盖项

1. **没有真实 QQ 账号**：端到端对端是协议兼容的 mock 网关（HTTP/WS/token/事件/发送全部覆盖），
   真实 NapCat / SnowLuma 的差异（版本行为、风控、封禁风险）需要用户用自己的网关实测；
   接入步骤与常见问题见 [USER-MANUAL.md](USER-MANUAL.md) 与 [RESEARCH-onebot-ecosystem.md](RESEARCH-onebot-ecosystem.md)。
2. **SnowLuma 探测**只做了单元级（临时目录 + 构造的 `onebot*.json`）与只读逻辑核对，未在本机真实
   SnowLuma 安装上验证（本机未安装）。
3. **深色主题**：面板只使用 DSH 语义 token，浅/深色由宿主切换；验证截图在浅色下采集，未逐页截深色。
4. 客户端插件在**已运行的 desktop GUI** 中是否需要刷新页面取决于 DSH 的运行时热加载行为；以安装结果为准。

## 9. 复现方式

```powershell
$node = "C:\Users\Run\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$dsh  = "C:\Users\Run\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"

# 1) 全部测试
Set-Location packages\dsh-onebot-qq
& $node --test test/*.test.js

# 2) 真实 DSH 安装/启动/接口验证（自带清理）
Set-Location ..\..
powershell -NoProfile -ExecutionPolicy Bypass -File packages\dsh-onebot-qq\scripts\verify-plugin.ps1

# 3) 本地人工联调：假网关 + 面板
& $node packages\dsh-onebot-qq\scripts\mock-gateway.mjs   # 默认 6700，打印地址/token
# 打开面板 → 连接页填 ws://127.0.0.1:6700 / http://127.0.0.1:6700 + token → 保存 → 连接
```
