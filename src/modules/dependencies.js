// 只分析目录，不导入代码。环上的节点 error，环的下游在运行协调阶段 blocked。
export function analyzeDependencies(records) {
  const errors = new Map()
  const compare = (a, b) => Number(records.get(b).builtin) - Number(records.get(a).builtin) || (a < b ? -1 : a > b ? 1 : 0)
  let index = 0
  const indices = new Map(), low = new Map(), stack = [], stacked = new Set()
  function visit(id) {
    indices.set(id, index); low.set(id, index++)
    stack.push(id); stacked.add(id)
    const record = records.get(id)
    for (const dep of record.requires) {
      if (!records.has(dep)) { errors.set(id, `缺少依赖：${dep}`); continue }
      if (!indices.has(dep)) { visit(dep); low.set(id, Math.min(low.get(id), low.get(dep))) }
      else if (stacked.has(dep)) low.set(id, Math.min(low.get(id), indices.get(dep)))
    }
    if (low.get(id) === indices.get(id)) {
      const group = []
      let member
      do { member = stack.pop(); stacked.delete(member); group.push(member) } while (member !== id)
      if (group.length > 1) {
        const message = `依赖循环：${group.sort().join(', ')}`
        for (const member of group) errors.set(member, message)
      }
    }
  }
  for (const id of records.keys()) if (!indices.has(id)) visit(id)
  // 错误节点视为已处理，使其下游仍按依赖顺序检查并获得 blocked。
  const order = [...errors.keys()].sort(compare)
  const done = new Set(order)
  while (done.size < records.size) {
    const ready = [...records.keys()].filter((id) => !done.has(id) && records.get(id).requires.every((dep) => !records.has(dep) || done.has(dep))).sort(compare)
    if (!ready.length) throw new Error('模块依赖图无法排序')
    const id = ready[0]
    order.push(id); done.add(id)
  }
  return { order, errors }
}

export function dependentClosure(records, ids) {
  const result = new Set(ids)
  let changed = true
  while (changed) {
    changed = false
    for (const [id, record] of records) if (!result.has(id) && record.requires.some((dep) => result.has(dep))) {
      result.add(id); changed = true
    }
  }
  return result
}
