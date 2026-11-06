// Media ingest/outbound foundation. External providers are opt-in and all failures are non-fatal.
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, resolve, sep, win32 } from 'node:path'
import { randomUUID } from 'node:crypto'

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'])
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.amr', '.silk'])
const FILE_EXTENSIONS = new Set(['.txt', '.md', '.json', '.csv', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.7z', '.rar'])
const MIME_EXT = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp',
  'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a',
  'text/plain': '.txt', 'application/pdf': '.pdf', 'application/zip': '.zip',
}
const IMAGE_SIZES = new Set(['256x256', '512x512', '1024x1024', '1792x1024', '1024x1792'])
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024

function safeName(value, fallback = 'media') {
  const name = basename(String(value || fallback)).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120)
  return name && name !== '.' && name !== '..' ? name : fallback
}

function endpoint(base, suffix) {
  const value = String(base || '').trim().replace(/\/+$/, '')
  if (!value) throw new Error('未配置 provider base URL')
  return value.endsWith(suffix) ? value : `${value}${suffix}`
}

function apiHeaders(envName) {
  const key = String(process.env[String(envName || '').trim()] || '').trim()
  if (!key) throw new Error(`环境变量 ${String(envName || '').trim() || '(未配置)'} 未设置`)
  return { authorization: `Bearer ${key}` }
}

function timeoutSignal(ms) {
  return AbortSignal.timeout(Math.max(1000, Math.min(120000, Number(ms) || 30000)))
}

async function responseBuffer(response, maxBytes) {
  if (!response?.ok) throw new Error(`HTTP ${response?.status || 0}`)
  const declared = Number(response.headers?.get?.('content-length') || 0)
  if (declared > maxBytes) throw new Error(`媒体超过大小限制 ${maxBytes} bytes`)
  if (response.body?.getReader) {
    const reader = response.body.getReader()
    const chunks = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      size += chunk.length
      if (size > maxBytes) {
        try { await reader.cancel() } catch (error) {}
        throw new Error(`媒体超过大小限制 ${maxBytes} bytes`)
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks, size)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > maxBytes) throw new Error(`媒体超过大小限制 ${maxBytes} bytes`)
  return buffer
}

