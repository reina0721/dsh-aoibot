# dsh-onebot-qq · 验证报告（VERIFICATION）

本文件记录 2026-11-03 在**真实 DeepSeek Harness** 环境里对本插件的完整验证，包括静态检查、
单元/集成测试、真实 DSH 安装与启动验证、浏览器端面板实际渲染，以及发现并修复的问题。

- DSH 版本：`0.2.1-rc.3`（`dsh --version`）
- 运行环境：Windows / PowerShell；Node `v24.21.0`（DSH 自带运行时，原生 `fetch` + `WebSocket` + `node:sqlite`）
- 插件版本：`dsh-onebot-qq@0.9.0`（本版修复 DSH 一次性模型调用、增加人格 JSON 导入与模型链路自检，并用 Aoi 蒸馏人格做真实 probe 闭环；v0.2 接入层、v0.3 视觉/设置页、v0.4 认知内核、v0.5 模型协议、v0.6 人格工作台、v0.7 多人格库、v0.8 人格级数据）
- 真实 QQ 网关：本机没有可登录的 NapCat / SnowLuma 实例，因此连接链路的对端使用**协议兼容的
  OneBot v11 mock 网关**（`test/helpers/mock-onebot.js`，HTTP + WS + token 校验 + 主动推事件）；
  真实网关侧的协议事实见 [RESEARCH-onebot-ecosystem.md](RESEARCH-onebot-ecosystem.md)。

## 0. 结论速览

| 验证项 | 结果 |
|---|---|
| 全部 JS `node --check`（宿主 + 网页半边 + 测试 + 脚本） | ✅ 通过 |
| 单元 / 集成测试 `node --test test/*.test.js` | ✅ **146 个用例**：无 key 时 142 通过 + 4 live skip；提供 OpenCode key 时 146/146 通过（20 个测试文件） |
| 真实 DSH 安装 + 无头启动 + REST 探活 + boot 图校验（`scripts/verify-plugin.ps1`） | ✅ **RESULT: PASS**（临时 profile `lead-ui`，端口 3198；新增 cognition/SQLite、persona profile、models 预设检查） |
| 真实 DSH 实例端到端联调（mock 网关 → 面板 REST → 连接/核验/事件/发送/断开） | ✅ **16 / 16 全过** |
| 浏览器端面板真实渲染（Chrome headless + puppeteer，1440×1000 与 360×800） | ✅ 侧栏入口 + **10 标签** + 数据驱动配置 + 连接态核验全部可见，无插件控制台错误 |
| 认知 UI（真实 DSH 页面 + 真实 REST 数据） | ✅ **15 / 15 布尔断言**：11 个子页、无横向溢出、空态/数据态、无页面异常 |
| 认知数据流（mock QQ → 真实宿主 → SQLite → UI） | ✅ 人物 1、关系 2、记忆 1、决策 1；演练模式不发送；人物/记忆/策略/关系页真实渲染 |
| 人格工作台 UI（v0.6） | ✅ 10 标签中「人格」可见；文本人设/边界/Prompt 预览/群聊参与/高级参数渲染；360px 无溢出 |
| 多人格库（v0.7） | ✅ 新建/复制/切换/删除；API 与浏览器 smoke：3+ 份人格、activeId 切换、UI 新建、360px 无溢出 |
| 人格级认知数据（v0.8） | ✅ 记忆/人物/关系/情绪/策略/学习/技能/诊断按人格隔离；旧数据迁移到默认人格；指定组复制到当前人格 |
| DSH 模型调用/人格导入（v0.9） | ✅ 一次性调用形状修复；`/cognition/llm/test` 返回真实 route/延迟/错误；Aoi 导入后私聊/群聊真实回复各 1 条 |
| 群聊参与（v0.6） | ✅ all 模式未点名消息产生决策且 `groupSkipped=0`；addressed 模式仍跳过；冷却/概率/名字唤醒有集成测试 |
| 模型页 UI（真实 DSH + 真实 provider） | ✅ provider 列表/编辑/测试/选择；密钥只显示后四位；360px 无溢出；无页面异常 |
| 模型协议 live（OpenCode Go key） | ✅ OpenAI 流式/非流式 + Anthropic 流式 + 模型发现；真实认知 analysis + compose 发送成功 |
| 模型发现（公开端点） | ✅ OpenRouter 451 个模型；Command Code 84 个可用（按 supported_endpoints 过滤） |
| UI/动效/设置断言（`document.getAnimations()`、主题、即时保存、持久壳、浅/暗色、窄屏） | ✅ **48 / 48 布尔断言全过**（见 §4.1 与 `docs/verification/ui-motion-evidence.json`） |
| 安装进当前桌面 profile 并生效 | ✅ 链接安装；宿主加载 0.9.0 需要重启一次 DSH |
| 已知缺陷 | 发现并修复客户端插件致命缺陷（§6.1）、认知存储目录缺陷（§6.2）、模型网关集成缺陷（§6.3）、人格/群聊可见性缺陷（§6.4）、单人格限制（§6.5）、认知数据全局共享（§6.6）与 DSH 一次性调用形状/无诊断问题（§6.7） |

