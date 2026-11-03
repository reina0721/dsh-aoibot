// 本地 mock 模型服务：协议适配测试不访问外网。
import { createServer } from 'node:http'

export async function startMockModelServer(handler) {
  const calls = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks).toString('utf8')
    let body = null
    try { body = raw ? JSON.parse(raw) : null } catch (error) { body = raw }
    const call = { method: req.method, url: req.url, headers: req.headers, body, raw }
    calls.push(call)
    try {
      await handler(req, res, call)
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      if (!res.writableEnded) res.end(JSON.stringify({ error: { message: String(error?.message || error) } }))
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => new Promise((resolve) => {
      try { server.closeAllConnections?.() } catch (error) {}
      server.close(resolve)
    }),
  }
}

export function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

export function sse(res, chunks, { status = 200 } = {}) {
  res.writeHead(status, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const chunk of chunks) res.write(chunk)
  res.end()
}

export function sseEvents(events) {
  return events.map((event) => {
    const payload = typeof event.data === 'string' ? event.data : JSON.stringify(event.data)
    return `event: ${event.event || 'message'}\ndata: ${payload}\n\n`
  })
}

export function ndjson(res, rows) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' })
  for (const row of rows) res.write(JSON.stringify(row) + '\n')
  res.end()
}
