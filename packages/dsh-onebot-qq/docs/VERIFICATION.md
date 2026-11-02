# dsh-onebot-qq · 验证报告（VERIFICATION）

本文件记录 2026-11-02 在**真实 DeepSeek Harness** 环境里对本插件的完整验证，包括静态检查、
单元/集成测试、真实 DSH 安装与启动验证、浏览器端面板实际渲染，以及发现并修复的问题。

- DSH 版本：`0.2.1-rc.3`（`dsh --version`）
- 运行环境：Windows / PowerShell；Node `v24.21.0`（DSH 自带运行时，原生 `fetch` + `WebSocket`）
- 插件版本：`dsh-onebot-qq@0.3.0`（本版新增「系统设置」第 7 标签与持久化设置壳；前两版分别完成接入层与视觉/动效系统）
- 真实 QQ 网关：本机没有可登录的 NapCat / SnowLuma 实例，因此连接链路的对端使用**协议兼容的
  OneBot v11 mock 网关**（`test/helpers/mock-onebot.js`，HTTP + WS + token 校验 + 主动推事件）；
  真实网关侧的协议事实见 [RESEARCH-onebot-ecosystem.md](RESEARCH-onebot-ecosystem.md)。

## 0. 结论速览

| 验证项 | 结果 |
|---|---|
| 全部 JS `node --check`（宿主 + 网页半边 + 测试 + 脚本） | ✅ 通过 |
| 单元 / 集成测试 `node --test test/*.test.js` | ✅ **79 / 79 通过**（7 个测试文件） |
| 真实 DSH 安装 + 无头启动 + REST 探活 + boot 图校验（`scripts/verify-plugin.ps1`） | ✅ **RESULT: PASS**（临时 profile `lead-ui`，端口 3198） |
| 真实 DSH 实例端到端联调（mock 网关 → 面板 REST → 连接/核验/事件/发送/断开） | ✅ **16 / 16 全过** |
| 浏览器端面板真实渲染（Chrome headless + puppeteer，1440×900 与 360×800） | ✅ 侧栏入口 + **7 标签** + 数据驱动配置 + 连接态核验全部可见，无插件控制台错误 |
| UI/动效/设置断言（`document.getAnimations()`、主题、即时保存、持久壳、浅/暗色、窄屏） | ✅ **48 / 48 布尔断言全过**（见 §4.1 与 `docs/verification/ui-motion-evidence.json`） |
| 安装进当前桌面 profile 并生效 | ✅ 见 §7（`plugin_manager` 安装结果） |
| 已知缺陷 | 发现并修复 1 个会导致客户端插件无法激活的致命缺陷（§6.1），并有回归测试锁定 |

截图（本目录 `docs/verification/`）：

