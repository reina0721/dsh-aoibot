import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeConfig } from '../src/core/config.js'
import { createMediaService } from '../src/media/index.js'

function response(body, { status = 200, type = 'application/octet-stream', headers = {} } = {}) {
  return new Response(body, { status, headers: { 'content-type': type, ...headers } })
}

function config(patch = {}) {
  return normalizeConfig({
    media: {
      enabled: true,
      maxBytes: 1024 * 1024,
      images: { enabled: true, visionEnabled: true, visionBaseUrl: 'https://vision.test/v1', visionModel: 'vision-test', visionApiKeyEnv: 'DSH_MEDIA_TEST_KEY' },
      audio: {
        asrEnabled: true, asrBaseUrl: 'https://asr.test/v1', asrModel: 'asr-test', asrApiKeyEnv: 'DSH_MEDIA_TEST_KEY',
        ttsEnabled: true, ttsBaseUrl: 'https://tts.test/v1', ttsModel: 'tts-test', ttsVoice: 'test', ttsApiKeyEnv: 'DSH_MEDIA_TEST_KEY',
      },
      files: { enabled: true },
      ...patch,
    },
  }).config
}

function turn(segment, images = []) {
  return { messages: [{ segments: segment ? [segment] : [], images }] }
}

test('媒体：图片下载并调用 vision，返回附件和描述文本', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-media-image-'))
  const calls = []
  process.env.DSH_MEDIA_TEST_KEY = 'not-logged-secret'
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    if (String(url).includes('image.test')) return response(Buffer.from('png-data'), { type: 'image/png' })
    return response(JSON.stringify({ choices: [{ message: { content: '一只白猫坐在窗边。' } }] }), { type: 'application/json' })
  }
  const media = createMediaService({ getConfig: () => config(), dataDir: dir, fetchImpl })
  try {
    const result = await media.ingestTurn(turn({ type: 'image', data: { url: 'https://image.test/cat.png', file: 'cat.png' } }))
    assert.equal(result.attachments.length, 1)
    assert.match(result.attachments[0].file, /inbound/)
    assert.equal(readFileSync(result.attachments[0].file, 'utf8'), 'png-data')
    assert.equal(result.text, '[图片：一只白猫坐在窗边。]')
    assert.equal(calls.length, 2)
    assert.match(calls[1].url, /\/chat\/completions$/)
    assert.doesNotMatch(JSON.stringify(calls.map((item) => item.url)), /not-logged-secret/)
  } finally {
    delete process.env.DSH_MEDIA_TEST_KEY
    rmSync(dir, { recursive: true, force: true })
  }
})

test('媒体：record 下载后调用 multipart ASR', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-media-asr-'))
  process.env.DSH_MEDIA_TEST_KEY = 'test-key'
  const calls = []
  const media = createMediaService({
    getConfig: () => config(), dataDir: dir,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init })
      if (String(url).includes('audio.test')) return response(Buffer.from('audio'), { type: 'audio/mpeg' })
      return response(JSON.stringify({ text: '你好世界' }), { type: 'application/json' })
    },
  })
  try {
    const result = await media.ingestTurn(turn({ type: 'record', data: { url: 'https://audio.test/a.mp3', file: 'a.mp3' } }))
    assert.equal(result.text, '[语音转写：你好世界]')
    assert.equal(result.attachments[0].kind, 'record')
    assert.ok(calls[1].init.body instanceof FormData)
    assert.match(calls[1].url, /\/audio\/transcriptions$/)
  } finally {
    delete process.env.DSH_MEDIA_TEST_KEY
    rmSync(dir, { recursive: true, force: true })
  }
})

