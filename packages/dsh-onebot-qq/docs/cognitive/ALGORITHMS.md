# 算法规范（ALGORITHMS）

> 每个算法按统一字段描述；参数全部在 `config.cognition` 中可配置，测试须覆盖边界/降级。  
> 记号：`t` 当前时间，`Δt` 自上次更新时间，`clamp(x,a,b)`。

## A1 轮次聚合 `turn.js`

- 问题：把同一人短时间连续消息合成一个会话轮次，避免逐条回复。
- 依据：会话分析话轮边界 + 本地启发式（不调用 LLM）。
- 输入：raw message（已持久化）、历史消息节奏、是否被点名、群/私聊。
- 状态：每 `(chat_type, chat_id, sender_id)` 一个 buffer；`message_ids`、`first_at`、`last_at`、`soft_deadline`、`hard_deadline`、`features`、`status`。
- 计算：
  - `c=clamp(0.5+Σw_i,0,1)`，特征权重见计划 4.1（终止标点 +.2，未完成词 −.3，短文本 −.15，点名 +.2，续发 −.2，独立指令 +.25…）。
  - `soft=clamp(1.8+(1-c)*4.5+(len<8?1.2:0)+(addressed?0.6:0)+habitAdj,1.2,8.0)` 秒。
  - `hard=clamp(soft+2,8,10)` 秒；命令 fast path 300ms。
  - 新消息重置 soft，不重置 hard；hard 到期强制关闭。
- 输出：`close_reason ∈ deadline|terminal|command|cancel|recall|restart`；turn 带消息 id 列表。
- 不确定：个人节奏只做 ±1.5s 修正；不因历史无限等待。
- 学习：更新发送者碎片率/中位间隔（指数平滑，慢）。
- 持久化：open turn 表；重启按 hard 关闭。
- 失败：不丢 raw；聚合失败标记并让注意力按单条处理。
- 成本：O(1)/消息；测试：P95 延迟、重复回复率、提前截断率。

## A2 注意力 `attention.js`

- 输入：事件、是否点名、关系快照、群规模/floor、未完成话题、命令/紧急词、近期忽略。
- 分数：`z = β0 + Σβ_i x_i`，`s=logistic(z)`；权重默认见计划 4.2。
- 阈值：ignore<.25；store .25–.55；consider ≥.55；immediate ≥.85。
- 群 floor：他人对话且未点名 → −.25；点名/回复 → +.35。
- 输出：`ignore|store|consider|immediate` + 原因。
- 竞争：同会话按 `s + waiting_bonus` 排序；全局每 60s 处理上限；饥饿保护。
- 失败：无 LLM 仍可运行。

## A3 人格 `persona.js`

- 状态 12 维 [0.1,0.9] + 风格/价值/锁定。
- 初始值配置；显式用户编辑优先。
- 演化：仅当多次一致长期证据；`v'=clamp(v+sign*Δ，[lo,hi])`，Δ≤0.005/日；记录 reason/history。
- 输出：策略先验与生成风格约束。
- 测试：单次事件不剧变；边界；锁定；重置。

## A4 情绪 `emotion.js`

- appraisal：相关/期望/主体/控制/规范/确定性/新颖 → Δvalence/arousal/dominance/stress。
- 离散映射：喜悦/悲伤/愤怒/恐惧/焦虑/惊讶/骄傲/羞耻/感激/羡慕/失望/平静。
- 更新：`x'=clamp(x+Δ- decay, -1,1)`；衰减 `x(t)=baseline+(x0-baseline)e^{-Δt/τ}`；半衰期 valence 120m、arousal 30m、stress 360m、mood 480m。
- 调节：内部强度与可见表达分离；疲劳/压力降低 effective skill，不降低安全。
- 影响：wait/风险/主动性/表达长度/调侃边界。
- 测试：衰减、惯性、极端值、恢复、情绪一致性召回。

## A5 关系 `relationships.js`

- 维度：affinity/familiarity/trust/intimacy/respect/wariness/conflict/comfort/initiative/stability。
- 更新：`v'=v + lr*src*(target-v)*inertia*ctx`；trust/intimacy 慢；conflict 升快降慢；repair 需反向证据累积。
- 作用域合并：当前群/私聊加权；全局仅作背景。
- 历史：每次关键变化写 relationship_events。
- 测试：方向性、单次互动、冲突/修复、作用域、边界。