| 文件 | 内容 |
|---|---|
| `overview-connected.png` | 已连接状态：eyebrow + 大标题页头、状态 pill、登录账号 `冒烟机器人 (20000002)`、`核验通过`、统计 tile、分布条形图、最近事件 |
| `overview-stopped.png` | 未配置状态：warning banner +「去连接」、可读空态、连接操作 |
| `connect-unconfigured.png` | 连接页空态：三步 stepper 与地址表单 |
| `connect-tab.png` | 「连接」标签：三步 stepper、端点、脱敏 URL、检测/探测、连接控制 |
| `messages-tab.png` | 「消息」标签：目标列表（好友/群 + 搜索）、发送表单、事件流 |
| `config-tab.png` | 「配置」标签：持久设置壳（左侧分组导航固定）+ 仅当前分组内容 |
| `settings-appearance.png` | 「系统设置 → 外观」：DSH 主题卡（浅色/深色/跟随系统）、强调色色卡、对比度 |
| `settings-motion.png` | 「系统设置 → 动效」：动效模式、页面切换动画与内容切换预览 |
| `settings-dark.png` | 在系统设置里切到深色主题后的外观页（整个 DSH 生效） |
| `logs-tab.png` | 「日志」标签：增量拉取的真实网关生命周期日志 |
| `about-tab.png` | 「关于」标签：版本/数据目录/能力边界/第三方与许可 |
| `dark-overview.png` / `dark-config.png` / `dark-settings.png` | 暗色主题（`body[data-ds-dark-theme]`）下的概览、配置与系统设置 |
| `narrow-360px.png` | 360px 窄宽单列布局，`scrollWidth == clientWidth`（无横向溢出） |
| `settings-narrow.png` | 360px 下系统设置：分类导航横向滚动，右内容无横向溢出 |
| `reduced-motion.png` | `ui.motion=reduced` 下的面板（动画时长被降为 0.01ms，信息完整） |
| `preferences-blue-compact.png` | `ui.accent=blue` + `ui.density=compact` + `fontScale=large` + `contentWidth=standard` 的真实渲染 |
| `ui-motion-evidence.json` | puppeteer 采集的动效/主题/即时保存/壳稳定性/响应式断言快照 |

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
# ℹ tests 79 / pass 79 / fail 0
```

| 测试文件 | 数量 | 覆盖 |
|---|---|---|
| `test/normalize.test.js` | 9 | CQ 码/消息段解析、@/图片/引用、notice/request/meta、不伪造缺失字段、raw 截断 |
| `test/actions.test.js` | 7 | 消息段转换、群/私聊 action 映射、id 参数、校验错误、raw 透传 |
| `test/snowluma.test.js` | 11 | 安装探测、`onebot.json` / `onebot_<uin>.json` 读取、`enabled`/`enable` 兼容、URL 脱敏、端点解析回退 |
| `test/gateway.test.js` | 10 | WS 连接、账号核验 ok/warn/enforce、核验期事件缓冲、probe、send、disconnect、重复 start、`enabled:false→true` 自动连接 |
| `test/config.test.js` | 6 | 字段表与 DEFAULTS 不漂移、非法 wsUrl 产生 issue、probeMs clamp、非法枚举回退、`logging.redact` 开关、**`ui.*`（含 contrast）合法值保留与非法回退** |
| `test/panel.test.js` | 27 | module loader 注册形状（`inject` 含 theme）、apply 注册两个 slot、纯函数、**七标签渲染冒烟**、Motion Policy / reveal / count-up / presence、**contrast / 设置分类 / 持久壳转场 / applyConfigPatch**、`ConfigTab` 过滤 ui 组、`SettingsTab` 持久壳冒烟、三段式样式契约、`exports.Config` 回归锁定 |
| `test/e2e.test.js` | 9 | fake DSH 挂载真实 `src/host.js`：health/status/config、save 热应用、reset、非法值 issues、核验 ok/warn/enforce、缓冲、事件过滤、send、disconnect、logs |

## 3. 真实 DSH 安装 / 启动验证

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File packages\dsh-onebot-qq\scripts\verify-plugin.ps1 -Profile lead-ui -Port 3198 -KeepServer -KeepProfile
# RESULT: PASS   （本次实际使用的临时 profile/端口；脚本不带参数时默认 onebot-qq-verify / 3199 并自动清理）
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
- 七个标签 `概览 / 连接 / 消息 / 配置 / 系统设置 / 日志 / 关于` 全部存在且可切换；
- 配置页字段完全来自 `GET /config.groups`（开关/文本/密钥/数字/下拉/列表/多行文本均可见），
  左侧分组切换只替换右侧内容、不滚动整页；
- 「系统设置」页的左侧分类固定，切换分类只替换右侧内容；主题切换会真实改变整个 DSH 的浅/深色；
- 连接态：顶部徽标 `已连接`，登录账号与「核验通过」可见，事件列表显示 mock 推送的消息；
- 窄屏 360×800：单列布局，`document.scrollWidth == document.clientWidth`（无横向溢出），
  系统设置分类导航横向滚动可用；
- 控制台除 DSH 自身的 `[deepseek-account] account read failed`（与插件无关）外无错误。

### 4.1 UI / 动效 / 系统设置专项验证（v0.2.0 动效 + v0.3.0 设置页）

用 puppeteer 对真实 DSH 面板做了 **48 个布尔断言**与逐项证据采集，全部通过
（原始快照见 [verification/ui-motion-evidence.json](verification/ui-motion-evidence.json)）：

| 类别 | 断言（全部 ✅） | 证据 |
|---|---|---|
| 视觉基线 | 页头 eyebrow/标题/描述、状态 pill、**7 个中文标签**、连接昵称、无 `Failed to load plugins` | 截图 + 页面文本 |
| 页面切换 | 内容容器获得 `ob-enter-fade`（配置/系统设置强制 fade）；`getAnimations()` 含 `ob-content-*`、duration=**180ms**；tab 滑块 transform 移动 | `motion.tabSwitch` |
| Reveal | 首屏 `ob-reveal[data-reveal=revealed]` > 0、pending=0；存在非 0 的 `--ob-reveal-delay`（stagger） | `motion.initial` |
| 持久设置壳（配置） | 点击另一分组后：页头/滚动位置不变、根内容容器 class 与动画未重播、右侧 `.ob-settings-pane` 出现 `ob-swap-in`（180ms） | `motion.configGroupSwap` |
| 持久设置壳（设置） | 分类切换同上；页头/导航不动，只出现 `ob-swap-in`；不再出现整页滑动 | `motion.settingsCategorySwap` |
| 系统设置 | 4+1 分类（外观/布局与字号/数据与刷新/动效/重置与说明）、主题 3 个卡、无脏保存条、动效预览可用 | `checks.settings*` |
| DSH 主题 | 点「深色」→ `body[data-ds-dark-theme]` 且根背景 `rgb(13,17,28)`；点「浅色」→ 根背景 `rgb(246,247,251)`；点「跟随系统」恢复；显示「当前渲染：深色」表明 `theme/change` 同步 | `motion.theme` |
| 即时保存 | 在「布局与字号」点「紧凑」后未点保存，`GET /config.ui.density == compact`，根 `data-density=compact`，无 Savebar/脏提示 | `motion.autoSave` |
| 对比度 | 切到「高对比度」后根 `data-contrast=high`，面板边框色与 `standard` 不同 | `motion.contrast` |
| 转场偏好 | `ui.pageTransition=fade-up` 后切换使用 `ob-enter-up` | `motion.fadeUp` |
| reduced | `ui.motion=reduced` → `data-motion=reduced`，`ob-content-*` duration=**0.01ms** | `motion.reduced` |
| off | `ui.motion=off` → `data-motion=off` 且顶部进度条 `display:none` | `motion.off` |
| 外观偏好 | `accent=blue` → 主按钮 `rgb(37, 99, 235)`；`density=compact` → tab 高 **30px**；`fontScale=large` → 根字号 **15.75px**；`contentWidth=standard` → shell `max-width=72rem` | `motion.prefs` |
| 浅/暗色 | 浅色根背景 `rgb(246, 247, 251)`；暗色 `body[data-ds-dark-theme]` 且根背景 `rgb(13, 17, 28)`；深色下系统设置也可用 | 截图 + `motion.dark` |
| 窄屏 | 360×800 下 `document.scrollWidth == clientWidth` 且面板容器无横向溢出；设置分类导航横向滚动 | `motion.narrow` / `motion.narrowSettings` |
| 事件流 | mock 推送的私聊消息文本出现在「消息」页；日志行、配置分组导航、关于页均渲染 | `checks.messagesFilled/logsRendered/configNav/aboutRendered` |

动效实现约束（已由 `test/panel.test.js` 锁定）：`TOKEN_CSS` 是唯一允许十六进制色值的区块；
`MOTION_CSS` 是唯一允许 `@keyframes` / `animation:` 的区块；`PANEL_CSS` 只消费 `--ob-*` 变量，
不出现裸色值/裸字重。动效只使用 opacity/transform/width，不改高度与滚动容器。

## 5. 复用与配置化核对

- **复用现有轮子**：OneBot 客户端、store/redact/logger、SnowLuma 只读解析、mock 网关、fake DSH、面板
  注册结构与 DSH 主题 token 用法均复用/改写自 `aureth-labs/dsh-aurabot-qq`（MIT）与 DeepSeek Harness；
  本版面板的视觉令牌与语义动效参考用户自己的 console-web 项目（`packages/design-system` 的 tokens/motion
  foundation、`surface-foundation` 的页面配方、`ui-adapter` 的 AsyncRegion/Presence/Skeleton 契约，
  以及 `surfaces/plugins/settings` 的「持久设置壳 + 只换右侧内容」模式），
  但在单文件浏览器插件里重新实现，不引入其运行时依赖。明细和许可证全文见
  [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。运行时不引入任何第三方依赖。
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
- **验证**：修复后同一真实 DSH 页面侧栏出现「QQ 连接」、七个标签全部渲染（§4 截图）。

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
| 旧面板视觉扁平、无动效体系（用户反馈「一点也不灵动」） | 按 console-web 的令牌/页面配方/动效语义整体重做：软底 + surface 卡片 + 阴影/大圆角、eyebrow 页头、soft Tabs + 滑块、StatTile/MiniBars/reveal/presence/trickle/数字滚动；新增 6 个 `ui.*` 偏好；`test/panel.test.js` 锁定三段式样式契约与 Motion Policy |
| 配置页分组导航跳转时 sticky 标签栏遮住分组标题、且整页滚动（用户反馈「不要一整个页面切换滑动」） | 改为持久化设置壳：左导航固定，只替换右侧内容（`ob-swap-in` 淡入，180ms），删除 `scrollIntoView`/整页滚动；`配置`/`系统设置` 顶层进入恒为 fade |
| 新增系统设置页需要控制 DSH 全局主题 | 客户端插件 `inject` 增加 `theme`，`apply` 里绑定 `ctx.theme`；`ThemeControl` 调用 `theme.setTheme()` 并订阅 `theme/change`，与 DSH 自带外观设置双向同步；失败/不可用时优雅禁用 |
| 系统设置修改需要像 console-web preferences 一样即时生效 | 新增 `saveUiPatch` 串行保存队列：乐观更新 → `POST /config/save` → 服务端规范化回写；设置页显示保存中/已保存/失败重试，不显示脏保存条 |
| 窄屏设置页左栏的 “显示与偏好” 标题被挤成竖排 | ≤960px 时隐藏该分组标题，分类导航横向滚动、按钮 `white-space: nowrap` |
| 系统设置右栏分类标题与卡片标题重复 | 提升为「主题与强调色 / 空间与阅读 / 动效与转场」子标题，避免重复 |
| 设置分类滚动后标题被 sticky 标签栏遮挡 | 已经不存在整页滚动；分类切换不改变页面滚动位置 |
| 旧面板样式契约测试过严（禁止任何十六进制/600 字重），阻塞主题化 | 改为「令牌块唯一允许色值、动效块唯一允许 keyframes、组件块只消费变量」；字重/配色全部走 `--ob-*` 令牌 |

## 7. 安装进当前 DSH profile

- 当前 GUI（`http://127.0.0.1:60932`）属于 `desktop` profile。验证完成后通过 DSH 的插件管理
  （`plugin_manager` / `dsh plugin add`）把本包安装/链接进 `desktop` profile；
  安装结果与「是否需要刷新页面 / 重启 DSH」以安装工具返回的 `application` 字段为准。
