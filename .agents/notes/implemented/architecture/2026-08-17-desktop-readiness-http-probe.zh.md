# Agent Note: Desktop Host readiness is an HTTP answer, not a line of stdout

Status: implemented

[English](2026-08-17-desktop-readiness-http-probe.md) | 中文

桌面把 Web Host 作为子进程监管，并在 Host 开始服务后打开窗口。本文记录它如何得知这一点——在原有机制被发现于 Windows 上不可用之后。

## Problem

监管器通过解析子进程 stdout 中的 `dsh web: http://127.0.0.1:<port>` 来判断 Host 已就绪，然后加载该 origin。而 Electron 在 Windows 上不投递子进程的管道 stdout（[electron/electron#28492](https://github.com/electron/electron/issues/28492)、[#5713](https://github.com/electron/electron/issues/5713)），因此那一行永远不会到达。

Host 启动正常、服务也正常；只是桌面永远没有察觉。于是每次 Windows 启动都只在任务管理器里看到进程、完全没有窗口，直到 90 秒就绪超时才终于弹出错误框。macOS 不受影响，而本仓库没有 Windows 桌面测试——CI 的 `windows` job 跑的是 wine 门禁而非应用本身——所以发布前没有任何环节拦下它。

那行就绪日志作为证据也比看上去更弱：它报告的是 Host 执行到了自己的日志语句，而不是它能应答请求。

## Decision

桌面预留一个 loopback 端口，让 Host 绑定它，并通过 HTTP 轮询该 origin 直到它应答。任何完整响应都算数，包括错误状态：问题是 Host 是否在监听，而不是它对 `/` 说了什么。

预留端口正是探测得以成立的前提——未知的 origin 无法探测，而由操作系统分配的端口只能从 Host 自己那里得知。`reserveLoopbackPort` 绑定端口 `0`、读出被分配的端口、再释放它。该端口在返回的那一刻是空闲的，而不是在 Host 绑定它的时刻；任何东西都无法在不成为监听者的前提下持有这个预留。空档期被抢占会表现为 Host 绑定失败并在就绪前退出，而监管器本就会带着 Host 的输出报告这种情况。

监管器仍然读取 stdout 与 stderr，但只用于累积附在启动失败上的诊断文本。没有任何控制决策依赖它，这正是该机制在所有平台上保持一致的原因：不存在只有 Windows 用户才会走到的 Windows 专属路径。

## Verification

`apps/desktop/tests/loopback.spec.ts` 面向真实服务器固定了预留与探测：预留出的端口可被绑定；探测对正在服务的 origin 返回 `true`（包括 `503`），对已关闭的端口以及"接受连接却从不应答"的情形返回 `false`。

`apps/desktop/tests/host-supervisor.spec.ts` 固定了就绪判断完全忽略 stdout——打印了就绪行却尚未应答的 Host 不算就绪，而没打印任何东西却已应答的 Host 算就绪。

在 macOS 上面向真实 Host 端到端：预留、`--port` 传递与探测让启动在约三秒内进入就绪，随后该 origin 对 `GET /` 返回 200。本次改动所针对的 Windows 行为无法在这台机器上验证，需要一次真实的 Windows 运行。

## Alternatives considered

**继续解析 stdout。** 没有新增活动部件，而且它在三个平台中的两个上本就工作。它无法在第三个平台上工作，而那正是报告该缺陷的平台。

**让 Host 把端口写入文件、桌面监视该文件。** 保留操作系统分配的端口，并让 Host 成为"绑定在哪里"的权威。代价是需要新增 CLI 标志，以及桌面与 Host 之间关于文件位置、生命周期和清理的成文契约——为修复一个仅存在于桌面内的缺陷而引入跨包改动。

**Windows 上轮询、其他平台解析 stdout。** 在可用之处保留既有路径。因其会让 Windows 路径只被 Windows 用户走到而否决：开发者运行得最少的平台，将拥有一套只属于自己且无人日常验证的启动机制。

**用 Electron 的 `utilityProcess` 运行 Host。** 这是 Electron 对子进程 stdio 给出的官方答案，且能保留操作系统分配的端口。但它替换的是 Host 的启动方式而非就绪的观察方式，会放弃"普通 `node` 子进程"这一点，而正是它让 Host 可以被独立运行和调试（[loopback supervisor](2026-08-15-electron-loopback-web-supervisor.md)）。

## Consequences

就绪现在意味着 Host 应答了一次请求，而这正是窗口真正需要的；并且所有平台走同一条代码路径。

启动在 spawn 之前多做一次绑定/释放，且就绪是按轮询间隔观察到的，而非 Host 起来的那一瞬——相对以秒计的启动，这是 250 毫秒的粒度。

预留引入了一个端口可能被其他进程抢占的空档。它很小，会通过既有的"就绪前退出"报告明确失败；而要彻底消除它，就需要让 Host 拥有端口选择权，也就是上面已否决的替代方案。
