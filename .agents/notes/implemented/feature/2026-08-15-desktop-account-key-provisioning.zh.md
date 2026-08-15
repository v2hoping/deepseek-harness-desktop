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

Key 的获取发生在平台自己的页面上。`快速获得` 在绑定持久 partition 的 `BrowserWindow` 中打开官方 Key 页，因此平台看到的是它自己的页面、它自己的设备标识、它自己的验证流程与用户本人的点击。外壳为该窗口挂上 Chrome DevTools Protocol 的网络事件，只启用 `Network`，读取响应体以寻找未脱敏的 `sk-…` 值。它不注入脚本、不发起自己的请求，也从不读取该页面的会话凭据。

三个细节决定捕获是否成立，而每一个都先错后对。只检查 `POST` 响应：创建是 POST，紧随其后的列表刷新是 GET 且其条目已脱敏，读到那些会得到一个被 API 拒绝的值。响应体在 `Network.loadingFinished` 时读取，因为在 `responseReceived` 时 `getResponseBody` 回答 "No data found for resource with given identifier"。匹配依据是未脱敏的值本身，而不是字段名或端点路径——平台把该字段叫作 `sensitive_id`，创建时返回完整值、列表里返回脱敏值，因此值自身的形态是唯一可靠的判据，并且在平台重命名字段或路径后依然成立。

捕获到的 Key 立即经既有的 `credentials.set` RPC 存入，先于任何其它检查。它的密钥只显示一次，拒绝存入用户刚创建的 Key 就等于把它彻底弄丢。页面随后在本次运行期间显示该 Key，默认脱敏、点击才展开，并且只保存在控制器的内存里：关闭应用即遗忘，而 Key 留在凭据层，由凭据子系统持有。

本应用不校验已存的 Key。刚签发的 Key 不会被 API 立即接受，而一条如实报告这一点的提示不给用户任何可做的事——Key 已经存好，下一次模型请求已经在用它。为此探测的代价是一次请求、最多十一秒挡在界面前的重试，以及一条读起来像失败的警告。

用量、账单、充值与 Key 管理都是在同一会话 partition 中打开官方页面的链接。自绘它们需要本决策拒绝调用的内部端点。

### 如何进入产品

该插件是外部插件（out-of-tree bundle）。`dsh plugin --profile web add file:<dir>` 把它装进 profile 目录，Loader 的裸说明符解析在那里能够找到它，而 CLI 会把任何声明了 `dsh.bundle.patch` 的包追加进 `dsh.profile.bundles`。`apps/desktop/src/account/ensure-plugin.ts` 在 Host 启动前执行这件事，并在 profile 清单已记录该依赖时跳过，因此普通启动不会拉起包管理器。该步骤失败时，Host 仍完全可用，只是没有账户页。

账户 section 本身不需要改动外壳：`settings.section` 是开放的 list slot。浏览器半读取 `window.dshDesktop?.account`，缺失时不注册任何东西，因此 `dsh web` 的浏览器标签页看到的设置页面与此前完全一致。渲染进程经由 preload 触及外壳，该 preload 只暴露两个账户方法、不暴露任何裸 IPC 通道，沙箱与上下文隔离保持不变。

触及首次运行步骤是唯一需要既有包让路的地方。`settings.onboarding.credentialAction` 是引导凭据输入框旁的一个 single slot，声明时带上它正在索取凭据的 provider route；`ProviderEditor` 把占据它的内容渲染进输入框的控件组，并且只在确有占据者时才把输入框相邻的两个圆角改成直角。该 slot 不提及账户概念，也不依赖本插件：无人占据时，该步骤的渲染与改动前完全一致。本插件占据它，拒绝 `deepseek-official` 之外的每一个 route，并通过账户页所用的同一个控制器存入——因此引导期间获得的 Key 正是账户页随后显示的那个。存入会发出 `credentials/updated`，而该步骤自己的控制器本就监听这个事件，因此双方都不需要知道对方的存在。

## Verification

`apps/desktop/tests/account.spec.ts` 钉住：捕获会从创建响应中取出密钥、忽略脱敏的列表形式与不含 Key 的响应体、并能读取 base64 传输的响应体；列表刷新永不被误认作创建；响应追踪器只跟踪平台 API、每个响应体只交付一次、并在响应从不完成时保持有界；以及安装检查把全新 profile、他方清单与损坏清单都判为未安装。以浏览器驱动桌面 Host 确认了：桥存在时账户 section 注册、桥缺失时不出现——这正是 `dsh web` 的保证。装入 profile 也已端到端确认：清单记录了该依赖，且 `dsh.profile.bundles` 增加了 `@deepseek-ai/dsh-desktop-account`。

