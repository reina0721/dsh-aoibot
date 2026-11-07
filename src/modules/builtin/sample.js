export function setup(api) {
  api.registerCommand('module-sample', () => api.config.get().message, { ownerOnly: true })
}