- 本次确认 `desktop` profile 的 bundle 为 `dsh-onebot-qq@0.3.0`（`link:` 指向本仓库的 source 目录，
  `installed: true`）。**刷新 Web 页面**即可加载新版面板；新增的 `ui.*` 字段与 `inject: theme` 需要
  **重启 DSH 进程**才会由宿主/客户端编排重新加载（旧配置会自动补默认值）。
- 插件数据目录为 `$DSH_HOME/plugins-data/dsh-onebot-qq/`；验证过程中产生的临时连接配置已在
  每次联调结束时通过 `POST /config/reset` 恢复默认，不会把 mock 地址留在你的配置里。

## 8. 局限与未覆盖项

1. **没有真实 QQ 账号**：端到端对端是协议兼容的 mock 网关（HTTP/WS/token/事件/发送全部覆盖），
   真实 NapCat / SnowLuma 的差异（版本行为、风控、封禁风险）需要用户用自己的网关实测；
   接入步骤与常见问题见 [USER-MANUAL.md](USER-MANUAL.md) 与 [RESEARCH-onebot-ecosystem.md](RESEARCH-onebot-ecosystem.md)。
2. **SnowLuma 探测**只做了单元级（临时目录 + 构造的 `onebot*.json`）与只读逻辑核对，未在本机真实
   SnowLuma 安装上验证（本机未安装）。
