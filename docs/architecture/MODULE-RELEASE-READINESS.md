# 模块架构发布就绪与授权边界（Phase 15）

日期：2026-11-07。状态：**离线架构验收完成，发布与 live 操作待用户明确授权**。本阶段仅编写发布就绪文档并创建一个本地提交，不执行发布流程。

## 分支与精确提交链

当前工作分支为 `feat/release-readiness`，从 Phase 14 提交 `90d6f1e6a23d478fe720b68665d4a9223cbcf3c6` 创建；本页所在的文档提交位于其后。以下提交按先后顺序连续相接，Phase 11 的直接父提交为 `994cbbe06aa13879540efbd15e084a6f105e2ff6`（Phase 10）。分支名是本次本地核对时的名称，不代表已推送或合并。

| 阶段 | 本地阶段分支 | 完整提交 SHA | 提交主题 |
|---|---|---|---|
| Phase 11 | `feat/provider-composition` | `25835aae54a4cd3fb371a088a85146ad9bac7a7c` | feat(extensions): Provider 注册表与提醒启动权收束 |
| Phase 12 | `feat/reminder-repository` | `8eae4f2afdd11ed8d43833ba017e1fd3ca7854c4` | feat(modules): 提醒仓库端口与只读配置绑定 |
| Phase 13 | `feat/builtin-reminders` | `c239d6f1138eb196b2b03fc7d766e5f623729541` | feat(modules): 内置提醒 Provider 与命令接管 |
| Phase 14 | `feat/module-boundary-final` | `90d6f1e6a23d478fe720b68665d4a9223cbcf3c6` | docs(modules): 收束模块边界与媒体决策 |

## 已实现的程序边界

- Provider 注册表仅开放 `reminders` 固定槽位，要求加载器确认的内置来源和 `providers:register` 权限；唯一注册、身份绑定幂等注销，模块不能取得注册表或其它服务。宿主统一选择核心或模块提醒所有者，运行期交接串行等待旧所有者停止/排空，新 provider 启动失败清理后回退核心。见 [ADR-010](ADR-010-provider-composition.md) 与后续收束的 [ADR-012](ADR-012-builtin-reminders.md)。
- 提醒仓库访问原核心 persona-scoped reminder kind，SQLite/JSON 无迁移、双写或 module_store 副本；普通调用访问当前人格，capture 固定在途写回的原人格，端口随 runtime 撤销。独立只读配置入口只返回 `cognition.reminders` 的五个规范化字段，不开放其它路径、写入或秘密。见 [ADR-011](ADR-011-reminder-repository.md)、[ADR-012](ADR-012-builtin-reminders.md)。
- `builtin-reminders` 使用窄仓库、scheduler、access/delivery 与 provider API，接管单 timer 调度及 `/remind`、`/reminders`、`/forgetreminder`；沿用原配置、命令文案、人格数据、访问/出站闸门，停用恢复核心。模块默认启用与业务开关默认关闭是两个独立状态。
- 媒体传输、存储、provider 调用/凭据、HTTP 路由及文件约束仍归核心；本程序不提取 builtin-media 服务、不增 media provider 槽位。未来功能策略/命令模块需另行设计宿主持有的窄 media port。见 [ADR-013](ADR-013-media-boundary.md)。
- 外部模块稳定 API 不获得 provider/服务所有权、planner、turn hooks、状态写入、scheduler、persona store、提醒仓库、旧配置、受保护命令覆盖或内部 delivery/access 端口；普通外部 API 保持原契约。Phase 14 覆盖 11 项特权的普通/伪造 builtin 双组拒绝。外部模块仍是操作员信任的同进程任意 Node.js 代码，权限不是进程或文件/网络沙箱。见 [最终验收](MODULE-ACCEPTANCE.md) 与[模块契约](../MODULES.md)。

| 随包内置模块 | 默认模块状态 | 业务与核心保留责任 |
|---|---|---|
| `builtin-reply-delivery` | 启用 | 回复 format 规划；核心执行、出站闸门、统计与兼容/纯文本回退 |
| `builtin-typing` | 启用 | 私聊 turn 输入状态；`cognition.typing.enabled` 默认 false |
| `builtin-reminders` | 启用 | 提醒 provider、命令与调度；`cognition.reminders.enabled` 默认 false |
| `builtin-sample` | 关闭 | 主人示例命令/声明式配置；默认不导入/setup |

