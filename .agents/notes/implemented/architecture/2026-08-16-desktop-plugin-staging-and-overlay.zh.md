# Agent Note: Desktop-only plugins reach a launch by staging plus a patch overlay

Status: implemented

[English](2026-08-16-desktop-plugin-staging-and-overlay.md) | 中文

桌面应用交付了一个包层不含的账户插件。本文记录该插件如何进入它所启动的 Host——在第一版机制只在构建它的那台机器上生效之后。

## Problem

账户插件随应用交付，但 Harness Loader 把裸插件标识符锚定在 profile 目录，因此插件仅仅位于应用包内并不足以被解析到。第一版机制因此用 `dsh plugin --profile web add file:<dir>` 安装它。

该命令转发给 pnpm，而打包后的应用够不到 pnpm。`dsh plugin` 通过 PATH 解析并 spawn 一个裸 `pnpm`，而从 Finder 或资源管理器启动的 GUI 继承的是不含用户自装 pnpm 的最小 PATH；随附的 Host 也不带包管理器。于是在任何非开发检出的机器上安装都失败，而 `ensureAccountPlugin` 对这种失败只报告不抛出，好让应用仍能启动。浏览器半边随后找不到账户桥接，于是什么也不注册。两步都是静默的，所以交付出去的结果是：设置页没有账户区块，首次运行步骤没有**快速获得**动作，只在 GUI 用户看不到的 stderr 上留下一行。

该机制还把开发者自己的检出路径以 `file:` 依赖写进 `$DSH_HOME/profiles/web/package.json`，而"是否已安装"的判断只问这个依赖键在不在。开发机因此一直加载检出而非应用自带的副本，这正是该故障没有在引入它的地方复现的原因。

## Decision

应用把插件预置到位，并按启动组合它。两步都不运行包管理器。

**预置**把交付的插件目录复制到 `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-desktop-account`。Node 从任何 profile 目录向上查找一级即到达该目录，而这正是 CLI 已在维护的扁平回退层——in-box bundle 靠它解析，无需 pnpm 管理。当交付版本与已预置版本不同时刷新副本；开发启动传入 `alwaysRestage`，因为检出的版本号不随其源码变化。

**组合**以 `dsh web --patch <staged>/cordis.patch.yml` 启动 Host，该 overlay 正是插件自己声明的 Loader 行。`dsh web` 在遇到第一个不属于自己的选项时停止解析自身选项，因此该 overlay 必须排在 web 应用所取的标志之前。

按启动组合正是 profile 本身保持不变的原因。`$DSH_HOME/profiles/web` 与用户从另一处安装运行的任何 `dsh web` 共用，因此一旦本应用被移动或移除，一条指向只有本应用能解析的包的 bundle 行会让那个 CLI 的 Loader 直接失败。

由于早先的版本确实写过那个 profile，预置会先清除它留下的东西：bundle 行、把插件钉死在构建机上的 `file:` 依赖，以及 profile 本地副本。三者都必须清除——残留的 bundle 行会在 overlay 之上把插件第二次组合进来，残留的本地副本会在模块查找中胜过已预置的那份。

采用复制而非软链，是为了让预置的插件不依赖应用自身的位置：在 Windows 上创建软链需要开发者模式或提权，而指向一个之后被移动或卸载的应用的链接会悬空。

## Verification

`apps/desktop/tests/account.spec.ts` 固定了预置、版本触发的重新预置、无条件重新预置、排除插件目录下的安装树、插件缺失时的报告，以及清理的每一部分。`apps/desktop/tests/host-supervisor.spec.ts` 固定了 overlay 排在 web 应用标志之前的位置。

打包关卡现在会拒绝缺少插件清单、overlay 或已构建 `lib/client.js` 的构建。最后那个文件是未被跟踪的构建产物，因此过去在干净检出上跳过插件构建的打包会交付其余一切、只丢掉账户区块。

端到端：面向空的 `$DSH_HOME`、全程无包管理器参与，Host 带 overlay 启动并在 `/plugins/@deepseek-ai/dsh-desktop-account/client.js` 提供插件的浏览器 bundle，其中同时带有账户区块与 `settings.onboarding.credentialAction` 注册。

## Alternatives considered

**随应用交付 pnpm，或以绝对路径调用它。** 保留既有安装路径，代价是在桌面启动中引入一个包管理器和一次网络安装——而插件本就已在磁盘上随应用交付。它也没有消除安装本身失败时的那种故障模式。

**从应用自己的 Host 解析插件，而不是 `$DSH_HOME`。** `resolveBundleDir` 先试安装位置再试 profile，因此把插件放进 `host/node_modules` 可以完全不碰用户主目录就解析成功。它失败的原因正是 profile 共用：Loader 把 overlay 标识符锚定在 profile 目录而非安装位置，因此插件无法从 overlay 行解析。

**继续写 profile 的 bundle 列表。** 自包含，且能在应用被移除后存活。因 profile 共用而否决：用户自己的 `dsh web` 将启动一个列出了只有桌面应用交付的包的 profile，而 Loader 对无法解析的 bundle 直接失败。

**把预置目录软链进应用。** 省去每次版本变化时的复制。但在 Windows 上创建软链需要开发者模式或提权，而且应用一旦被移动或卸载，链接就会悬空。

**给桌面单独一个 profile。** 直接消除共用约束。因其会静默丢弃用户既有的 `web` profile 补丁层而否决，且桌面是刻意复用 Web profile 的（[loopback supervisor](2026-08-15-electron-loopback-web-supervisor.md)）。

## Consequences

账户页现在在任何安装了发行版的机器上都会出现，这正是该机制的目的。应用在运行时不再依赖包管理器，而它所启动的 profile 对该 profile 的其他每一个使用者都保持逐字节不变。

预置把插件复制进 `$DSH_HOME` 而非就地读取，因此被移动或删除的应用会留下已预置的副本，直到之后某次启动刷新它。来自另一处安装的 `dsh web` 会忽略该副本，因为没有任何东西组合那条会挂载它的 overlay。

移除插件自己的 `pnpm` 安装路径，同时也移除了桌面应用需要知道如何运行 CLI `plugin` 命令的唯一理由；剩余的 Host 路径只为启动 Host 而携带 CLI 入口。

静默降级的面变窄但未消失：预置失败的应用仍会在没有账户页的情况下启动，并向 stderr 报告一行。打包关卡现在能拦住该故障的构建期成因，运行期剩下的成因是用户自己主目录中的文件系统错误。