CDP 的时序由实测而非假设确定：在 `responseReceived` 时协议回答 "No data found for resource with given identifier"，在 `loadingFinished` 时返回响应体。

登录与创建路径需要真实账号，已人工对平台验证，包括本决策所针对的那种情形——Key 已创建并存入，而 API 仍在拒绝它。

## Alternatives considered

**提取平台的 bearer token 并调用其内部端点。** 这是完全自动化所需要的——列出 Key、创建 Key、读取用量，全程不离开应用。该 token 不在任何普通存储中，因此获取它意味着从官方页面的运行时里读出一个被混淆的存储，而此后每个请求都不携带平台期待的浏览器身份。判断错误的代价是用户的账号，而不只是一个失败的功能。

**读取 Key 列表并复用第一个 Key。** 这是显而易见的设计，也是最初提出的方案。列表只返回脱敏值，因此它报告的任何 Key 都无法认证任何东西。

**在应用内用 iframe 内嵌登录页。** 平台设置了 `X-Frame-Options`，且被内嵌的页面本来也不共享会话。

**自建登录表单并调用平台的登录端点。** 不存在公开的登录端点，该流程带有图形验证与设备指纹，而且用户的密码与短信验证码会流经我们的界面——用户理应拒绝这一点。

**把插件放进 `packages/client`。** 它会与其它 UI 插件并列，也更便于日后回馈上游，但它将为一个 fork 本地的功能承担包层的门禁（每文件全覆盖、invariant 伴生插件、限制章节），并把一个仅桌面可用的能力放进共享层。

**在应用内自绘用量与账单。** 两者都需要内部端点。链接的代价是用户多一个窗口，而且不会因平台改版而损坏。

**报告成功之前先校验已存的 Key。** 第一版就是这么做的，而它错了两重：为一个用户无法据以行动的答案，让界面等待最多十一秒的重试；而更早的一版还把存储置于校验之后——那会丢弃一个密钥只显示一次的 Key。刚创建后被拒绝的真实含义是"还没生效"，而无论如何，对此唯一的回应都是等待。

**持久化记录获得的是哪个 Key。** 一份持久记录能跨重启存活，并能展示 Key 的来历。但它同时意味着把一个完整的 Key 写进第二个文件，违背凭据子系统"存引用不存值"的规则。会话内存在用户真正需要的那一刻——刚创建完——把 Key 展示给他，且不付出任何代价。

**在账户窗口里隐藏平台自己的导航。** 用注入的 CSS 可以把窗口裁剪到只剩 Key 表单。但那个窗口正因为看起来就是平台自己的页面才可信，而用户要在里面输入密码；并且它的侧边栏带着充值入口——一个刚创建 Key 的用户很可能接下来就需要它。

## Consequences

用户经两次点击加一次登录即可得到可用的 Key——无论从首次运行步骤还是从设置进入——而应用从不持有平台凭据、从不重放会话，并且完全不向 DeepSeek 发送任何请求。平台重构其内部端点不会破坏本功能，因为它一个也不调用；重命名创建端点或其字段同样不会，因为匹配依据是 Key 自身的形态。

残余暴露面是：该窗口是 Electron，其 user agent 表明了这一点；以及 CDP 挂载原则上可被观察。两者都不加掩饰：覆盖 user agent 会把"换了个浏览器"变成规避。最坏的结果是平台要求该窗口再验证一次，而不是账号处罚，因为从平台一侧看，这始终是一个已登录用户在自己的会话中操作。

该功能的代价是每次启动一次 profile 检查、首次启动一次 pnpm 安装，以及主窗口上的一个 preload。它不声称已存的 Key 是否可用：`credentials.describe` 永不返回值，而本决策停止了对无法据以行动之事的探测。一个最终无效的 Key 会以一次失败的模型请求暴露出来，而同一个按钮就能替换它。

为此改动的上游只有一处：引导凭据的扩展位。它是一个中立扩展点——一条 slot 声明、编辑器渲染占据它的内容、以及钉住空位的那个测试——不含账户概念、不依赖本插件，因此可以原样提交给上游。本功能所需的其余一切，要么本就是开放 slot，要么是既有 RPC。
