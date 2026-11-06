// Manual global registry only. Nothing here creates, merges or edits a person,
// verifies account ownership, routes messages or contacts another platform.
import { randomBytes } from 'node:crypto'
import { scanText } from '../core/leak-guard.js'

// Keep legacy persona-scoped identity records and their migration untouched.
const KIND = 'manual_identity'
const PLATFORMS = ['qq', 'telegram', 'discord', 'matrix', 'custom']
const MAX_ROWS = 5000

function platformOf(value) {
  if (!PLATFORMS.includes(value)) throw new Error('IDENTITY_INVALID_PLATFORM')
  return value
}

function identifier(value, pattern, max, field) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || !pattern.test(value)) throw new Error(`IDENTITY_INVALID_${field}`)
  if (scanText(value).matched) throw new Error('IDENTITY_SECRET')
  return value
}

function keyOf({ platform, externalId } = {}) {
  return { platform: platformOf(platform), externalId: identifier(externalId, /^[A-Za-z0-9_.:@-]+$/, 64, 'EXTERNAL_ID') }
}

function personOf(value) {
  return identifier(value, /^[A-Za-z0-9_-]+$/, 80, 'PERSON_ID')
}

function labelOf(value) {
  if (typeof value !== 'string' || Array.from(value).length > 80 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) throw new Error('IDENTITY_INVALID_LABEL')
  if (scanText(value).matched) throw new Error('IDENTITY_SECRET')
  return value.trim()
}

export function createIdentityService({ store, clock = { now: Date.now }, logger } = {}) {
  const log = logger?.child?.('identities') || logger
  const rows = () => store.list(KIND, { limit: MAX_ROWS + 1 })
  const find = (items, key) => items.find((row) => row.platform === key.platform && row.externalId === key.externalId) || null

  function link({ platform, externalId, personId, label } = {}) {
    const key = keyOf({ platform, externalId })
    const person = personOf(personId)
    const cleanLabel = label === undefined ? undefined : labelOf(label)
    const items = rows()
    const previous = find(items, key)
    if (!previous && items.length >= MAX_ROWS) throw new Error('IDENTITY_FULL')
    const now = clock.now()
    const row = {
      id: previous?.id || 'idn_' + randomBytes(12).toString('hex'),
      ...key,
      personId: person,
      label: cleanLabel ?? previous?.label ?? '',
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      source: 'manual',
    }
    const saved = store.put(KIND, row.id, row, { createdAt: row.createdAt, updatedAt: row.updatedAt })
    log?.debug?.('Manual identity link saved', row.id)
    return saved
  }

  function list({ platform, personId, limit = 100 } = {}) {
    if (platform !== undefined) platformOf(platform)
    if (personId !== undefined) personOf(personId)
    if (!Number.isInteger(limit) || limit < 1) throw new Error('IDENTITY_INVALID_LIMIT')
    return rows()
      .filter((row) => (platform === undefined || row.platform === platform) && (personId === undefined || row.personId === personId))
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      .slice(0, Math.min(100, limit))
  }

  function resolve(input) {
    const key = keyOf(input)
    return find(rows(), key)
  }

  function unlink(input) {
    const row = resolve(input)
    if (!row) return false
    store.remove(KIND, row.id)
    log?.debug?.('Manual identity link removed', row.id)
    return true
  }

  function counts() {
    const items = rows()
    const byPlatform = Object.fromEntries(PLATFORMS.map((platform) => [platform, 0]))
    for (const row of items) byPlatform[row.platform] += 1
    return { total: items.length, byPlatform }
  }

  return { link, list, resolve, unlink, counts }
}