## A6 记忆检索 `memory/retrieval.js`

- 编码：turn→episodic；salience/importance；source ids。
- 关联：共同人物/话题/情绪/行为/结果；2 跳激活，每跳 ×0.5。
- 分数：`0.30 recency + 0.25 importance + 0.25 relevance + 0.10 emotion + 0.05 relationship + 0.05 association`。
- 过滤：scope/sensitivity/时间/类型；私聊隔离；dedupe/MMR。
- 输出：topK=8，≤4k 字符；每条带来源/时间/置信度。
- 巩固：簇摘要为 semantic；保留 sources；inactive 冷存。
- 遗忘：权重/稳定性衰减；检索成功强化；不删除。
- 测试：命中率、隔离、删除、遗忘≠删除、重启。

## A7 信念/未知 `beliefs.js` / `unknown.js`

- 信念：`logit(p')=logit(p)+Σw_i evidence_i`，clamp [0.02,0.98]；冲突保留 disputed。
- 未知触发：LLM 置信<.45、检索空、新实体、用户纠正、重复提问、能力缺失、知识矛盾。
- 优先级：`p = relevance*recurrence*curiosity*expected_gain/(cost+risk)`，clamp。
- 学习任务：最多 3 子问题，TTL 24h，预算/并发/重试上限。
- 输出：gap/task/claim。

## A8 策略 `policy/utility.js`

- 候选动作及前置条件见计划 4.8。
- `U = w_goal g + w_rel r + w_emo e + w_persona p + w_curiosity i + w_habit h - w_risk R - w_norm N - w_cost C - w_fatigue F`。
- `P(reply)=logistic(U)`；阈值：reply .52/wait .38/silence .30；点名/私聊 −.15，群聊 +.10。
- 选择：先硬门控（权限/频率/隐私/风险），再效用；ε=.04 仅低风险。
- bandit：每个 `(action, context_bucket)` Beta(1,1)；reward∈[-1,1]；更新 α/β；新情境先探索。
- 结果：观察窗口 2 turns/10min；归因 confidence；单次成功不永久。
- 测试：反馈修正、阈值、预算、无操纵/隐私、策略-结果分离。

## A9 技能 `skills.js`

- 初始 base mastery；effective = base*(0.5+0.5*(1-stress))，压力可调。
- 成功 `m+=α(1-m)`；失败 `m-=β*m`；不用 `m*=e^{-Δt/τ}`；恢复 `m+=ρ(baseline-m)`。
- 迁移：transfer_map 加权，不机械同步。
- 作用：策略权重/表达约束/检索深度；不是只显示。
- 测试：增长/退化/恢复、压力、迁移、边界。

## A10 学习 `learning/`

- 任务状态机 pending→running→done/failed/cancelled；重试上限；幂等。
- 证据：URL/标题/时间/摘录/hash/可靠性；独立来源计数。
- 验证：≥2 独立域名，或 1 高可信主源 + 明确标注；冲突→disputed。
- claim：concept/claim/definition/citations/confidence/validity；无支持的引用拒绝。
- 应用：检索返回 claims（带 confidence），Composer 只可使用 active 且未过期；不向用户伪造引用。
- 测试：无来源保持 unknown、多源、冲突、预算、注入、复核。

## A11 元认知 `metacognition.js`

- 校准：Brier score；低置信/高冲突 → 澄清/沉默。
- 自评：策略 reward 偏差、检索命中、来源可靠性、技能趋势、能力缺口。
- 反思：周期 bounded insight（JSON），不改代码/权限。
- 测试：重复失败被识别；缺证据不自信；UI 指标。

## A12 主动行为 `proactivity.js`

- 候选：未完话题、关系主动、好奇心、检查-in。
- 门槛：开关、安静时段、关系 familiarity/initiative、日预算、上次无回应退避、群聊默认 0。
- 决策复用策略引擎；动作入队→发送→观察→更新。
- 测试：预算、安静时段、退避、opt-out、不骚扰。
