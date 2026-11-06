import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs'
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
    assert.deepEqual(sent[2].slice(0, 3), ['group-file', '3', realpathSync(file)])
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
  const expected = realpathSync(join(root, 'inbound/ok.txt'))
  assert.deepEqual(calls, [['private', '10001', expected, 'ok.txt'], ['group', '20001', expected, 'ok.txt']])
  for (const relativePath of ['/etc/passwd', '../outside.txt', 'C:/outside.txt', 'link.txt', 'escape/outside.txt', 'bad.exe', 'big.txt', 'inbound']) await assert.rejects(service.sendMedia({ chatType: 'private', chatId: '10001', kind: 'file', relativePath }))
  await assert.rejects(service.sendMedia({ chatType: 'private', chatId: '10001', kind: 'file', filePath: join(root, 'link.txt') }), /符号链接/)
  assert.equal(calls.length, 2)
})

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
function imageConfig(patch = {}) {
  return config({ images: { enabled: true, generateEnabled: true, editEnabled: true, generateBaseUrl: 'https://image-provider.test/v1', generateApiKeyEnv: 'DSH_MEDIA_IMAGE_KEY', ...patch } })
}
function imageHarness(t, { cfg = imageConfig(), fetchImpl } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-image-provider-'))
  const calls = [], sent = [], logs = []
  process.env.DSH_MEDIA_IMAGE_KEY = 'image-secret'
  t.after(() => { delete process.env.DSH_MEDIA_IMAGE_KEY; rmSync(dir, { recursive: true, force: true }) })
  const media = createMediaService({ getConfig: () => cfg, dataDir: dir,
    logger: { debug: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
    gateway: { actions: { sendMessage: async (payload) => { sent.push(payload) } } },
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return fetchImpl ? fetchImpl(url, init) : response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
    },
  })
  return { media, cfg, dir, calls, sent, logs }
}

test('images: generation JSON, confined PNG output, status, ordinary image send', async (t) => {
  const { media, dir, calls, sent, logs } = imageHarness(t)
  const result = await media.generateImage('  一只猫  ', { size: '512x512' })
  assert.equal(result.ok, true)
  assert.equal(result.size, '512x512')
  assert.ok(result.path.startsWith('generated/') && result.path.endsWith('.png'))
  assert.deepEqual(readFileSync(join(dir, result.path)), PNG)
  assert.equal(calls[0].url, 'https://image-provider.test/v1/images/generations')
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: 'gpt-image-1', prompt: '一只猫', size: '512x512', n: 1 })
  assert.equal(calls[0].init.headers.authorization, 'Bearer image-secret')
  assert.equal(calls[0].init.redirect, 'error')
  assert.ok(calls[0].init.signal instanceof AbortSignal)
  await media.sendMedia({ chatType: 'group', chatId: '20001', kind: 'image', relativePath: result.path })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].message[0].data.file, 'base64://' + PNG.toString('base64'))
  assert.deepEqual(media.status().images.generate, { enabled: true, configured: true })
  assert.deepEqual(media.status().images.edit, { enabled: true, configured: true })
  assert.ok(!JSON.stringify([logs, media.status()]).includes('image-secret'))
})

test('images: DALL-E 3 requests b64_json while gpt-image omits response_format', async (t) => {
  const dalle = imageHarness(t, { cfg: imageConfig({ generateModel: 'dall-e-3' }) })
  await dalle.media.generateImage('cat')
  assert.equal(JSON.parse(dalle.calls[0].init.body).response_format, 'b64_json')
  const gpt = imageHarness(t, { cfg: imageConfig({ generateModel: 'gpt-image-1' }) })
  await gpt.media.generateImage('cat')
  assert.equal(JSON.parse(gpt.calls[0].init.body).response_format, undefined)
})