3. **主题控制范围**：系统设置里的「DSH 主题」调用客户端公开的 `theme` 服务，作用于整个 DSH；
   已用探针 profile 验证浅色/深色/跟随系统切换与 `theme/change` 同步，但未在 `desktop` 真实用户主题
   （自定义第三方主题 id）上逐一回归；自定义主题时设置页会显示其 id 并允许切回内置三档。
4. **即时保存**：系统设置每次修改都会串行写一次 `config.json`（防止快速点击竞争）；已覆盖成功/回滚读取，
   未覆盖所有网络中断时刻的 UI 一致性（失败时保留草稿并给出重试）。
5. **动效矩阵**：在 1440×900 与 360×800 两个断点验证；未覆盖全部窗口宽度矩阵与高刷新率屏幕的
   逐帧性能测量（实现只使用合成友好的 opacity/transform/width，无 JS RAF 动画循环）。
6. 客户端插件在**已运行的 desktop GUI** 中是否需要刷新页面取决于 DSH 的运行时热加载行为；以安装结果为准。

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

# 4) UI/动效/系统设置证据（需要真实 DSH 探针实例 + puppeteer-core，见 .refs/tools/ui-shots.mjs）
& $node .refs/tools/ui-shots.mjs 'http://127.0.0.1:3198/?token=…' '.<输出目录>'
# 共 48 个布尔断言：tab/reveal/转场偏好/reduced/off/持久壳/主题/即时保存/对比度/暗色/窄屏
```
