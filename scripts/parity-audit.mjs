import { readdirSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const statuses = ['has', 'partial', 'none', 'limited', 'leading']
const header = ['#', '能力', 'Aurabot', 'dsh-bot', '状态', '目标']

// Pipes in inline code (including multi-backtick spans) and escaped pipes are cells' content.
function cells(line) {
  const parts = []
  let cell = '', ticks = 0
  const text = line.trim().replace(/^\|/, '').replace(/\|\s*$/, '')
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '\\' && i + 1 < text.length) { cell += text[i] + text[++i]; continue }
    if (char === '`') {
      const run = /^`+/.exec(text.slice(i))[0]
      if (!ticks) ticks = run.length
      else if (ticks === run.length) ticks = 0
      cell += run; i += run.length - 1
    } else if (char === '|' && !ticks) { parts.push(cell.trim()); cell = '' }
    else cell += char
  }
  parts.push(cell.trim())
  return parts
}

function normalizeStatus(status) {
  if (status.includes('部分')) return 'partial'
  if (status.includes('受限')) return 'limited'
  if (status.includes('无')) return 'none'
  if (status.includes('领先')) return 'leading'
  if (status.includes('有')) return 'has'
  return null
}

/** Return matrix rows, retaining malformed entries as { line, raw, error } for audit. */
export function parseMatrix(markdown) {
  const rows = []
  let section = '', table = false, foundHeader = false, fenced = false
  const bad = (line, raw, error) => rows.push({ line, raw, error })
  for (const [index, raw] of markdown.split(/\r?\n/).entries()) {
    const text = raw.trim(), line = index + 1
    if (/^(`{3,}|~{3,})/.test(text)) { fenced = !fenced; continue }
    if (fenced) continue
    if (/^#{1,6}\s/.test(text)) {
      section = /^###\s+(3\.\d+)\b/.exec(text)?.[1] || ''
      table = false
      continue
    }
    if (!section || !text.startsWith('|')) { table = false; continue }
    const values = cells(text)
    if (values[0] === '#') {
      table = true
      foundHeader = true
      if (values.length !== 6 || values.some((value, i) => value !== header[i])) bad(line, raw, '矩阵表头必须为 # / 能力 / Aurabot / dsh-bot / 状态 / 目标')
      continue
    }
    if (values.every((value) => /^:?-+:?$/.test(value))) continue
    if (!table) { bad(line, raw, '3.x 矩阵行缺少表头'); continue }
    if (values.length !== 6) { bad(line, raw, `矩阵行应有 6 列，实际 ${values.length} 列`); continue }
    const [id, capability, aurabot, dshBot, rawStatus, target] = values
    const status = normalizeStatus(rawStatus)
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)) || !capability || !aurabot || !dshBot || !status) {
      bad(line, raw, '矩阵行编号、能力、实现说明或状态不合法')
      continue
    }
    rows.push({ id: Number(id), capability, aurabot, dshBot, status, rawStatus, target, section, line })
  }
  if (!foundHeader) bad(0, '', '未找到 3.x 能力矩阵表头')
  else if (!rows.some((row) => !row.error)) bad(0, '', '能力矩阵没有有效数据行')
  return rows
}

export function summarize(rows) {
  const valid = rows.filter((row) => !row.error)
  const byStatus = Object.fromEntries(statuses.map((status) => [status, 0]))
  const ids = new Map()
  for (const row of valid) {
    byStatus[row.status]++
    ids.set(row.id, (ids.get(row.id) || 0) + 1)
  }
  const remaining = valid.filter((row) => row.status !== 'has')
    .map(({ id, capability, status, target }) => ({ id, capability, status, target }))
  const missingTargets = remaining.filter((row) => !row.target.replace(/[*_`\s—–-]/g, ''))
  const duplicateIds = [...ids].filter(([, count]) => count > 1).map(([id]) => id)
  const malformedRows = rows.filter((row) => row.error)
  return { total: valid.length, byStatus, duplicateIds, malformedRows, missingTargets, remaining,
    ok: duplicateIds.length === 0 && malformedRows.length === 0 && missingTargets.length === 0 }
}

function filesUnder(dir, accept) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const file = join(dir, entry.name)
    return entry.isDirectory() ? filesUnder(file, accept) : entry.isFile() && accept(entry.name) ? [file] : []
  })
}

// Count physical lines, including a final unterminated line; empty files have zero lines.
function lines(text) { return text ? text.split('\n').length - Number(text.endsWith('\n')) : 0 }

export function countSource(root) {
  const files = filesUnder(join(root, 'src'), (name) => name.endsWith('.js'))
  return { files: files.length, lines: files.reduce((sum, file) => sum + lines(readFileSync(file, 'utf8')), 0) }
}

export function countTests(root) {
  const files = filesUnder(join(root, 'test'), (name) => name.endsWith('.test.js'))
  const texts = files.map((file) => readFileSync(file, 'utf8'))
  return { files: files.length, lines: texts.reduce((sum, text) => sum + lines(text), 0),
    cases: texts.reduce((sum, text) => sum + [...text.matchAll(/^test(?:\.\w+)?\(/gm)].length, 0) }
}

export function formatReport(result) {
  const { total, byStatus, remaining, duplicateIds, malformedRows, missingTargets, source, tests } = result
  const report = [
    '# 对标审计（并非全量对齐 / not full parity）', '',
    `矩阵 ${total} 项；${statuses.map((status) => `${status}: ${byStatus[status]}`).join('，')}。`,
    `剩余 ${remaining.length} 项（所有非 has 项，包括领先项；不等于缺失功能数）。`,
  ]
  if (source) report.push(`源码：${source.files} 个 JS 文件 / ${source.lines} 行。`)
  if (tests) report.push(`测试静态计数：${tests.files} 个文件 / ${tests.lines} 行 / ${tests.cases} 个顶层 test 声明；包含 skip，不代表执行结果。`)
  report.push('', `结构检查：${result.ok ? '通过' : '失败'}；重复编号 ${duplicateIds.length}，格式错误 ${malformedRows.length}，非 has 缺目标 ${missingTargets.length}。`)
  if (duplicateIds.length) report.push(`- 重复编号：${duplicateIds.join(', ')}`)
  for (const row of malformedRows) report.push(`- 第 ${row.line} 行：${row.error}`)
  for (const row of missingTargets) report.push(`- #${row.id} ${row.capability}：缺少目标（当前：${row.target || '空'}）`)
  // Rows with no milestone token stay visible in an explicit unassigned group.
  const groups = new Map()
  for (const row of remaining) {
    const milestone = /^M[1-7]\b/.test(row.target)
      ? row.target.match(/\bM[1-7](?:-[a-z])?\b/g).join(' / ')
      : '未分配里程碑'
    if (!groups.has(milestone)) groups.set(milestone, [])
    groups.get(milestone).push(row)
  }
  for (const [milestone, rows] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    report.push('', `## ${milestone}`, '', '| # | 能力 | 状态 | 目标 |', '|---|---|---|---|')
    for (const row of rows) report.push(`| ${row.id} | ${row.capability} | ${row.status} | ${row.target} |`)
  }
  return report.join('\n') + '\n'
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(import.meta.dirname, '..')
  const result = { ...summarize(parseMatrix(readFileSync(join(root, 'docs/research/GAP-AURABOT.md'), 'utf8'))),
    source: countSource(root), tests: countTests(root) }
  process.stdout.write(process.argv.includes('--json') ? JSON.stringify(result, null, 2) + '\n' : formatReport(result))
  process.exitCode = result.ok ? 0 : 1
}