test('images: edit multipart source bytes, independent overrides and generate fallbacks', async (t) => {
  const { media, dir, calls, cfg } = imageHarness(t)
  writeFileSync(join(dir, 'source.png'), PNG)
  const result = await media.editImage('蓝色背景', 'source.png')
  assert.deepEqual(readFileSync(join(dir, result.path)), PNG)
  assert.equal(calls[0].url, 'https://image-provider.test/v1/images/edits')
  const form = calls[0].init.body
  assert.ok(form instanceof FormData)
  assert.equal(form.get('model'), 'gpt-image-1')
  assert.equal(form.get('prompt'), '蓝色背景')
  assert.equal(form.get('size'), '1024x1024')
  assert.equal(form.get('response_format'), null)
  assert.equal(form.get('image').name, 'source.png')
  assert.equal(form.get('image').type, 'image/png')
  assert.deepEqual(Buffer.from(await form.get('image').arrayBuffer()), PNG)
  assert.equal(calls[0].init.headers['content-type'], undefined)
  Object.assign(cfg.media.images, { editBaseUrl: 'https://edit.test/v1', editModel: 'edit-model', editApiKeyEnv: 'DSH_MEDIA_EDIT_KEY', editSize: '256x256' })
  process.env.DSH_MEDIA_EDIT_KEY = 'edit-secret'
  t.after(() => { delete process.env.DSH_MEDIA_EDIT_KEY })
  await media.editImage('绿色背景', 'source.png', { size: '1024x1792' })
  assert.equal(calls[1].url, 'https://edit.test/v1/images/edits')
  assert.equal(calls[1].init.body.get('model'), 'edit-model')
  assert.equal(calls[1].init.body.get('size'), '1024x1792')
  assert.equal(calls[1].init.headers.authorization, 'Bearer edit-secret')
})

test('images: disabled switches and invalid prompt/size/config never fetch', async (t) => {
  const { media, cfg, calls } = imageHarness(t, { cfg: normalizeConfig({}).config })
  assert.deepEqual(media.status().images.generate, { enabled: false, configured: false })
  assert.deepEqual(media.status().images.edit, { enabled: false, configured: false })
  await assert.rejects(media.generateImage('cat'), /未启用/)
  await assert.rejects(media.editImage('cat', 'source.png'), /未启用/)
  Object.assign(cfg.media, imageConfig().media)
  for (const prompt of ['', '   ', 'x'.repeat(1001), null, {}, 3]) {
    await assert.rejects(media.generateImage(prompt), /prompt/)
    await assert.rejects(media.editImage(prompt, 'source.png'), /prompt/)
  }
  for (const size of ['auto', '9999x9999', '', null, {}]) {
    await assert.rejects(media.generateImage('cat', { size }), /size/)
    await assert.rejects(media.editImage('cat', 'source.png', { size }), /size/)
  }
  cfg.media.images.generateEnabled = false
  await assert.rejects(media.generateImage('cat'), /未启用/)
  cfg.media.images.editEnabled = false
  await assert.rejects(media.editImage('cat', 'source.png'), /未启用/)
  Object.assign(cfg.media.images, { generateEnabled: true, generateBaseUrl: '' })
  await assert.rejects(media.generateImage('cat'), /base URL/)
  Object.assign(cfg.media.images, { generateBaseUrl: 'https://image-provider.test', generateApiKeyEnv: 'DSH_UNSET_IMAGE_KEY' })
  await assert.rejects(media.generateImage('cat'), /环境变量/)
  assert.equal(calls.length, 0)
})

