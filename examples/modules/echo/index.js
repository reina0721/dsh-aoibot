// `.js` outside a `type: module` package uses CommonJS; `.mjs` modules may use
// `export function setup(api) { ... }` instead.
exports.setup = async function setup(api) {
  api.on('message', async () => {
    const count = await api.storage.get('messageCount', 0)
    await api.storage.set('messageCount', count + 1)
  })

  api.registerCommand('echo', async ({ args }) => {
    const count = await api.storage.get('messageCount', 0)
    return { reply: `${args || 'echo'}（已观察 ${count} 条消息）` }
  })
}
