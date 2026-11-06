import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseMatrix, summarize, countSource, countTests, formatReport } from '../scripts/parity-audit.mjs'

const header = '| # | 能力 | Aurabot | dsh-bot | 状态 | 目标 |\n|---|---|---|---|---|---|'
const matrix = (...rows) => `## 3. 能力矩阵\n### 3.1 连接\n${header}\n${rows.join('\n')}\n## 4. 其他\n| 999 | 不计 | 有 | 有 | 有 | — |`
const row = (id, status = '有', target = '—') => `| ${id} | 能力 ${id} | 有 | 实现 | ${status} | ${target} |`
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'parity-audit-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (path, text) => {
    const file = join(root, path)
    mkdirSync(resolve(file, '..'), { recursive: true })
    writeFileSync(file, text)
  }
  return { root, put }
}

test('parity: parse only section 3.x matrices, preserve metadata and code-span pipes', () => {
  const input = matrix('| 1 | 媒体 | 有 | `/media/status|test|tts` 和 ``a`|b`` 及 a\\|b | **有** | — |')
  const rows = parseMatrix(input.replaceAll('\n', '\r\n'))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 1)
  assert.equal(rows[0].section, '3.1')
  assert.match(rows[0].dshBot, /status\|test\|tts/)
  assert.equal(rows[0].status, 'has')
  assert.equal(rows[0].target, '—')
  assert.equal(summarize(rows).ok, true)
  assert.deepEqual(parseMatrix(input), rows)
})

test('parity: statuses normalize with partial/limited before none, leading and has', () => {
  const variants = ['**有**（M1）', '部分（受限是许可要求）', '**无**', '**受限实现**', '领先（但无媒体）', '**领先**']
  // The explicit priority treats 无 inside the annotation as none.
  const summary = summarize(parseMatrix(matrix(...variants.map((status, i) => row(i + 1, status, 'M7')))))
  assert.deepEqual(summary.byStatus, { has: 1, partial: 1, none: 2, limited: 1, leading: 1, exempt: 0 })
  assert.equal(summary.total, 6)
  assert.equal(summary.remaining.length, 5)
  assert.equal(summary.ok, true)
})

test('parity: leading annotation without 无 keeps leading status; missing target includes leading', () => {
  const summary = summarize(parseMatrix(matrix(row(1, '领先（隔离深度）'), row(2, '部分', ''), row(3, '受限', '**—**'))))
  assert.equal(summary.byStatus.leading, 1)
  assert.deepEqual(summary.missingTargets.map((r) => r.id), [1, 2, 3])
  assert.deepEqual(summary.remaining[0], { id: 1, capability: '能力 1', status: 'leading', target: '—' })
  assert.equal(summary.ok, false)
})

test('parity: duplicate IDs across matrices are structural errors', () => {
  const summary = summarize(parseMatrix(`${matrix(row(1))}\n### 3.2 运行时\n${header}\n${row(1, '部分', 'M1')}`))
  assert.equal(summary.total, 2)
  assert.deepEqual(summary.duplicateIds, [1])
  assert.equal(summary.ok, false)
})

test('parity: malformed columns, IDs, fields and unknown statuses stay visible', () => {
  const summary = summarize(parseMatrix(matrix(row(1), '| 2 | 缺列 |', row('bad'), row(3, '待确认'), '| 4 | | 有 | 实现 | 有 | — |')))
  assert.equal(summary.total, 1)
  assert.equal(summary.malformedRows.length, 4)
  assert.ok(summary.malformedRows.every((r) => r.line > 0 && r.raw && r.error))
  assert.equal(summary.ok, false)
})

test('parity: missing/empty/malformed headers fail, code fences do not supply matrices', () => {
  for (const input of ['', `### 3.1 示例\n\`\`\`md\n${header}\n${row(1)}\n\`\`\``, matrix(), matrix(row(1)).replace('Aurabot', '错误表头'), `### 3.1 示例\n${row(1)}`]) {
    assert.equal(summarize(parseMatrix(input)).ok, false, input)
  }
})

test('parity: source counts recurse through JS only, count unterminated lines, ignore symlinks', (t) => {
  const { root, put } = fixture(t)
  assert.deepEqual(countSource(root), { files: 0, lines: 0 })
  put('src/main.js', 'one\ntwo\n')
  put('src/nested/other.js', 'one\r\ntwo')
  put('src/empty.js', '')
  put('src/ignored.mjs', 'ignored\n')
  put('outside.js', 'ignored\n')
  symlinkSync(join(root, 'outside.js'), join(root, 'src/link.js'))
  symlinkSync(join(root, 'src'), join(root, 'src/loop'), 'dir')
  assert.deepEqual(countSource(root), { files: 3, lines: 4 })
})

