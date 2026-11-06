# 故障排查

- **下载 404**：确认仓库已改名、目标标签已发布且包含安装资源。首次 Release 前使用源码安装。
- **找不到 dsh**：先确认 DSH 已安装，脚本通过 `-DshPath` 或 `--dsh` 指定可执行路径；路径含空格时加引号。
- **校验失败**：停止安装，重新下载同版本安装包和 SHA256SUMS；不要跳过校验。
- **侧栏没有面板**：确认安装到正在使用的 profile，重启该 profile，检查插件注册与启动日志；旧版升级时移除旧插件注册。
- **配置或人格消失**：检查 DSH_HOME 和 DSH_BOT_DATA_DIR，按[迁移指南](MIGRATION.md)复制旧数据。新版不自动搜索旧目录。
- **只能发消息、收不到事件**：检查正向 WebSocket 服务与地址。只有 HTTP 地址不能实时收事件。
- **账号核验失败**：检查机器人 QQ 号、网关当前账号和 access token。
- **模型不可用**：在模型面板执行连通测试，检查协议、URL、密钥与模型 ID，参考[模型网关](MODEL-GATEWAY.md)。

报告问题请附版本、系统、DSH 版本、复现步骤及脱敏日志，不要附密钥、token 或完整私人聊天记录。

## 左侧「QQ 连接」入口消失

**症状**：Host 侧 `/onebot-qq/api/health` 正常、QQ 网关 connected，但网页左侧没有「QQ 连接」，`client Slots` 的 `sidebar.panellist` 只剩 core 插件、没有 `onebot-qq`。

**原因**：升级/热重载 dsh-bot 时，Host 半边被替换，浏览器侧 `client.js` 的 Slot 注册被清掉；单纯刷新页面不一定会重新挂载。

**恢复**：

1. 先硬刷新页面（`Ctrl+Shift+R` / `Cmd+Shift+R`）。
2. 若仍未出现，在 DSH 的插件管理里把 `dsh-bot` bundle **停用再启用**，或重启 DSH Host；确认 `sidebar.panellist` 重新出现 `onebot-qq`。
3. 再刷新页面。

2026-11-06 本次真实故障即通过 bundle 停用/启用恢复；不影响 dsh-bot 配置、QQ 网关或数据。