function sourceItems(turn) {
  const items = []
  const seen = new Set()
  const add = (kind, data = {}) => {
    const url = String(data.url || data.file || '').trim()
    if (!/^https?:\/\//i.test(url) || seen.has(`${kind}:${url}`)) return
    seen.add(`${kind}:${url}`)
    items.push({ kind, url, name: data.name || data.file || '', summary: data.summary || '' })
  }
  for (const message of turn?.messages || []) {
    for (const segment of message?.segments || []) {
      if (['image', 'record', 'file'].includes(segment?.type)) add(segment.type, segment.data)
    }
    for (const image of message?.images || []) add('image', image)
  }
  return items
}

function extensionFor(kind, item, contentType) {
  const fromName = extname(safeName(item.name || new URL(item.url).pathname, '')).toLowerCase()
  const allowed = kind === 'image' ? IMAGE_EXTENSIONS : kind === 'record' ? AUDIO_EXTENSIONS : FILE_EXTENSIONS
  if (allowed.has(fromName)) return fromName
  const fromMime = MIME_EXT[String(contentType || '').split(';')[0].toLowerCase()]
  if (fromMime && allowed.has(fromMime)) return fromMime
  return kind === 'image' ? '.jpg' : kind === 'record' ? '.mp3' : '.bin'
}

function mediaEnabled(cfg, kind) {
  if (!cfg.enabled) return false
  if (kind === 'image') return cfg.images?.enabled === true
  if (kind === 'record') return cfg.audio?.asrEnabled === true
  if (kind === 'file') return cfg.files?.enabled === true
  return false
}

export function createMediaService({ getConfig, dataDir, logger, fetchImpl = globalThis.fetch, gateway = null } = {}) {
  if (typeof getConfig !== 'function') throw new Error('createMediaService 需要 getConfig')
  if (typeof fetchImpl !== 'function') throw new Error('当前环境不支持 fetch')
  const log = logger?.child?.('media') || logger || { debug() {}, info() {}, warn() {} }
  const defaultDir = resolve(String(dataDir || 'media'))
  const config = () => getConfig()?.media || {}
  const rootDir = () => resolve(String(config().dir || defaultDir))
  const maxBytes = () => Math.min(100 * 1024 * 1024, Math.max(1024, Number(config().maxBytes) || DEFAULT_MAX_BYTES))
  const fetchTimeout = () => getConfig()?.timeouts?.callMs || 30000

  async function providerFetch(url, init) {
    return fetchImpl(url, { ...init, signal: timeoutSignal(fetchTimeout()) })
  }

  async function transcribe(buffer, name = 'audio.mp3') {
    const c = config().audio || {}
    const form = new FormData()
    form.append('model', String(c.asrModel || 'whisper-1'))
    form.append('file', new Blob([buffer]), safeName(name, 'audio.mp3'))
    const response = await providerFetch(endpoint(c.asrBaseUrl, '/audio/transcriptions'), { method: 'POST', headers: apiHeaders(c.asrApiKeyEnv), body: form })
    if (!response.ok) throw new Error(`ASR HTTP ${response.status}`)
    const body = await response.json()
    return String(body?.text || '').trim()
  }

  async function describeImage(buffer, mimeType = 'image/jpeg') {
    const c = config().images || {}
    const response = await providerFetch(endpoint(c.visionBaseUrl, '/chat/completions'), {
      method: 'POST',
      headers: { ...apiHeaders(c.visionApiKeyEnv), 'content-type': 'application/json' },
      body: JSON.stringify({
        model: c.visionModel,
        max_tokens: 160,
        messages: [{ role: 'user', content: [
          { type: 'text', text: '请用一句简洁中文描述这张图片，只描述可见内容。' },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${buffer.toString('base64')}` } },
        ] }],
      }),
    })
    if (!response.ok) throw new Error(`Vision HTTP ${response.status}`)
    const body = await response.json()
    return String(body?.choices?.[0]?.message?.content || '').trim().slice(0, 500)
  }

  async function download(item) {
    const response = await providerFetch(item.url, { method: 'GET', redirect: 'follow' })
    const buffer = await responseBuffer(response, maxBytes())
    const mimeType = String(response.headers?.get?.('content-type') || '').split(';')[0].toLowerCase()
    const ext = extensionFor(item.kind, item, mimeType)
    if (ext === '.bin' && item.kind === 'file') throw new Error('文件扩展名不在允许列表')
    const dir = join(rootDir(), 'inbound')
    await mkdir(dir, { recursive: true })
    const preferred = safeName(item.name || new URL(item.url).pathname, `${item.kind}${ext}`)
    const stem = preferred.replace(/\.[^.]*$/, '').slice(0, 80) || item.kind
    const filePath = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}-${stem}${ext}`)
    await writeFile(filePath, buffer, { flag: 'wx' })
    return { kind: item.kind, file: filePath, name: `${stem}${ext}`, size: buffer.length, mimeType, buffer }
  }

  async function ingestTurn(turn) {
    const c = config()
    if (!c.enabled) return { text: '', attachments: [] }
    const attachments = []
    const extra = []
    for (const item of sourceItems(turn)) {
      if (!mediaEnabled(c, item.kind)) continue
      try {
        const attachment = await download(item)
        const { buffer, ...publicAttachment } = attachment
        attachments.push(publicAttachment)
        if (item.kind === 'record' && c.audio?.asrEnabled) {
          try {
            const text = await transcribe(buffer, attachment.name)
            if (text) extra.push(`[语音转写：${text}]`)
          } catch (error) { log.debug?.(`ASR 失败：${error.message}`) }
        }
        if (item.kind === 'image' && c.images?.visionEnabled) {
          try {
            const text = await describeImage(buffer, attachment.mimeType || 'image/jpeg')
            if (text) extra.push(`[图片：${text}]`)
          } catch (error) { log.debug?.(`图片理解失败：${error.message}`) }
        }
      } catch (error) {
        log.debug?.(`${item.kind} 下载失败：${error.message}`)
      }
    }
    return { text: extra.join('\n'), attachments }
  }

  async function synthesize(text) {
    const c = config()
    if (!c.enabled || !c.audio?.ttsEnabled) throw new Error('TTS 未启用')
    const input = String(text || '').trim()
    if (!input) throw new Error('text 不能为空')
    const maxChars = Math.max(1, Math.min(5000, Number(c.tts?.maxChars) || 300))
    if (input.length > maxChars) throw new Error(`text 过长（最多 ${maxChars} 字符）`)
    const response = await providerFetch(endpoint(c.audio.ttsBaseUrl, '/audio/speech'), {
      method: 'POST',
      headers: { ...apiHeaders(c.audio.ttsApiKeyEnv), 'content-type': 'application/json' },
      body: JSON.stringify({ model: c.audio.ttsModel, voice: c.audio.ttsVoice, input, response_format: 'mp3' }),
    })
    const buffer = await responseBuffer(response, maxBytes())
    const dir = join(rootDir(), 'outbound')
    await mkdir(dir, { recursive: true })
    const file = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}.mp3`)
    await writeFile(file, buffer, { flag: 'wx' })
    return file
  }

  async function confinedFile(kind, { relativePath, filePath } = {}) {
    const root = rootDir()
    if (relativePath !== undefined && (typeof relativePath !== 'string' || !relativePath.trim() || isAbsolute(relativePath) || win32.isAbsolute(relativePath) || /^[a-z]:/i.test(relativePath) || /[\x00-\x1f\x7f\\]/.test(relativePath) || relativePath.split('/').includes('..'))) throw new Error('仅支持媒体根内相对路径')
    const fullPath = relativePath !== undefined ? resolve(root, relativePath) : resolve(String(filePath || ''))
    if (fullPath !== root && !fullPath.startsWith(`${root}${sep}`)) throw new Error('媒体路径必须在媒体目录内')
    const realRoot = await realpath(root)
    const realFile = await realpath(fullPath)
    if (!realFile.startsWith(`${realRoot}${sep}`)) throw new Error('媒体路径不能通过符号链接逃逸媒体目录')
    const info = await stat(realFile)
    if (!info.isFile()) throw new Error('媒体路径不是文件')
    if (info.size > maxBytes()) throw new Error(`媒体超过大小限制 ${maxBytes()} bytes`)
    const ext = extname(fullPath).toLowerCase()
    const allowed = kind === 'image' ? IMAGE_EXTENSIONS : kind === 'record' ? AUDIO_EXTENSIONS : FILE_EXTENSIONS
    if (!allowed.has(ext) || !allowed.has(extname(realFile).toLowerCase())) throw new Error(`${kind} 文件扩展名不在允许列表`)
    return { realFile, fullPath }
  }

  function imageSettings(kind) {
    const c = config()
    const images = c.images || {}
    if (!c.enabled || images[`${kind}Enabled`] !== true) throw new Error(kind === 'edit' ? '改图未启用' : '生图未启用')
    return {
      base: images[`${kind}BaseUrl`] || (kind === 'edit' ? images.generateBaseUrl : ''),
      model: images[`${kind}Model`] || images.generateModel || 'gpt-image-1',
      env: images[`${kind}ApiKeyEnv`] || (kind === 'edit' ? images.generateApiKeyEnv : ''),
      size: images[`${kind}Size`] || '1024x1024',
    }
  }

  function imageInput(prompt, size, fallback) {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.trim().length > 1000) throw new Error('prompt 必须为 1–1000 字符')
    const selected = size === undefined ? fallback : size
    if (!IMAGE_SIZES.has(selected)) throw new Error('size 不在允许列表（256x256、512x512、1024x1024、1792x1024、1024x1792）')
    return { prompt: prompt.trim(), size: selected }
  }

  async function saveImageResponse(url, init) {
    let response, body
    try {
      response = await providerFetch(url, { ...init, redirect: 'error' })
    } catch (error) {
      if (['AbortError', 'TimeoutError'].includes(error?.name)) throw new Error('图片 provider 请求超时')
      throw new Error('图片 provider 请求失败')
    }
    if (!response?.ok) throw new Error(`图片 provider HTTP ${Number(response?.status) || 0}`)
    try {
      // Bound the JSON too: base64 expands binary by 4/3, plus a small metadata allowance.
      body = JSON.parse((await responseBuffer(response, Math.ceil(maxBytes() / 3) * 4 + 65536)).toString('utf8'))
    } catch (error) {
      if (['AbortError', 'TimeoutError'].includes(error?.name)) throw new Error('图片 provider 请求超时')
      throw new Error('图片 provider 响应无效或超过大小限制')
    }
    const encoded = body?.data?.[0]?.b64_json
    if (typeof encoded !== 'string' || !encoded || encoded.length > Math.ceil(maxBytes() / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('图片 provider 必须返回大小限制内的 b64_json（不支持 URL）')
    const buffer = Buffer.from(encoded, 'base64')
    if (!buffer.length || buffer.length > maxBytes()) throw new Error('生成图片超过大小限制')
    if (buffer.length < 33 || !buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR') throw new Error('图片 provider 必须返回 PNG')
    const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20)
    if (!width || !height || width > 1792 || height > 1792 || width * height > 1792 * 1024) throw new Error('生成图片尺寸超过限制')
    const root = rootDir()
    const dir = join(root, 'generated')
    await mkdir(dir, { recursive: true })
    const realRoot = await realpath(root), realDir = await realpath(dir)
    if (!realDir.startsWith(`${realRoot}${sep}`)) throw new Error('生成目录不能通过符号链接逃逸媒体目录')
    const name = `${randomUUID()}.png`
    await writeFile(join(realDir, name), buffer, { flag: 'wx' })
    return `generated/${name}`
  }

  async function generateImage(prompt, { size } = {}) {
    const c = imageSettings('generate')
    const input = imageInput(prompt, size, c.size)
    // gpt-image-* always returns base64 and rejects response_format; DALL-E 2/3 need it.
    const formats = /^gpt-image/i.test(String(c.model)) ? {} : { response_format: 'b64_json' }
    const path = await saveImageResponse(endpoint(c.base, '/images/generations'), {
      method: 'POST', headers: { ...apiHeaders(c.env), 'content-type': 'application/json' },
      body: JSON.stringify({ model: c.model, ...input, n: 1, ...formats }),
    })
    return { ok: true, path, size: input.size }
  }

  async function editImage(prompt, sourceRelativePath, { size } = {}) {
    const c = imageSettings('edit')
    const input = imageInput(prompt, size, c.size)
    if (typeof sourceRelativePath !== 'string' || !sourceRelativePath.trim()) throw new Error('仅支持媒体根内相对路径')
    const { realFile } = await confinedFile('image', { relativePath: sourceRelativePath })
    const buffer = await readFile(realFile)
    if (buffer.length > maxBytes()) throw new Error('源图片超过大小限制')
    const form = new FormData()
    const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' }[extname(realFile).toLowerCase()]
    form.append('image', new Blob([buffer], { type: mime }), safeName(basename(realFile)))
    const formats = /^gpt-image/i.test(String(c.model)) ? {} : { response_format: 'b64_json' }
    for (const [key, value] of Object.entries({ model: c.model, ...input, ...formats })) form.append(key, value)
    const path = await saveImageResponse(endpoint(c.base, '/images/edits'), { method: 'POST', headers: apiHeaders(c.env), body: form })
    return { ok: true, path, size: input.size }
  }

  async function sendMedia({ chatType, chatId, kind, filePath, relativePath, name } = {}) {
    const c = config()
    if (!c.enabled) throw new Error('媒体功能未启用')
    if (!['image', 'record', 'file'].includes(kind)) throw new Error('kind 必须是 image、record 或 file')
    if (!['private', 'group'].includes(chatType) || !String(chatId || '').trim()) throw new Error('chatType/chatId 无效')
    const { realFile, fullPath } = await confinedFile(kind, { relativePath, filePath })
    if (kind === 'image' && c.images?.enabled !== true) throw new Error('图片功能未启用')
    if (kind === 'file' && c.files?.enabled !== true) throw new Error('文件功能未启用')
    if (kind === 'file') {
      const action = chatType === 'group' ? gateway?.actions?.uploadGroupFile : gateway?.actions?.uploadPrivateFile
      if (typeof action !== 'function') throw new Error('网关不支持文件上传')
      return action(chatId, realFile, safeName(name || basename(fullPath)))
    }
    if (typeof gateway?.actions?.sendMessage !== 'function') throw new Error('网关不支持发送消息')
    const buffer = await readFile(realFile)
    return gateway.actions.sendMessage({ chatType, chatId, message: [{ type: kind, data: { file: `base64://${buffer.toString('base64')}` } }] })
  }

  function status() {
    const c = config()
    return {
      enabled: Boolean(c.enabled), maxBytes: maxBytes(), dir: rootDir(),
      images: {
        enabled: Boolean(c.images?.enabled), visionEnabled: Boolean(c.images?.visionEnabled), configured: Boolean(c.images?.visionBaseUrl && c.images?.visionModel && c.images?.visionApiKeyEnv),
        generate: { enabled: Boolean(c.images?.generateEnabled), configured: Boolean(c.images?.generateBaseUrl && (c.images?.generateModel || 'gpt-image-1') && c.images?.generateApiKeyEnv) },
        edit: { enabled: Boolean(c.images?.editEnabled), configured: Boolean((c.images?.editBaseUrl || c.images?.generateBaseUrl) && (c.images?.editModel || c.images?.generateModel || 'gpt-image-1') && (c.images?.editApiKeyEnv || c.images?.generateApiKeyEnv)) },
      },
      audio: { asrEnabled: Boolean(c.audio?.asrEnabled), ttsEnabled: Boolean(c.audio?.ttsEnabled), asrConfigured: Boolean(c.audio?.asrBaseUrl && c.audio?.asrModel && c.audio?.asrApiKeyEnv), ttsConfigured: Boolean(c.audio?.ttsBaseUrl && c.audio?.ttsModel && c.audio?.ttsApiKeyEnv) },
      files: { enabled: Boolean(c.files?.enabled) },
    }
  }

  async function testProvider(kind) {
    if (kind === 'tts') return { kind, file: await synthesize('媒体语音测试。') }
    if (kind === 'asr') {
      if (!config().enabled || !config().audio?.asrEnabled) throw new Error('ASR 未启用')
      return { kind, text: await transcribe(Buffer.from('RIFF\0\0\0\0WAVE'), 'test.wav') }
    }
    if (kind === 'vision') {
      if (!config().enabled || !config().images?.visionEnabled) throw new Error('图片理解未启用')
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
      return { kind, text: await describeImage(png, 'image/png') }
    }
    throw new Error('kind 必须是 tts、asr 或 vision')
  }

  return { ingestTurn, sendMedia, synthesize, generateImage, editImage, status, test: testProvider }
}