## 证据与本阶段验证

Phase 14 的离线结果保留在 [MODULE-ACCEPTANCE](MODULE-ACCEPTANCE.md)：

| 证据 | 已记录结果与适用范围 |
|---|---|
| `npm test` | 851 项，847 通过、0 失败、4 项既有 live 模型测试跳过；Node v24.18.0，155520.2911 ms。这是 Phase 14 结果，本阶段未重跑 |
| `npm run check:docs` | Phase 14 通过，本地链接与命名 |
| `npm run check:parity` | Phase 14 通过；61 项，6 has / 40 partial / 0 none / 1 limited / 6 leading / 8 exempt；remaining 47 |
| `npm run pack:release` / `npm run check:package` | Phase 14 本地 tgz/zip/SHA256SUMS 构建及双格式解包、文档/内容、四内置独立加载通过；不代表已发布或安装 |

remaining 47 排除 has/exempt、包含 leading，不是缺失功能数；既有能力状态与豁免不变，不宣称全量 parity。见 [PARITY-AUDIT](../PARITY-AUDIT.md)。

本阶段为纯文档变更，不重跑耗时数分钟的完整 `npm test`；没有新增完整测试结果。由于 `package.json` 的 files 包含 `docs/architecture/*.md` 和 `CHANGELOG.md`，仍执行本地打包与解包检查，确保文档进入包且包内链接有效。

| Phase 15 本地检查 | 结果 |
|---|---|
| `npm run check:docs` | 通过；本地链接与命名 |
| `npm run check:parity` | 通过；61 项，状态分布如上，remaining 47 |
| `npm run pack:release` | 通过；仅构建本地 tgz/zip/SHA256SUMS，包版本保持 0.11.7 |
| `npm run check:package` | 通过；两种包的校验和、内容、文档链接与四内置独立加载；包内本阶段三份文档与工作区逐字节核对 |
| `git diff --check` | 通过；含新增文档的暂存差异检查 |

上述检查在填入最终记录后再次执行，确保本地包包含最终文档。`dist/` 为忽略的本地产物，不纳入本次文档提交。

全部架构证据限本地离线测试、文档与包检查；本程序未做 live 模型/媒体 provider/QQ、真实定时投递或浏览器验收。旧版本历史 live 记录不能作为本次模块架构的 live 证据。

## Phase 15 显式授权门槛

以下五项全部为**待授权、未执行**。本地文档提交和离线检查不授予其中任何权限；接受既有 parity 或旧版本部署也不授予本次操作权限。用户需明确同意相应目标、范围及顺序，才能在后续任务执行。

| 门槛 | 授权前需明确的内容 | 通过条件与记录 |
|---|---|---|
| 1. 推送分支 / 合并 main | 远端、待推送分支、准确提交范围、目标 main 与合并方式 | 复核远端差异及既有架构前置链；用户批准后才 push/merge，记录最终 main SHA |
| 2. 版本 bump / tag / Release | 版本号、版本提交范围、标签与 Release/工作流发布范围 | 候选 **0.11.8 仅为提议**；批准后修改版本及发布记录、重跑检查，标签匹配 package，使用通过 CI 的产物。推送标签可能触发 Release，须事先授权 |
| 3. live 安装 / 热重载 / bundle 开关 | 目标 profile、确切包及校验和、维护窗口、备份、允许的重载/停启方式 | 先通过临时隔离 profile 的安装 smoke，再在获准目标安装；确认实际运行的新代码。内置模块不能直接重载，宿主热重载或 bundle 停启也需本项授权 |
| 4. live smoke | 测试号/群、允许的真实消息/模型调用/提醒投递、临时配置及模块开关变化、故障回退验证方式 | 按下表逐项记录实际观察、失败与未覆盖项；批准安装不自动批准真实发送或其它外部调用 |
| 5. 回滚方案 | 原运行包/校验和、数据与配置快照、触发条件、执行人及恢复授权范围 | 安装前确认回滚材料可用并明确允许的恢复动作；失败时按已授权方案停写/恢复/验证，数据恢复须另含明确授权 |

拟议 live smoke（全部未执行）：

