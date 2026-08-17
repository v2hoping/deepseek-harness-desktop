# Agent Note: The COM path read spans its allocation, not a fixed window

Status: implemented

[English](2026-08-17-com-path-read-spans-its-allocation.md) | 中文

## Problem

在 Windows 上选择工作空间目录会直接杀死对话框 worker。用户只看到 `win32 folder dialog worker exited before reporting a result`，因为进程在原生代码中死亡，来不及通过 IPC 汇报任何东西。崩溃堆栈点出了帧：`readUtf16`，其下是 `napi_register_module_v1`，也就是 koffi 的原生层。

解码器在 `IShellItem::GetDisplayName` 返回的地址上视图了固定的 32768 字节窗口：

```js
const bytes = Buffer.from(koffi.view(address, 32768))
```

`CoTaskMemAlloc` 按字符串自身长度分配——像 `D:\dsh\workspace` 这样的路径是 34 字节。从它开始视图 32 KB 会跨越八个进程从未分配的页，读取它们即是访问违例。是否崩溃取决于堆中紧随该块之后是什么，这正是它得以存活到发布的原因。

## Decision

视图恰好覆盖字符串本身。`lstrlenW` 走到 COM 契约保证存在的终止符，解码器只映射这些单元：

```js
const units = Number(measure(address))
if (!Number.isFinite(units) || units <= 0) return ''
const bytes = Buffer.from(koffi.view(address, units * 2))
```

`lstrlenW` 的参数按 `void *` 而非字符串类型绑定，这样 koffi 度量的是该地址上已有的字符串，而不是把一个 JavaScript 值编组进去。

无法度量的长度则完全不读取。零、负数或 `NaN` 都在不视图任何内存的情况下返回空字符串，因此一次坏的度量不会变成一次坏的读取。

## Verification

`tests/read-utf16.spec.ts` 面向一个 koffi 替身驱动解码器，其 `view` 在被要求超出分配大小时抛错——用替身的访问违例代表真实的那一个。它固定了请求的确切跨度、一个非 ASCII 路径，以及三种无法度量的长度。

`tests/win32-dialog-bindings.spec.ts` 中的共享替身出于同样理由现在也拒绝超额视图，因此回归会让整个绑定测试套件失败，而不只是解码器自己的那个测试。

把固定窗口改回去会让五个测试以 `access violation: viewed 32768 of 34 allocated bytes` 失败，这正是生产环境那次崩溃在单元测试中的复现。

## Alternatives considered

**`koffi.decode(address, 'str16')`。** 最直观的 API，而模块注释已记录了它被否决的原因：koffi 会把该值当作指针解引用，而 `_Out_ void **` 出参持有的本就是地址本身，多出的这层间接在真实 Windows 上会崩溃。

**把窗口缩小到 `MAX_PATH * 2` 并按需增长。** 代价低，且会把崩溃从必然变为偶发——520 字节的视图通常落在同一个堆页内。但它仍然读取进程并不拥有的内存，等于用一个可复现的故障换来一个间歇性的故障。

**逐个单元扫描终止符。** 无需 `lstrlenW` 即可不越界读取。但每次读取都是一次跨边界的 koffi 调用，为拿回一个平台一次调用就能算出的长度，按字符付出这份开销。

## Consequences

选择工作空间目录不再取决于堆布局。解码器现在需要 `lstrlenW`，即在 `GetCurrentThreadId` 之外多一个 kernel32 绑定。

这次崩溃之所以长期不可见，是因为一个在原生层死亡的 worker 什么也报告不了：driver 的消息只陈述了这个事实本身。该 driver 现在会附上退出码与捕获的 stderr，因此下一次同类失败会带着原因抵达，而不需要读崩溃转储才能定位。