截图（本目录 `docs/verification/`）：

| 文件 | 内容 |
|---|---|
| `cognition-overview.png` | 认知 → 状态：计数、人格/情绪摘要、LLM 路由与预算、最近决策/未知 |
| `cognition-persona.png` | 认知 → 人格：12 维滑杆、表达风格、价值边界 |
| `cognition-persons-data.png` | 认知 → 人物：mock 消息产生的真实人物实体（非空态） |
| `cognition-memory-data.png` | 认知 → 记忆：真实情景记忆、作用域 `private:10001`、重要性 |
| `cognition-policy-data.png` | 认知 → 策略：真实决策、候选/效用/置信度 |
| `cognition-relationships-data.png` | 认知 → 关系：全局+私聊作用域、多维条 |
| `cognition-narrow-360px.png` | 360×800 认知设置：无横向溢出，子导航横向滚动 |
| `models-overview.png` | 第 9 标签「模型」：路由模式、DSH/直连状态、provider 列表 |
| `models-editor.png` | provider 编辑器：协议/端点/认证/模型 ID/测试；密钥只显示状态与后四位 |
| `models-narrow-360px.png` | 360×800 模型页：单列、无横向溢出 |
| `persona-overview.png` | 顶层「人格」：文本人设、Prompt 预览、群聊参与、高级参数 |
| `persona-group-mode.png` | 群聊参与方式、概率/冷却/分钟上限与当前状态 |
| `persona-library.png` | 多人格库：当前人格下拉、新建/复制/删除、份数 |
| `persona-library-switched.png` | 切换后人格库与编辑表单 |
| `persona-library-narrow-360px.png` | 360×800 多人数库：按钮换行、无横向溢出 |
| `persona-data.png` | 人格级认知数据：各组条数、来源人格、数据组勾选、复制按钮 |
| `persona-data-after-copy.png` | 复制认知数据后当前人格的统计 |
| `persona-data-narrow.png` | 360×800 认知数据卡片：无横向溢出 |
| `persona-narrow-360px.png` | 360×800 人格页：无横向溢出 |
| `overview-diagnostic.png` | QQ 概览：人格卡与运行诊断（最近 turn、群聊模式、跳过原因） |
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
- 十个标签 `概览 / 连接 / 消息 / 配置 / 人格 / 模型 / 系统设置 / 认知 / 日志 / 关于` 全部存在且可切换；
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

### 4.2 认知内核与认知 UI 专项验证（v0.4.0）

