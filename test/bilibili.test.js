import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createBilibiliService } from '../src/content/bilibili.js'

function response(data, { ok = true, status = 200 } = {}) {
  return { ok, status, async json() { return data } }
}

function service(payloads, config = { enabled: true, timeoutMs: 15000, maxResults: 2 }) {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options })
    const next = payloads.shift()
    if (next instanceof Error) throw next
    return next
  }
  return { calls, api: createBilibiliService({ getConfig: () => ({ content: { bilibili: config } }), fetchImpl }) }
}

test('bilibili：解析搜索、热门与视频并规范化字段', async () => {
  const { api, calls } = service([
    response({ code: 0, data: { result: [{ title: '<em class="keyword">猫</em>咪', author: 'UP1', play: 12, duration: '1:02', bvid: 'BVsearch1' }] } }),
    response({ code: 0, data: { list: [{ title: '热门', owner: { name: 'UP2' }, stat: { view: 34 }, duration: 125, bvid: 'BVpopular1' }] } }),
    response({ code: 0, data: { title: '详情', owner: { name: 'UP3' }, stat: { view: 56 }, duration: 3, bvid: 'BVdetail1' } }),
  ])
  assert.deepEqual((await api.search('猫')).items[0], { title: '猫咪', author: 'UP1', play: 12, duration: '01:02', url: 'https://www.bilibili.com/video/BVsearch1', bvid: 'BVsearch1' })
  assert.equal((await api.hot()).items[0].duration, '02:05')
  assert.equal((await api.video('BVdetail1')).items[0].author, 'UP3')
  assert.match(calls[0].url, /search\/type/)
  assert.equal(calls[0].options.headers.Referer, 'https://www.bilibili.com/')
})

test('bilibili：非零 code、HTTP、超时/网络错误给清晰错误', async () => {
  const coded = service([response({ code: -412, message: 'blocked' })]).api
  await assert.rejects(() => coded.hot(), /不使用 Cookie\/WBI/)
  const http = service([response({}, { ok: false, status: 503 })]).api
  await assert.rejects(() => http.hot(), /HTTP 503/)
  const failed = service([new Error('socket secret')]).api
  await assert.rejects(() => failed.hot(), /^Error: B站请求失败$/)
  const timedOut = service([new DOMException('timed out', 'TimeoutError')]).api
  await assert.rejects(() => timedOut.hot(), /B站请求超时/)
})

test('bilibili：默认关闭且不发起网络请求', async () => {
  let fetched = 0
  const api = createBilibiliService({ getConfig: () => ({}), fetchImpl: async () => { fetched += 1 } })
  await assert.rejects(() => api.hot(), /B站内容未启用/)
  assert.equal(fetched, 0)
})
