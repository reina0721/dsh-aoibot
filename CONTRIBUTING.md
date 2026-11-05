# 贡献指南

使用 Node.js >=22.13.0，在仓库根目录开发。运行时无第三方依赖，不需要安装依赖即可运行 `npm test`。

提交前运行 `npm test`、`npm run check:docs`、`npm run pack:release` 和 `npm run check:package`。外部模型测试按环境变量启用；普通 CI 不注入密钥。不要提交日志、个人配置、数据库或 verify-out。

宿主实现位于 src，面板位于 client.js。接口调整同步更新[架构契约](docs/ARCHITECTURE.md)，用户行为变化更新对应手册与 CHANGELOG。OneBot API 和事件名属于协议契约，不能当作产品旧名直接替换。

真实 DSH 验证使用独立临时 profile：

```powershell
npm run verify -- -DshPath 'C:\path\to\dsh.cmd'
```

该验证创建临时 profile、启动独立进程并自动清理。发布步骤见[发布指南](docs/RELEASING.md)。PR 描述说明问题、行为变化和验证结果。