**自动化测试**：11 个测试文件 / 99 个用例全部通过；其中认知 26 项覆盖：
存储事务/回滚/备份/FTS 中文检索、轮次软硬截止与快路径、人格单次不剧变、情绪衰减/调节、
关系冲突非对称、记忆重要性/相关性/隐私隔离/遗忘≠删除、策略候选/沉默/撤回分支/奖励归因、
信念证据更新与纠正、技能成功/失败/压力/迁移、学习任务与多来源 claim、群聊未点名不回复、
机器人自发消息防循环、主动行为安静时段。

**真实 DSH + 真实 REST 数据 + 浏览器**（`cognition-shots.mjs` / `cognition-data-shots.mjs`）：

| 检查项 | 结果 |
|---|---|
| 顶层标签数 = 8，新增「认知」可进入 | ✅ |
| 认知 11 个子页全部可切换、正文非空 | ✅ 状态/人格/人物/关系/记忆/情绪/策略/学习/技能/元认知/设置 |
| 空态渲染（无人物/无记忆时） | ✅ 空态文案与图标，不报错 |
| 数据态渲染（mock 私聊两段消息，演练模式） | ✅ 人物 1、关系 2（全局+私聊）、记忆 1、决策 1（`reply`，置信度 0.806，状态 `dry_run`） |
| 演练模式不发送 | ✅ mock `sentMessages=[]`，决策状态 `dry_run` |
| 1440×1000 / 360×800 无横向溢出 | ✅ `scrollWidth <= clientWidth` |
| 页面异常 | ✅ 0 个 `pageerror`；仅 DSH 自带 `[deepseek-account] account read failed` 控制台日志 |
| LLM 不可用 | ✅ 不伪造回复：`compose_failed` 记录 `LLM_PROVIDER_ERROR`，状态 `degraded`；页面显示 LLM 路由/降级 |

证据：`docs/verification/cognition-ui-evidence.json`、`cognition-data-*.png`、
`cognition-overview.png`、`cognition-narrow-360px.png`。
真实 DSH 探针中 `cognition/overview` 返回 `ready=true, mode=sqlite, skills=13`，
数据目录生成 `cognition/cognition.sqlite`（`verify-out/SUMMARY.txt` 第 32 项）。

**真实 LLM 说明**：本机探针 profile 从 `web` 模板创建，未携带桌面账号的模型凭据；因此真实探针验证的是
「无凭据时降级不伪造」。桌面 profile 使用当前 DSH 模型路由（`agentDefaultModel`），在有凭据时
`ctx.get('llm').stream()` 走完整分析/生成；该路径由假 LLM 集成测试锁定消息形状与降级行为，
未把「无凭据」误报成能力失败。

### 4.3 模型协议与模型网关专项验证（v0.5.0）

独立脚本 `scripts/verify-model-gateway.mjs`（不依赖 DSH；key 只从 env 读取；细节见
[MODEL-GATEWAY.md](MODEL-GATEWAY.md)）：

| 检查 | 结果 |
|---|---|
| 预设/协议注册表 | ✅ 12 个预设、5 种协议 |
| OpenRouter 公开模型发现 | ✅ 451 个模型 |
| Command Code 公开模型发现 + supported_endpoints 过滤 | ✅ 84 个可用模型 |
| OpenCode Go OpenAI 流式/非流式 | ✅ 文本非空；usage 57 / 41 tokens |
| OpenCode Go Anthropic 流式（x-api-key + session） | ✅ 文本非空；usage 93 tokens |
| OpenCode Go 模型发现 | ✅ 28 个模型 |

真实 DSH + 真实认知直连：mock QQ 收到「你好，今天有点累。」→ analysis
`greet_and_share_fatigue conf=0.88`（degraded=false，route=opencode-go/deepseek-v4.1-flash，1286 tokens）
→ compose 成功 → mock 收到真实回复：

> 你好呀，辛苦了。累的时候不用硬撑着聊天，想说说发生了什么我听着，想歇会儿就去歇会儿也行，我在这儿。

pipeline：`turns=1 decisions=1 sent=1 degraded=0 errors=0 pending=1`。

