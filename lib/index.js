/**
 * dsh-proxy-switch —— 只让 DSH 走代理。
 *
 * DSH 的出站代理只来自启动环境；启动器在加载任何插件之前就已经给 undici 装好了全局
 * dispatcher。所以「只给某一个进程挂代理」既不能靠 Windows 系统代理，也不能靠 TUN /
 * 虚拟网卡——那两者都是整机级别。插件能补的正好是这一步：在运行时重新安装同一个
 * dispatcher。
 *
 * 这里刻意复用 DSH 自己的 `installProxyFromEnvironment`：代理 URL 的校验、大小写变量
 * 名的取值顺序、loopback 永远直连、no_proxy 合并、把解析结果写回 process.env 供子进程
 * 继承，全部沿用官方实现，不再写第二套判断。因此插件装上的路由和启动器装上的永远一致，
 * 也不会出现「dispatcher 按一种规则、web-fetch 按另一种规则」的分裂。
 *
 * 边界（诚实版）：
 *  - 覆盖插件加载之后、经由 DSH 那份 undici 发出的请求：网页抓取、模型请求、MCP、插件
 *    安装；
 *  - 不覆盖 worker（PTC runtime / workflow 引擎各有自己的 globalThis），也不覆盖插件加载
 *    之前 boot 阶段发出的请求；
 *  - 会把解析后的代理变量写进 process.env，因此 DSH 派生的子进程会继承这份代理。
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-proxy-switch'

export const Config = Schema.object({
  enabled: Schema.boolean().default(false).description(
    '插件加载时是否立刻把 DSH 接到下面的代理。默认关闭：装好之后不改变任何网络行为，确认代理已在监听后再打开。',
  ),
  url: Schema.string().default('http://127.0.0.1:7890').description(
    '本机 HTTP 代理地址，必须带 http:// 或 https://。SOCKS 地址会被 DSH 拒绝并跳过（该协议下仍然直连）。',
  ),
  noProxy: Schema.string().default('').description(
    '逗号分隔的直连名单，会和 DSH 的 loopback 默认名单合并。留空表示除 loopback 外全部走代理。',
  ),
  probeUrl: Schema.string().default('https://www.gstatic.com/generate_204').description(
    '/proxy test 与 /proxy on 的自动校验所用的目标地址。',
  ),
})

const DISPLAY_NAME = 'dsh-proxy-switch'
const FALLBACK_URL = 'http://127.0.0.1:7890'
const FALLBACK_PROBE = 'https://www.gstatic.com/generate_204'
const PROXY_ENV_NAMES = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
]

/** 当前这一份安装：dispose 是官方 install 返回的还原函数。 */
const state = {
  dispose: undefined,
  url: undefined,
  note: '尚未安装',
  diagnostics: [],
}

// ── 从 DSH 安装位置加载它自己的模块 ────────────────────────────────────────────
// 插件在 profile 目录下运行，而 @deepseek-ai/dsh-http-proxy 是 DSH 安装目录里的依赖，
// 从 profile 解析不到。必须拿到与启动器完全相同的那个模块实例：dispatcher 的状态和
// undici 实例都挂在模块作用域上，另起一份副本等于装到一个没人用的对象上。

let cachedRequire
let probed = false

