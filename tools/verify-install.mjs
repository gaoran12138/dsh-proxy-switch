/**
 * 在真实 DSH 之外把插件跑一遍，验证三件事：
 *  1. 插件能按 DSH 安装位置解析到 @deepseek-ai/dsh-http-proxy（和启动器同一实例）；
 *  2. apply 之后，走 DSH 那份 undici 的请求真的进了代理（日志里出现 CONNECT）；
 *  3. dispose 之后流量回到直连（日志不再增长）。
 *
 * 关键技巧：先把 process.argv[1] 指到 DSH 的入口，插件就会像在真进程里一样定位安装目录。
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const DSH_ENTRY = 'A:/node.js/node_global/node_modules/@deepseek-ai/dsh/lib/bin.js'
const PROXY = 'http://127.0.0.1:7899'
const TARGET = 'https://www.baidu.com/'
const LOG = new URL('./proxy.log', import.meta.url)

process.argv[1] = DSH_ENTRY

const dshRequire = createRequire('A:/node.js/node_global/node_modules/@deepseek-ai/dsh/package.json')
const undici = await import(pathToFileURL(dshRequire.resolve('undici')).href)
const plugin = await import(new URL('../lib/index.js', import.meta.url).href)

const disposers = []
const logs = []
const ctx = {
  effect: (callback) => {
    const disposer = callback()
    if (typeof disposer === 'function') disposers.push(disposer)
  },
  get: () => undefined,
  logger: { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) },
}

const readLog = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8') : '')
const connectLines = () => readLog().split('\n').filter((line) => line.startsWith('CONNECT')).length

function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`)
  if (!ok) process.exitCode = 1
}

await plugin.apply(ctx, {
  enabled: true,
  url: PROXY,
  noProxy: '',
  probeUrl: TARGET,
})

const first = await undici.fetch(TARGET, { signal: AbortSignal.timeout(15000) })
await first.body?.cancel?.()
check('apply 后请求成功', first.status < 400, `HTTP ${first.status}`)
check('流量进了代理', connectLines() >= 1, `CONNECT 次数 ${connectLines()}`)
check('进程内出现代理变量', Boolean(process.env.HTTPS_PROXY || process.env.https_proxy), process.env.HTTPS_PROXY ?? '(none)')

const beforeDispose = connectLines()
await disposers[0]?.()
const second = await undici.fetch(TARGET, { signal: AbortSignal.timeout(15000) })
await second.body?.cancel?.()
check('dispose 后仍然能上网', second.status < 400, `HTTP ${second.status}`)
check('dispose 后不再经过代理', connectLines() === beforeDispose, `CONNECT 次数 ${connectLines()}`)

console.log('\n插件日志：')
for (const [level, message] of logs) console.log(`  [${level}] ${message}`)