test('媒体：文件下载遵守扩展名和大小上限', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-media-file-'))
  const payload = Buffer.alloc(1025, 1)
  let cfg = config({ maxBytes: 1024, images: { enabled: false }, audio: { asrEnabled: false, ttsEnabled: false }, files: { enabled: true } })
  const media = createMediaService({ getConfig: () => cfg, dataDir: dir, fetchImpl: async () => response(payload, { type: 'text/plain' }) })
  try {
    const tooLarge = await media.ingestTurn(turn({ type: 'file', data: { url: 'https://file.test/a.txt', name: 'a.txt' } }))
    assert.deepEqual(tooLarge.attachments, [])
    cfg = config({ maxBytes: 2048, images: { enabled: false }, audio: { asrEnabled: false, ttsEnabled: false }, files: { enabled: true } })
    const ok = await media.ingestTurn(turn({ type: 'file', data: { url: 'https://file.test/a.txt', name: 'a.txt' } }))
    assert.equal(ok.attachments.length, 1)
    assert.equal(ok.attachments[0].size, 1025)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('媒体：TTS 输出 mp3；图片、语音和文件走对应网关动作', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-media-out-'))
  process.env.DSH_MEDIA_TEST_KEY = 'test-key'
  const sent = []
  const gateway = { actions: {
    sendMessage: async (...args) => { sent.push(['send', ...args]); return { message_id: 1 } },
    uploadGroupFile: async (...args) => { sent.push(['group-file', ...args]); return { ok: true } },
    uploadPrivateFile: async (...args) => { sent.push(['private-file', ...args]); return { ok: true } },
  } }
  const media = createMediaService({ getConfig: () => config(), dataDir: dir, gateway, fetchImpl: async () => response(Buffer.from('mp3-result'), { type: 'audio/mpeg' }) })
  try {
    const speech = await media.synthesize('你好')
    assert.equal(readFileSync(speech, 'utf8'), 'mp3-result')
    const image = join(dir, 'x.png'); writeFileSync(image, 'image')
    const audio = join(dir, 'x.mp3'); writeFileSync(audio, 'audio')
    const file = join(dir, 'x.pdf'); writeFileSync(file, 'file')
    await media.sendMedia({ chatType: 'group', chatId: '1', kind: 'image', filePath: image })
    await media.sendMedia({ chatType: 'private', chatId: '2', kind: 'record', filePath: audio })
    await media.sendMedia({ chatType: 'group', chatId: '3', kind: 'file', filePath: file, name: '报告.pdf' })
    assert.match(sent[0][1].message[0].data.file, /^base64:\/\//)
    assert.equal(sent[1][1].message[0].type, 'record')
    assert.deepEqual(sent[2].slice(0, 3), ['group-file', '3', file])
    await assert.rejects(() => media.sendMedia({ chatType: 'private', chatId: '2', kind: 'image', filePath: '/etc/passwd' }), /媒体目录内/)
  } finally {
    delete process.env.DSH_MEDIA_TEST_KEY
    rmSync(dir, { recursive: true, force: true })
  }
})

test('媒体：默认禁用时 ingest 不产生网络请求', async () => {
  let calls = 0
  const cfg = normalizeConfig({}).config
  const media = createMediaService({ getConfig: () => cfg, dataDir: tmpdir(), fetchImpl: async () => { calls += 1; throw new Error('unexpected') } })
  const result = await media.ingestTurn(turn({ type: 'image', data: { url: 'https://image.test/a.png' } }))
  assert.deepEqual(result, { text: '', attachments: [] })
  assert.equal(calls, 0)
})

test('media file command: relative paths, size/extension gates and symlink confinement use fake uploads', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-file-command-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const root = join(base, 'media')
  mkdirSync(join(root, 'inbound'), { recursive: true })
  writeFileSync(join(root, 'inbound', 'ok.txt'), 'ok')
  writeFileSync(join(root, 'bad.exe'), 'bad')
  writeFileSync(join(root, 'big.txt'), Buffer.alloc(1024 * 1024 + 1))
  writeFileSync(join(base, 'outside.txt'), 'secret')
  symlinkSync(join(base, 'outside.txt'), join(root, 'link.txt'))
  symlinkSync(base, join(root, 'escape'), 'dir')
  const calls = []
  const service = createMediaService({ getConfig: () => config(), dataDir: root, gateway: { actions: {
    async uploadPrivateFile(...args) { calls.push(['private', ...args]) },
    async uploadGroupFile(...args) { calls.push(['group', ...args]) },
  } } })
  await service.sendMedia({ chatType: 'private', chatId: '10001', kind: 'file', relativePath: 'inbound/ok.txt' })
  await service.sendMedia({ chatType: 'group', chatId: '20001', kind: 'file', relativePath: 'inbound/ok.txt' })
  assert.deepEqual(calls, [['private', '10001', join(root, 'inbound/ok.txt'), 'ok.txt'], ['group', '20001', join(root, 'inbound/ok.txt'), 'ok.txt']])
  for (const relativePath of ['/etc/passwd', '../outside.txt', 'C:/outside.txt', 'link.txt', 'escape/outside.txt', 'bad.exe', 'big.txt', 'inbound']) await assert.rejects(service.sendMedia({ chatType: 'private', chatId: '10001', kind: 'file', relativePath }))
  await assert.rejects(service.sendMedia({ chatType: 'private', chatId: '10001', kind: 'file', filePath: join(root, 'link.txt') }), /符号链接/)
  assert.equal(calls.length, 2)
})
