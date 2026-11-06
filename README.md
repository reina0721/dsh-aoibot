# dsh-bot

![dsh-bot 宣传插画：会话、人格与记忆的连接](https://raw.githubusercontent.com/reina0721/dsh-bot/main/docs/assets/promo/dsh-bot-hero.png)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供 QQ 接入、人格与认知服务的插件。通过 OneBot v11 连接 NapCat、SnowLuma、Lagrange.OneBot 或 LLOneBot，提供网页管理面板和本地持久化。

## 实机演示

下面是在真实 DSH `0.2.1-rc.3` 中运行 `dsh-bot v0.10.0` 的网页面板。账号、人格和消息为合成演示数据，QQ 链路使用仓库自带的模拟 OneBot 网关；不代表真实 QQ 登录或外部模型调用。

![真实 DSH 面板：模拟网关已连接、账号核验通过、事件计数和人格概览](https://raw.githubusercontent.com/reina0721/dsh-bot/main/docs/assets/screenshots/overview-desktop.jpg)

[查看演示环境、验证结果与复现步骤](docs/DEMO.md)。顶部横幅为 AI 宣传插画，实际界面以实机截图为准。

## 能力与要求

- QQ 连接、账号核验、事件接收、群聊与私聊消息发送。
- 访问控制：`open`/`allowlist`、主人 QQ、私聊/群白名单、统一出站闸门与审计。
- 可选 DSH Session 运行时：`runtime.engine=agent` 时每聊天一个 DSH Session；仅主人私聊在运行时挂载 3 个当前会话 QQ 工具，失败自动回退 oneshot。
- QQ 命令（主人）：`/status` `/quiet` `/active` `/model` `/remember` `/forget` `/tts` `/say` `/sticker` `/bili` `/help`；支持按聊天覆盖模型。
- 回复分条、可配引用/@、连续未点名接话上限，避免长文刷屏与自说自话。
- 合并转发展开、拍一拍回应、表情表态归因；主人命令 `/like` `/poke` `/groupinfo` `/memberinfo`。
- 可选媒体：图片下载/视觉描述、语音 ASR/TTS、图片/语音发送、群/私聊文件上传，以及本地表情包库与媒体面板；M7-c 增加 OpenAI 兼容生图/改图和 `/draw` `/redraw` `/image`；外部 provider 默认关闭。
- 本地模块内核：从数据目录加载操作员安装的 JS 模块，提供显式权限 API、命令/事件/存储、错误隔离、热重载和模块面板；不含远程安装或 marketplace。
- 可选 B站公共内容：搜索、热门、BV 视频基本信息、REST API 与「内容」页；默认关闭，不使用 Cookie/WBI，不含评论/分享。QQ空间因登录授权与服务条款边界未实现。
- 本地目录备份与「备份」面板：默认 200 MiB / 5000 文件 / 保留 10 份；恢复默认暂存，应用需显式开启并先创建恢复前备份。快照含密钥与认知隐私，请按秘密保护；复制 SQLite 前停止写入，恢复后重启。无 zip、云端传输、自动恢复或工作区迁移，见[备份说明](docs/USER-MANUAL.md#备份)。
- 「安全」页：只读访问审计与危险面、上线检查清单；默认关闭的手动 GitHub Release 版本检查，stable/beta 仅改变发布过滤，不自动更新、下载或安装。保持 DSH 本机信任边界，不改变 API 鉴权；不提供工作区迁移或离峰省钱，见[安全与上线检查](docs/USER-MANUAL.md#安全与上线检查)。
- 目的系统（目标/计划/意图，面板与 `/purpose` 管理）；每日记忆整理与按作用域反思；时间轴只读回忆日志。
- 多人格管理，按人格隔离记忆、人物、关系、情绪及策略数据。
- 旧档案导入：认知记忆页/API 将通用 JSON/JSONL 导入当前人格，默认最多 5 MiB/5000 项，按作用域/人物/正文幂等去重，本地处理。
- OpenAI Chat/Responses、Anthropic、Gemini、Ollama 等模型协议与路由配置。
- 连接、消息、人格、模型、认知、日志及系统设置面板。

需要 DSH >=0.2.0 <0.3.0、Node.js >=22.13.0，以及已登录的 OneBot v11 网关。运行时无额外第三方依赖。能力边界见[实现状态](docs/cognitive/IMPLEMENTATION-STATUS.md)，长期目标见[项目愿景](docs/research/VISION.md)。

## 安装与下载

`v0.10.0` 已发布，可通过以下 GitHub 直链安装或下载。

| 入口 | 下载 |
| --- | --- |
| 最新稳定版 | [安装包 tgz](https://github.com/reina0721/dsh-bot/releases/latest/download/dsh-bot.tgz) · [解压包 zip](https://github.com/reina0721/dsh-bot/releases/latest/download/dsh-bot.zip) |
| 固定版本 0.10.0 | [安装包 tgz](https://github.com/reina0721/dsh-bot/releases/download/v0.10.0/dsh-bot.tgz) |
| 完整版本与校验文件 | [GitHub Releases](https://github.com/reina0721/dsh-bot/releases) |
| 开发源码 | [main.zip](https://github.com/reina0721/dsh-bot/archive/refs/heads/main.zip) |

将 desktop 换成实际使用的 DSH profile：

```sh
dsh plugin --profile desktop add https://github.com/reina0721/dsh-bot/releases/download/v0.10.0/dsh-bot.tgz
```

也可下载并查看安装脚本后执行：

```powershell
Invoke-WebRequest https://raw.githubusercontent.com/reina0721/dsh-bot/main/scripts/install.ps1 -OutFile install.ps1
.\install.ps1 -Profile desktop -Version 0.10.0
```

```sh
curl -fL https://raw.githubusercontent.com/reina0721/dsh-bot/main/scripts/install.sh -o install.sh
sh install.sh --profile desktop --version 0.10.0
```

脚本验证发布包 SHA-256，支持自定义 DSH 路径；不会自动重启 DSH。源码安装在仓库根目录执行 `dsh plugin --profile desktop add .`。详见[安装、升级与回退](docs/INSTALLATION.md)。旧版用户先阅读[迁移说明](docs/MIGRATION.md)。

M7-c 生图/改图与普通图片发送已接入服务、主人命令和媒体面板。生成/改图默认关闭，仅接收受大小/尺寸限制的 PNG base64，不抓取返回 URL；源图限媒体根内相对路径，realpath 防符号链接逃逸。改图只支持 OpenAI 兼容 edits；面板/API 只落盘，QQ 命令先检查 access。自动化使用 fake provider，真实 provider/QQ 生图改图未验证，#44/#46 仍保留差距。配置和限制见 [CONFIG 媒体](docs/CONFIG.md#39-媒体media) 与 [用户手册](docs/USER-MANUAL.md#37-媒体与表情包m4-am4-bm7-c)。

M7-b 新增默认关闭的主人 QQ 管理命令：资料、当前群管理、精华/撤回与媒体根内文件上传。需启用 `cognition.qqAdmin.enabled`，踢人始终 `confirm`、撤回默认确认；群管需机器人具备权限，无任意 action 透传或新增 Agent 工具，真实 QQ 管理/资料/文件动作尚未验证。用法见 [用户手册](docs/USER-MANUAL.md#33-按聊天选模型与-qq-命令主人)，配置见 [CONFIG](docs/CONFIG.md)。2026-11-06 用户批准的发布门槛豁免见 [GAP §8.1](docs/research/GAP-AURABOT.md#81-用户批准豁免)，其他差距继续跟踪。

M7-d 提供通用 JSON/JSONL 旧档案导入：记忆页选文件，或调用 `POST /cognition/import`，内容写入当前人格并幂等去重，不联网、不自动发送 QQ。无 Aurabot 专用迁移、向量或时间轴事件导入，尚无真实旧档案样本验证，#30 仍 partial。格式与用法见 [用户手册](docs/USER-MANUAL.md#36-目的与记忆整理)，开关和限额见 [CONFIG](docs/CONFIG.md#导入旧档案cognitionimportm7-d)。

M7 发布候选的强制检查、回滚与声明边界见 [发布检查表](docs/RELEASE.md)；当前未达全量 parity，不得宣称与 Aurabot 完全一致。

## 首次连接

1. 在 QQ 网关启用正向 WebSocket 与 HTTP 服务，设置 access token。
2. 重启目标 DSH profile，在侧栏「QQ 连接」填写网关地址、token 和机器人 QQ 号。
3. 保存并连接，确认「已连接」「核验通过」，再到消息页测试收发。
4. 打开「安全」页检查白名单/主人、备份、raw action、媒体 provider 与本地模块审核状态。

配置默认存放于 `$DSH_HOME/plugins-data/dsh-bot/`，可用 DSH_BOT_DATA_DIR 覆盖。不要公开含密钥的配置文件。

## 文档与开发

[文档首页](docs/README.md) · [用户手册](docs/USER-MANUAL.md) · [配置参考](docs/CONFIG.md) · [本地模块](docs/MODULES.md) · [模型网关](docs/MODEL-GATEWAY.md) · [Aurabot 对标](docs/research/GAP-AURABOT.md) · [视觉基线](docs/visuals/README.md) · [故障排查](docs/TROUBLESHOOTING.md) · [贡献指南](CONTRIBUTING.md) · [变更记录](CHANGELOG.md)

```sh
npm test
npm run check:docs
npm run check:parity
npm run smoke:temp # 需要本机 DSH；仅临时 profile，不连接 QQ/外部服务
npm run pack:release
npm run check:package
```

[对标审计与临时 profile smoke](docs/PARITY-AUDIT.md)记录当前计数、剩余项与证据边界；审计会因矩阵结构错误返回 1，剩余差距本身不会导致失败。`smoke:temp` 可用 `DSH_BIN=/path/to/dsh` 指定 DSH，始终新建并清理临时 `DSH_HOME`。

目录：src/ 为宿主实现，client.js 为网页面板，test/ 为测试，scripts/ 为开发与安装工具，docs/ 为用户、开发与研究文档。

## 许可

[MIT](LICENSE)。复用来源及版权声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
