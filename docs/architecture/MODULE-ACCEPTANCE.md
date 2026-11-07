# 模块架构最终验收（Phase 14）

日期：2026-11-07。基线为 Phase 13 `c239d6f`，工作分支 `feat/module-boundary-final`。本阶段只增加边界测试、包检查与文档；没有生产行为变更或新增模块代码。

## 生产内置模块

| 内置模块 | 默认状态 | 责任与保留边界 |
|---|---|---|
| `builtin-reply-delivery` | 启用 | 唯一 format 规划器；执行、出站闸门、轮次状态与统计由核心持有；保留核心兼容规划与失败纯文本回退 |
| `builtin-typing` | 启用 | 私聊 turn 开始/结束的输入状态；业务开关仍是默认关闭的 cognition.typing.enabled |
| `builtin-reminders` | 启用 | reminders provider、单 timer 调度和三个受保护命令；业务开关仍是默认关闭的 cognition.reminders.enabled，复用核心人格数据及配置 |
| `builtin-sample` | 关闭 | 仅主人示例命令与声明式配置；默认不导入/setup |

tgz/zip 独立解包后检查四项目录、默认状态、提醒 provider 注册/注销、typing hooks、reply planner 与 sample 启用。构建本地验证包不等于发布。

## 外部稳定 API 边界

`test/module-boundary.test.js` 对以下 11 项分别使用普通外部清单和伪造 `source:builtin` / `builtin:true` 清单，验证拒绝且没有宿主调用或注册残留：

| 权限 | 实际拒绝阶段 |
|---|---|
| `providers:register` | setup 内注册拒绝，不能取得服务所有权 |
| `delivery:plan` | setup 内 planner 注册拒绝 |
| `turn:lifecycle` | setup 内 hook 注册拒绝 |
| `status:write` | setup 内状态写入拒绝 |
| `scheduler` | 整个 scheduler 属性不暴露，setup 使用失败 |
| `persona:store` | 清单校验拒绝，入口不导入 |
| `reminders:service` | 清单校验拒绝，入口不导入 |
| `config:read` | 清单校验拒绝，入口不导入 |
| `commands:override` | setup 内受保护命令覆盖注册拒绝 |
| `delivery:send` | 清单校验拒绝，入口不导入 |
| `access:check` | 清单校验拒绝，入口不导入 |

旧清单允许声明部分权限，不等于得到权限；本阶段保留既有拒绝时机。普通外部 commands/events/send:text 等接口保持原契约，send:text 仍走宿主交付与出站闸门。测试还验证未声明权限无法调用特权入口；伪造来源、provides 或 config 不会获得内置身份、服务、配置或媒体能力。

provider 注册同时要求加载器认定的内置来源和 providers:register 权限。生产 provider 仅 builtin-reminders，固定槽位 reminders，不存在生产外部 provider、外部服务替换或 media 槽位。模块不能得到注册表、其它服务对象、媒体资源或路由注册入口。

权限只约束稳定 API。外部模块是操作员信任的同进程任意 Node.js 代码，此证据不代表操作系统隔离、网络/文件沙箱或既有本机 HTTP 接口的新增鉴权。

## 数据与所有权证据

`test/module-reminder-repository.test.js` 验证 SQLite/JSON 使用原核心 reminder kind；普通仓库每次只访问当前人格，capture 只能固定调用时人格供在途写回，不接受其它人格参数或暴露身份。all/capture 均受 runtime 撤销约束，无 raw store/SQL/文件路径。旧配置端口独立只读全局 cognition.reminders 的五个规范化字段，深拷贝、不含秘密，不开放其它配置路径；它不是跨人格配置选择器。底层仓库/配置异常的对外错误不回显路径、SQL 或正文。没有 module_store 副本、双写或数据迁移。

`test/providers.test.js`、`test/host-providers.test.js` 和 `test/builtin-reminders.test.js` 验证单槽身份绑定及幂等注销、默认 provider/空注册表、停用/重启接管、先排空旧所有者再启动新所有者、启动失败清理后回退核心，以及最终 dispose 阻止迟到写库。核心 start/stop 幂等；同一次失败注册不无限重启，命令覆盖撤销后恢复核心。

这证明正确内置实现在同一进程的交接；不保证跨进程 exactly-once、网关幂等或崩溃后零重复。第三方内置 provider 的 stop 实现错误只能尽力清理，已经发出的网络请求不能撤回。

## 媒体与程序范围

[ADR-013](ADR-013-media-boundary.md) 明确媒体传输、存储、provider 调用、HTTP 路由与文件约束继续属于核心。本程序不提取 builtin-media 服务；未来可选模块只负责功能策略/命令，并须先设计宿主持有的窄 media port。外部模块不获得媒体资源或路由；无数据迁移。

本阶段无配置、UI、依赖、版本或新生产模块变化，不修改 cordis.patch.yml 或 .archify/。parity 能力状态和既有发布豁免保持，不据此声称全量功能对齐。

## 离线验证记录

仅执行本地自动化测试、文档/parity 检查和解包验证；没有 live 模型/媒体 provider/QQ、真实定时投递或浏览器验收。既有 live 模型测试未配置凭据时跳过。

| 命令 | Phase 14 结果 |
|---|---|
| `npm test` | 通过；851 项，847 通过、0 失败、4 项既有 live 模型测试跳过，155520.2911 ms（Node v24.18.0） |
| `npm run check:docs` | 通过；本地链接与命名 |
| `npm run check:parity` | 通过；61 项，6 has / 40 partial / 0 none / 1 limited / 6 leading / 8 exempt，remaining 47 |
| `npm run pack:release` | 通过；仅构建本地 tgz/zip/SHA256SUMS |
| `npm run check:package` | 通过；两种包的文档、内容和独立模块加载 |
| `git diff --check` | 通过 |

边界与提醒仓库专项 `node --test test/module-boundary.test.js test/module-reminder-repository.test.js`：46 项全部通过；外部 11 项特权 × 普通/伪造来源共 22 个拒绝子用例。完整测试包含既有 provider 交接、提醒命令/数据对等、出站闸门与媒体回归；pack/package 检查在填入最终记录后重新执行，保证产物包含最终文档。

推送、部署、发布与版本变更是独立工作，需要另行明确授权。本次只创建一个本地提交，不执行上述操作。
