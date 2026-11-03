# dsh-bot · DSH QQ 接入插件（OneBot v11）

本仓库当前交付 **`dsh-onebot-qq`**：为 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness)
提供一个 **QQ 接入插件**。它通过 **OneBot v11** 协议连接 **NapCat / SnowLuma / Lagrange.OneBot /
LLOneBot** 等 QQ 网关的正向 WebSocket + HTTP 地址，把 QQ 变成 DSH 可感知、可操作的外部通道，
并提供**完整的网页面板与持久化配置**。

> 这是更大目标（`goal-context.md`：具有长期记忆、人物画像、情绪/人格、技能演化的人工认知架构）。
> v0.4 起本包同时提供**平台感知/执行接入层**与**内置认知内核**：连接、核验、事件规范化、消息收发保持稳定边界；
> 人格、人物、关系、记忆、情绪、策略、学习、技能与元认知在 `packages/dsh-onebot-qq/src/cognition/` 中实现，
> 通过 SQLite + 算法/服务持久化，而不是把所有东西塞进一个巨大 Prompt。

## 能力

- **连接管理**：OneBot v11 正向 WS 收事件 + HTTP 调接口；自动重连（退避/抖动/超时/重试全部可配）；
  只配 HTTP 时明确提示「无法实时收事件」；连上后按 `get_login_info` 核验登录账号
  （`off` / `warn` / `enforce` 三种策略），核验期间事件先缓冲、通过后按序补发，不丢消息。
- **事件规范化**：消息 / 通知 / 请求 / 元事件 → 统一结构（消息段、@、图片、引用、发送者、群/私聊），
  「平台没给就不伪造」；过滤规则（忽略用户/群、事件类型、消息子类型、是否含机器人自己）全部走配置；
  事件可选 JSONL 落盘；同时通过 `ctx.emit('onebot-qq/event', record)` 暴露给其它 DSH 插件。
- **动作**：发私聊/群聊（字符串自动转文本消息段、支持消息段数组）、好友/群/群成员、撤回、查询消息、
  原始 action 透传（默认关闭，需显式开启）。
- **SnowLuma 只读适配**：自动探测安装目录、读取它自己的 `config/onebot*.json`（含 `onebot_<uin>.json`、
  `mode: snapshot`）得到地址与 token；**不下载、不启动、不注入**（尊重其 EULA）。读不到时回退手填地址并说明原因。
- **完整面板**：DSH Web 侧栏「QQ 连接」入口 + 整页面板，八个标签：概览 / 连接 / 消息 / 配置 / 系统设置 / 认知 / 日志 / 关于。
  视觉与动效按 `console-web` 的设计体系（令牌 + 语义动效配方）重做：eyebrow 页头、软底 + surface 卡片、
  软阴影/大圆角、soft Tabs + 滑块、StatTile/MiniBars、骨架屏、presence 反馈、trickle 进度、状态脉冲与数字滚动。
  新增的「系统设置」参考 console-web preferences：DSH 全局主题（浅色/深色/跟随系统）、强调色、对比度、
  密度、字号、内容宽度、动效模式与页面切换动画；分类切换只替换右侧内容、不整页滑动，修改即时保存。
  「认知」第 8 标签提供状态/人格/人物/关系/记忆/情绪/策略/学习/技能/元认知/设置 11 个子页，
  可暂停/演练、查看决策与未知、删除/导出人物数据，全部走服务层命令。
  配置页 100% 由服务端字段表驱动（新增配置项不需要改 UI），支持保存/撤销/恢复默认/Ctrl+S、
  dirty 提示、toast、加载/空态/错误重试；`reduced`/`off` 与系统 `prefers-reduced-motion` 双重降级，
  浅/深色（`body[data-ds-dark-theme]`）与 190–390px 窄宽均已验证。
- **不写死参数**：所有可调算法参数集中在 `src/core/config.js` 的 `DEFAULTS`，首次运行写出
  `$DSH_HOME/plugins-data/dsh-onebot-qq/config.json`，面板可改，热应用（连接相关改动自动重连）。

## 安装

```powershell
$dsh = "C:\Users\Run\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"

# 1) 链接进某个 profile（推荐先用临时 profile 验证；desktop 是当前 GUI 的 profile）
& $dsh plugin --profile desktop add "C:\rin\coder\rin721\dsh-bot\packages\dsh-onebot-qq"

# 2) 重启 / 刷新 DSH 后，侧栏出现「QQ 连接」
```

也可以在 DSH 的插件管理里以本地 bundle 安装 `packages/dsh-onebot-qq`。详细步骤、NapCat / SnowLuma
开网关方式、面板用法与 FAQ 见 [`packages/dsh-onebot-qq/docs/USER-MANUAL.md`](packages/dsh-onebot-qq/docs/USER-MANUAL.md)。

## 快速开始

1. 在 QQ 网关（NapCat / SnowLuma 等）里开启「正向 WebSocket 服务端」（常见默认端口 `3001`）和
   「HTTP 服务端」（常见默认端口 `3000`），设置 access token；
