// Populate only the isolated verification instance; never use a personal profile.
const base = 'http://127.0.0.1:3211/onebot-qq/api';
const gateway = 'http://127.0.0.1:6711';
async function request(url, body) {
  const response = await fetch(url, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(`${url}: ${data.message || response.status}`);
  return data;
}
const current = await request(`${base}/config`);
if (!current.dataDir.replaceAll('\\', '/').endsWith('/verify-out/plugin-data')) {
  throw new Error('Refusing to seed a non-verification data directory.');
}
// Only the bundled mock exposes this endpoint. Refuse to seed a real QQ gateway.
await request(`${gateway}/_mock/state`);
const config = current.config;
Object.assign(config, { enabled: true, botQQ: '20000002', accountCheck: 'enforce' });
Object.assign(config.onebot, { wsUrl: 'ws://127.0.0.1:6711', httpUrl: gateway, wsToken: 'mock-token-abcdef', httpToken: 'mock-token-abcdef' });
config.cognition.dryRun = true;
config.cognition.llm.mode = 'direct';
config.cognition.llm.fallbackToDsh = false;
config.cognition.proactivity.enabled = false;
config.ui.accent = 'blue';
await request(`${base}/config/save`, { config });
await request(`${base}/cognition/persona/switch`, { personaId: 'self' });
await request(`${base}/cognition/persona/edit`, { profile: {
  displayName: '小澄 · 演示人格', tagline: '清晰表达，认真记住每一次交流。',
  identity: 'dsh-bot 文档演示助手（虚构角色）', background: '用于开源项目文档的合成演示，不对应真实用户。',
  personality: '温和、好奇、有条理；承认不确定，尊重对话边界。',
  speakingStyle: '中文短句，先给结论，再补充必要细节。',
  likes: ['咖啡', '开源项目', '记录灵感'], boundaries: ['不编造事实', '不泄露隐私', '不主动打扰'],
  examples: '可以，我们先把目标拆成两步。\n这条我还不确定，先标记下来。',
}, reason: 'public documentation demo' });
const library = await request(`${base}/cognition/persona`);
if (!library.personas.some(p => p.displayName === '小岚 · 演示人格')) {
  await request(`${base}/cognition/persona/create`, { name: '小岚 · 演示人格', activate: false });
}
await request(`${base}/cognition/persona/switch`, { personaId: 'self' });
await request(`${base}/connect`, {});
let status;
for (let i = 0; i < 40; i++) {
  status = await request(`${base}/status`);
  if (status.gateway.loginCheck === 'ok') break;
  await new Promise(resolve => setTimeout(resolve, 250));
}
if (status.gateway.loginCheck !== 'ok') throw new Error('Mock gateway verification did not complete.');
for (const [nickname,userId,message] of [
  ['演示用户 A', '10001', '这周想把开源项目的安装流程整理清楚。'],
  ['演示用户 B', '10002', '我准备了测试步骤，也记下了遇到的问题。'],
  ['演示用户 A', '10001', '我喜欢咖啡，周末通常会读一会儿技术文档。'],
  ['演示用户 B', '10002', '先验证连接，再检查事件流和人格配置。'],
]) await request(`${gateway}/_mock/push`, { type: 'group', groupId: '30000001', userId, nickname, message });
console.log('Demo seeded: verified mock gateway, synthetic personas/messages; dry run, no external model fallback.');
