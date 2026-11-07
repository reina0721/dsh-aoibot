# ADR-008：内置模块人格作用域仓库

- 状态：已接受（Phase 9，有限范围）
- 日期：2026-11-07

## 背景与决定

未来提醒迁移需要人格隔离的模块数据契约。现有 api.storage 是模块级异步 data.json，不能承担人格作用域；直接开放 cognition store 则会带出原始 kind、核心数据、SQL 或跨人格能力。本阶段仅建立窄仓库 API，不迁移提醒/媒体，不新增生产模块、依赖、配置、面板或 REST，版本保持不变。

host 将 cognition.services.personaStore（已有 createPersonaScopedStore facade）通过 kernel 的 personaStore 选项注入。仅 builtin 且声明 persona:store 权限的模块获得冻结 api.personaStore；缺权限时属性不存在。共享权限白名单认识该权限，外部清单声明它则在导入前拒绝，即使伪造 builtin/source 也无效。模块仍是任意本地 Node.js 代码，permissions 不是沙箱。

## 同步窄契约

get(key) 返回值的 structuredClone，缺失为 null；put(key,value) 完整覆盖并返回保存值的 structuredClone；remove(key) 返回存在且删除的 boolean；list({limit}={}) 返回新建时间降序的 {key,value} 数组（同时间顺序未定义），默认 100、整数 1–1000；count() 返回当前模块当前人格记录数。已存 null 和缺失的 get 结果相同，可用 list/count 区分。方法与底层 store/事务一样同步，不需要 await。

key 必须为字符串并匹配 ^[a-z0-9][a-z0-9_-]{0,63}$，模块 ID 同样由 manifest 验证。参数数量严格校验；put 没有 options，list 只接受 limit。没有 raw kind、SQL、where、offset、路径、底层 store、当前人格 ID、跨人格参数或句柄。值可包含业务字段，但这些字段不会用作存储 kind/ID/作用域元数据。

仅接受可 structuredClone 的 JSON 值，按 JSON 语义持久化；拒绝 undefined、函数、Symbol、BigInt、非有限数、循环、稀疏数组和 Date/Map/Set/二进制等类型。所有输入/输出（包括 list 内嵌值、put 返回值）复制，调用者修改不影响保存数据。每值 JSON.stringify 后 UTF-8 不超过 65,536 bytes，含引号/转义、不含内部 key/元数据；每模块每人格最多 1000 条。put 的额度检查与写入位于既有同步事务中，满额可覆盖，删除释放额度。非法/超限失败保留旧记录；底层故障统一固定错误，不带原异常 cause、数据库路径、SQL 或 payload。

## 命名空间、持久化与生命周期

使用固定内部 kind module_store，记录 ID 为 module:<moduleId>:<key>，再由既有 facade 映射为 persona_<id>:module_store。冒号不能进入模块 ID/key，前缀按完整分隔符匹配，避免不同模块 ID 的拼接碰撞。核心 kind 从不作为 API 参数；即使用 memory/setting 作为安全 key，也只是在本模块空间内保存普通值。

选择固定集合可以让既有 dropPersonaData 清理整个人格的所有模块记录，无需发现动态 kinds 或建立额外元数据/存储枚举 API。按命名空间过滤 count/list 沿用现有 store where，当前会扫描此人格的模块集合；不是通用数据库或高容量查询接口。没有独立持久层，沿用 cognition 的 SQLite/JSON fallback、事务、关闭与备份目录；原 api.storage 不变。

每个同步操作使用当时的当前人格。人格切换后同一 API 只读写新人格，不接受模块指定目标人格；未来异步提醒等待后的原人格归属、恢复、重试和投递语义另行设计。模块记录不加入现有人格复制/统计 UI 数据组，但人格删除会清理集合。停用、setup/事件失败、依赖重载/禁用、内核 dispose 撤销所有旧 runtime 方法（cleanup 时也已失效）；已提交记录保留，重新启用/重新 setup/重启可继续读取。没有卸载删除数据接口。

## 验证与限制

只用测试内置描述符申请权限，生产 registry 仍是三个内置模块。测试覆盖两内置模块隔离（含 ID 前缀）、SQLite 与 JSON fallback、当前人格切换与显式跨人格拒绝、核心 kind 隔离、非法 key/选项/命名空间、输入与所有输出深拷贝、非法值与 UTF-8/转义大小边界、1000 条额度/覆盖/删除释放、外部伪造在导入前拒绝、底层安全错误、停止/失败/依赖生命周期撤销且数据不丢失，以及实际 cognition 服务的重启持久化与人格删除。宿主接线也有回归断言。

运行 npm test、npm run check:docs、npm run check:parity、npm run pack:release、npm run check:package 与 git diff --check。离线校验与本地打包不代表 live QQ 验收、推送、部署或发布。仓库 API 本身不是提醒实现，不提供调度、发送、恢复、TTL、跨人格访问、查询语言或新的数据库。
