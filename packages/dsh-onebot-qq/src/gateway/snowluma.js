// SnowLuma 只读适配：探测本机是否装了 SnowLuma、从它自己的配置里读出 OneBot 地址。
//
// 边界（在 docs/ARCHITECTURE.md 与 USER-MANUAL 中同样声明）：
//   - 不下载、不解压、不启动、不注入 SnowLuma（其 EULA 限制部署/注入行为）；
//   - 只读取主人自己装好、自己配置好的 SnowLuma 的 config/onebot*.json；
//   - 读不到就明确说明原因，让用户手填地址，绝不猜测端口。
//
// detectInstall / readOneBotEndpoint 移植自 aureth-labs/dsh-aurabot-qq 的 src/snowluma/manager.js（MIT，
// 见 THIRD_PARTY_NOTICES.md），去掉了进程管理/密码注入等需要写权限的部分，只保留只读检测。

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { registerSecret } from '../core/redact.js'

export const DOWNLOAD_PAGE = 'https://github.com/SnowLuma/SnowLuma/releases/latest'

function readJsonSafe(file) {
  try {
    let text = readFileSync(file, 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    return JSON.parse(text)
  } catch (error) {
    return null
  }
}

/**
 * 候选安装目录（只读探测，按优先级排序）。
 * @param {{ configured?: string, env?: object }} [o]
 * @returns {string[]}
 */
export function detectDirs({ configured = '', env = process.env } = {}) {
  const list = []
  const push = (value) => {
    const dir = String(value || '').trim()
    if (!dir) return
    if (!list.includes(dir)) list.push(dir)
  }
  push(configured)
  push(env.SNOWLUMA_DIR)
  const localAppData = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  const programFiles = env.ProgramFiles || 'C:\\Program Files'
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  push('C:\\SnowLuma')
  push(join(homedir(), 'SnowLuma'))
  push(join(localAppData, 'SnowLuma'))
  push(join(programFiles, 'SnowLuma'))
  push(join(programFilesX86, 'SnowLuma'))
  return list
}

/**
 * 判断某个目录是不是一份装好的 SnowLuma。
 * @param {string} dir
 * @returns {{ installed: boolean, dir?: string, entry?: string, nodeExe?: string, version?: string, reason?: string }}
 */
export function detectInstall(dir) {
  const d = String(dir || '').trim()
  if (!d) return { installed: false, reason: '还没填 SnowLuma 安装目录' }
  if (/[^\x00-\x7f]/.test(d)) {
    return { installed: false, dir: d, reason: '目录里有中文，SnowLuma 需要用纯英文路径（例如 C:\\SnowLuma）' }
  }
  if (!existsSync(d)) return { installed: false, dir: d, reason: `目录不存在：${d}` }
  const entry = join(d, 'index.mjs')
  if (!existsSync(entry)) {
    return { installed: false, dir: d, reason: `在 ${d} 里没找到 index.mjs，请确认解压的是 SnowLuma 根目录` }
  }
  const nodeExe = join(d, 'node.exe')
  const release = readJsonSafe(join(d, 'release.json')) || {}
  const pkg = readJsonSafe(join(d, 'package.json')) || {}
  return {
    installed: true,
    dir: d,
    entry,
    nodeExe: existsSync(nodeExe) ? nodeExe : '',
    version: String(release.version || pkg.version || '?'),
  }
}

/**
 * 在候选目录里找第一个装好的 SnowLuma。
 * @param {{ configured?: string, env?: object }} [o]
 */
export function detectFirstInstall({ configured = '', env = process.env } = {}) {
  const candidates = detectDirs({ configured, env })
  const tried = []
  for (const dir of candidates) {
    const result = detectInstall(dir)
    tried.push({ dir, installed: result.installed, reason: result.reason })
    if (result.installed) return { ...result, candidates: tried }
  }
  return { installed: false, reason: tried.length ? '在候选目录里没找到 SnowLuma（index.mjs）' : '没有可用候选目录', candidates: tried }
}

/** 列出 config 目录里形如 onebot_<uin>.json 的账号覆盖文件。 */
export function listUinConfigs(dir) {
  const cfgDir = join(dir, 'config')
  try {
    return readdirSync(cfgDir)
      .filter((name) => /^onebot_\d+\.json$/i.test(name))
      .map((name) => ({ file: name, uin: name.replace(/^onebot_/i, '').replace(/\.json$/i, '') }))
      .sort((a, b) => a.uin.localeCompare(b.uin))
  } catch (error) {
    return []
  }
}

/**
 * 从 SnowLuma 配置里读出 OneBot HTTP / WS 地址与 token。
 * onebot.json 是全局；onebot_<uin>.json 是单账号覆盖；mode=snapshot 时不叠全局。
 *
 * @param {string} dir SnowLuma 安装目录
 * @param {string|number} [uin] 账号（留空则扫描 config/onebot_*.json）
 * @returns {{ httpUrl:string, wsUrl:string, httpToken:string, wsToken:string, found:boolean,
 *             uin:string, files:string[], sources:string[], reason?:string }}
 */
export function readOneBotEndpoint(dir, uin) {
  const d = String(dir || '').trim()
  const cfgDir = join(d, 'config')
  const explicitUin = String(uin || '').trim()
  const files = []
  const candidates = explicitUin ? [explicitUin] : listUinConfigs(d).map((item) => item.uin)

  const global = readJsonSafe(join(cfgDir, 'onebot.json'))
  if (global) files.push('onebot.json')

  let http = null
  let ws = null
  const sources = []
  let usedUin = ''
  let reason = ''

  // 有显式 uin 时只看它；没有时依次尝试每个账号覆盖文件，取第一个真有网络的。
  // SnowLuma 2.x 用 `enabled`，旧版本/个别发行版用 `enable`；两者都认，缺省视为启用。
  const usable = (item) => Boolean(item && item.enabled !== false && item.enable !== false)
  for (const candidate of candidates.length ? candidates : ['']) {
    const per = candidate ? readJsonSafe(join(cfgDir, `onebot_${candidate}.json`)) : null
    if (per) files.push(`onebot_${candidate}.json`)
    const list = per?.mode === 'snapshot' ? [per] : [global, per].filter(Boolean)
    let localHttp = null
    let localWs = null
    for (const source of list) {
      const networks = source?.networks || {}
      const httpServers = Array.isArray(networks.httpServers) ? networks.httpServers : []
      const wsServers = Array.isArray(networks.wsServers) ? networks.wsServers : []
      const h = httpServers.find(usable)
      const w = wsServers.find(usable)
      if (h) localHttp = h
      if (w) localWs = w
      if (source === global) sources.push('onebot.json')
      else sources.push(`onebot_${candidate}.json`)
    }
    if (localHttp || localWs) {
      http = localHttp
      ws = localWs
      usedUin = candidate
      break
    }
  }

  const hostOf = (item) => {
    if (!item) return '127.0.0.1'
    const host = String(item.host || '')
    if (!host || host === '0.0.0.0' || host === '::') return '127.0.0.1'
    return host
  }
  const pathOf = (item) => {
    const path = String(item?.path || '')
    return path && path !== '/' ? (path.startsWith('/') ? path : `/${path}`) : ''
  }
  const out = {
    httpUrl: http ? `http://${hostOf(http)}:${Number(http.port) || 3000}${pathOf(http)}` : '',
    httpToken: String(http?.accessToken || http?.token || ''),
    wsUrl: ws ? `ws://${hostOf(ws)}:${Number(ws.port) || 3001}${pathOf(ws)}` : '',
    wsToken: String(ws?.accessToken || ws?.token || ''),
    found: Boolean(http || ws),
    uin: usedUin,
    files: [...new Set(files)],
    sources: [...new Set(sources)],
  }
  if (!out.found) {
    out.reason = files.length
      ? 'SnowLuma 配置里没有启用中的 HTTP/WS 服务端（networks.httpServers / wsServers）'
      : `没找到 SnowLuma 的 OneBot 配置（${join(cfgDir, 'onebot.json')}）`
  }
  registerSecret(out.httpToken)
  registerSecret(out.wsToken)
  return out
}

/**
 * 把 URL 里的敏感信息遮掉（面板/状态里展示用）：access_token 参数、userinfo 密码。
 * 非 URL 字符串原样返回（截断），避免面板显示报错。
 */
export function safeUrl(url) {
  const text = String(url || '').trim()
  if (!text) return ''
  try {
    const parsed = new URL(text)
    parsed.username = ''
    parsed.password = ''
    for (const key of ['access_token', 'token', 'key']) {
      if (parsed.searchParams.has(key)) parsed.searchParams.set(key, '***')
    }
    return parsed.toString()
  } catch (error) {
    return text.length > 160 ? `${text.slice(0, 160)}…` : text
  }
}

function configuredEndpoint(cfg) {
  const onebot = cfg?.onebot || {}
  return {
    httpUrl: String(onebot.httpUrl || ''),
    wsUrl: String(onebot.wsUrl || ''),
    httpToken: String(onebot.httpToken || ''),
    wsToken: String(onebot.wsToken || ''),
    httpAuth: ['bearer', 'header-token', 'query'].includes(onebot.httpAuth) ? onebot.httpAuth : 'bearer',
  }
}

/**
 * 解析当前配置要使用的连接端点（同步、只读）。
 *
 * - gateway='onebot'：直接用 onebot.httpUrl / wsUrl / token；
 * - gateway='snowluma'：探测 SnowLuma 并读它配置里的端点；读不到时回退到手填的 onebot.* 并给出原因。
 *
 * @param {object} cfg 插件配置
 * @returns {{
 *   endpoint: { httpUrl:string, wsUrl:string, httpToken:string, wsToken:string, httpAuth:string },
 *   safe: { mode:string, httpConfigured:boolean, wsConfigured:boolean, wsUrlSafe:string, httpUrlSafe:string, source:string },
 *   mode: 'onebot'|'snowluma', source: 'onebot'|'snowluma',
 *   snowluma: object, reason: string
 * }}
 */
export function resolveEndpoint(cfg) {
  const mode = cfg?.gateway === 'snowluma' ? 'snowluma' : 'onebot'
  const configured = configuredEndpoint(cfg)
  let endpoint = { ...configured }
  let source = 'onebot'
  let snowluma = null
  let reason = ''

  if (mode === 'snowluma') {
    const install = detectFirstInstall({ configured: String(cfg?.snowluma?.dir || '') })
    snowluma = install
    if (install.installed) {
      const read = readOneBotEndpoint(install.dir, cfg?.snowluma?.uin || cfg?.botQQ || '')
      snowluma.read = {
        found: read.found,
        uin: read.uin,
        files: read.files,
        sources: read.sources,
        reason: read.reason || '',
        httpConfigured: Boolean(read.httpUrl),
        wsConfigured: Boolean(read.wsUrl),
        httpUrlSafe: safeUrl(read.httpUrl),
        wsUrlSafe: safeUrl(read.wsUrl),
      }
      if (read.found) {
        endpoint = {
          httpUrl: read.httpUrl || configured.httpUrl,
          wsUrl: read.wsUrl || configured.wsUrl,
          httpToken: read.httpToken || configured.httpToken,
          wsToken: read.wsToken || configured.wsToken,
          httpAuth: configured.httpAuth,
        }
        source = 'snowluma'
      } else {
        reason = `${read.reason || 'SnowLuma 里没读到可用的 OneBot 端点'}；已回退到手填地址（onebot.*）`
      }
    } else {
      reason = `${install.reason || '没有找到 SnowLuma'}；已回退到手填地址（onebot.*）`
    }
  }

  const safe = {
    mode,
    httpConfigured: Boolean(endpoint.httpUrl),
    wsConfigured: Boolean(endpoint.wsUrl),
    wsUrlSafe: safeUrl(endpoint.wsUrl),
    httpUrlSafe: safeUrl(endpoint.httpUrl),
    source,
  }
  return { endpoint, safe, mode, source, snowluma, reason }
}

/**
 * 只读探测：SnowLuma 安装信息 + 当前解析出来的端点（不含明文 token）。
 * @param {object} cfg
 */
export function detectGateway(cfg) {
  const resolved = resolveEndpoint(cfg)
  return {
    mode: resolved.mode,
    source: resolved.source,
    endpoint: resolved.safe,
    snowluma: resolved.snowluma
      ? {
          installed: Boolean(resolved.snowluma.installed),
          dir: resolved.snowluma.dir || '',
          version: resolved.snowluma.version || '',
          reason: resolved.snowluma.reason || '',
          read: resolved.snowluma.read || null,
        }
      : null,
    reason: resolved.reason,
    candidates: (resolved.snowluma?.candidates || []).slice(0, 10),
    downloadPage: DOWNLOAD_PAGE,
  }
}