2. DSH 侧栏打开「QQ 连接」→「连接」页填 `ws://127.0.0.1:3001`、`http://127.0.0.1:3000` 与 token，
   填机器人 QQ 号（用于核验）→ 保存 → 连接；
3. 「概览」看到 `已连接` 与 `核验通过` 即接入成功；「消息」页可直接发私聊/群消息并查看事件流。

> 只想本机自测、没有真实网关？运行 `scripts/mock-gateway.mjs` 起一个假网关（默认 `6700`），
> 填它的地址/token 即可走通全部面板与接口。

## 仓库结构

```
dsh-bot/
├── goal-context.md                     # 项目总纲（人工认知架构愿景与原则）
├── docs/ARCHITECTURE.md                # 本插件与团队协作的接口契约
└── packages/dsh-onebot-qq/             # 插件包（DSH bundle + client plugin）
    ├── package.json                    # dsh.bundle.patch / dsh.client 清单
    ├── cordis.patch.yml                # bundle 插入行
    ├── client.js                       # 网页半边：侧栏入口 + 八标签整页面板（配置/系统设置/认知持久壳）
    ├── src/host.js                     # 宿主半边入口（组装 gateway/events/routes）
    ├── src/core/                       # 配置、持久化、日志、脱敏、事件缓冲
    ├── src/gateway/                    # 连接生命周期、事件规范化、action、SnowLuma 只读适配
    ├── src/onebot/client.js            # OneBot v11 WS/HTTP 客户端（重连/echo/握手超时）
    ├── src/http/routes.js              # /onebot-qq/api/* REST（含 /cognition/*）
    ├── src/cognition/                  # 认知内核：turn/store/persona/emotion/person/relationships/memory/policy/learning/skills/meta/proactivity
    ├── test/                           # 99 个 node:test 用例（含认知 26、e2e、mock 网关、fake DSH、设置/动效/样式契约）
    ├── scripts/                        # 真实 DSH 验证脚本 / 独立 mock 网关
    └── docs/                           # 用户手册、配置手册、生态调研、验证报告、截图
```

## 验证

- `node --test packages/dsh-onebot-qq/test/*.test.js` → **99/99 通过**；
- `packages/dsh-onebot-qq/scripts/verify-plugin.ps1` → 临时 profile 真实 DSH 安装/启动/REST/boot 图/认知 SQLite
  **RESULT: PASS**（可重复运行，自动清理）；
- 真实 DSH + mock 网关 + Chrome headless：面板实际渲染、连接态核验、事件/发送/断开全链路 **16/16**；
  认知真实数据流：人物/关系/记忆/决策产生、演练不发送、8 标签与 11 子页、360px 无横向溢出；
  另有 UI/动效/系统设置专项断言（`getAnimations()`：标签切换 180ms、reveal stagger、持久壳只换右内容、
  DSH 主题切换、即时保存、对比度、reduced/off、暗色根背景、360px 无横向溢出）**48/48** 全部通过，
  截图与证据见 [`packages/dsh-onebot-qq/docs/verification/`](packages/dsh-onebot-qq/docs/verification/)。
  实际能力边界与未实现项见
  [`IMPLEMENTATION-STATUS.md`](packages/dsh-onebot-qq/docs/cognitive/IMPLEMENTATION-STATUS.md)。
- 完整证据、根因复盘（含一个 Cordis `Config` 槽位冲突导致的激活失败修复）与限制见
  [`docs/VERIFICATION.md`](packages/dsh-onebot-qq/docs/VERIFICATION.md)。

## 复用与许可

本插件**不重复造轮子**：OneBot 客户端、存储/脱敏/日志、SnowLuma 只读解析、mock 网关、fake DSH、
面板注册结构与 DSH 主题 token 用法复用/改写自成熟的 DSH 插件
[`aureth-labs/dsh-aurabot-qq`](https://github.com/aureth-labs/dsh-aurabot-qq)（MIT）与
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）；本版面板的视觉令牌与语义动效
参考用户自己的 `console-web` 前端基座（design-system tokens/motion foundation、surface 页面配方），
在单文件插件里重新实现，不复制其源码、不引入其运行时依赖。
运行时不引入任何第三方依赖（Node 内置 `fetch` / `WebSocket` + DSH 注入的 React）。
版权与许可证全文见 [`packages/dsh-onebot-qq/THIRD_PARTY_NOTICES.md`](packages/dsh-onebot-qq/THIRD_PARTY_NOTICES.md)；
本仓库以 MIT 许可发布（`packages/dsh-onebot-qq/LICENSE`）。

## 后续方向（不属于本插件）

接入层之上将按 `goal-context.md` 继续构建：消息防抖与会话轮次、人物画像与持久化关系、记忆
（情景/语义/程序性）、情绪与人格状态、注意力与工作记忆、行为规划与反馈学习、技能习得与演化，
以及供这些模块使用的可观测性与调试面板。本插件已经把这些能力需要的输入（规范化事件流、
连接状态、消息发送动作）以稳定的接口与 DSH 事件形式提供出来。