**v0.5 阶段重启后的 desktop profile 实测**：DSH 宿主已加载 `0.5.0`（`/onebot-qq/api/health` 返回
`version=0.5.0`，QQ `state=connected`）；在 desktop 数据目录临时保存 OpenCode Go provider 后，
经宿主 API 测试 `deepseek-v4.1-flash`（OpenAI，1706ms）与 `qwen3.8-flash`（Anthropic，1647ms）均返回 200；
随后删除临时 provider，`models.json` 恢复为空，未持久化测试 key。

模型页浏览器验证：9 个顶层标签；provider 列表/编辑/测试按钮/密钥状态均渲染；密钥只显示
`…tIe8` 与来源；360×800 无横向溢出；0 个 `pageerror`（仅 DSH 自身 account 日志）。

未做真实调用：Command Code（无付费 key；Go 套餐无 API）、OpenRouter 聊天（无 key）、
OpenAI/Anthropic 官方/Gemini/Ollama（只有 mock 协议测试）。原始证据：
[`model-gateway-evidence.json`](verification/model-gateway-evidence.json)。

### 4.4 人格可见性与群聊参与专项验证（v0.6.0）

**根因证据（真实 desktop 数据，修复前）**：

- `/cognition/persona` 正常，已有 12 维人格/风格/价值边界与 5 次 `reason:"ui"` 编辑；但没有文本人设字段；
- 最近 13 条 `turn_start` 全部是 `chatType=group, addressed=false`；
- 统计 `turns=7, decisions=0, sent=0, errors=0`，原因是群聊门控在分析前直接跳过并写入 `group_ambient_skipped`；
- 因此不是连接/模型/人格后端损坏，而是入口过深、缺少文本人设、群聊默认仅点名且 UI 没有任何解释。

**修复后验证（v0.6.0）**：

| 检查 | 结果 |
|---|---|
| 全量测试 | ✅ 146/146（有 OpenCode key；无 key 128 pass + 4 live skip） |
| 真实 DSH `verify-plugin.ps1` | ✅ PASS；`version=0.6.0`、`groupMode=addressed`、persona profile 可读 |
| 浏览器 10 标签 | ✅ 概览/连接/消息/配置/人格/模型/系统设置/认知/日志/关于 |
| 人格工作台 | ✅ 名字/身份/背景/性格/风格/喜好/边界/示例；Prompt 预览；高级 12+6 参数；保存后 API 持久化 |
| 群聊 `all` 未点名 | ✅ mock 群消息产生 decision，`groupSkipped=0`，`lastTurn.addressed=false`；真实 OpenCode 直连时实际发送回复（19.7s） |
| 群聊 `addressed` | ✅ 未点名只写记忆不决策（回归测试） |
| 概率/冷却/名字唤醒 | ✅ 集成测试：probability=0、cooldown、displayName 唤醒 |
| 概览运行诊断 | ✅ 显示群聊模式、跳过计数、最近 turn outcome/reason |
| 360px | ✅ 无横向溢出；无插件 pageerror（仅 DSH 自身 account 日志） |

截图：[`persona-overview.png`](verification/persona-overview.png)、
[`persona-group-mode.png`](verification/persona-group-mode.png)、
[`persona-narrow-360px.png`](verification/persona-narrow-360px.png)、
[`overview-diagnostic.png`](verification/overview-diagnostic.png)。
原始 UI 证据：`docs/verification/persona-ui-summary.json`（由浏览器 smoke 生成）。

### 4.5 多人格库专项验证（v0.7.0）

- 单元/服务测试：默认 `self` 迁移；新建空人格、复制、切换、删除 active、删除最后一份保护、
  指定 personaId 编辑/重置、activeId 跨 service 实例持久化、复制不共享引用。
