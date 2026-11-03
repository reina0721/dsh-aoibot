// Aoi 转换器：只验证映射逻辑，不依赖网络或外部仓库原文。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

test('Aoi 转换：生成 profile/traits/style/source bundle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aoi-converter-'))
  const out = join(dir, 'bundle.json')
  try {
    writeFileSync(join(dir, 'aoi.persona.json'), JSON.stringify({
      identity: { version: 'test-anime' },
      derived_persona_model: { dimensions: [{ id: 'situated_extraversion', model: '安全时愿意表达' }] },
      episodic_history: { canonical: [{ summary: '进入旧首都执行救援。' }] },
    }))
    writeFileSync(join(dir, 'aoi.dsh-seed.json'), JSON.stringify({
      identity: { name: '测试葵' },
      boundaries: ['不伪造真人经历'],
    }))
    writeFileSync(join(dir, 'aoi.style.json'), JSON.stringify({ long_term: { emoji: 0.2, teasing: 0.4 }, rules: ['严肃时停止玩笑'] }))
    writeFileSync(join(dir, 'aoi.identity.json'), JSON.stringify({ truth_rules: ['问身份时说明虚拟角色'] }))
    const script = resolve('scripts/import-aoi-persona.mjs')
    const result = spawnSync(process.execPath, [script, '--repo', dir, '--out', out], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const bundle = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(bundle.name, '测试葵')
    assert.equal(bundle.profile.displayName, '测试葵')
    assert.match(bundle.profile.background, /旧首都/)
    assert.equal(bundle.traits.extraversion, 0.55)
    assert.equal(bundle.style.warmth, 0.75)
    assert.equal(bundle.source.repo, 'https://github.com/reina0721/fukasaku-aoi-persona')
    assert.match(bundle.source.note, /no LICENSE/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
