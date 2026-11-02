#!/usr/bin/env node
// 独立人工联调用的假 OneBot v11 网关：固定端口 6700，打印 WS/HTTP 地址与 token。
//
// 用途（见 docs/USER-MANUAL.md「本地自测」）：
//   在没装 NapCat / SnowLuma 时，用这个脚本起一个内存假网关，把面板里的地址填成它打印的地址，
//   就能完整点一遍「连接 → 账号核验 → 消息 → 事件 → 发送」流程。
//
// 用法：
//   node scripts/mock-gateway.mjs                    # 127.0.0.1:6700，默认 token
//   node scripts/mock-gateway.mjs --port 6701        # 换端口
//   node scripts/mock-gateway.mjs --token my-token   # 换 token（留空字符串 = 不校验）
//   node scripts/mock-gateway.mjs --self-id 123456789 --nickname 我的机器人
//   node scripts/mock-gateway.mjs --no-heartbeat     # 不自动推心跳事件
//
// Ctrl+C 退出（会关闭监听端口）。这个脚本只是测试替身，不要拿它对接真实 QQ。

import process from 'node:process'

import { startMockOneBot } from '../test/helpers/mock-onebot.js'

function readArg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && index + 1 < process.argv.length) {
    const value = process.argv[index + 1]
    if (!value.startsWith('--')) return value
  }
  const inline = process.argv.find((item) => item.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  return fallback
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`)
}

function printHelp() {
  console.log(`dsh-onebot-qq 假 OneBot v11 网关（人工联调用）

用法：node scripts/mock-gateway.mjs [选项]
  --port <端口>        监听端口（默认 6700，0 = 随机）
  --token <token>      访问 token（默认 mock-token-abcdef；传空字符串不校验）
  --self-id <QQ号>     模拟登录的机器人 QQ 号（默认 20000002）
  --nickname <昵称>    模拟登录昵称（默认 测试机器人）
  --no-heartbeat       不自动每 30s 推一条心跳事件
  --help               显示本帮助

启动后把打印的 ws:// 与 http:// 地址、token 填进 DSH 面板「连接」页即可。`)
}

if (hasFlag('help') || hasFlag('h')) {
  printHelp()
  process.exit(0)
}

const port = Number(readArg('port', '6700'))
const token = readArg('token', 'mock-token-abcdef')
const selfId = readArg('self-id', '20000002')
const nickname = readArg('nickname', '测试机器人')
const heartbeat = !hasFlag('no-heartbeat')

let mock
try {
  mock = await startMockOneBot({ port, token, selfId, nickname })
} catch (error) {
  if (error && error.code === 'EADDRINUSE') {
    console.error(`✖ 端口 ${port} 已被占用：换一个 --port，或先关掉占用该端口的程序。`)
  } else {
    console.error(`✖ 启动假网关失败：${error?.message || error}`)
  }
  process.exit(1)
}

console.log('')
console.log('dsh-onebot-qq 假 OneBot v11 网关已启动（Ctrl+C 退出）')
console.log('──────────────────────────────────────────────')
console.log(`  WS 地址（正向 WebSocket） : ${mock.wsUrl}`)
console.log(`  HTTP 地址                 : ${mock.httpUrl}`)
console.log(`  access token              : ${mock.token || '(不校验)'}`)
console.log(`  机器人 QQ 号 / 昵称       : ${mock.selfId} / ${nickname}`)
console.log('')
console.log('在 DSH 插件面板「连接」标签里填写：')
console.log(`  网关类型                 : 连接已有 OneBot v11 地址`)
console.log(`  WebSocket 地址           : ${mock.wsUrl}`)
console.log(`  HTTP 地址                : ${mock.httpUrl}`)
console.log(`  WS / HTTP access token   : ${mock.token || '(留空)'}`)
console.log(`  机器人 QQ 号             : ${mock.selfId}`)
console.log('')
console.log('mock 控制端点（浏览器/curl 可用）：')
console.log(`  GET  ${mock.httpUrl}/_mock/state                     查看连接数、调用数、事件数`)
console.log(`  GET  ${mock.httpUrl}/_mock/calls                     查看收到的全部 action 调用`)
console.log(`  POST ${mock.httpUrl}/_mock/push                      主动推事件：`)
console.log(`       {"type":"private","userId":10001,"message":"你好"}`)
console.log(`       {"type":"group","groupId":30001,"userId":10001,"message":"群消息"}`)
console.log(`       {"type":"notice","noticeType":"friend_recall","userId":10001}`)
console.log(`  POST ${mock.httpUrl}/_mock/config                    改模拟状态：{"loginUserId":"99999999"} / {"loginDelayMs":500}`)
console.log(`  POST ${mock.httpUrl}/_mock/clear                     清空调用记录`)
console.log('')
console.log('提示：把 state.loginUserId 改成别的号（如 mock 控制端点 /_mock/config），')
console.log('      可以在面板里验证「账号不一致」的 warn / enforce 行为。')
console.log('')

let timer = null
if (heartbeat) {
  timer = setInterval(() => {
    try {
      mock.pushHeartbeat()
    } catch (error) {}
  }, 30_000)
  if (typeof timer.unref === 'function') timer.unref()
}

let closing = false
async function shutdown(signal) {
  if (closing) return
  closing = true
  if (timer) clearInterval(timer)
  console.log(`\n收到 ${signal}，正在关闭假网关…`)
  try {
    await mock.close()
  } catch (error) {}
  console.log('已关闭。')
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
