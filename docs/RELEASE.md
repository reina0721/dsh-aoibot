# 发布检查表（M7 发布候选）

状态：**v0.11.0 发布候选，未完成真实 QQ 验收**。本页是可复查的发布检查表，不是“全量 parity”声明。

## 1. 当前结论

- 版本：`package.json` 为 `0.11.3`；GitHub 标签/Release 与线上 `web` 安装状态见文末。
- 审计：61 项中 `has 6`、`partial 38`、`none 2`、`limited 1`、`leading 6`、`exempt 8`；**47 项非 has/exempt**。完整快照见 [PARITY-AUDIT.md](PARITY-AUDIT.md)。
- 用户已批准 8 项发布门槛豁免（2026-11-06）：#16 远端 API 鉴权、#47 QQ空间、#52 模块市场/远程安装、#55 25 页级面板、#59 工作区迁移/离峰省钱、#42 RVC/翻唱、#49 抖音/小黑盒、#50 桌宠。豁免是用户决定，不是实现证据；见 [GAP §8.1](research/GAP-AURABOT.md#81-用户批准豁免)。
- 未豁免且影响发布陈述：生图/改图 #44（受限实现）、向量检索 #31、时间轴事件导入 #30 等。
- 真实 QQ、媒体 provider、B站、GitHub、浏览器管理员操作均未做生产凭据验证；验收前不得声明已实机通过。

## 2. 发布前必须通过

在仓库根目录：

```sh
npm test                  # 期望 0 失败；4 项 live 因无 key 跳过
npm run check:docs
npm run check:parity
DSH_BIN=/opt/dsh/bin/dsh PATH=/opt/dsh/bin:$PATH npm run smoke:temp
git diff --check
```

`smoke:temp` 必须使用临时 `DSH_HOME`，不连接真实 QQ，不请求外部 provider；通过后清理临时目录。其摘要格式见 [m7-smoke.json](assets/m7-smoke.json)。

## 3. 数据与回滚

1. 发布前在**停写**的维护窗口创建本地备份：「备份」页或 `POST /onebot-qq/api/backup/create`；确认 `item.id` 与 manifest。
2. 恢复默认只暂存到 `restore-<id>/`；`apply` 需要 `ops.backup.allowRestore=true`，且必须先 stop DSH、恢复后重启。见 [USER-MANUAL 备份](USER-MANUAL.md#备份)。
3. 回滚代码：按已提交里程碑 `git revert` 或检出上一提交；不要覆盖线上 profile 的 `cordis.patch.yml`。
4. 配置变更可回滚 `config.json`；人格/认知数据优先用备份，不要手工改 SQLite。
5. 线上 `web` profile 的 dsh-bot 包升级/重装必须单独执行，并在临时 profile 先 smoke；本仓库提交本身不会更新线上。

## 4. 发布物与安装

- 构建：`npm run pack:release`（生成 `dist/` 安装包）；`npm run check:package` 的 SHA 校验失败时不得宣称发布包已验收，需按构建日志修正。
- 安装：`dsh plugin --profile web add <包或目录>`；具体命令与回滚见 [README](../README.md) 与 [安装说明](INSTALLATION.md)。
- 面板：15 个顶层标签；新增「备份」「安全」及媒体/内容/模块页。
- 默认安全姿态：QQ 自动连接取决于 `enabled`；外部媒体/B站/升级检查默认关闭；`cognition.qqAdmin.enabled` 默认关闭。

## 5. 发布声明边界

可以声明：

- 已实现并可复查的 M0–M6 与 M7-a–d 代码/文档/测试；
- 临时 profile API smoke 通过；
- 8 项用户批准的发布门槛豁免。

不可声明：

- “全量 parity”或“与 Aurabot 功能完全一致”；
- 真实 QQ/媒体/provider 已验证；
- 生图/改图完全闭环；RVC/抖音/桌宠虽已豁免但未实现；
- 工作区迁移、模块市场、QQ空间、25 页级面板或 API 鉴权已实现。

## 6. 真机验收状态（部分）

2026-11-06 已将 `v0.11.1` 本地构建安装到 live `web` profile 并完成**部分**真实 QQ smoke：

- live health `version=0.11.3`、`state=connected`；
- 新增 `/media/status`、`/backup`、`/upgrade`、`/modules` 路由均返回 200；
- 真实私聊入站消息与助手回复出现在 `/events`；通过 `/send` 实际发出消息，message_id `535556004`；
- 通过 `/backup/create` 创建本地快照 `20261106T153925024Z-f43f618a`。

**这不等于全量实机验收**：0.11.2 未重跑主人命令/typing；真实 GitHub `/upgrade/check` 返回当前/最新 `0.11.1`；B站公开搜索被 HTTP 412、热榜被 -352 风控，仅离线分享可用。主人命令 `/status` 已在 0.11.1 由配置主人（QQ 2152719569）真实发送并收到状态回复（入站 message_id `770603012`，回复 `890788338`）；typing 已在 0.11.1 由主人确认看到“正在输入/输入状态”提示；仅私聊/C2C，未验证群聊 typing；媒体 provider、文件发送、请求审批、typing、提醒投递、B站/GitHub 等仍未覆盖。脱敏证据见 [live-acceptance-2026-11-06.json](assets/live-acceptance-2026-11-06.json)。验收文档只记录实际观察，不把 API 200 或一条消息当成全量能力证据。

## 7. 版本与发布状态

- 标签/Release：`v0.11.0` 已发布；`v0.11.1` 为 M7-q typing 补丁；`v0.11.2` 为操作员/审批/目的计划；`v0.11.3` 为文件下载/删除补丁发布，资产由 GitHub Actions 生成。
- 线上 `web`：已升级到 0.11.0 构建并完成部分真实 smoke；未完成主人命令/媒体 provider/审批/typing/提醒投递等验收，不得写“全量实机验收”。
- 发布包：`npm run pack:release` 生成 `dist/dsh-bot.tgz` / `dsh-bot.zip`，`npm run check:package` 通过；GitHub Release 已上传。

## 8. 建议的下一步

1. 已批准 RVC/翻唱、抖音/小黑盒、桌宠豁免；继续闭环 47 项非 has/exempt。
2. 完成向量检索与时间轴事件导入，或明确列为下一版本；
3. 用测试号/测试群做一次受控 QQ smoke，并记录证据；
4. 通过 `pack:release` + 临时 profile 安装 smoke 后，再更新线上 `web`。
