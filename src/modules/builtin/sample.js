export function setup(api) {
  api.registerCommand('module-sample', () => '内置示例模块已启用。', { ownerOnly: true })
}
