# Agent Note: The COM path read spans its allocation, not a fixed window

Status: implemented

English | [中文](2026-08-17-com-path-read-spans-its-allocation.zh.md)

## Problem

Choosing a workspace directory on Windows killed the dialog worker outright. The user saw only `win32 folder dialog worker exited before reporting a result`, because the process died in native code before it could report anything over IPC. A crash dump named the frame: `readUtf16`, below `napi_register_module_v1`, which is koffi's native layer.

The decoder viewed a fixed 32768-byte window at the address `IShellItem::GetDisplayName` returned:

```js
const bytes = Buffer.from(koffi.view(address, 32768))
```

`CoTaskMemAlloc` sizes that string to its own length — 34 bytes for a path like `D:\dsh\workspace`. Viewing 32 KB from it spans eight pages the process never allocated, and reading them is an access violation. Whether it crashed depended on what happened to follow that block in the heap, which is why it survived long enough to ship.

## Decision

The view spans exactly the string. `lstrlenW` walks to the terminator the COM contract guarantees, and the decoder maps only those units:

```js
const units = Number(measure(address))
if (!Number.isFinite(units) || units <= 0) return ''
const bytes = Buffer.from(koffi.view(address, units * 2))
```

`lstrlenW` is bound with a `void *` parameter rather than a string type, so koffi measures the string already at that address instead of marshalling a JavaScript value in.

An unmeasurable length reads nothing at all. A zero, a negative, or a `NaN` returns the empty string without viewing memory, so a bad measurement cannot become a bad read.

## Verification

`tests/read-utf16.spec.ts` drives the decoder against a koffi stand-in whose `view` throws when asked for more than the allocation holds — the fake's access violation standing in for the real one. It pins the exact span requested, a non-ASCII path, and the three unmeasurable lengths.

The shared fake in `tests/win32-dialog-bindings.spec.ts` now refuses an oversized view for the same reason, so the whole binding suite fails on a regression rather than only the decoder's own test.

Restoring the fixed window fails five tests with `access violation: viewed 32768 of 34 allocated bytes`, which is the production crash reproduced in the unit lane.

## Alternatives considered

**`koffi.decode(address, 'str16')`.** The obvious API, and the module's comment records why it was rejected: koffi dereferences the value as a pointer, and the `_Out_ void **` out-param already holds the address itself, so the extra indirection crashes on real Windows.

**Shrink the window to `MAX_PATH * 2` and grow on demand.** Cheap, and it would have made the crash rare rather than certain — a 520-byte view usually lands inside the same heap page. It still reads memory the process does not own, so it trades a reproducible failure for an intermittent one.

**Scan for the terminator one unit at a time.** Never reads past the string without needing `lstrlenW`. Each read is its own koffi call across the boundary, paying that cost per character to recover a length the platform already computes in one call.

## Consequences

Selecting a workspace directory no longer depends on heap layout. The decoder now needs `lstrlenW`, one more kernel32 binding beside `GetCurrentThreadId`.

The crash was invisible for as long as it was because a worker that dies natively reports nothing: the driver's message named only that fact. That driver now attaches the exit code and captured stderr, so the next failure of this shape arrives with its cause instead of requiring a crash dump to read.
