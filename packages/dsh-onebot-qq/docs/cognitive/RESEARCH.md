# 跨学科研究与算法映射（RESEARCH）

> 本文件只记录**被采用/被评估**的理论，不罗列名词。每项映射到：行为 → 输入 → 状态 → 算法 → 数据 → 模块 → 验证。  
> 说明：引用为经典文献与公开工程论文；未在项目内重复实验前，不把理论当作已验证事实。

## 1. 认知架构层

| 理论/系统 | 采用点 | 映射 |
|---|---|---|
| ACT-R（Anderson, 2007） | 模块化缓冲、激活值、程序性/陈述性记忆分离 | 工作记忆槽、记忆激活值、技能与语义记忆分表 |
| Soar（Laird, 2012） | 问题空间/候选算子/冲突消解 | 候选动作生成 + 效用/策略选择 |
| 双过程理论（Kahneman, 2011） | 本地快速启发式 + LLM 深度路径 | `attention`/`turn` 本地算法；复杂语义才调用 LLM |
| 预测加工/评价理论 | 期望违背驱动情绪与注意 | appraisal 的 expectation/novelty 维度 |

**边界**：不模拟生物神经元；ACT-R 的激活公式只作为检索权重设计参考，不声称实现 ACT-R。

## 2. 会话与语用

| 理论 | 采用点 | 映射 |
|---|---|---|
| 会话分析/话轮转换（Sacks, Schegloff & Jefferson, 1974） | 轮次边界、话轮分配、沉默意义 | `turn` 聚合、群聊 floor、`wait/silence` 动作 |
| Grice 合作原则（1975） | 量/质/关联/方式 | 回复长度、澄清、避免编造 |
| 语用学/反讽/暗示 | 字面义与意图分离 | LLM 结构化 intent + 本地风险门控 |
| 信息缺口理论（Loewenstein, 1994） | 好奇心/未知优先 | unknown priority、学习调度 |

**边界**：中文口语/网络梗的完整性判断以本地启发式 + 数据学习为主，不假设通用规则；所有阈值可配置并有测试。

## 3. 人格与情绪

| 理论 | 采用点 | 映射 |
|---|---|---|
| Big Five（Goldberg, 1990） | 稳定特质维度 | `persona_state.traits`（12 维扩展：幽默/主动/谨慎等） |
| OCC 评价模型（Ortony, Clore & Collins, 1988） | 事件评价 → 离散情绪 | `emotion` appraisal 维度与 12 类离散情绪 |
| PAD 情感空间（Mehrabian, 1996） | 连续情绪坐标 | valence/arousal/dominance + mood |
| 情绪调节过程模型（Gross, 1998） | 内部强度 vs 表达抑制 | `regulation` 参数与表达约束 |
| 社会渗透理论（Altman & Taylor, 1973） | 关系由浅入深、互惠 | familiarity/intimacy 慢变量与历史 |

**边界**：人格演化是慢变量，单次互动不改变；情绪是模拟状态，UI 明确标注，不声称主观体验。

## 4. 记忆与学习

| 理论/工程 | 采用点 | 映射 |
|---|---|---|
| 艾宾浩斯遗忘曲线（1885）/ FSRS 思路 | 稳定性、检索强化、遗忘非删除 | `memory.stability`、检索半衰期 |
| 扩散激活（Collins & Loftus, 1975） | 关联网络、多跳召回 | `memory_links` + 2 跳激活 |
| 记忆巩固/再巩固（McGaugh, 2000） | 重要事件巩固为语义；检索后更新 | consolidation worker、access 强化 |
| 贝叶斯信念更新 | 事实/推测/冲突的置信度 | `beliefs.probability` logit 更新 |
| Generative Agents（Park et al., 2023） | memory stream + retrieval + reflection | 情景记忆/重要性/反思，但状态独立存储 |
| MemGPT（Packer et al., 2023） | 分层记忆/上下文预算 | working memory + retrieval budget |
| Mem0 / A-MEM（2024–2025） | 记忆抽取/关联/更新 | extraction/consolidation seam，不依赖其服务 |
| Reflexion（Shinn et al., 2023） | 经验反思但不改代码 | 元认知 insight，仅写 bounded 状态 |
| Voyager（Wang et al., 2023） | 技能库/可组合技能 | `skills` + transfer_map |

**边界**：默认 lexical+FTS+关联图，不假设有向量模型；embedding 是可选 seam，未配置时明确 `lexical-only`。

## 5. 决策与学习

| 理论 | 采用点 | 映射 |
|---|---|---|
| 期望效用/风险权衡 | 候选动作打分 | `policy/utility.js` |
| 上下文多臂老虎机（Li et al., 2010） | 情境化策略学习 | `policies` Beta 后验 |
| 信用分配/延迟反馈 | 结果观察与归因 | `outcomes` + attribution confidence |
| 强化学习（谨慎采用） | 不用端到端 RL 改模型；只更新策略后验 | 有界、可解释、可重置 |
| 刻意练习/技能习得（Fitts & Posner, 1967） | 熟练度、退化、恢复 | `skills` 增长/衰减/恢复 |

**边界**：不做操纵性反馈收集；不为了学习故意打扰；不把单次反馈当永久策略。

## 6. 社会关系与群体

| 理论 | 采用点 | 映射 |
|---|---|---|
| 社会交换/互惠 | 关系多维更新 | relationship update |
| 社会认同/群体行为 | 群氛围、角色、floor | group context/attention |
| 心智理论（Premack & Woodruff, 1978） | 区分「我知道」与「对方知道」 | belief scope、third-party hypothesis |
| 隐私边界（Altman） | 私聊/群聊隔离 | scope/sensitivity |

**边界**：第三方关系只能是带来源的假设，不写成事实；不推断敏感属性。

## 7. 工程参考

- DSH `ctx.llm` / `ctx.web` / `ctx.agentDefaultModel` / `ctx.provide` 契约（见 DSH 文档）。
- 事件溯源、WAL、FTS5、上下文预算、熔断/降级。
- 评测：场景回放、反事实、长跑模拟；不以「看起来像人」作为有效性证据。

## 8. 验证要求

每项算法必须有：
1. 可复现输入/状态夹具；2. 单元测试；3. 场景/集成测试；4. 指标阈值；5. 失败/降级路径；6. 参数说明与适用范围；7. 成本估计；8. 版本/迁移。

未达到以上任一项，覆盖矩阵状态最高为「已设计」。
