# 当前项目审计（AUDIT）

> 依据：`docs/research/VISION.md`、当前仓库源码、DSH `0.2.1-rc.3` 运行时。
> 结论：现有实现是**高质量的平台接入层 + 面板**，不是认知系统；以下能力是增量补齐，不需要先重构接入层。

## 1. 已确认可复用

| 层 | 现有实现 | 可复用性 |
|---|---|---|
| OneBot 接入 | `src/onebot/client.js`、`src/gateway/manager.js` | 高：WS/HTTP、重连、echo、账号核验、超时、日志 |
| 事件规范化 | `src/gateway/normalize.js` | 高：message/notice/request/meta、CQ、@、图片、引用、撤回通知 |
| 事件缓冲与过滤 | `src/core/events.js` | 中：认知需要**过滤前原始事件**，需新增 raw sink；现有缓冲保留给面板 |
| 配置 | `src/core/config.js` | 高：字段表驱动、规范化、原子写；需新增 `cognition`/`cog-*` 组与版本 2 |
| 数据目录 | `src/core/store.js` | 高：路径/原子 JSON；认知库使用子目录 |
| 日志/脱敏 | `src/core/logger.js`、`redact.js` | 高：全部认知日志复用 |
| REST | `src/http/routes.js` | 高：认知路由挂同一前缀 |
| 面板 | `client.js` + `.ctx/newclient/*` 分片 | 高：React 无依赖、持久设置壳、Panel/StatTile/MiniBars 可复用 |
| 测试/验证 | 79 个 node:test、verify-plugin、UI 脚本 | 高：扩展为认知场景测试 |

## 2. 能力缺口（按目标域）

| 域 | 缺失 |
|---|---|
| 感知 | 原始事件未全量落盘；图片/语音/视频仅部分字段；无能力声明；撤回原文获取未建模 |
| 轮次 | 每条消息独立，无话语完整度、软/硬截止、群聊分桶、生成中追加、重启恢复 |
| 注意力 | 无显著度、话语权、竞争、群聊 floor、点名/关系权重 |
| 人物 | 无 Person/Identity/画像 facet/来源/置信度/作用域/版本 |
| 关系 | 无多维、方向性、情境、历史、修复曲线 |
| 人格/情绪 | 无状态模型；无演化、衰减、调节、多时间尺度 |
| 记忆 | 无工作/情景/语义/程序记忆，无关联检索、巩固、遗忘、隐私 |
| 认知 | 无情境对象、信念/推测/未知分离、规划/元认知 |
| 决策 | 无候选动作/效用/风险/沉默；无策略-结果分离与反馈 |
| 学习 | 无未知检测、知识缺口、来源注册、证据/claim、预算队列 |
| 技能 | 无技能状态、迁移、退化/恢复 |
| 可观测 | 无 trace、认知指标、管理 UI、数据删除/导出 |
| 工程 | 无 SQLite/迁移/备份/恢复；无长跑模拟 |

## 3. 现有约束（必须遵守）

- 单文件 `client.js`、无 JSX、无第三方 UI 库；构建走 `.ctx/newclient` 分片。
- 客户端插件不能导出 `Config`；`inject` 与包清单同步。
- 所有默认值/选项来自服务端；客户端不写死。
- reduced/off、360px、暗色、无裸色值；样式契约测试锁定。
- host 插件 Node ESM；可用 Node 内置 `node:sqlite`（Node 24.21 已验证），旧版需 JSON fallback。
- 平台层不得伪造观察；能力不支持时必须声明受限。

## 4. 技术债与风险

- `events.push` 前过滤会丢失未接受事件：认知新增 raw sink，**不改变**现有面板事件语义。
- 单进程内存缓冲 + 定时器：需持久化 open turn/任务，重启恢复。
- 现有配置字段表很大：新增 `cog-*` 组后 `配置` 页必须过滤，避免把认知设置混进平台配置。
- client.js 240KB：认知页拆为独立 fragments，避免单文件不可维护。
- 实时写 SQLite 可能阻塞事件循环：WAL + 小事务 + 批量/后台任务；性能测试纳入验收。

## 5. 决策

见 `docs/cognitive/DECISIONS.md`：单 bundle 内 `platform`/`cognition` 边界、SQLite+FTS+JSON fallback、LLM 继承 DSH 默认路由、无巨型 Prompt、安全默认。
