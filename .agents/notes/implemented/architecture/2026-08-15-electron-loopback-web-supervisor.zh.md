# Agent Note: Electron desktop starts as a replaceable loopback Web supervisor

Status: implemented

[English](2026-08-15-electron-loopback-web-supervisor.md) | 中文

## Problem

桌面应用需要一个 Electron 窗口和由托盘持有的应用生命周期，同时不让窗口成为 Harness 工作的持有者。关闭窗口必须让会话与后台工作继续运行，而显式退出应用必须处置 Harness 进程并等待其子孙进程。若同时构建最终的 Electron IPC 载体，则在第一个可用外壳交付之前，还需要打包的客户端模块加载器、IPC 流式传输、原生操作路由，以及一条新的渲染进程安全边界。

既有的 Web profile 已经提供完整的交互式客户端、ApiProxy 校验、会话回放、审批处理、配置界面和原生 Host 操作。第一版桌面实现需要复用这些行为，同时不把它的进程编排固定下来，也不削弱[与通道无关的 GUI 协议](2026-07-19-gui-layering-and-rpc-protocol.md)。

## Decision

`apps/desktop` 下的 `@deepseek-ai/dsh-desktop` 是一个私有 Electron 应用，也是一个可替换的监管者，而不是新的 Harness 装配或协议载体。它启动一个绑定 loopback、端口由操作系统分配的 `dsh web` 子进程，然后从子进程的 `dsh web: <url>` 就绪行加载规范 URL。就绪解析器跟随流的分片而不是 stdout 回调边界，忽略无关输出与可选的 LAN 标注，且只接受端口有效且非零的 HTTP loopback 授权。就绪行格式错误、启动出错、子进程提前退出，或流在就绪前结束，都让启动失败，而不是导航到推断出的地址。

根命令 `dev:desktop` 是完整的源码启动入口。Electron 启动前，它先构建 Host 与客户端包的编译面、Web 前端和 Electron 主进程，因此全新安装依赖后不需要另行执行仓库构建。

根命令 `package:desktop` 是完整的本地打包入口。它执行同一套仓库构建，随后 `apps/desktop/scripts/stage-runtime.ts` 依据纯依赖清单 `apps/desktop/runtime/package.json` 生成被忽略的 `apps/desktop/runtime-host` 目录树。暂存器执行仅生产依赖的 hoisted `pnpm deploy`，补回 legacy deploy 遗漏的直接依赖，物化包链接，并拒绝任何残留的符号链接。Electron Builder 把这棵闭合的树连同构建好的 Web 前端复制进应用的 `resources/host` 目录。

打包后的监管者用打包的 Electron 可执行文件加 `ELECTRON_RUN_AS_NODE=1` 启动 `resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js`；源码启动继续使用宿主的 `node` 命令与工作区 CLI 入口。Electron 的 Node 模式提供了独立的 Host 进程，而不给应用增加第二个 Node 可执行文件。因此，暂存闭包中原生依赖的兼容性由 Electron 附带的 Node ABI 决定。

macOS 与 Windows 使用同一份纳入版本管理的 `apps/desktop/build/icon.png` 输入，仓库侧不做转换。本地 `package:desktop` 的产物是未压缩且未签名的，因此不需要任何分发凭据。

子进程仍是 Web profile 的 Cordis 树、会话、设置、凭据、文件系统与 shell 服务、HTTP/WebSocket 载体以及静默处置的唯一持有者。Electron 不把这些服务引入它的主进程或渲染进程。BrowserWindow 加载校验过的 loopback URL，禁用 Node 集成，启用上下文隔离与渲染进程沙箱，且不提供 preload 能力。这仍是既有的本地 Web 安全模型：桌面外壳不新增认证层或 IPC 授权层。

托盘与 Host 监管者持有应用生命周期，与 BrowserWindow 是否可见无关。用户关闭窗口的动作被拦截并隐藏窗口；它既不退出 Electron，也不向子进程发信号。托盘激活与 macOS 应用激活重新显示既有窗口。`window-all-closed` 不是退出请求。单实例锁阻止第二个桌面进程与第二个 Host 子进程；第二次启动只恢复并聚焦主窗口。

每条显式退出路径都汇聚到同一个幂等的退出操作。它停止接受窗口恢复工作，向子进程发送 `SIGTERM`，并等待子进程退出。普通的 `dsh` 启动器处理该信号的方式是处置根 Cordis fiber，其持有的持久化与子进程服务在进程退出前排空。有界的超时把无响应的子进程一次性升级为 `SIGKILL`，并且仍在 Electron 退出前等待子进程落定。重复的退出请求汇入同一个操作，而不是另起一轮信号或计时器序列。

就绪之后子进程的意外退出会报告其确切的退出码与信号，随后进入同一个应用退出操作。外壳不会让一个存活的窗口挂在已死的 Host 上，也不会在没有明确恢复策略的情况下重启执行环境。

监管者向 Electron 应用呈现启动、就绪与关闭的事实，而不是把子进程机制暴露给窗口与托盘的处理函数。后续的本地自定义协议加 IPC 载体可以在这个所有权点之后替换 loopback 子进程。那次迁移替换资产加载与传输，同时保留托盘与窗口的生命周期规则以及既有的 ApiProxy 消息模型；第一阶段不为子进程编排引入兼容承诺。

### Repository placement

`apps/desktop` 是一个工作区成员，其产物是可安装的应用而不是 npm 包，因此它是第一个位于 dsh npm 发布族之外的 `apps/*` 成员。`scripts/release/families.ts` 显式列出发布的应用装配（`apps/cli` 与 `apps/web`），`scripts/check-workspace-constraints.ts` 消费该列表，因此私有应用清单被接受，而每个发布成员仍须声明其发布访问级别与仓库目录。

