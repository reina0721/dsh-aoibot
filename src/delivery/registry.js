/** Internal registry. The module kernel enforces source and permissions. */
export function createDeliveryRegistry() {
  const planners = new Map()

  function register(descriptor) {
    if (!descriptor || typeof descriptor.id !== 'string' || !descriptor.id.trim()) throw new Error('交付 planner 需要 id')
    if (planners.has(descriptor.id)) throw new Error('交付 planner id 重复')
    if (descriptor.stage !== 'format') throw new Error('未知交付规划 stage')
    if (resolve(descriptor.stage)) throw new Error('交付规划 stage 已注册')
    const order = descriptor.order ?? 0
    if (!Number.isFinite(order) || typeof descriptor.plan !== 'function') throw new Error('交付 planner 需要有效 order 和 plan 函数')
    const planner = Object.freeze({ id: descriptor.id, stage: descriptor.stage, order, plan: descriptor.plan })
    planners.set(planner.id, planner)
    // An old disposer must never remove a later registration with the same id.
    return () => planners.get(planner.id) === planner && remove(planner.id)
  }

  function resolve(stage = 'format') {
    return [...planners.values()].find((planner) => planner.stage === stage) || null
  }

  function remove(id) { return planners.delete(id) }
  function list() { return [...planners.values()] }

  return Object.freeze({ register, resolve, remove, list })
}
