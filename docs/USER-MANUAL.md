# dsh-bot 用户手册

本手册面向「已经能打开 DeepSeek Harness（DSH）Web，想把 QQ 接进来」的用户。
安装细节与全部配置项分别见 [README](../README.md) 与 [CONFIG.md](CONFIG.md)。

> 本插件只连接**你已经运行并登录好的** OneBot v11 网关（NapCat / SnowLuma / Lagrange.OneBot /
> LLOneBot），不下载、不安装、不启动、不注入任何网关。网关怎么装、怎么登录 QQ 不在本文范围。

## 目录

1. [安装到 DSH](#1-安装到-dsh)
2. [准备 QQ 网关](#2-准备-qq-网关)
3. [在面板里填地址与 token](#3-在面板里填地址与-token)
4. [面板十个标签](#4-面板十个标签)
5. [常见问题](#5-常见问题)
6. [本地自测（没有 QQ 网关也能跑通）](#6-本地自测没有-qq-网关也能跑通)
7. [安全与隐私](#7-安全与隐私)
8. [卸载与数据清理](#8-卸载与数据清理)

---

## 1. 安装到 DSH

完整安装、下载、升级和回退步骤统一见[安装指南](INSTALLATION.md)，旧版先阅读[迁移说明](MIGRATION.md)。安装后重启目标 profile，打开带 token 的 DSH 页面，检查侧栏「QQ 连接」及 /onebot-qq/api/health。

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

### 3.1 访问控制（建议上线前开启）

默认 `open`：任何私聊/群都能触发回复，保持升级前的行为。真正把 bot 放进群之前，建议在「配置 → 访问控制」
切换成 `allowlist`。

| 模式 | 谁能触发回复/主动行为 | 被拒绝的消息 |
|---|---|---|
| `open`（默认） | 任何私聊、任何群 | — |
| `allowlist` | 主人私聊、私聊白名单、群白名单 | 不落 raw、不聚合、不回复；只记审计元数据 |

操作：

1. 「配置 → 访问控制」把模式改成 `allowlist`；
2. 填「主人 QQ」（必填，否则没有主人特权，只有白名单生效）；
3. 在「私聊白名单」/「群白名单」里逐个输入 QQ 号/群号后回车；
4. 保存。概览页的「访问控制」卡片会显示模式、名单数量与最近拦截计数。

说明：

- **群聊按群放行**，不按发言人：群里任何人都能触发（是否回复仍由点名/概率/冷却决定）；不想让某个群触发，就不要把它放进白名单。
- **私聊按人放行**：主人和私聊白名单可以触发，其他人不行。
- 被拒绝的消息**不写入原始事件、不进认知、不回复**；审计只保留会话/发送者/原因/时间，不存消息正文，重启清空。
- 面板「消息」页手动发送是人工操作，不受访问闸门限制。
- 排查某条会话为什么被拒：面板概览计数，或 `POST /onebot-qq/api/access/check`（body：`chatType` / `chatId` / `senderId`）。

### 3.2 会话运行时（实验，默认关闭）

「配置 → 会话运行时 → 引擎」有两个选择：

| 引擎 | 行为 | 适用 |
|---|---|---|
| `oneshot`（默认） | 认知 pipeline 拼 prompt，一次性调用 LLM 生成回复 | 现有部署；无需宿主提供会话服务 |
| `agent` | 每个 QQ 聊天一个 DSH Session，由 Agent 生成回复，可用 preset 里的工具 | 想用工具/长上下文/DSH 原生能力时 |

`agent` 需要当前 DSH profile 提供 `sessionController`、`workspaceRegistry`、`agents`；缺任何一个或调用失败时，
本条消息自动回退到 `oneshot`，不会静默丢回复。

两个 preset 由插件 bundle 声明：

- `dsh-bot-private`：主人私聊，带 `tool-fs` / `tool-fs-search` / `tool-web`，人格与规则来自 `{{dshbot_persona}}` / `{{dshbot_rules_private}}`；
- `dsh-bot-social`：群聊与他人私聊，只有人格与时间上下文，不挂本机工具。

会话映射写在数据目录 `runtime/sessions.json`，工作区默认在 `runtime/workspace`；单轮等待上限由
「会话运行时 → 单轮回复超时」控制（默认 120s，超时只放弃等待，不强杀会话）。概览「运行诊断」会显示
`运行时：agent/oneshot` 与当前会话数；也可看 `GET /onebot-qq/api/runtime/stats`、`/runtime/sessions`。

建议先在测试群/测试号打开 `agent`，确认回复、工具调用与回退都正常，再考虑默认开启。`agent` 仍是实验路径：
工具清单、QQ 动作工具、按聊天选模型与命令会在后续里程碑补齐。

---

## 4. 面板十个标签

### 概览

- 连接状态、登录账号、账号核验结果、最近错误；
- 事件统计（收到 / 接受 / 丢弃 / 缓冲占用）、日志统计；
- **人格卡**：显示名字/介绍，快速进入人格工作台；
- **运行诊断**：最近一条消息是回复/沉默/跳过、群聊模式、跳过计数；可直接看到“为什么没回复”；
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

- 按分组（基本 / 连接地址 / SnowLuma 地址读取 / 超时与重试 / 事件 / 日志 / 安全）渲染插件字段；
- 左侧分组导航固定在页面上，点击只替换右侧当前分组的内容（`content.swap` 淡入），**不会整页滑动或滚动跳转**；
- 字段由宿主 `GET /config` 的 `groups` 数据驱动，客户端不写死默认值；
- 保存（Ctrl+S）、撤销改动、恢复默认；有未保存改动时标签上有 dirty 标记，底部会出现吸底保存条；
- 保存失败/非法值回退会在面板上给出可读提示（宿主返回的 `issues`）；
- 界面外观与主题不在这里，统一放到「系统设置」。

### 人格

顶层第 5 个标签，编辑 bot 的固定人设、多人格库与群聊参与方式；这是解决“人格看不到/不会聊天”的主要入口。

- **人格库**：保存多份互相独立的人格；下拉切换当前人格，切换后下一轮消息立即使用新人格；
- **新建人格**：填名字创建空白人格；**复制当前**：复制当前 profile/数值/风格，生成独立副本；
- **删除当前**：至少保留一份；删除当前人格会自动切到剩余人格；
- **导入人格 JSON**：接受 `persona-import@1` 格式（name/profile/traits/style/values/source），创建并激活新人格；
  适合导入外部蒸馏人格；外部包没有 LICENSE 时不要提交原文到公开仓库；
- **测试模型链路**：调用 `/cognition/llm/test` 实测当前 DSH/直连 route，显示成功 route/延迟或 provider 真实错误；
- 每份人格独立保存 profile、12 维特质、表达风格、价值边界、编辑历史与版本；旧 `self` 自动作为默认人格；
- 未保存修改时切换/新建/复制会先确认，不会静默丢草稿；
- **认知数据独立**：记忆、人物画像、关系、情绪、策略/决策、信念/学习、技能、诊断/元认知按当前人格隔离；
  切换人格等于切换整套认知状态；旧版本的无前缀数据首次启动时自动迁移到默认人格；
- **数据复制**：在「认知数据」卡片选择来源人格和数据组，把来源的指定组**单向替换**到当前人格；
  来源人格不变，复制后两者继续独立；删除人格会同时删除它的认知数据。

- **基本人设**：名字/自称、一句话介绍、身份/角色、背景；
- **性格与表达**：自然语言性格、说话风格/口癖、喜欢/不喜欢、边界/禁忌、示例对话；
- **Prompt 预览**：直接看到会注入分析与回复 system 的人设块（截断到 2000 字符）；空字段不会出现；
- **群聊参与**：
  - `仅 @ / 回复 / 唤醒词`（默认，安全）；
  - `点名必回，未点名按概率`（可调 0–1 概率）；
  - `所有群消息都分析`（仍受策略沉默、同群冷却、每分钟上限约束）；
  - 名字会作为唤醒词；群友叫 bot 名字也能触发；
- **保存**：显式保存 profile + 数值人格；有未保存改动时显示标记；
- **高级认知参数**：展开后可微调 12 维人格和 6 维表达风格；
- **演化历史**：记录人工编辑与慢演化；
- 文本人设保存在认知 SQLite 的 persona 记录，和 `config.json` 的数值初值分离；旧 persona 读取时补空 profile，不覆盖已有内容。
- 群聊仍只读本群/本作用域记忆；私聊记忆不会进入群聊 prompt。

### 模型

顶层标签，管理认知/生成使用的模型协议与厂商，不只适配 GPT/Claude/DeepSeek：

- **路由模式**：自动（DSH 优先） / 仅 DSH / DSH 固定 / 仅直连 / 直连→DSH 链式；"直连"指本页 provider；
- **预设**：OpenAI Chat、OpenAI Responses、Anthropic、DeepSeek、OpenRouter、OpenCode Go（OpenAI 与
  Anthropic 两种端点）、Command Code（两种）、Gemini、Ollama、Custom；
- **Provider 编辑器**：协议、base URL、请求路径、模型列表路径、认证方式、环境变量、API key、额外 headers、
  session header、模型 ID、超时、流式、重试；
- **测试**：发一个最小真实请求，显示协议/延迟/tokens/文本预览/错误；不显示 key/请求 header；
- **发现模型**：从 `/models`（或 Anthropic/Gemini/Ollama 对应端点）拉列表，确认后写入；
- **设为直连 / 设为备用**：认知默认用直连时走这里；`chain` 按 selected + fallback 顺序尝试；
- 密钥优先读环境变量（如 `OPENCODE_GO_API_KEY`）；UI 保存的 key 只在本地 `models.json`，API 只返回
  后四位和来源；留空保存表示保持原 key；
- **OpenCode Go** 必须带 `x-opencode-session`，预设已自动生成；**Command Code** 的 Go 套餐没有 API 权限
  （403），需要更高套餐；OpenRouter 聊天需要 key；
- 直连失败时按模式回退 DSH；所有路由都失败时不伪造回复，认知进入 degraded。

### 系统设置

参考 console-web 的偏好设置，专门放外观与动效：

- 左侧分类：**外观 / 布局与字号 / 数据与刷新 / 动效 / 重置与说明**；页头、标签栏、左侧导航始终保持不动，
  切换分类只替换右侧内容（同样是淡入 swap，不整页滑动）；
- **每次修改即时保存**，不需要点保存按钮，也不会出现吸底保存条；右侧标题旁会显示「保存中… / 已保存 / 保存失败」；
  失败时页内出现错误条与「重试」；
- 「重置与说明」可以恢复默认 `ui.*` 外观（只影响面板外观，不动主题、连接与账号配置），并查看当前生效值。

| 分类 | 配置 | 说明 |
|---|---|---|
| 外观 | DSH 主题 | 浅色 / 深色 / 跟随系统；通过 DSH 客户端 `theme` 服务切换，**作用于整个 DSH**，与 DSH 自带外观设置双向同步 |
| 外观 | 强调色 | 紫（默认）/ 蓝 / 绿 / 橙 / 跟随 DSH 主题；只影响本面板品牌色、选中态与焦点环 |
| 外观 | 对比度 | 跟随系统（读取 `prefers-contrast`）/ 标准 / 高对比度；高对比度加强边框与文字 |
| 布局与字号 | 界面密度 | 紧凑 / 标准 / 舒适；控件高度与卡片内距 |
| 布局与字号 | 界面字号 | 小（93.75%）/ 标准（100%）/ 大（112.5%）；只缩放任一面板文字 |
| 布局与字号 | 内容宽度 | 标准（72rem）/ 宽（100rem）/ 自动铺满 |
| 数据与刷新 | 状态刷新间隔 / 事件列表每页条数 / 日志列表每页条数 | 来自服务端 `ui.*` 数值字段，即时保存 |
| 动效 | 动效模式 | 跟随系统（默认）/ 始终开启 / 减少动效 / 关闭动效；减少/关闭会把动画时长降为 0.01ms，信息完整 |
| 动效 | 页面切换动画 | 默认（轻抬升 + 淡入）/ 淡入 / 自右 / 自下 / 自上轻移入 / 关闭；**只影响顶层标签**，配置与系统设置内部恒为淡入 |

动效只使用透明度和位移（不改高度、不造成布局跳动）：首屏区块进入视口时轻量淡入（stagger 40ms/项、
上限 120ms），标签切换、初始骨架、刷新保留内容、保存/提示进出、顶部进度与状态脉冲都由同一套
Motion Policy 控制。系统开启「减少动态效果」时，即使这里选「跟随系统」也会自动降级。

**说明**：主题不在 `config.json` 里——它由 DSH 自己持久化。`配置` / `系统设置` 页签进入时也只做淡入，
不会出现整块页面滑动。

### 认知

第 8 个顶层标签「认知」是长期状态与管理界面。它不是把所有内容塞进 Prompt，而是把状态存在
`cognition/cognition.sqlite`，LLM 只做语义分析与最终表达：

| 子页 | 你看到什么 / 能做什么 |
|---|---|
| 状态 | 人物/关系/记忆/未知/决策/技能计数；当前人格摘要、模拟情绪、LLM 路由与今日预算；暂停/恢复；最近决策与未知 |
| 人格 | 12 维特质与表达风格滑杆、价值边界、演化历史；修改即时保存，可重置；单次互动不会改变长期人格 |
| 人物 | 人物列表/搜索；平台身份、分层画像（事实/自述/观察/推断/假设）、置信度/作用域；删除单条画像或整个人物 |
| 关系 | 多维（好感/信任/熟悉/亲密/冲突/戒备…）、作用域与历史；不是单一好感度 |
| 记忆 | 搜索/类型过滤；情景/语义/情绪/社会/程序记忆；查看来源、重要性/访问次数；激活、遗忘（降权，不删除）、彻底删除 |
| 情绪 | 内部/外显效价、唤醒、压力、疲劳、心境与离散情绪；重置；模拟状态，不声称主观体验 |
| 策略 | 决策候选/效用/置信度/结果；标记正向/负向反馈；查看策略 Beta 后验并重置策略学习 |
| 学习 | 未知缺口、学习任务、带引用的 knowledge claims；手动运行/重试/取消；自动外部检索需在设置开启 |
| 技能 | 基础/有效熟练度、使用/成功/失败；压力与长期不用会降低有效值，恢复比初学更快 |
| 元认知 | 校准（Brier）、结果趋势、记忆/技能/学习健康、能力缺口与有限反思 |
| 设置 | 认知开关/演练、模型路由与预算、轮次窗口、人格/情绪/关系/记忆/策略/学习/隐私等全部 `cog-*` 字段，即时保存 |

**安全默认**：

- 群聊默认只回应 @ / 回复 / 唤醒词 / 命令；`群聊非点名参与` 需显式开启；
- 主动行为默认关闭；开启后仍受安静时段、日预算、关系门槛与退避限制；
- 自动外部检索默认关闭（只检测未知）；开启后按来源、预算、许可限制，外部内容不执行指令；
- 私聊/群聊默认隔离；私聊记忆不会进入群聊检索；删除人物会级联清理其画像/关系/记忆；
- LLM 不可用/失败时进入 degraded，不伪造回复；演练模式完整决策但不发送。

认知 API 前缀为 `/onebot-qq/api/cognition/*`（概览、人物、记忆、情绪、策略、学习、技能、元认知、导出/删除），
与平台配置共用同一个 DSH 认证边界。

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
- 打开浏览器开发者工具 Console 看 `dsh-bot` 的 client 加载错误。

### 5.8 如何重置配置

- 面板「配置」→「恢复默认」；
- 或直接删除数据目录里的 `config.json` 后重启插件/DSH。

### 5.9 群聊/私聊不回消息（访问控制）

先看「概览 → 访问控制」卡片：

- 模式是 `open`：访问控制不是原因，按「5.5 已连接但收不到事件」和认知诊断排查；
- 模式是 `allowlist`：确认目标群/私聊在对应白名单里，且主人 QQ 填写正确；
- 看「入站拦截 / 出站拦截」计数是否增长；用 `POST /onebot-qq/api/access/check` 查询具体会话的判定与中文原因；
- 被拒消息不会出现在「消息」页，也不会写入认知库，这是预期行为。

---

## 6. 本地自测（没有 QQ 网关也能跑通）

仓库自带一个内存版假 OneBot v11 网关，用于人工把面板点一遍（不是真实 QQ）：

```powershell
node scripts/mock-gateway.mjs
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
dsh plugin --profile <profile> remove dsh-bot

# 删除插件数据（配置 / 事件落盘 / 日志）
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\plugins-data\dsh-bot"
```

如果设置了 `DSH_BOT_DATA_DIR`，数据在它指向的目录里，等价删除即可。
卸载后重启 DSH，侧栏「QQ 连接」入口会消失。
