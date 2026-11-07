# ADR-011：提醒仓库端口与只读配置绑定

- 状态：已接受（Phase 12，仅前置端口）
- 日期：2026-11-07

## 背景与决定

Phase 11 已收束提醒启动权，未来 builtin-reminders 仍需要访问核心提醒数据和既有配置。Phase 9 的 personaStore 只适合模块私有数据，不应将提醒复制到 module_store 或开放通用 kind 访问。本阶段建立固定 reminder kind 的窄端口，数据留在现有 persona-scoped store，不迁移、不提取提醒。

新增 src/modules/reminder-repository.js，依赖注入的当前人格 facade，不读取 base/scopedKind/currentPersonaId，不导入数据库、文件系统或路径。host 已将 cognition.services.personaStore 注入内核，无需新增生产接线。模块不能指定 kind、persona、路径、SQL、过滤函数或事务回调；底层故障仅输出固定安全错误，无 store 报服务不可用。

## 仓库契约

方法同步且冻结：get(id)、list({status='active',limit=50}={})、findDue(now,limit=20)、countActive()、put(row)、update(id,patch)、remove(id)。get/update 对缺失行返回 null，remove 返回是否存在；update/remove 使用同步事务，update 不创建缺失行。list 最新创建优先，limit 为 1–50 整数；findDue 只选择 active 且 nextAt ≤ now，按 nextAt/id 升序后截取 1–20 条。计数不受返回上限影响。findDue 复用 facade.list 获取全部到期候选，在进程内排序，不新增 SQL 或索引。

put 是完整 upsert，沿用核心 store 的首次创建时间保留语义；update 仅允许 status/nextAt/sentCount/lastError，满足取消、成功计数、重复下次时间和失败退避的最小补丁需求；remove 提供显式删除。没有批量或任意行补丁入口。

业务行保持 id/scopeType/scopeId/text/at/everySeconds/nextAt/status/createdBy/createdAt/sentCount/lastError；输出投影剔除底层 kind/updatedAt。输入和所有行输出复制。完整行与补丁拒绝未知字段、访问器、符号键、非普通对象；所有方法严格校验参数数量。

ID 为核心生成的 rem_ + 24 小写 hex；状态只允许 active/sent/cancelled，目标仅 private/group，无前导零的正安全整数字符串 scopeId/createdBy。文本非空且最多 500 Unicode 字符。at/everySeconds 恰好一个非 null；重复间隔为 60–2592000 整数秒；at（非 null）/nextAt/createdAt/now 为非负有限有效 Date 毫秒数字。sentCount 为非负安全整数，lastError 为现有固定错误白名单或空串。允许历史到期时间，不在仓库复制业务授权、防重、maxActive 或配置间隔策略。

## 权限、配置与生命周期

新增 reminders:service，仅加载器确认 builtin 且声明权限的模块得到 api.reminderRepository。新增独立 config:read，控制 api.legacyConfig；缺权限整个属性不存在，外部清单声明任一权限在导入前拒绝，伪造 source/builtin 无效。permissions 是同进程稳定 API 边界，不是任意 Node.js 代码沙箱。

src/modules/legacy-config.js 仅支持 section('cognition.reminders')，拒绝所有其它路径和额外参数。每次读取当前 getConfig 的 reminders 节后复用核心 normalizeConfig，深拷贝只含 enabled/maxActive/minIntervalSeconds/maxIntervalSeconds/tickMs 的规范化结果。未知字段、秘密和其它配置不返回；缺配置使用现有默认值，读取异常固定安全报错。没有写入、通知/订阅，不更改现有模块 api.config 或全局配置/UI。

两种端口均绑定当前 setup runtime，每次调用检查活跃状态和身份；停用、setup/事件失败、依赖禁用/重载、dispose 撤销旧引用，cleanup 中也拒绝。已提交行与已返回快照保留。重新 setup 创建新端口，不删除数据。

仓库每次同步调用使用调用时的当前人格，切换后同一端口只访问新人格；没有跨人格参数或跨 await 固定人格句柄。旧快照不能作为异步写回归属的保证。未来提取提醒时必须设计在途人格归属、取消/删除竞态和 provider 停止语义，本阶段不以端口替换现有 tick。

## 验证与限制

新增 SQLite/JSON CRUD、状态、全量计数、先排序后截取、参数/行/补丁验证、clone 隔离、当前人格与其它 kind 隔离、禁止读取 facade 内部、核心服务互通、生产 facade 重启持久化测试。覆盖独立权限、外部/伪造来源导入前拒绝、缺后端与安全异常、停用/失败/依赖清理/dispose 撤销，以及配置精确路径、当前快照、默认值、规范化、秘密与其它配置剔除。

运行 npm test、npm run check:docs、npm run check:parity、npm run pack:release、npm run check:package、git diff --check。现有 reminder 测试不修改。打包仅本地验证，不表示发布或部署。

核心提醒继续拥有命令、业务规则、调度、出站与清理；没有 builtin-reminders、新生产 provider、数据迁移或通用数据库 API。未使用时无行为变化；数据继续纳入既有提醒人格统计/复制/删除和备份。无配置字段、UI、REST、依赖或版本变化。到期选择目前会扫描全部候选；不提供异步人格固定、原子业务防重/额度操作、调度或投递保证。
