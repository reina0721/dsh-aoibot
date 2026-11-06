# 认知能力地图（CAPABILITY-MAP）

> 状态：**D** 设计中、**I** 已实现、**T** 已测试、**V** 已验证、**L** 受限、**R** 待研究。  
> 本表随实现/测试/真实验证更新；没有测试证据不得从 D 升到 I/T。
>
> 注：表中 `attention.js` / `identity.js` / `groups.js` / `unknown.js` / `capabilities.js` / `privacy.js` 等是目标态命名；当前实现落在 `turn.js` / `person.js` / `relationships.js` / `policy.js`，以 [IMPLEMENTATION-STATUS](IMPLEMENTATION-STATUS.md) 为准。

| 能力域 | 子能力 | 模块 | v0.4 目标状态 | 后续 |
|---|---|---|---|---|
| 感知 | 原始事件落盘、字段规范化、能力声明、图片/语音/文件元数据 | `gateway/normalize`, `cognition/bus`, `raw_events` | I/T | 多模态 v0.5 |
| 轮次 | 碎片聚合、软/硬截止、个人节奏、群聊分桶、生成中追加、撤回/编辑、重启恢复 | `turn.js` | I/T | 更细语用 v0.5 |
| 注意力 | 显著度、群 floor、点名/关系权重、竞争/饥饿、速率限制 | `attention.js` | I/T | 群体学习 v0.5 |
| 工作记忆 | 当前 turn/人物/目标/候选 | `memory/working.js` | I/T | — |
| 人物 | Person/Identity、初识、观察、facet 分层、置信度/作用域/版本、修正/合并 | `identity.js`, `person-facets.js` | I/T | 跨平台身份 v0.5 |
| 关系 | 多维/方向/情境/历史/修复/群成员网络 | `relationships.js`, `groups.js` | I/T | 复杂网络 v0.5 |
| 人格 | 12 维特质、价值/边界、风格、慢演化、锁定/重置 | `persona.js` | I/T | — |
| 情绪 | OCC 评价、PAD/离散/心境/压力/疲劳、惯性/衰减/调节/复发 | `emotion.js` | I/T | 表达细化 v0.5 |
| 多时间尺度 | 长期/中期/短期/瞬时状态分离与耦合 | `persona/emotion/relationship` | I/T | 长期验证 v1 |
| 记忆 | 工作/情景/语义/程序/情绪/人物/经验；关联；检索；巩固；遗忘；重激活 | `memory/**` | I/T | 向量 seam v0.5 |
| 认知 | 情境、信念/推测/未知、目标、规划、决策、执行、反馈、元认知 | `context/pipeline/beliefs/metacognition` | I/T | 更深推理 v0.5 |
| 未知 | 缺口检测、类型、持久化、生命周期、优先级 | `unknown.js` | I/T | — |
| 学习 | 计划、来源、证据、验证、claims、应用、复核、预算 | `learning/**`, `sources.js` | I/T | 多源 v0.5 |
| 多模态 | 图片/语音/视频检测与受限声明 | `normalize.js` | I/L | 理解 v0.5 |
| 技能 | 状态、习得、迁移、退化、恢复、组合 | `skills.js` | I/T | 组合 v0.5 |
| 经验/信念 | 经验循环、修正、习惯、复发 | `beliefs.js`, `skills.js` | I/T | — |
| 策略 | 候选、效用、风险、沉默、上下文 bandit、结果归因 | `policy/**` | I/T | — |
| 专项行为 | 普通/群聊/撤回/调侃/关心/澄清/冲突修复/主动 | `policy/candidates.js`, `proactivity.js` | I/T | 更多分支 v0.5 |
| 主动 | 时机、关系、预算、安静时段、退避 | `proactivity.js` | I/T | — |
| 插件/能力 | 知识源/动作/索引注册、版本/权限/隔离 | `capabilities.js` | I/T | 外部插件 v0.5 |
| 可观测 | trace、metrics、审计、导出/删除、暂停 | `metrics/traces/api` | I/T | 图形化 v0.5 |
| 安全/隐私 | scope/sensitivity、私聊隔离、secret 剔除、预算、注入防护、删除 | `privacy.js`, `store` | I/T | 审计报告 v1 |
| UI | 认知状态/人格/人物/关系/记忆/情绪/策略/学习/技能/元认知/设置 | `client.js` fragments | I/T | 可视化 v0.5 |
| 长期 | 10k 事件模拟、DB/延迟/成本、迁移/备份/恢复 | `scripts/cognition-sim.mjs` | I/T | v1 长期 |

## 能力扩展原则

- 新增感知/执行/知识源通过注册接口，不 fork 内核。
- 每个能力有 `version`、`availability`、`permissions`、`limits`；不可用显式 `L`/degraded。
- 能力缺口进入 `unknowns`/capability gaps UI；运行时不自安装。