test('images: edit rejects absolute/traversal/control paths, escaping symlinks, extensions and oversized files before fetch', async (t) => {
  const { media, dir, cfg, calls } = imageHarness(t)
  const outside = mkdtempSync(join(tmpdir(), 'dsh-image-outside-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  writeFileSync(join(outside, 'outside.png'), PNG)
  symlinkSync(join(outside, 'outside.png'), join(dir, 'escape.png'))
  symlinkSync(outside, join(dir, 'escape-dir'), 'dir')
  writeFileSync(join(dir, 'source.txt'), PNG)
  symlinkSync(join(dir, 'source.txt'), join(dir, 'disguised.png'))
  writeFileSync(join(dir, 'big.png'), Buffer.alloc(1025))
  cfg.media.maxBytes = 1024
  for (const path of [undefined, null, '', '../outside.png', '/etc/passwd', 'C:/outside.png', 'C:outside.png', 'a' + String.fromCharCode(92) + 'b.png', 'x' + String.fromCharCode(0), 'escape.png', 'escape-dir/outside.png', 'source.txt', 'disguised.png', 'big.png', '.']) await assert.rejects(media.editImage('cat', path))
  assert.equal(calls.length, 0)
})

test('images: missing base64 never follows provider URL; HTTP, invalid PNG, dimensions and response size are bounded', async (t) => {
  let body = { data: [{ url: 'https://untrusted.test/image.png' }] }, status = 200
  const { media, cfg, calls, dir } = imageHarness(t, { fetchImpl: async () => response(JSON.stringify(body), { status }) })
  await assert.rejects(media.generateImage('cat'), /b64_json/)
  assert.equal(calls.length, 1)
  status = 401
  await assert.rejects(media.generateImage('cat'), /HTTP 401/)
  status = 200
  for (const value of ['invalid', Buffer.from('not-png').toString('base64')]) {
    body = { data: [{ b64_json: value }] }
    await assert.rejects(media.generateImage('cat'), /b64_json|PNG/)
  }
  const huge = Buffer.from(PNG); huge.writeUInt32BE(10000, 16)
  body = { data: [{ b64_json: huge.toString('base64') }] }
  await assert.rejects(media.generateImage('cat'), /尺寸/)
  cfg.media.maxBytes = 1024
  body = { data: [{ b64_json: Buffer.alloc(1025).toString('base64') }] }
  await assert.rejects(media.generateImage('cat'), /大小/)
  body = { data: [{ b64_json: 'A'.repeat(70000) }] }
  await assert.rejects(media.generateImage('cat'), /响应无效或超过大小限制/)
  body = { data: [{ b64_json: PNG.toString('base64') }] }
  const outside = mkdtempSync(join(tmpdir(), 'dsh-image-generated-outside-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  symlinkSync(outside, join(dir, 'generated'), 'dir')
  await assert.rejects(media.generateImage('cat'), /符号链接/)
})

test('images: fetch timeout aborts and provider errors never expose secrets or response bodies', async (t) => {
  const { media, cfg, dir } = imageHarness(t, { fetchImpl: async (_url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
  }) })
  cfg.timeouts.callMs = 1000
  // AbortSignal.timeout is unref'ed; keep this fake provider test alive until it aborts.
  const timer = setInterval(() => {}, 100)
  try { await assert.rejects(media.generateImage('cat'), /超时/) } finally { clearInterval(timer) }
  writeFileSync(join(dir, 'source.png'), PNG)
  const failing = imageHarness(t, { fetchImpl: async () => { throw new Error('image-secret raw provider body') } })
  await assert.rejects(failing.media.generateImage('cat'), { message: '图片 provider 请求失败' })
  writeFileSync(join(failing.dir, 'source.png'), PNG)
  await assert.rejects(failing.media.editImage('cat', 'source.png'), { message: '图片 provider 请求失败' })
  assert.deepEqual(failing.logs, [])
})

function filesHarness(t, patch = {}) {
  const base = mkdtempSync(join(tmpdir(), 'dsh-files-panel-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const root = join(base, 'media'), cfg = config(patch)
  const media = createMediaService({ getConfig: () => cfg, dataDir: root,
    fetchImpl: async () => { assert.fail('local files must never fetch') },
    gateway: { actions: new Proxy({}, { get() { assert.fail('local files must never send') } }) },
  })
  return { media, cfg, root, base }
}

test('files: upload/list Unicode basename, relative path, bytes and newest-first metadata', async (t) => {
  const { media, root } = filesHarness(t)
  assert.deepEqual(await media.listFiles(), { items: [], totalBytes: 0 })
  const saved = await media.saveFile({ name: '报告.TXT', dataBase64: Buffer.from('你好').toString('base64') })
  assert.deepEqual(Object.keys(saved).sort(), ['name', 'ok', 'path', 'size'])
  assert.equal(saved.ok, true)
  assert.equal(saved.name, '报告.TXT')
  assert.equal(saved.size, 6)
  assert.match(saved.path, /^files\/\d+-[a-f0-9]{8}-报告.TXT$/)
  assert.equal(readFileSync(join(root, saved.path), 'utf8'), '你好')
  const listed = await media.listFiles()
  assert.equal(listed.totalBytes, 6)
  assert.deepEqual(listed.items.map(({ at, ...item }) => item), [{ path: saved.path, name: saved.name, size: 6 }])
  assert.ok(Number.isFinite(listed.items[0].at))
})

test('files: strict canonical base64 rejects data URLs, whitespace, malformed padding and empty data', async (t) => {
  const { media } = filesHarness(t)
  for (const dataBase64 of [undefined, null, 123, {}, '', ' ', 'YQ', 'YQ=', 'YQ===', '=YQ=', 'YQ==\n', 'Y Q==', 'data:text/plain;base64,YQ==', 'YQ-_', 'YR==', 'YWJ=']) {
    await assert.rejects(media.saveFile({ name: 'a.txt', dataBase64 }), /base64/)
  }
  assert.deepEqual(await media.listFiles(), { items: [], totalBytes: 0 })
  for (const value of ['a', 'ab', 'abc']) await media.saveFile({ name: 'a.txt', dataBase64: Buffer.from(value).toString('base64') })
  assert.equal((await media.listFiles()).totalBytes, 6)
})

test('files: size boundary, allowed extensions and safe basename validation', async (t) => {
  const { media } = filesHarness(t, { maxBytes: 1024 })
  const dataBase64 = Buffer.alloc(1024).toString('base64')
  await media.saveFile({ name: 'a'.repeat(116) + '.txt', dataBase64 })
  await assert.rejects(media.saveFile({ name: 'a.txt', dataBase64: Buffer.alloc(1025).toString('base64') }), /大小/)
  await assert.rejects(media.saveFile({ name: 'a.txt', dataBase64: Buffer.alloc(1027).toString('base64') }), /大小/)
  for (const name of [undefined, null, 1, {}, '', ' ', '.', '..', 'a'.repeat(117) + '.txt', '../a.txt', '/a.txt', 'a/b.txt', 'a\\b.txt', 'C:a.txt', 'a\0.txt', 'a\n.txt', 'a?.txt']) {
    await assert.rejects(media.saveFile({ name, dataBase64 }), /文件名/)
  }
  for (const name of ['a.exe', 'a.png', 'a.txt.exe', 'a.', 'a', '.txt']) await assert.rejects(media.saveFile({ name, dataBase64 }))
  for (const ext of ['txt', 'md', 'json', 'csv', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', '7z', 'rar']) await media.saveFile({ name: 'file.' + ext, dataBase64: 'YQ==' })
  assert.equal((await media.listFiles()).items.length, 15)
})

test('files: total/media switches gate upload and list without creating directories', async (t) => {
  const { media, cfg, root } = filesHarness(t, { enabled: false })
  for (const switches of [{ enabled: false, files: { enabled: true } }, { enabled: true, files: { enabled: false } }]) {
    Object.assign(cfg.media, switches)
    await assert.rejects(media.saveFile({ name: 'a.txt', dataBase64: 'YQ==' }), /文件功能未启用/)
    await assert.rejects(media.listFiles(), /文件功能未启用/)
  }
  assert.throws(() => readFileSync(root), /ENOENT/)
})

test('files: list ignores symlinks, directories, nested/inbound files, bad extensions and oversized files', async (t) => {
  const { media, root, base } = filesHarness(t, { maxBytes: 1024 })
  await media.saveFile({ name: 'ok.txt', dataBase64: 'YQ==' })
  const dir = join(root, 'files')
  mkdirSync(join(dir, 'nested.txt'))
  writeFileSync(join(dir, 'nested.txt', 'hidden.txt'), 'hidden')
  mkdirSync(join(root, 'inbound'))
  writeFileSync(join(root, 'inbound', 'hidden.txt'), 'hidden')
  writeFileSync(join(base, 'outside.txt'), 'secret')
  writeFileSync(join(dir, 'bad.exe'), 'bad')
  writeFileSync(join(dir, 'big.txt'), Buffer.alloc(1025))
  symlinkSync(join(base, 'outside.txt'), join(dir, 'escape.txt'))
  symlinkSync(join(dir, 'big.txt'), join(dir, 'inside.txt'))
  symlinkSync(join(root, 'inbound'), join(dir, 'directory'), 'dir')
  const listed = await media.listFiles({ path: base })
  assert.equal(listed.items.length, 1)
  assert.equal(listed.items[0].name, 'ok.txt')
  assert.equal(listed.totalBytes, 1)
})

test('files: upload/list reject files-directory symlinks inside or outside root and non-directories', async (t) => {
  const { media, root, base } = filesHarness(t)
  mkdirSync(root)
  const target = join(base, 'outside')
  mkdirSync(target)
  for (const directory of [target, root]) {
    symlinkSync(directory, join(root, 'files'), 'dir')
    await assert.rejects(media.saveFile({ name: 'a.txt', dataBase64: 'YQ==' }), /符号链接/)
    await assert.rejects(media.listFiles(), /符号链接/)
    rmSync(join(root, 'files'))
  }
  writeFileSync(join(root, 'files'), 'untouched')
  await assert.rejects(media.saveFile({ name: 'a.txt', dataBase64: 'YQ==' }), /不是目录/)
  await assert.rejects(media.listFiles(), /不是目录/)
  assert.equal(readFileSync(join(root, 'files'), 'utf8'), 'untouched')
})

test('files: same-name concurrent uploads at one timestamp preserve existing contents without overwriting', async (t) => {
  const { media, root } = filesHarness(t)
  t.mock.method(Date, 'now', () => 1793923200000)
  const payloads = Array.from({ length: 12 }, (_, index) => 'payload-' + index)
  const saved = await Promise.all(payloads.map((text) => media.saveFile({ name: 'same.txt', dataBase64: Buffer.from(text).toString('base64') })))
  assert.equal(new Set(saved.map((item) => item.path)).size, payloads.length)
  saved.forEach((item, index) => assert.equal(readFileSync(join(root, item.path), 'utf8'), payloads[index]))
  assert.equal((await media.listFiles()).items.length, payloads.length)
  // Force an actual timestamp/UUID collision to verify exclusive creation, not just unique naming.
  const { default: crypto } = await import('node:crypto')
  const { syncBuiltinESMExports } = await import('node:module')
  const original = crypto.randomUUID
  try {
    crypto.randomUUID = () => 'deadbeef-0000-4000-8000-000000000000'
    syncBuiltinESMExports()
    const first = await media.saveFile({ name: 'collision.txt', dataBase64: 'YQ==' })
    await assert.rejects(media.saveFile({ name: 'collision.txt', dataBase64: 'Yg==' }), { code: 'EEXIST' })
    assert.equal(readFileSync(join(root, first.path), 'utf8'), 'a')
  } finally { crypto.randomUUID = original; syncBuiltinESMExports() }
})

test('files: list is limited to newest 500 while totalBytes counts every eligible file', async (t) => {
  const { media, root } = filesHarness(t)
  const { utimesSync } = await import('node:fs')
  mkdirSync(join(root, 'files'), { recursive: true })
  for (let index = 0; index < 502; index++) {
    const file = join(root, 'files', index + '.txt')
    writeFileSync(file, 'a')
    utimesSync(file, index + 1, index + 1)
  }
  const result = await media.listFiles()
  assert.equal(result.items.length, 500)
  assert.equal(result.totalBytes, 502)
  assert.equal(result.items[0].path, 'files/501.txt')
  assert.equal(result.items.at(-1).path, 'files/2.txt')
  assert.ok(result.items.every((item, index) => !index || result.items[index - 1].at >= item.at))
})
