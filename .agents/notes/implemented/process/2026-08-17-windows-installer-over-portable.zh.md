# Agent Note: Windows ships an installer instead of a portable executable

Status: implemented

[English](2026-08-17-windows-installer-over-portable.md) | 中文

## Problem

Windows 目标此前是 electron-builder 的 `portable`，它把整个应用包进一个 NSIS 自解压壳。什么都不安装：每次启动都要先把完整负载——112 MB 的 Electron、暂存的 Host 闭包及其原生包——解压到 `%TEMP%`，应用自身的启动才能开始，而 Windows Defender 还会扫描刚写出来的这些文件。用户报告启动非常慢，而 macOS 一侧（磁盘映像只挂载并复制一次）并无此问题。

这个壳还会误导人们对构建产物的判断。无论负载是什么架构，它本身都是 32 位可执行文件，因此任务管理器为一个 x64 应用显示 32 位进程，而且无法从产物文件读回真实架构。

应用本身并不从"便携"中获益。它每次启动都会写 `$DSH_HOME` 和自己的用户数据，因此它从来就不是该格式所面向的那种无痕工具。

## Decision

Windows 交付 NSIS 安装程序 `DeepSeek-Harness-<version>-x64-Setup.exe`。

它按用户安装（`perMachine: false`），因此从下载到应用运行之间不隔着管理员提权提示，也使安装避开 `Program Files`——在那里按机器写入需要提权。`oneClick: false` 展示安装向导并允许用户选择目录；`runAfterFinish` 在向导关闭时启动应用。开始菜单与桌面快捷方式以产品名创建。

`useZip: true` 以安装包体积换解压速度，而这正是本次改动的要点：负载在安装时写入一次，而不是每次启动写一次。

macOS 一侧不变。它本就具备这一性质——磁盘映像只需复制到 Applications 一次——这也正是慢只在一个平台上被报告的原因。

## Verification

`apps/desktop/tests/packaging-config.spec.ts` 固定了目标、显式声明的 x64 架构、产物名，以及本次改动所要提供的四项安装行为：向导式而非一键安装、结束时启动、两处快捷方式、按用户安装。

本次消除的启动开销无法从 macOS 机器上度量，由报告问题的用户在其 Windows 安装上确认。

## Alternatives considered

**保留 `portable` 并缩小负载。** 从另一侧攻击同一成本，但负载是完整的 Electron 运行时加一套 Node 依赖闭包。其中没有哪部分是意外变大的，而且无论缩小到多少，仍然是每次启动都付解压代价，而非只付一次。

**同时交付便携版与安装版。** 服务于无法安装软件的用户。代价是 Windows 发布面与支持负担翻倍，而这种诉求尚无人提出；何况选择便携路径的人仍要承受其启动开销。

**使用 `nsis-web`。** 一个小体积下载器，在安装过程中拉取负载，这通常是大型应用想要的。但它要求负载被托管在安装时可达之处，给当前只是"一个 GitHub 资产"的发布增加了发布托管依赖。

**一键安装（`oneClick: true`）。** 步骤更少，也是 electron-builder 的默认值。但它不给用户任何安装位置的控制权，也不显示正在发生什么；对于一个 SmartScreen 已经警告过的未签名安装程序，这只会显得更糟而非更好。

## Consequences

Windows 启动现在直接启动应用，而不是先解压它；应用会出现在开始菜单、桌面与已安装程序列表中，并带有可用的卸载程序。

此前使用便携版可执行文件的用户不会被迁移：它从未注册过任何东西，因此没有可就地升级的对象。他们运行安装程序并删除旧的 `.exe` 即可。他们的 `$DSH_HOME` profile 与账户凭据不受影响，因为二者从来都不在应用内部。

发布物现在是安装程序，因此 Windows 产物不再能下载后不安装直接运行。