test('parity: test counts use the exact anchored declaration regex, not execution or skip totals', (t) => {
  const { root, put } = fixture(t)
  assert.deepEqual(countTests(root), { files: 0, lines: 0, cases: 0 })
  put('test/main.test.js', ['test("a", () => {})', 'test.skip("b", () => {})', 'test.todo("c")', '  test("nested", () => {})', '// test("comment")', 'test.only("d", () => {})'].join('\n'))
  put('test/nested/other.test.js', 'test("e", () => {})\n')
  put('test/helpers/helper.js', 'test("ignored", () => {})\n')
  assert.deepEqual(countTests(root), { files: 2, lines: 7, cases: 5 })
})

test('parity: report includes counts, structural problems and milestone groups without claiming parity', () => {
  const result = { ...summarize(parseMatrix(matrix(row(1), row(2, '部分', 'M2/M4'), row(3, '领先'), row(1), row(4, '无', '明确不在 M6-a/M6-b 范围')))), source: { files: 1, lines: 2 }, tests: { files: 1, lines: 3, cases: 4 } }
  const report = formatReport(result)
  assert.match(report, /not full parity/)
  assert.match(report, /重复编号：1/)
  assert.match(report, /#3.*缺少目标/)
  assert.match(report, /## M2 \/ M4/)
  assert.match(report, /## 未分配里程碑/)
  assert.doesNotMatch(report, /## M6/)
  assert.match(report, /包含 skip，不代表执行结果/)
  assert.match(report, /源码：1 个 JS 文件 \/ 2 行/)
})

test('parity: CLI JSON shape and exit code distinguish remaining gaps from structural errors', (t) => {
  const { root, put } = fixture(t)
  put('scripts/parity-audit.mjs', readFileSync(new URL('../scripts/parity-audit.mjs', import.meta.url), 'utf8'))
  const run = (...args) => spawnSync(process.execPath, [join(root, 'scripts/parity-audit.mjs'), ...args], { encoding: 'utf8' })
  put('docs/research/GAP-AURABOT.md', matrix(row(1), row(2, '部分', 'M7')))
  const json = run('--json')
  assert.equal(json.status, 0, json.stderr)
  const result = JSON.parse(json.stdout)
  assert.deepEqual(Object.keys(result).sort(), ['total', 'byStatus', 'duplicateIds', 'malformedRows', 'missingTargets', 'remaining', 'ok', 'source', 'tests'].sort())
  assert.equal(result.total, 2)
  assert.equal(result.remaining.length, 1)
  assert.deepEqual(result.source, { files: 0, lines: 0 })
  assert.deepEqual(result.tests, { files: 0, lines: 0, cases: 0 })
  assert.match(run().stdout, /对标审计/)
  for (const input of [matrix(row(1), row(1)), matrix(row(1, '部分')), matrix('| 1 | broken |')]) {
    put('docs/research/GAP-AURABOT.md', input)
    const failure = run('--json')
    assert.equal(failure.status, 1, failure.stderr)
    assert.equal(JSON.parse(failure.stdout).ok, false)
  }
})

test('parity: user exemptions count separately, leave remaining and still require targets', () => {
  const rows = parseMatrix(matrix(row(1, '豁免（用户批准）', '2026-11-06 用户批准：远端 API 鉴权'), row(2, '有'), row(3, '无', 'M7')))
  const result = summarize(rows)
  assert.equal(result.byStatus.exempt, 1)
  assert.equal(parseMatrix(matrix(row(1, '无（未获豁免）', 'M7')))[0].status, 'none')
  assert.equal(parseMatrix(matrix(row(1, '**豁免**（用户批准）', '2026-11-06')))[0].status, 'exempt')
  assert.deepEqual(result.remaining.map((r) => r.id), [3])
  assert.equal(result.ok, true)
  assert.match(formatReport(result), /exempt: 1/)
  assert.match(formatReport(result), /排除 has\/exempt/)
  for (const target of ['', '—', '**—**']) {
    const invalid = summarize(parseMatrix(matrix(row(1, '豁免（用户批准）', target))))
    assert.equal(invalid.ok, false)
    assert.deepEqual(invalid.missingTargets.map((r) => r.id), [1])
    assert.equal(invalid.remaining.length, 0)
  }
})