| 项目 | 授权后的观察目标 |
|---|---|
| 模块列表 | `/modules` 或管理页看到四个内置模块；新安装默认三个 loaded、sample disabled，既有 profile 需对照持久化开关；外部模块兼容 |
| 提醒 disabled/enabled | `cognition.reminders.enabled=false` 不投递，启用后仅创建经批准的一次测试提醒，验证三命令与实际单次观察；停用/重新启用 builtin-reminders 时核心/provider 串行交接，无并行调度；结束取消测试项并恢复原配置 |
| typing | 配置关闭不调用输入状态；启用后私聊开始/结束可观察，群聊不产生私聊 typing；结束恢复原值 |
| 回复分条 | 受控内容验证分条、首条引用/群 @、条间等待及余文合并，保留访问/出站闸门 |
| fallback | 授权停用回复规划模块后 auto 路径回到核心；规划器缺失/失败的安全纯文本回退、提醒 provider 启动失败回核心先用离线证据。若要求 live 故障验证，需另明确受控方式与恢复点，不向生产注入故障代码或声称已测 |

## 拟议合并与版本顺序（未执行）

1. 先审阅本地 `feat/release-readiness` 文档提交和 Phase 11–14 连续链。核对 main 与更早架构前置提交的祖先关系；不把 Phase 11–14 当作可脱离前置链的独立补丁。
2. 获门槛 1 授权后，推送批准的分支/提交，通过审查与 CI 后按批准方式合并到 main；已被最终分支包含的阶段提交无需逐个重复合并。任何冲突解决或范围变化都应重新验证。
3. 获门槛 2 授权后，提议以 **0.11.8** 发布本次架构程序；实际版本以用户决定和届时标签核对为准。另建版本提交，更新 package/发布记录并重新运行完整测试、docs/parity、pack/package 和 diff 检查。本阶段 package 仍为 **0.11.7**，没有改版。
4. 在明确批准的最终版本提交上创建匹配标签并推送，依照[发布流程](../RELEASING.md)等待 CI 使用验证产物创建 Release；不覆盖既有版本产物。合并权限不等于标签或 Release 权限。
5. 门槛 3、4、5 均明确后，先备份并确认恢复材料、做临时 profile 安装验证，再 live 安装与获准的重载/bundle 切换、smoke；逐项记录版本、包校验和、配置恢复及观察结果。流程顺序可由用户另行批准调整，本页不执行任何一步。

## 回滚预案与已知限制

回滚预案同样未执行。安装前记录实际运行包版本/校验和、bundle 状态、模块 state/config、全局配置和人格数据备份；当前线上状态未在本阶段核实，不能仅凭仓库版本选择回滚包。出现启动失败、疑似双调度/重复提醒、访问/出站约束失效、数据异常或严重回复回归时，按授权窗口先停用 bundle/停止宿主以停止新发送，再恢复已验证旧包和原开关/配置并重启，检查 health、模块列表、提醒状态及基本交付。单纯停用 builtin-reminders 会回到核心，不能用来暂停全部提醒；需要暂停时应关闭提醒业务开关或停止宿主。

代码回滚不等于数据恢复：本程序无数据迁移，默认保留现有人格数据，不能为重发测试而回退成功状态。仅在用户明确授权数据恢复且宿主停写后按[备份与恢复流程](../RELEASE.md#3-数据与回滚)恢复快照；不得手改 SQLite、覆盖 live `cordis.patch.yml` 或覆盖已发布同版本产物。远端合并的撤销使用另行审查的 revert，不强推历史；代码回滚无法撤销已经提交的网络请求或已产生的发送副作用，不能承诺零重复。

- 尚无本程序的 live/浏览器验收，不能由离线通过推断真实 QQ、provider 或定时器已通过。
- 不保证跨进程 exactly-once、网关幂等或崩溃后零重复；最终同步卸载或超时后重试可能重复投递。
- Provider 交接是同进程串行排空，时长依赖在途发送完成/超时；错误 provider 的 stop 只能尽力清理，不提供分布式锁或健康监控。
- 媒体基础设施继续属于核心；没有 builtin-media 服务、媒体端口实施、外部媒体资源或路由授权。

本阶段没有生产代码、配置、UI、依赖或版本变化；不修改 `cordis.patch.yml` 或 `.archify/`。**未推送、未合并、未创建标签/Release、未安装/热重载/切换 live bundle、未部署、未 bump 版本、未执行 live smoke 或回滚。以上操作均需用户明确授权。**
