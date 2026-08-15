# DeepSeek Harness 桌面应用

[English](README.md) | 中文

桌面应用监管既有的 loopback Web Host，窗口关闭后由系统托盘让它继续运行。

## 开发

安装依赖后使用唯一的桌面开发命令。它先构建 Host 与客户端包、Web 前端和 Electron 主进程，再启动应用：

```sh
pnpm run dev:desktop
```

关闭窗口是隐藏。托盘菜单用于恢复窗口或退出应用。显式退出会等待 Host 进程停止，超过 Host 宽限期后升级终止方式。

桌面应用只接受 `dsh web` 为 `127.0.0.1` 或 `localhost` 输出的就绪 URL。导航停留在该源上；HTTP 与 HTTPS 链接在系统浏览器中打开。

## 打包

两条命令共用完整的仓库构建与 Host 依赖暂存，因此不需要另行手工构建。`package:desktop` 生成用于本地验证的未压缩应用目录；`dist:desktop` 生成可分发的 macOS 磁盘映像：

```sh
pnpm run package:desktop   # apps/desktop/dist/<platform>/DeepSeek Harness.app
pnpm run dist:desktop      # apps/desktop/dist/DeepSeek-Harness-<version>-<arch>.dmg
```

打包后的应用通过 Electron 的 Node 模式在独立进程中运行暂存的 `@deepseek-ai/dsh` CLI。因此应用保留受监管的 Host 生命周期，而不附带第二个 Node 可执行文件。暂存的 CLI 入口或 Web 前端入口缺失时，`afterPack` 检查拒绝该包。macOS 与 Windows 都使用纳入版本管理的 `apps/desktop/build/icon.png` 原图；仓库不预处理也不提交分平台的图标变体。

每条需要 Electron 的命令都先重跑一次其幂等的二进制解包。pnpm 只在包首次安装时执行该解包，解包产物被删除后不会再执行，因此丢失产物的目录树否则只会在打包时才失败。

## 安装

磁盘映像未签名。它携带 ad-hoc 签名，而 macOS 在下载隔离属性存在时把 ad-hoc 包报告为已损坏，因此移除该属性是启动它的唯一途径。`scripts/install.sh` 完成整套安装：

```sh
apps/desktop/scripts/install.sh ~/Downloads/DeepSeek-Harness-0.1.0-rc.5-arm64.dmg
```

不带参数时，它从 `DSH_DESKTOP_REPO` 的 GitHub releases 中解析出适配本机架构的最新磁盘映像。它挂载映像，用 `ditto` 复制应用——因为包内含框架符号链接，普通归档会把它们展开——移除隔离属性，然后卸载。

在 Finder 中把应用拖进 Applications 同样可行，之后执行同一条属性移除命令：

```sh
xattr -dr com.apple.quarantine "/Applications/DeepSeek Harness.app"
```

## 跟进上游

一条命令合并上游 Harness 仓库并重新构建应用：

```sh
pnpm run upgrade:desktop
```

它要求工作树干净，`upstream` remote 缺失时自动添加，并打印合并前的提交，使 `git reset --hard` 可以撤销整轮运行。`pnpm-lock.yaml` 与 `THIRD_PARTY_NOTICES.md` 的冲突通过重新生成这两个文件并提交合并来解决；其它任何文件的冲突让运行停止，并列出需要人工决定的文件。合并之后它重装依赖、刷新生成物、校验 `apps/desktop/runtime/package.json` 是否仍覆盖上游的依赖图，然后打包应用。

`--dry-run` 只列出将合入的提交而不合并。`--ref <branch>` 合并 `master` 以外的分支。`--skip-merge` 在人工解决冲突后继续。`--skip-package` 在合并后停止。

它唯一无法察觉的上游变更是 `dsh web: <url>` 就绪行格式改变：合并干净、构建成功，只有启动应用才暴露失败。审阅 `packages/bundle/web-app` 的合并 diff 可以覆盖它，启动本轮产出的打包应用同样可以。

## 已知限制

首个桌面装配使用 loopback HTTP Host，因此会绑定一个由操作系统分配的 loopback 端口。渲染进程与 Host 协议保持不变，应用因此可以在不改变产品功能的前提下，把传输层换成 GUI 架构预留的 IPC 载体。

打包产出的是未签名的未压缩应用。安装包格式、分发签名与公证仍属发布工作。

窗口使用宿主平台的普通系统边框。原生外观——无边框内嵌标题栏、侧边栏 vibrancy、置于应用头部的系统按钮——仍属客户端包的表现层工作。

## 模型体验

桌面外壳不新增模型可见输入。复用的 Web profile 继续持有其既有的 Web 运行时上下文。
