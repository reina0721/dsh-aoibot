// 静态、受信任的包内目录；禁止文件系统发现。关闭时不调用 load。
export const builtinRegistry = Object.freeze([
  Object.freeze({
    manifest: Object.freeze({
      id: 'builtin-sample', name: '内置示例', version: '1.0.0',
      description: '默认关闭的模块 API 示例', entry: 'builtin/sample.js', apiVersion: 1,
      permissions: Object.freeze(['commands', 'storage']), requires: Object.freeze([]),
    }),
    defaultEnabled: false,
    config: Object.freeze({
      version: 1,
      fields: Object.freeze([
        Object.freeze({ path: 'message', type: 'text', label: '示例回复', default: '内置示例模块已启用。', maxChars: 200, help: '主人使用 /module-sample 时发送的回复。' }),
      ]),
    }),
    load: () => import('./builtin/sample.js'),
  }),
])
