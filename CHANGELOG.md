# 变更记录

## 0.10.0

- 项目、插件、界面和包统一为 dsh-bot，插件移至仓库根目录。
- 数据目录改为 plugins-data/dsh-bot，覆盖变量改为 DSH_BOT_DATA_DIR；旧数据需手动迁移。
- 保留 OneBot API 路径与事件契约。
- 建立分层文档、GitHub Release 安装包、校验文件和跨平台安装脚本。
- 新增离线测试、文档检查和发布产物检查流程。
- 兼容 Node 22.13 未编译 FTS5 的 SQLite：保留数据库与事务，检索使用词法匹配。

历史功能与验证材料见 [归档](docs/archive/README.md)。