/** 找到 @deepseek-ai/dsh 的 package.json，并从那里建 require。 */
function dshRequire() {
  if (probed) return cachedRequire
  probed = true
  const starts = []
  const entry = process.argv?.[1]
  if (entry) starts.push(dirname(entry))
  starts.push(process.cwd())
  for (const start of starts) {
    let dir = start
    for (let depth = 0; depth < 8; depth += 1) {
      const manifest = join(dir, 'package.json')
      if (existsSync(manifest)) {
        try {
          if (JSON.parse(readFileSync(manifest, 'utf8')).name === '@deepseek-ai/dsh') {
            cachedRequire = createRequire(manifest)
            return cachedRequire
          }
        } catch {
          // 读不动或不是 JSON，继续往上找
        }
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return cachedRequire
}

/** 优先按 DSH 安装目录解析（同一模块实例），退而求其次才用普通 bare specifier。 */
async function loadShipped(spec) {
  const require = dshRequire()
  if (require) {
    try {
      return await import(pathToFileURL(require.resolve(spec)).href)
    } catch (error) {
      const code = error?.code
      if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') throw error
    }
  }
  try {
    return await import(spec)
  } catch (error) {
    throw new Error(
      `找不到 ${spec}：DSH 安装目录没有定位到（process.argv[1] = ${process.argv?.[1] ?? '?'}），portable 安装下请把本插件装在 DSH 自带 profile 里。原因：${error?.code ?? error?.message ?? error}`,
    )
  }
}

// ── 把配置翻译成 DSH 认识的那份「启动环境」 ───────────────────────────────────
// readEnv 只做 env.get(name)?.value.trim()，所以一个带 get 的普通对象就够。

function environmentFor(url, noProxy) {
  const names = { http_proxy: url, https_proxy: url }
  const bypass = String(noProxy ?? '').trim()
  if (bypass) names.no_proxy = bypass
  return {
    get(key) {
      return Object.hasOwn(names, key) ? { value: names[key] } : undefined
    },
  }
}

// ── 安装 / 还原 ──────────────────────────────────────────────────────────────

async function arm(logger, config) {
  await disarm(logger)

  const url = String(config?.url ?? '').trim()
  if (config?.enabled === false) {
    state.note = '已关闭（配置 enabled: false）'
    return
  }
  if (!url) {
    state.note = '已关闭（没有填写代理地址）'
    return
  }

  let proxy
  try {
    proxy = await loadShipped('@deepseek-ai/dsh-http-proxy')
  } catch (error) {
    state.note = error?.message ?? String(error)
    logger.warn(state.note)
    return
  }

  const rejected = []
  try {
    state.dispose = await proxy.installProxyFromEnvironment(
      environmentFor(url, config?.noProxy),
      (message) => rejected.push(String(message)),
    )
  } catch (error) {
    state.note = `安装失败：${error?.message ?? error}`
    logger.warn(state.note)
    return
  }

  state.url = url
  state.diagnostics = rejected
  state.note = rejected.length ? '已安装（有取值被拒绝，见下）' : '已安装'
  for (const message of rejected) logger.warn(message)
}

async function disarm(logger) {
  const dispose = state.dispose
  state.dispose = undefined
  state.url = undefined
  state.diagnostics = []
  if (!dispose) {
    state.note = '未开启'
    return
  }
  try {
    await dispose()
    state.note = '已关闭（还原了加载前的 dispatcher）'
  } catch (error) {
    state.note = `关闭时出错：${error?.message ?? error}`
    logger?.warn?.(state.note)
  }
}

// ── 探测 ────────────────────────────────────────────────────────────────────

async function probeThrough(rawTarget) {
  const target = String(rawTarget ?? '').trim() || FALLBACK_PROBE
  const started = Date.now()
  try {
    const undici = await loadShipped('undici')
    const response = await undici.fetch(target, {
      signal: AbortSignal.timeout(8000),
      redirect: 'manual',
    })
    try {
      await response.body?.cancel()
    } catch {
      // 204 之类没有 body，取消失败不影响结论
    }
    return { ok: true, detail: `${target} → HTTP ${response.status}，${Date.now() - started} ms` }
  } catch (error) {
    const code = error?.cause?.code ?? error?.code
    const reason = code ?? error?.cause?.message ?? error?.message ?? String(error)
    return { ok: false, code, detail: `${target} 请求失败（${reason}），${Date.now() - started} ms` }
  }
}

/** 端口没人监听时给一条能直接照做的提示，而不是让用户猜。 */
function listeningHint(url, code) {
  if (code !== 'ECONNREFUSED') return ''
  let host
  let port
  try {
    const parsed = new URL(url)
    host = parsed.hostname
    port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
  } catch {
    return ''
  }
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  if (!local) return ''
  return `\n提示：${host}:${port} 上没有程序在监听。FlClash 的内核没启动时就是这样——打开 FlClash 点「启动」按钮，保持系统代理与 TUN 关闭，确认 Test-NetConnection 127.0.0.1 -Port ${port} 返回 True 之后再执行 /proxy on。`
}

// ── 状态文本 ─────────────────────────────────────────────────────────────────

function describeEnv() {
  const seen = PROXY_ENV_NAMES
    .filter((key) => typeof process.env[key] === 'string' && process.env[key] !== '')
    .map((key) => `${key}=${process.env[key]}`)
  return seen.length
    ? `进程内代理变量：${seen.join('  ')}`
    : '进程内没有代理变量：DSH 派生的子进程不会继承代理。'
}

function statusText(config) {
  const lines = [
    `状态：${state.dispose ? '已开启' : '未开启'}（${state.note}）`,
    `目标代理：${state.url ?? config?.url ?? FALLBACK_URL}`,
    `直连名单：${String(config?.noProxy ?? '').trim() || '（仅 loopback，DSH 默认）'}`,
  ]
  if (state.diagnostics.length) lines.push(`被拒绝的取值：${state.diagnostics.join('；')}`)
  lines.push(describeEnv())
  return lines.join('\n')
}

// ── /proxy 命令 ──────────────────────────────────────────────────────────────

const success = (text) => ({ kind: 'success', text })
const failure = (text) => ({ kind: 'error', text })

function findCommands(ctx) {
  try {
    const found = ctx?.get?.('commands')
    if (found) return found
  } catch {
    // 服务还没就位
  }
  try {
    return ctx?.commands
  } catch {
    return undefined
  }
}

function registerProxyCommand(ctx, logger, currentConfig) {
  const definition = {
    name: 'proxy',
    description:
      '只给 DSH 挂代理：/proxy status | /proxy test | /proxy on [http://127.0.0.1:7890] | /proxy off',
    input: { hint: '[status|test|on|off] [代理地址]' },
    handler: (invocation) => runCommand(invocation, logger, currentConfig),
  }

  // commands 服务可能比本插件晚就位：用 cordis 的 inject 等它，而不是悄悄跳过注册。
  // 这一步只影响 /proxy 命令，不挡代理本身——代理已经装上了。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['commands'], (scoped) => {
      const commands = scoped.commands ?? findCommands(scoped)
      if (!commands || typeof commands.register !== 'function') {
        logger.warn('commands 服务不可用，/proxy 命令没有注册；配置本身仍然生效。')
        return
      }
      scoped.effect(() => commands.register(definition))
    })
    return
  }

  const commands = findCommands(ctx)
  if (!commands || typeof commands.register !== 'function') {
    logger.warn('commands 服务不可用，/proxy 命令没有注册；配置本身仍然生效。')
    return
  }
  ctx.effect(() => commands.register(definition))
}