- 集成测试：切换到新人格后，下一轮 compose system 实际包含新 `名字/自称`、性格和风格。
- REST 实测：GET 返回 `personas`/`activeId`；create/switch/delete 全链路；最后一份删除返回 `LAST_PERSONA`。
- 浏览器 smoke（真实 DSH probe）：
  - 创建「温柔版」「吐槽版」；
  - 人格页出现下拉、份数、新建/复制/删除按钮；
  - UI 新建「UI新建人格」后 activeId 指向新人格；
  - UI 切换回初始人格后服务端 activeId 同步；
  - 360px 按钮换行、无横向溢出；无插件 pageerror。
- 截图：[`persona-library.png`](verification/persona-library.png)、
  [`persona-library-switched.png`](verification/persona-library-switched.png)、
  [`persona-library-narrow-360px.png`](verification/persona-library-narrow-360px.png)。
- 原始证据：[`persona-multi-summary.json`](verification/persona-multi-summary.json)。

### 4.6 人格级认知数据隔离与复制专项验证（v0.8.0）

- 单元测试（`test/persona-scope.test.js`）：
  - 记忆/情绪按 active 人格隔离；`setting` 等全局 kind 不隔离；
  - 旧无前缀 memory/relationship 迁移到 `self`，旧行清理，第二次迁移幂等跳过；
  - 按组复制只用来源替换目标，来源不变，未选组不复制；同人格/不存在人格拒绝；
  - 删除人格数据清理。
- 启动迁移实测：v0.7 probe 的 14 条旧认知记录首次启动迁移到 `self`，`/cognition/persona/data?personaId=all` 可见。
- 浏览器 smoke（真实 DSH probe + puppeteer）：
  - 「认知数据」卡片显示当前人格 8 组条数；
  - 来源人格下拉、8 个数据组复选框、复制按钮渲染；
  - 点击复制后 toast 成功，API 数据摘要可读；
  - 360px 无横向溢出；无插件 pageerror。
- 截图：[`persona-data.png`](verification/persona-data.png)、
  [`persona-data-after-copy.png`](verification/persona-data-after-copy.png)、
  [`persona-data-narrow.png`](verification/persona-data-narrow.png)。
- 原始证据：[`persona-data-summary.json`](verification/persona-data-summary.json)。

### 4.7 DSH 模型调用修复与 Aoi 人格闭环（v0.9.0）

**修复前实测（desktop 0.8.0）**：

```text
groupMode=all, turns=7, decisions=7, sent=0, degraded=14
lastTurn.outcome=degraded, reason=LLM_PROVIDER_ERROR
persona: self, displayName="", hasProfile=false
```

结论：消息已进入认知流程，但所有生成都死在模型调用；同时没有导入人格，所以不可能看到效果。

**修复**：

- DSH one-shot 改为顶层 `system` + 只含 user input 的 `messages`；
- **必须带 `sessionId`**：desktop 真实日志暴露
  `400 MissingSessionID: Request is missing x-opencode-session`；手工 one-shot 现在生成稳定 UUID 并传给
  `llm.stream`，与 DSH agent loop 的行为对齐；
- 默认不向 DSH route 发送 `temperature`；
- provider finish error 保留真实 `failure.message`；
- `POST /cognition/llm/test` 用于独立验证 route；
- 修复「点插件白屏」：PersonaTab 引用 `importOpen/importBusy/modelTest` 时漏了 `useState`，导致
  `ReferenceError: importOpen is not defined`；补齐状态后 probe 面板正常渲染。

**真实 probe（真实 DSH + direct OpenCode route + mock OneBot）**：

- 导入 `深作葵`，activeId 指向 Aoi；
- `/cognition/llm/test` → `ok=true`，route `opencode-go/deepseek-v4.1-flash`；
- 私聊“你是谁？”实际发送：
  > 我是深作葵，原型来自《COPPELION》。这里是虚拟角色版本，由 DSH/QQ 负载运行，不是真人。先认识现在的你吧。
- 群聊（all 模式、未 @）“今天的待办像山一样。”实际发送：
  > 嗯，先别急着搬整座山。今天最占你精力的是哪一件？挑出来，我们先处理这一小块。
