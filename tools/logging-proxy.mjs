/**
 * 最小的可观测 HTTP 代理，只用于本地验证 dsh-proxy-switch 到底有没有接管流量。
 *
 * 用法：node tools/logging-proxy.mjs <日志文件> [端口]
 *  - CONNECT 隧道（HTTPS 走这里）与普通 HTTP 转发都会先追加一行到日志；
 *  - 只是转发，不改写内容，因此被代理的客户端拿到的是真实响应。
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'

const logFile = process.argv[2] ?? 'proxy.log'
const port = Number(process.argv[3] ?? 7899)

writeFileSync(logFile, '')
appendFileSync(logFile, `# listening on 127.0.0.1:${port}\n`)

const server = http.createServer((req, res) => {
  appendFileSync(logFile, `HTTP ${req.method} ${req.url}\n`)
  let target
  try {
    target = new URL(req.url)
  } catch {
    res.writeHead(400)
    res.end('absolute-form URL required')
    return
  }
  const upstream = http.request(
    {
      host: target.hostname,
      port: Number(target.port || 80),
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers: req.headers,
    },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(res)
    },
  )
  upstream.on('error', (error) => {
    if (!res.headersSent) res.writeHead(502)
    res.end(String(error))
  })
  req.pipe(upstream)
})

server.on('connect', (req, socket, head) => {
  appendFileSync(logFile, `CONNECT ${req.url}\n`)
  const [host, portText] = String(req.url).split(':')
  const upstream = net.connect(Number(portText ?? 443), host, () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head?.length) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`proxy ready http://127.0.0.1:${port} log=${logFile}\n`)
})
