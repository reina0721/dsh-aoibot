// 两种来源共享清单；来源与操作能力只能由加载器赋值。
export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const PERMISSIONS = new Set(['events', 'commands', 'send:text', 'cognition:read', 'knowledge', 'capabilities', 'storage', 'delivery:plan', 'turn:lifecycle', 'status:write'])

export function validateManifest(manifest, { builtin = false, directoryName } = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('module.json 必须是对象')
  const id = String(manifest.id || '')
  if (!ID_RE.test(id)) throw new Error('manifest.id 不合法')
  if (builtin !== id.startsWith('builtin-')) throw new Error(builtin ? '内置模块 id 必须以 builtin- 开头' : 'builtin- 是内置模块保留前缀')
  if (directoryName !== undefined && id !== directoryName) throw new Error(`manifest.id 必须与目录名一致（${directoryName}）`)
  const apiVersion = manifest.apiVersion === undefined ? 1 : manifest.apiVersion
  if (apiVersion !== 1) throw new Error('不支持的 manifest.apiVersion（仅支持 1）')
  const permissions = manifest.permissions === undefined ? [] : manifest.permissions
  if (!Array.isArray(permissions) || permissions.some((item) => typeof item !== 'string')) throw new Error('manifest.permissions 必须是字符串数组')
  const unknown = permissions.find((item) => !PERMISSIONS.has(item))
  if (unknown) throw new Error(`未知 permission：${unknown}`)
  const requires = manifest.requires === undefined ? [] : manifest.requires
  if (!Array.isArray(requires) || requires.length > 16 || requires.some((item) => typeof item !== 'string' || !ID_RE.test(item))) throw new Error('manifest.requires 必须是有效模块 id 数组，最多 16 项')
  if (new Set(requires).size !== requires.length) throw new Error('manifest.requires 不能重复')
  if (requires.includes(id)) throw new Error('manifest.requires 不能依赖自身')
  return {
    id, name: String(manifest.name || id), version: String(manifest.version || ''),
    description: String(manifest.description || ''), entry: String(manifest.entry || ''),
    permissions: [...new Set(permissions)], apiVersion, requires: [...requires],
    manifestEnabled: manifest.enabled !== false,
  }
}