- 人格页新增「导入人格 JSON」「测试模型链路」控件；`client.js` 构建通过，probe 面板渲染无 pageerror，
  导入/自检 API 由 e2e 与 probe 覆盖。
- `pipeline`：`sent=2`、`degraded=0`、`groupSkipped=0`、`lastTurn.outcome=sent`；

**边界**：

- probe 的 DSH default route 没有 `DEEPSEEK_API_KEY`，`/llm/test` 真实返回
  “no API key for provider route”，证明错误不再被吞；随后用 direct OpenCode route 完成闭环。
- desktop 的 DSH route 依赖启动环境中的 provider key；重启到 v0.9 后必须先点「测试模型链路」，
  成功后再把 Aoi 用于真实 QQ。若失败，页面会显示 provider 原文而不是只有 `LLM_PROVIDER_ERROR`。
- Aoi 只导入核心人格（identity/style/derived traits/boundaries/examples + canon 摘要），
  没有移植其完整 CRDE/brain 五层适配器；外部仓库没有 LICENSE，原文不进入本仓库。

原始证据：`docs/verification/aoi-closed-loop.json`（本地 probe 结果，含生成回复）。

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
- **验证**：修复后同一真实 DSH 页面侧栏出现「QQ 连接」、九个标签全部渲染（§4 截图）。

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
| 认知 SQLite 目录不存在时打开失败 → JSON fallback 写临时文件 ENOENT，`/cognition/overview` 500 | `store.js` 在打开数据库/写 JSON 前 `mkdirSync(dirname, {recursive:true})`；真实探针新增指标：`ready=true, mode=sqlite` |
| 轮次聚合把合法值 `shortMsgMs: 0` 当成缺省（`|| 1200`），软窗口被莫名拉长 | 所有等待参数改用 `??`/`Number.isFinite`；集成测试锁定 `shortMsgMs=0` 时 1.5s 内聚合 |
| 机器人自己的消息可能再次进入认知形成回复循环 | aggregator 保存 `selfId`，pipeline 在入口跳过 `senderId === selfId || botQQ`；新增集成测试 |
| 权重计算在情绪为 `{}` 时 `Number(...)/stress` 得到 NaN，记忆重要性恒为 0.05 | 数值读取改为 `Number(...) || 0`；单元测试覆盖 |
| `updatedAt=0` 被误判为「无历史情绪」而跳过衰减 | 仅 `updatedAt > 0` 时执行衰减；单元测试覆盖 |
| 结果反馈总是更新「最近一条决策」的技能，而不是实际产生结果的决策 | outcome 按 `decisionId` 取决策再 `skills.applyOutcome` |
| 群聊 ambient 消息会触发分析/回复（违反默认仅点名） | pipeline 在分析前执行群聊 gate：默认只存情景记忆，不决策；集成测试锁定 |
| 人格只有初值、没有实际慢演化 | pipeline 增加 24h 门控的 `maybeEvolvePersona()`：至少 5 个结果样本、按近期平均奖励/未知量给证据，受 `maxDeltaPerDay` 与锁定项约束 |

### 6.3 模型网关集成修复

| 问题 | 修复 |
|---|---|
| provider 注册表若放在 config 会通过 `/config` 回传密钥 | 独立 `models.json`（原子写、0600 尽力）；API 只返回 hasApiKey/source/后四位 |
| 模型页 `h(strong)` 引用未定义变量导致整页崩溃 | 改为 `h('strong', …)`；真实浏览器回归通过 |
| 非流式适配器漏传 `sessionId`，OpenCode Go 缺 `x-opencode-session` 会 400 | 所有适配器非流式分支统一带 session header；真实非流式通过 |
| SSE 聚合后 usage 被二次归一化为 0 | `usageOf()` 同时识别内部 `{input,output,total}` 与厂商字段；mock/live 断言 token |
| Command Code `supported_endpoints` 可能把 Claude 发到 chat/completions | 发现结果保留 endpoints，网关按协议过滤并报 `PROTOCOL_MISMATCH` |
| 公开模型发现被误要求 key | discovery 无 key 也先尝试公开端点；需要认证的端点返回归一化 AUTH |
| `/models` API 包版本被注册表 version 覆盖 | 注册表字段改名 `registryVersion`；API 返回包版本 |
| 直连 analysis 在 700 tokens 下被 reasoning 截断 | 分析默认上限提升到 1800；真实直连 analysis `degraded=false` |