async function runCommand(invocation, logger, currentConfig) {
  const tokens = String(invocation?.rawInput ?? '').trim().split(/\s+/).filter(Boolean)
  const verb = (tokens.shift() ?? 'status').toLowerCase()
  const config = currentConfig() ?? {}

  if (verb === 'off') {
    await disarm(logger)
    return success(`DSH 代理已关闭。\n${statusText(config)}`)
  }

  if (verb === 'on') {
    const url = String(tokens[0] ?? config.url ?? FALLBACK_URL).trim()
    await arm(logger, { ...config, enabled: true, url })
    if (!state.dispose) return failure(`代理没有装上：${state.note}`)

    const probe = await probeThrough(config.probeUrl)
    if (!probe.ok) {
      await disarm(logger)
      return failure(
        `代理 ${url} 装上了但探测失败，已自动回滚，避免把 DSH 自己的模型请求一起断掉。\n${probe.detail}${listeningHint(url, probe.code)}`,
      )
    }
    return success(`DSH 现在走 ${url}，其它程序不受影响。\n探测：${probe.detail}\n${describeEnv()}`)
  }

  if (verb === 'test') {
    const probe = await probeThrough(config.probeUrl)
    return success(`${probe.ok ? '通' : '不通'}（${state.dispose ? '代理已开启' : '代理未开启，直连'}）\n${probe.detail}`)
  }

  const hint = verb === 'status' ? '' : `\n（不认识的子命令 ${verb}，已按 status 处理）`
  return success(`${statusText(config)}${hint}`)
}

// ── 插件入口 ─────────────────────────────────────────────────────────────────

function makeLogger(ctx) {
  const candidate = ctx?.logger
  if (typeof candidate === 'function') {
    try {
      const scoped = candidate(DISPLAY_NAME)
      if (scoped && typeof scoped.warn === 'function') return scoped
    } catch {
      // 不是 scoped logger 工厂，退回下面两种
    }
  }
  if (candidate && typeof candidate.warn === 'function') return candidate
  return {
    info: (...args) => console.log(`[${DISPLAY_NAME}]`, ...args),
    warn: (...args) => console.warn(`[${DISPLAY_NAME}]`, ...args),
  }
}

export async function apply(ctx, config) {
  const logger = makeLogger(ctx)

  // 卸载 / 热重载 / 配置变更时都要把 dispatcher 还回去，不能留下半开状态。
  ctx.effect(() => () => {
    void disarm(logger)
  })

  registerProxyCommand(ctx, logger, () => config)
  await arm(logger, config)
  logger.info?.(`${DISPLAY_NAME}: ${state.note}${state.url ? ` → ${state.url}` : ''}`)
}
