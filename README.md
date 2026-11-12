# dsh-proxy-switch

只让 **DSH 这一个进程**走代理，本机其它程序照旧直连。

系统代理和 TUN / 虚拟网卡都是整机级别的，做不到「只给一个进程」。插件能补的正是这一步：
在运行时把 DSH 的 undici 全局 dispatcher 换成走代理的那个。它不自己实现规则，而是直接调用
DSH 启动器用的同一个 `installProxyFromEnvironment`，所以：

- 代理 URL 的校验、`https_proxy` / `HTTPS_PROXY` 的取值顺序、`ALL_PROXY` 回退、
  loopback 永远直连、`no_proxy` 合并，全部与 DSH 启动时一致；
- 解析出的代理变量会写回 `process.env`，DSH 派生的子进程因此也能继承；
- 关闭时把加载前的 dispatcher 原样还回去，不留半开状态。

## 安装

```powershell
# 在 DSH 里安装（进 profile 的 bundle 列表）
# plugin_manager: action=install_bundle, target=github:gaoran12138/dsh-proxy-switch
```

装好后默认 `enabled: false`，网络行为不变；确认要启用时再 `/proxy on`。

> 改完代码需要重装才生效：同名包再装会返回 `already-installed`，先 `remove_bundle` 再
> `install_bundle`。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 插件加载时是否立刻接上代理。默认关闭，装好不改变任何网络行为。 |
| `url` | `http://127.0.0.1:7890` | 本机 HTTP 代理地址，必须带 `http://` / `https://`。**SOCKS 地址会被 DSH 拒绝并跳过**（该协议下仍直连）。 |
| `noProxy` | 空 | 逗号分隔的直连名单，与 loopback 默认名单合并。 |
| `probeUrl` | `https://www.gstatic.com/generate_204` | `/proxy test` 与 `/proxy on` 校验用的目标。 |

在自己的 profile `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: proxy-switch
  config:
    enabled: true
    url: http://127.0.0.1:7890
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `/proxy` `/proxy status` | 当前状态、目标地址、被拒绝的取值、进程内代理变量 |
| `/proxy test` | 用 DSH 那份 undici 发一次请求，确认现在的链路通不通 |
| `/proxy on [url]` | 立即接上代理；**先探测，探测失败自动回滚**，避免把 DSH 自己的模型请求一起断掉 |
| `/proxy off` | 还原加载前的 dispatcher |

`/proxy on` 的自动回滚是刻意的：模型请求也走这份 undici，如果代理是死的，会话会直接失去响应，
回滚是唯一能自救的选择。

## 边界

- 覆盖插件加载**之后**、经由 DSH 那份 undici 发出的请求：网页抓取、模型请求、MCP、插件安装。
- 不覆盖 worker：PTC runtime 与 workflow 引擎各有自己的 `globalThis`，装不到它们身上（DSH 也
  刻意不给它们代理，因为模型写的脚本可能把带凭据的代理地址带走）。
- 不覆盖插件加载**之前** boot 阶段发出的请求（例如启动时的插件市场索引）。
- SOCKS / PAC 不是 DSH 支持的代理形式。

## 和 FlClash / mihomo 配合

订阅链接是节点清单，不是代理地址，必须由内核转成本机端口。以 FlClash 为例：

1. 打开 FlClash，**保持「系统代理」和「TUN / 增强模式」关闭**——本插件不需要它们，打开反而会接管整机；
2. 确认 `mixed-port`（默认 7890）在监听：`Test-NetConnection 127.0.0.1 -Port 7890`；
3. `/proxy on`。

这样 FlClash 只提供一个本机端口，谁想用谁连；Windows 的系统设置、其它程序都不受影响。

## 本地验证

```powershell
# 终端 A：一个会记录每次转发的最小代理
node tools/logging-proxy.mjs tools/proxy.log 7899

# 终端 B：在真实 DSH 之外跑一遍，验证「装上→流量真的进代理→卸下→回到直连」
node tools/verify-install.mjs
```

`verify-install.mjs` 用 `process.argv[1]` 指向 DSH 入口来复现真实进程里的模块解析，因此它验证的
就是插件在 DSH 里会走的那条路径。

## 实现要点

`@deepseek-ai/dsh-http-proxy` 是 DSH 安装目录里的依赖，从 profile 解析不到；而且 dispatcher 与
undici 实例都挂在模块作用域上，另起一份副本会装到没人使用的对象上。因此插件先在
`process.argv[1]` 的祖先目录里找到 `@deepseek-ai/dsh` 的 `package.json`，再用
`createRequire` 从那里解析——拿到的就是启动器导入的同一个模块实例。
