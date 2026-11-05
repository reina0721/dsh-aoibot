# 从旧插件迁移到 dsh-bot

0.10.0 将旧包 `dsh-onebot-qq` 改为 `dsh-bot`，并调整为根目录单包。新版不会读取旧目录或 `DSH_ONEBOT_QQ_DATA_DIR`。

1. 停止使用旧插件的 DSH profile，避免数据库或配置仍在写入。
2. 完整备份 `$DSH_HOME/plugins-data/dsh-onebot-qq/`，或旧环境变量指向的目录；包含配置、人格、模型及认知数据。默认 DSH_HOME 为 `~/.dsh`。
3. 在目标 profile 的插件管理器移除旧插件及其 bundle 注册。确认旧插件不会随 profile 启动；不要同时运行新旧插件。
4. 将旧数据目录完整复制到 `$DSH_HOME/plugins-data/dsh-bot/`。若目标已存在数据，先单独备份，不要直接合并或覆盖数据库。
5. 如需自定义路径，设置 `DSH_BOT_DATA_DIR`，移除旧变量；不要把两个插件配置到同一数据目录。
6. 按[安装指南](INSTALLATION.md)安装新版，启动 profile，确认插件名、配置、人格列表、记忆与模型配置，以及 QQ 连接状态。

协议接口仍为 `/onebot-qq/api/*`，OneBot 事件契约不变。新生成的人格 JSON 格式标识为 `dsh-bot/persona-import@1`。历史证据保留原名称，不能据此判断当前安装名。