### 6.4 人格/群聊可见性修复

| 问题 | 修复 |
|---|---|
| 人格只有 12 个数值滑杆，没有用户能读懂的文本人设 | persona 记录增加 profile（名字/身份/背景/性格/风格/喜好/边界/示例），并加入 analysis/compose prompt |
| 人格入口埋在「认知 → 人格」，顶层看不到 | 新增第 10 个顶层「人格」标签 + QQ 概览人格卡 + 认知人格页跳转入口 |
| 群聊未点名被硬跳过，UI 不解释 | 新增 `groupReplyMode`（addressed/probability/all）、冷却/分钟上限；trace/stats/overview 记录 `group_skipped` 与 `lastTurn`；概览/诊断卡展示原因 |
| 改名后群友叫名字不触发 | `profile.displayName` 自动并入唤醒词；集成测试覆盖 |
| 群聊模式与旧 `addressedOnlyGroups` 冲突 | 旧字段保留兼容映射，UI 只暴露新 `groupReplyMode`；全部模式仍受 policy 沉默/限频约束 |

### 6.5 单人格限制修复

| 问题 | 修复 |
|---|---|
| `persona` 只读写 `store.get('persona','self')`，无法保存第二份 | 改为 persona 记录集合 + `setting.persona.activeId`；旧 `self` 保留为默认 |
| 没有切换/新建/复制/删除 API | 新增 `/cognition/persona/{create,switch,delete}`；edit/reset 接受 personaId |
| 切换是否影响 prompt/唤醒词不明确 | `persona.get()` 始终返回 active；切换后下一轮 compose/唤醒词使用新人格；集成测试锁定 |
| 删除 active 后可能没有当前人格 | 自动切到剩余最早人格；删除最后一份返回 `LAST_PERSONA` |
| UI 只能编辑当前那一份 | 顶部「人格库」下拉 + 新建/复制/删除；份数/active 标记/未保存确认 |

### 6.6 认知数据全局共享修复

| 问题 | 修复 |
|---|---|
| 记忆/人物/关系/情绪/策略/技能等不区分人格，切换人格仍共享 | 新增 `createPersonaScopedStore`，非全局 kind 自动加 `persona_<id>:` 前缀；服务层无感 |
| 旧数据会因命名空间变化“消失” | 启动时把旧无前缀数据迁移到默认人格；写入幂等标记，已有目标记录不覆盖 |
| 需要“把一个人格的数据给另一个” | 人格页「认知数据」支持选来源人格 + 数据组，单向替换当前人格对应组；来源不变 |
| 删除人格留下孤儿数据 | 删除成功后清理该人格全部 scoped 数据 |

### 6.7 DSH 一次性调用与无诊断问题

| 问题 | 修复 |
|---|---|
| DSH one-shot 把 system 伪造为 system-role Message，且强制 temperature | 改为顶层 `system` + identity-free user messages；默认不发 temperature |
| DSH provider 返回 `MissingSessionID`（缺 `x-opencode-session`） | 手工 one-shot 生成稳定 UUID，作为 `GenerateOptions.sessionId` 传给 `llm.stream` |
| 点插件白屏：`ReferenceError: importOpen is not defined` | PersonaTab 补齐 `importOpen/importBusy/modelTest/modelTestBusy` useState；probe 面板恢复渲染 |
| 失败只记录 `LLM_PROVIDER_ERROR`，看不到 provider 原因 | 保留 `finish.reason.failure.message`；写日志/overview.lastFailure/`/llm/test` attempts |
| 没有独立模型自检，无法区分“人格没效果”和“模型没通” | 新增 `POST /cognition/llm/test`，UI 人格页按钮；真实显示 route、延迟或错误 |
| 外部人格无法导入 | 新增 `persona-import@1`、UI 文件导入、Aoi 转换脚本 |

