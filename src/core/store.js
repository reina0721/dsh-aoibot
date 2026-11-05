// 数据目录与 JSON 读写工具。
// 移植/改写自 aureth-labs/dsh-aurabot-qq 的 src/core/store.js（MIT，见 THIRD_PARTY_NOTICES.md），
// 增加了本插件独立的数据目录名与 JSONL 追加/轮转支持。

import {
  readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, appendFileSync,
  statSync, truncateSync, rmSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

/** DSH 主目录（`$DSH_HOME`，默认 `~/.dsh`）。 */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 本插件所有持久化数据都在这里；测试可用 `DSH_BOT_DATA_DIR` 覆盖。 */
export function dataDir(...parts) {
  const base = process.env.DSH_BOT_DATA_DIR || join(dshHome(), 'plugins-data', 'dsh-bot')
  return join(base, ...parts)
}

export function ensureDir(p) {
  mkdirSync(p, { recursive: true })
  return p
}

/** 读 JSON；文件缺失或损坏时返回 fallback（函数会被调用）。 */
export function readJson(file, fallback) {
  try {
    let text = readFileSync(file, 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    return JSON.parse(text)
  } catch (error) {
    return typeof fallback === 'function' ? fallback() : fallback
  }
}

/** 原子写 JSON：先写临时文件再 rename，读方永远看到完整内容。 */
export function writeJson(file, value) {
  ensureDir(dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

/** 追加一行 JSONL；文件超过 maxBytes 时先轮转成 `.1`（只保留一份旧档）。 */
export function appendJsonl(file, value, { maxBytes = 0 } = {}) {
  ensureDir(dirname(file))
  try {
    if (maxBytes > 0 && existsSync(file) && statSync(file).size > maxBytes) {
      try {
        renameSync(file, `${file}.1`)
      } catch (error) {
        truncateSync(file, 0)
      }
    }
  } catch (error) {
    // 忽略轮转失败：写日志不能因为轮转把主流程带崩
  }
  appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8')
}

/** 读 JSONL 的尾部若干行（用于重启后回看最近事件）。 */
export function tailJsonl(file, limit = 100) {
  try {
    const text = readFileSync(file, 'utf8')
    const lines = text.split('\n').filter(Boolean)
    return lines.slice(-Math.max(1, limit)).map((line) => {
      try {
        return JSON.parse(line)
      } catch (error) {
        return null
      }
    }).filter(Boolean)
  } catch (error) {
    return []
  }
}

export function removeFile(file) {
  try {
    rmSync(file, { force: true })
  } catch (error) {}
}

export { existsSync, statSync }
