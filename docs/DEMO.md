# DSH 实机演示

## 这次展示了什么

2026-11-05（America/New_York），在 Windows 上使用真实安装的 DeepSeek Harness `0.2.1-rc.3`，通过独立 `dsh-bot-public-demo` profile 加载 `dsh-bot v0.10.0`。界面来自真实浏览器渲染，未使用 AI 重绘或替换截图中的内容。

OneBot 链路使用仓库自带的模拟网关，机器人昵称为 `dsh-bot-demo`，QQ 标识 `20000002`、群标识 `30000001` 都是测试标识；消息来自“演示用户 A/B”，人格“小澄”“小岚”均为虚构角色。没有发布私人聊天、真实账号、模型密钥或 DSH 访问 token。

![1440×1000 的真实 DSH 连接概览](https://raw.githubusercontent.com/reina0721/dsh-bot/main/docs/assets/screenshots/overview-desktop.jpg)

画面展示连接状态、账号核验、实时事件计数、人格摘要、群聊运行诊断和事件分布。截图中的计数是截屏时刻的状态，心跳会使计数继续变化。当前公开截图只覆盖桌面概览，不宣称完成所有页签或窄屏截图验证。

## 验证记录与边界

| 项目 | 结果 |
| --- | --- |
| 真实 DSH 安装、启动与客户端注册 | 通过 |
| OneBot WS 连接与 HTTP 账号核验 | 通过，模拟账号核验为 ok |
| 群消息事件接收 | 合成消息进入真实插件事件流 |
| 认知数据 | 合成群聊产生人物、关系与记忆记录，SQLite 模式 |
| 人格 | 通过插件 API 保存并展示演示人格 |
| 桌面布局 | 1440px 视口，文档宽度 1440px，无页面级横向溢出 |
| 外部模型与真实 QQ | 未在本次演示中调用或接入 |

演示开启 dry run，关闭主动行为，模型路由为 direct 且禁用 DSH fallback；未配置直连模型。未点名的群消息按 addressed-only 规则跳过回复，这正是概览中 skipped / addressed_only 的含义。模拟网关连接成功不等于真实 QQ 登录成功；合成数据形成记忆记录不等于完成外部模型推理验证。

机器可读的脱敏结果见[演示验证摘要](assets/demo-evidence.json)。截图后尝试继续拍摄原生浏览器时，自动控制因无法可靠确认当前网址而停止，因此未补拍其它页签与窄屏画面。

## 本机复现

使用源码仓库，在根目录操作。需要已安装 DSH、Node.js 和 PowerShell。先确认 3211、6711 端口未被占用，以下 profile 仅用于演示。

1. 启动模拟 OneBot 网关，并保持该终端运行：

   ```sh
   node scripts/mock-gateway.mjs --port 6711 --nickname dsh-bot-demo
   ```

2. 在另一个终端创建并启动独立 DSH 实例：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-plugin.ps1 -Profile dsh-bot-public-demo -Port 3211 -DshPath 'C:\path\to\dsh.cmd' -KeepProfile -KeepServer
   ```

   使用实际 DSH 路径。这个验证脚本会重新创建指定临时 profile，并重置 verify-out 中的验证数据；不要用于需要保留的数据。保留开关使演示实例在验证结束后继续运行。

3. 写入合成演示数据：

   ```sh
   node scripts/seed-demo.mjs
   ```

   该脚本仅连接本机 3211/6711，检查数据目录必须为 verify-out/plugin-data，且网关必须提供 `_mock/state`；不满足条件即拒绝写入。重复运行会追加一组演示消息。

4. 从本机 `verify-out/boot.log` 取得带 token 的访问地址，用浏览器打开，进入侧栏「QQ 连接」。不要分享或提交该地址、日志或整个数据目录。
5. 在概览检查“已连接”“核验通过”；在消息页查看合成消息；在人格页查看小澄和小岚；在认知页查看人物与记忆。真实模型验证需要另行配置模型，详见[模型网关](MODEL-GATEWAY.md)。

演示结束后仅停止此次创建的 DSH 进程和模拟网关进程；进程号记录于本机验证结果中。不要结束日常使用的 DSH/QQ 进程。需要清理时先停止实例，再备份或移除专用演示 profile 与 verify-out。

## 宣传素材

横幅和方形分享图使用内置 image 模型生成，属于概念宣传插画，不是功能截图。素材与完整提示词见[素材来源和使用说明](https://github.com/reina0721/dsh-bot/blob/main/docs/assets/README.md)。

![dsh-bot 方形宣传图](https://raw.githubusercontent.com/reina0721/dsh-bot/main/docs/assets/promo/dsh-bot-social.png)
