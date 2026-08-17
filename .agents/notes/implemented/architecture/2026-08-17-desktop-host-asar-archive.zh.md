# Agent Note: The packaged desktop Host ships as one asar archive

Status: implemented

[English](2026-08-17-desktop-host-asar-archive.md) | 中文

## Problem

Windows 上桌面启动慢到影响使用，且在安装版消除了每次启动的解压之后依然如此。

打包的 Host 闭包是 31891 个散落文件。Host 启动要导入数千个模块，而 Windows 上每个文件的首次读取都要经过 Defender 的实时扫描——一笔按文件计的开销，把毫秒级的税乘上了依赖树的规模。macOS 上同一启动约 600 ms，因为它没有这种按文件的税；这份慢所依附的机制在那里根本不存在，这正是它无法在开发机上复现或度量的原因。

剔除声明文件与 sourcemap 已把文件数减了约一半，但启动真正读取的是剩下的那些 `.js` 模块。

## Decision

暂存的闭包被打成应用旁的单个 `host.asar`，打包后的启动从其内部运行 CLI 入口。Electron 打补丁的 `fs` 向 Host 进程提供归档成员——`ELECTRON_RUN_AS_NODE` 保留该补丁——于是每次模块读取都落在同一个已打开的文件里，按文件的打开成本坍缩为一次。

操作系统自身必须打开的东西保留为 `host.asar.unpacked` 中的真实文件：被 `dlopen` 的原生模块（`.node`、动态库）、被 spawn 的可执行文件，以及在自己目录下携带此类二进制的包（node-pty 的控制台宿主、ripgrep 的 `rg`、Landlock 启动器）。Electron 自动把归档路径重定向到这个同名邻居。`afterPack` 关卡要求至少存在一个解包的原生模块，因此解包模式失效的构建无法交付谁也加载不了的原生模块。

裸插件名通过一个解析器进入归档：`host-resolver.mjs`，归档旁的单个自包含文件，由被 spawn 的 Host 以 `--import` 加载。它注册一个 `module.registerHooks` 解析钩子，其兜底用钉在归档自身 `package.json` 上的 `createRequire` 来应答任何失败的裸标识符。用钉住的 `createRequire`——而不是改写 `parentURL` 重试 `nextResolve`——是承重的：默认解析器对 `import` 尊重改写后的父模块、对 `require` 却不尊重，这一点由实验发现，并被下述客户端清单检查钉住。

`healProfilesModuleFallback` 对锚定在归档内的安装直接跳过。它本要创建的链接永远无法解析——归档内部路径只对 Electron 打补丁的 `fs` 存在，对符号链接所经过的操作系统不存在——而启动器的解析器替代了它们提供的能力。来自独立 CLI 安装的 `dsh web` 仍照常修复并启动共享 profile。

两个 Electron Builder 行为塑造了打包方式：解包树无法经 `extraResources` 运输（名字涉及 `*.asar.unpacked` 的映射会被静默丢弃），因此由 `afterPack` 自己从暂存输出复制；归档由 `stage-runtime.ts` 产出，打包前剔除 `.d.ts`/`.map`/`.md`。

## Verification

在 macOS 上面向真实打包出的应用 bundle 端到端：Host 在空 `$DSH_HOME` 上从 `host.asar` 冷启动约 2.5 秒，`/` 返回 200，boot manifest 列出全部 38 个客户端插件 bundle——与散文件基线相同的数量，而这正是抓住上述 `require` 重试失败的检查（在解析器改用钉住的 `createRequire` 之前，manifest 是空的）。账户插件 overlay 流程——profile 中的真实文件与归档 Host 组合——照常提供其 bundle 及两处设置注册。asar 内的 worker 线程入口可加载并回报。

macOS 计时：散文件约 570 ms，归档约 715 ms——归档要解析 170 MB 的头部，而 macOS 对每个文件不收税。这份开销随处都在；本改动所为的收益是按文件的扫描税，只有 Windows 收取，也只有一次 Windows 启动能度量它。

`tests/host-resolver.spec.ts` 钉住兜底行为（两种模块系统的 not-found 代码、仅裸标识符、报告原始错误）；`profile.spec.ts` 钉住归档锚点不产生任何链接；`verify-packaged-runtime.spec.ts` 钉住 afterPack 各关卡，包括解包原生模块的硬性要求。

## Alternatives considered

**把闭包捆成少数几个 JS 文件。** 不用 asar、不依赖 Electron 机制就能坍缩文件数。但它破坏插件系统赖以构建的按包身份：Loader 按包名挂载插件，profile 通过 `node_modules` 解析外部插件，`dsh-client-modules` 按包提供浏览器 bundle。捆包等于为一笔打包成本重构组合机制。

**把 Host 放进 Electron 主进程运行。** 省去子 Electron 启动，窗口直接拿到 URL。但它放弃了这个桌面刻意选择的受监管、可独立运行的 Host，而且不触及按文件的成本——进程内的 Host 读的还是同样那些文件。

**在 profile 回退层放指向归档路径的软链桩。** 保留修复机制。但 Windows junction 要求操作系统层真实的目标，归档成员不是；生成再导出归档路径的桩包则是每个版本重新生成的上千个小文件——恰是本改动要消灭的形态。

**请用户把安装目录加入扫描排除。** 完全不用写代码，但这是需要提权、有安全隐患、多数用户不会照做的建议。应用自身的布局不应依赖它。

## Consequences

Windows 启动现在在每个曾触及散文件的环节都只打开一个 170 MB 归档而非约 16000 个文件：安装时的 NSIS 解压、Defender 的首读扫描、Host 的模块加载。同一布局在 macOS 上以每次启动约 150 ms 的归档头开销交付，保住了所有平台同一条启动路径。

Host 的安装以比从前更强的意义变为只读：没有任何东西能写入归档，而这与安装本来被对待的方式一致。

解析器是启动器所有的接缝：未来任何把安装归档化的打包表面都需要同样的 `--import` 钩子；`app-boot` 中的修复跳过写明了这份契约——归档化的安装经其启动器解析，而非经 profile 链接。
