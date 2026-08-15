# Agent Note: The desktop account page provisions a key without acting as the user

Status: implemented

[English](2026-08-15-desktop-account-key-provisioning.md) | 中文

## Problem

首次使用要求用户自备 API Key：理解概念、去 DeepSeek 平台注册、创建 Key、粘贴。对非开发者而言，这是发出第一条消息之前最大的障碍。桌面应用应当以尽可能少的步骤把一个可用的 Key 放进模型凭据，并指明在哪里充值。

这个 fork 还必须保持低成本合并上游，因此该功能必须经由既有扩展点进入产品，而不是修改上游包层。

三个平台事实——通过登录并记录平台自身页面的行为确认——限定了可行范围：

- DeepSeek 公开 API 只有 `chat/completions`、`models` 与 `user/balance`。登录、Key 管理、用量与账单都没有公开端点。
- Key 列表（`GET /api/v0/users/get_api_keys`）只返回脱敏值（`sk-75dc3***…0a11`）。可用的密钥只出现在创建的响应里，这正是平台自己页面所声明的。
- 平台用 bearer token 认证其网站调用，而该 token 不在任何普通浏览器存储中——cookie、`localStorage`、`sessionStorage`、IndexedDB 都没有——同时还有图形验证、设备标识与 WAF 会话。

因此"读取 Key 列表并取用其一"不可能成立，而获取该 token 需要从官方页面的运行时里读出一个刻意混淆的存储。

## Decision

`apps/desktop/plugins/account` 下的 `@deepseek-ai/dsh-desktop-account` 在设置中增加账户页。外壳从不以用户身份认证，也从不代表用户向平台网站发起请求。

Key 的获取发生在平台自己的页面上。`获取 API Key` 在绑定持久 partition 的 `BrowserWindow` 中打开官方 Key 页，因此平台看到的是它自己的页面、它自己的设备标识、它自己的验证流程与用户本人的点击。外壳为该窗口挂上 Chrome DevTools Protocol 的网络事件，只启用 `Network`，读取响应体以寻找未脱敏的 `sk-…` 值。它不注入脚本、不发送请求，也从不读取该页面的会话凭据。以未脱敏的值而不是端点路径来匹配，正是区分创建响应与脱敏列表的方式，并且在平台重命名端点后依然有效。

一个 Key 只有在公开的 `GET /user/balance` 端点接受之后才进入存储——那是本应用发出的唯一请求，由用户自己的 Key 认证。随后它经既有的 `credentials.set` RPC 写入，凭据子系统因此持有它，模型请求在下一次调用时解析到它。用户粘贴已有 Key 走的是同一条"先校验后存储"的路径。

`credentials.describe` 永不返回值，因此已就位的 Key 无法在此重新校验。页面报告配置状态、生效层与可写性，并只保证：它写入的 Key 事先通过了校验。

用量、账单、充值与 Key 管理都是在同一会话 partition 中打开官方页面的链接。自绘它们需要本决策拒绝调用的内部端点。

### 不触碰上游地进入产品

该插件是外部插件（out-of-tree bundle）。`dsh plugin --profile web add file:<dir>` 把它装进 profile 目录，Loader 的裸说明符解析在那里能够找到它，而 CLI 会把任何声明了 `dsh.bundle.patch` 的包追加进 `dsh.profile.bundles`。`apps/desktop/src/account/ensure-plugin.ts` 在 Host 启动前执行这件事，并在 profile 清单已记录该依赖时跳过，因此普通启动不会拉起包管理器。该步骤失败时，Host 仍完全可用，只是没有账户页。

section 本身不需要改动外壳：`settings.section` 是开放的 list slot。浏览器半读取 `window.dshDesktop?.account`，缺失时不注册任何东西，因此 `dsh web` 的浏览器标签页看到的设置页面与此前完全一致。渲染进程经由 preload 触及外壳，该 preload 只暴露三个账户方法、不暴露任何裸 IPC 通道，沙箱与上下文隔离保持不变。

`packages/` 中没有任何内容因此功能而改变。

## Verification

`apps/desktop/tests/account.spec.ts` 钉住：捕获会从创建响应中取出密钥、忽略脱敏的列表形式与不含 Key 的响应体、并在缺少名称时如实报告；以及安装检查把全新 profile、他方清单与损坏清单都判为未安装。以浏览器驱动桌面 Host 确认了：桥存在时该 section 注册、桥缺失时不出现——这正是 `dsh web` 的保证。装入 profile 也已端到端确认：清单记录了该依赖，且 `dsh.profile.bundles` 增加了 `@deepseek-ai/dsh-desktop-account`。

登录与创建路径需要真实账号，已人工对平台验证。

## Alternatives considered

**提取平台的 bearer token 并调用其内部端点。** 这是完全自动化所需要的——列出 Key、创建 Key、读取用量，全程不离开应用。该 token 不在任何普通存储中，因此获取它意味着从官方页面的运行时里读出一个被混淆的存储，而此后每个请求都不携带平台期待的浏览器身份。判断错误的代价是用户的账号，而不只是一个失败的功能。

**读取 Key 列表并复用第一个 Key。** 这是显而易见的设计，也是最初提出的方案。列表只返回脱敏值，因此它报告的任何 Key 都无法认证任何东西。

**在应用内用 iframe 内嵌登录页。** 平台设置了 `X-Frame-Options`，且被内嵌的页面本来也不共享会话。

**自建登录表单并调用平台的登录端点。** 不存在公开的登录端点，该流程带有图形验证与设备指纹，而且用户的密码与短信验证码会流经我们的界面——用户理应拒绝这一点。

**把插件放进 `packages/client`。** 它会与其它 UI 插件并列，也更便于日后回馈上游，但它将为一个 fork 本地的功能承担包层的门禁（每文件全覆盖、invariant 伴生插件、限制章节），并把一个仅桌面可用的能力放进共享层。

**在应用内自绘用量与账单。** 两者都需要内部端点。链接的代价是用户多一个窗口，而且不会因平台改版而损坏。

## Consequences

用户经两次点击加一次登录即可得到可用的 Key，而应用从不持有平台凭据、从不重放会话、也从不发送平台未曾发起的请求。平台重构其内部端点不会破坏本功能，因为它一个也不调用。

残余暴露面是：该窗口是 Electron，其 user agent 表明了这一点；以及 CDP 挂载原则上可被观察。两者都不加掩饰：覆盖 user agent 会把"换了个浏览器"变成规避。最坏的结果是平台要求该窗口再验证一次，而不是账号处罚，因为从平台一侧看，这始终是一个已登录用户在自己的会话中操作。

该功能的代价是每次启动一次 profile 检查、首次启动一次 pnpm 安装，以及主窗口上的一个 preload。已存储的 Key 无法从页面校验，因此报告的状态是"已配置"而不是"可用"。无论走的是用户粘贴路径还是捕获路径，存入的 Key 都事先被公开端点接受过。