## 7. 安装进当前 DSH profile

- 当前 GUI（`http://127.0.0.1:60932`）属于 `desktop` profile。验证完成后通过 DSH 的插件管理
  （`plugin_manager` / `dsh plugin add`）把本包安装/链接进 `desktop` profile；
  安装结果与「是否需要刷新页面 / 重启 DSH」以安装工具返回的 `application` 字段为准。
- 本次确认 `desktop` profile 的 bundle 为 `dsh-onebot-qq@0.9.0`（`link:` 指向本仓库的 source 目录，
  `installed: true`）。**重启 DSH 进程**后宿主/客户端编排会加载 0.9.0（DSH 调用修复、人格导入、模型自检）；
  仅刷新页面只会加载客户端部分。
- 插件数据目录为 `$DSH_HOME/plugins-data/dsh-onebot-qq/`；模型 provider/密钥在 `models.json`，
  不在 `config.json` 中，不会被 `/config` 回传。验证产生的临时 provider 已删除；mock 连接配置已
  通过 `POST /config/reset` 恢复默认。
- 当前 desktop 的 `config.json` 已把 `cognition.turn.groupReplyMode` 预置为 `all`（备份 `config.json.v06.bak`）；
  旧宿主 0.5 不识别该字段，**重启到 0.6 后生效**。若只想被 @ 时回复，重启后在「人格 → 群聊参与」切回 `addressed`。

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
6. **模型协议边界**：本版验证了 OpenCode Go 的真实 OpenAI/Anthropic 调用；Command Code/OpenRouter
   只有公开模型发现，Gemini/Ollama 只有 mock 协议测试；工具调用、视觉/音视频多模态、Azure/Bedrock/Vertex
   等需要额外认证方式的协议不在本版。
7. **群聊参与边界**：`all` 模式会让所有群消息进入分析，成本/打扰随群活跃度增长；默认仍是 `addressed`，
   冷却与每分钟上限只能降低、不能消除刷屏风险；当前 desktop 验收需显式切换并观察真实群流量。
8. **文本人设**：profile 由本地操作者编辑，属于可信配置；模型仍可能不完全遵循，需通过示例和边界迭代；
   不能覆盖安全/隐私硬规则。
9. 客户端插件在**已运行的 desktop GUI** 中是否需要刷新/重启取决于 DSH 的运行时热加载行为；以重启后的加载结果为准。

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

# 3) 模型协议真实连通（OpenCode key 只在 env；不依赖 DSH）
$env:OPENCODE_GO_API_KEY = '...'
& $node packages\dsh-onebot-qq\scripts\verify-model-gateway.mjs
& $node --test packages\dsh-onebot-qq\test\model-live.test.js

# 4) 本地人工联调：假网关 + 面板
& $node packages\dsh-onebot-qq\scripts\mock-gateway.mjs   # 默认 6700，打印地址/token
# 打开面板 → 连接页填 ws://127.0.0.1:6700 / http://127.0.0.1:6700 + token → 保存 → 连接

# 4) UI/动效/系统设置证据（需要真实 DSH 探针实例 + puppeteer-core，见 .refs/tools/ui-shots.mjs）
& $node .refs/tools/ui-shots.mjs 'http://127.0.0.1:3198/?token=…' '.<输出目录>'
# 共 48 个布尔断言：tab/reveal/转场偏好/reduced/off/持久壳/主题/即时保存/对比度/暗色/窄屏
```
