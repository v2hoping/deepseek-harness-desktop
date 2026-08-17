# Agent Note: A shell that owns a directory chooser answers without the Host

Status: implemented

[English](2026-08-17-shell-owned-directory-chooser.md) | 中文

## Problem

在桌面应用中选择工作空间目录慢到已经影响使用。

`WorkspacesService.pickDirectory` 一律经由 wire 抵达 Host，而 Host 的 `native` 能力打开平台对话框的方式是 spawn 一个子进程：把应用可执行文件当作 Node 运行，随后加载原生绑定、初始化 COM，并自行驱动 Win32 对话框。因此每次选择都要先付一次 Electron 冷启动才会出现对话框，在 Windows 上还要外加对这次启动所触及的一切进行实时病毒扫描。

而桌面本就有现成的对话框。Electron 主进程可以用一次调用打开目录选择器，且该进程已在运行。

## Decision

`pickDirectory` 先询问所处的外壳，没有外壳时再回落到 Host：

```js
const shell = shellDirectories()
if (shell !== undefined) return await shell.pick()
```

外壳以结构化方式从 `window.dshDesktop.directories` 读取，按调用读取而非捕获，且仅在其 `pick` 可调用时采用。浏览器标签页没有该对象，会原样走 Host 路径，这正是让 `dsh web` 在任何环境下保持一致的原因。`dsh-client-runtime` 不因此新增对任何外壳包的依赖。

桌面通过账户功能所用的同一套桥接暴露该对象：一个覆盖单条 IPC 通道的 preload 表面，其主进程处理器以发起请求的窗口为父窗口调用 `dialog.showOpenDialog`，因此一次选择不会被遗落在自己的窗口之后。

Host 的能力本身没有任何变化。对于一切不处在外壳中的消费者，它仍是选择器；而 browse 能力——页面内的目录浏览器——完全未被触碰。

## Verification

`packages/client/runtime/tests/workspaces-service.client.spec.ts` 固定了两个方向：外壳选择器存在时 Host 从未被调用（`callsOf('host.pickDirectory')` 为空）；而当暴露的是无关桥接时——外壳提供 `account` 却没有 `directories`——Host 一如既往地应答。

Electron 那一半是 IPC 与 `dialog` 的接线，本包没有相应测试设施；它通过运行应用来验证。

## Alternatives considered

**把桌面做成 Host 侧的 `native` provider。** 让选择发生在能力接缝本来所在之处。但 Host 作为独立进程运行，没有回到外壳的通道；为它提供服务就意味着为一个渲染进程本可直接发起的调用去发明一条通道。

**交付一个注册进 directory-flow slot 的桌面专属 client 插件。** 与账户页的交付方式一致，也能把外壳分支挡在 `dsh-client-runtime` 之外。但它需要第二个被预置的插件——现有预置路径只处理一个——外加一层 overlay 停用既有 flow，以免两者注册进同一个 slot；为搬动一次调用而付出的组合成本过大。

**把选择器暴露为经 `ctx.get` 读取的可选 client service。** 这是本仓库处理可选能力的固有惯用法，也能把查找移出 service 主体。但它需要一个插件来提供该 service，也就是上一个替代方案；在只有一个消费者与一个提供者的情况下，结构化读取就是它的全部。

**保留 Host 路径，让 worker 更廉价。** 为所有界面保留同一个选择器。但代价本身就在于要启动一个进程，而打包应用可用的最廉价的进程正是应用可执行文件自身。

## Consequences

桌面内的一次选择立即打开，且不再为此加载原生绑定——因此那个绑定曾产生的崩溃类别，也无法再从这条路径抵达。

`WorkspacesService` 现在多了一处知道"可能存在外壳"的分支。它没有指名任何外壳，也不为检查而 import 任何东西，但它确实是一个原本只与 wire 对话的 service 中的一次查找。

Host 的原生选择器保留了它仅剩的消费者：浏览器中的 `dsh web`，以及任何处在外壳之外的界面。它不再被桌面调用，而桌面正是它此前被调用得最多的地方。