该包保留自己的编译面而不加入 `tsconfig.host.json`：Electron 类型包声明的浏览器全局不能进入 Host 聚合的程序。`apps/desktop/runtime` 是独立的嵌套工作区成员，使这份仅用于 deploy 的清单留在应用构建与发布族扫描之外。

### Upstream upgrades

这个 fork 跟进上游的成本就是它改动的九个既有文件，因此 `apps/desktop/scripts/upgrade-from-upstream.ts` 只自动化不含决策的部分。它合并上游 ref，通过重新生成解决 `pnpm-lock.yaml` 与 `THIRD_PARTY_NOTICES.md` 的冲突，并在其它任何冲突上停下，列出需要人处理的路径。随后它重装依赖、刷新生成物、运行桌面闭包检查并打包应用，因此一次完整跑通的运行已经证明该合并可构建。

就绪行是唯一没有门禁观察的耦合：上游改变格式时合并干净、编译通过。启动本轮产出的打包应用才会让它暴露。

## Verification

`apps/desktop/tests/host-supervisor.spec.ts` 钉住任意 stdout 分片与未终止末行下的就绪解析，拒绝非法的协议、主机、端口与缺失的就绪行，并覆盖单次在途启动、启动失败、提前退出、幂等关闭、协作式 `SIGTERM` 落定，以及一次性的超时升级。`apps/desktop/tests/window-lifecycle.spec.ts` 钉住关闭即隐藏、窗口创建的合并、退出期间拒绝恢复，以及 Electron 重试退出之前只处置一次 Host。`apps/desktop/tests/packaging-config.spec.ts` 钉住共享的源图标、完整构建与运行时暂存命令、打包 Host 的资源映射、锁定的 Electron 分发，以及仓库根入口。`apps/desktop/tests/verify-packaged-runtime.spec.ts` 钉住 Host 入口缺失时在打包前的拒绝。源码检查与评审钉住 Electron 事件接线、单实例恢复、精确同源的导航策略，以及收紧的 BrowserWindow 设置。

## Alternatives considered

**在交付任何桌面应用之前先构建 IPC 载体。** 这是传输层的目标方向，但它把进程安全、客户端模块打包、双向流、取消、原生操作与生命周期工作全部压进第一个版本。监管者让那次迁移保持可行，而不把这一切都变成托盘外壳的前置条件。

**在 Electron 主进程内启动 Harness 插件树。** 这省掉一个子进程和 loopback 套接字，但把模型、持久化与子进程的故障耦合进那个必须保持托盘与退出控件响应的进程。它还会造出第二套应用装配，而不是运行已交付的 Web profile；并且需要一个模块解析替身，因为 Electron 不向 Loader 的内建 require 路径暴露 Node 的内部模块加载器。

**窗口关闭即终止子进程。** 这让 BrowserWindow 的可见性持有 agent 生命周期，丢弃后台工作，与常驻托盘的应用相矛盾。只有显式退出应用才持有 Host 的处置。

**关闭时销毁并重建 BrowserWindow。** 会话回放能重建持久的对话状态，但瞬态的客户端状态与打开的控件会丢失。隐藏为第一个外壳保留了当前的客户端世代；接受其渲染进程内存开销是明确的选择。

**使用固定的 loopback 端口，或从进程参数推断地址。** 固定端口造成本可避免的冲突，推断出的 URL 可能与尚未完成 Loader 激活的服务器抢跑。端口 0 加上既有的落定后就绪行，让子进程报告它实际持有的地址。

**显式退出时立即杀死子进程。** 立即终止缩短了关闭时间，但跳过会话刷盘与受管进程树的清理。`SIGTERM` 把处置委托给子进程；强制终止仅保留为有界的失败路径。

**给第一个外壳配上原生平台外观。** 无边框内嵌标题栏、侧边栏材质，以及置于应用头部的系统按钮，需要在布局、主题与对话三个客户端包中改动表现层。窗口保留平台普通的系统边框，使第一个外壳的正确性只依赖生命周期与打包。

## Consequences

桌面应用以很小的 Host 与客户端风险交付了既有的交互式产品，关闭窗口后 agent 运行时仍可从托盘取用。额外的进程也把 Electron 的应用控件与普通的 Harness 故障隔离开，并留下一个可供日后更换传输层的明确位置。

这一阶段的代价是一个 loopback 监听器、一个额外的 Node 进程、对就绪行的耦合，以及一个隐藏渲染进程的资源开销。它继承 Web 载体的信任与暴露规则，而不是获得一条 Electron IPC 安全边界。可分发的包携带 CLI 的生产依赖闭包与 Web 前端，而 Electron 的 Node 模式避免了重复的 Node 二进制，代价是把原生依赖的兼容性与 Electron 附带的 ABI 绑在一起。运行时暂存还依赖 legacy `pnpm deploy` 的行为，因此在 Builder 消费这棵树之前补回遗漏的直接依赖并移除链接。桌面启动只有在子进程报告其 Loader 之后的 URL 时才成功。Host 崩溃会退出外壳而不是恢复当前窗口；自动重启仍是后续的生命周期决策。

本地打包产出未签名的未压缩应用。安装包格式、分发签名与公证仍属独立的发布工作；在平台外观进入客户端包之前，窗口保持普通的系统边框。

子进程编排是实现选择，不是公开协议。未来基于 IPC 的桌面端仍使用四象限的 ApiProxy 契约，并保留关闭即隐藏、托盘持有、单实例行为与有序的 Host 处置，同时替换 loopback 服务器、就绪行与受监管的 CLI 进程。
