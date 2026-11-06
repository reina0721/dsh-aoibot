import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStickerService } from '../src/media/stickers.js'

function harness(dir, stickers = {}) {
  const config = { media: { stickers: { enabled: true, maxBytes: 1024, maxCount: 2, ...stickers } } }
  return createStickerService({ dataDir: dir, getConfig: () => config })
}

test('表情包：导入、hash 去重、列表、标签、随机选择与删除', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-stickers-'))
  try {
    const service = harness(dir)
    const first = await service.importBuffer(Buffer.from('png-one'), { name: '开心.png', mime: 'image/png', tags: ['开心'] })
    const duplicate = await service.importBuffer(Buffer.from('png-one'), { name: 'duplicate.png', mime: 'image/png' })
    assert.equal(duplicate.id, first.id)
    assert.equal((await service.status()).count, 1)
    assert.equal('path' in first, false)
    assert.equal('file' in first, false)

    const tagged = await service.updateTags(first.id, ['开心', '猫'])
    assert.deepEqual(tagged.tags, ['开心', '猫'])
    assert.equal((await service.list({ query: '猫' })).length, 1)
    assert.equal((await service.list({ tag: '开心' }))[0].id, first.id)
    assert.equal((await service.pick({ tag: '猫' })).id, first.id)
    const file = await service.fileFor(first.id)
    assert.equal(file.mime, 'image/png')
    assert.equal(file.size, 7)

    assert.equal(await service.remove(first.id), true)
    assert.equal(await service.fileFor(first.id), null)
    assert.deepEqual(await service.list(), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('表情包：限制大小、数量并拒绝无效 MIME/扩展名', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-stickers-limit-'))
  try {
    const service = harness(dir, { maxBytes: 1024, maxCount: 1 })
    await assert.rejects(() => service.importBuffer(Buffer.alloc(1025), { name: 'big.png', mime: 'image/png' }), /大小限制/)
    await assert.rejects(() => service.importBuffer(Buffer.from('x'), { name: 'x.txt', mime: 'text/plain' }), /只支持/)
    await assert.rejects(() => service.importBuffer(Buffer.from('x'), { name: 'x.jpg', mime: 'image/png' }), /不匹配/)
    await service.importBuffer(Buffer.from('one'), { name: 'one.webp', mime: 'image/webp' })
    await assert.rejects(() => service.importBuffer(Buffer.from('two'), { name: 'two.gif', mime: 'image/gif' }), /数量已达上限/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('表情包：缺失或损坏索引按空库加载', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-stickers-corrupt-'))
  try {
    writeFileSync(join(dir, 'stickers.json'), '{broken')
    const service = harness(dir)
    assert.deepEqual(await service.list(), [])
    const item = await service.importBuffer(Buffer.from('ok'), { name: 'ok.jpeg', mime: 'image/jpeg' })
    assert.ok(item.id)
    assert.equal((await service.status()).count, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('表情包：禁用时拒绝导入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-stickers-off-'))
  try {
    const service = harness(dir, { enabled: false })
    await assert.rejects(() => service.importBuffer(Buffer.from('png-one'), { name: 'a.png', mime: 'image/png' }), /未启用/)
    assert.equal((await service.status()).enabled, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
