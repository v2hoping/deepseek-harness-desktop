# Agent Note: The desktop records its startup to disk and reveals its window on first paint

Status: implemented

English | [中文](2026-08-17-desktop-startup-log-and-window-reveal.zh.md)

Two changes that make a desktop launch observable, written after a Windows launch that still produced no window and no evidence.

## Problem

A packaged GUI application has nowhere to write stderr on Windows. No console is attached, so every diagnostic the desktop already produced — the Host's own output, the account plugin's staging report, the reason a start failed — reached a stream nobody could read. The only report a user could make was "there is a process and no window", which is consistent with a failure at any point in a startup that stages a plugin, reserves a port, spawns a Host, waits for it to answer, creates a window, and loads a renderer.

The window itself carried a silent failure. It was constructed with `show: false` and revealed only after `loadURL` settled, so a renderer that was slow to finish its subresources — or a load that never settled at all — left a created, functioning window permanently invisible. That state is indistinguishable from the application never having started.

## Decision

Every startup step appends a timestamped line to `startup.log` in the platform's own log directory — `~/Library/Logs/DeepSeek Harness` on macOS, `%APPDATA%\DeepSeek Harness\logs` on Windows — carrying wall-clock time and milliseconds since launch, so a log shows which step stalled rather than only which step was last. The Host's output and the account plugin's staging report are recorded there as well as written to stderr. The startup-failure dialog names the file, because a user cannot report a log whose location they were never told.

Forwarding the Host's output outlives startup. The supervisor previously dropped its output listeners once the Host answered, which was enough to explain a failed start and nothing else: a native dialog worker that fails to load, or a plugin that throws an hour in, writes to a stderr the packaged application has no console for. Buffering stays startup-only — it exists to attach recent output to a start that failed, not to accumulate a running Host's whole history.

Writing to the log never fails a launch. It is the diagnostic of last resort, so an unwritable directory degrades to dropped lines. An oversized log from earlier launches is discarded rather than grown, and each launch also spends a byte budget as it writes, since the Host keeps producing output for as long as it runs. Stopping at the cap keeps the earliest lines, which are the ones that explain a startup.

Window reveal is driven by the first paint (`ready-to-show`) instead of by `loadURL` settling, with a 15-second fallback and an immediate reveal on `did-fail-load`. A window that fails to load now appears showing its error rather than never appearing at all, and `loadURL` remains awaited so a rejected load still fails the start loudly.

The window is also created before the Host is waited on, loading a splash page carrying no script and no external reference, and swapping to the Host's origin once that answers. Loading the Host's plugin tree past on-access virus scanning takes long enough on Windows that an empty desktop reads as a failure to start; the wait is the same length either way, but it is now visible. Session policy and the tray move ahead of that window for the same reason — the splash is a renderer, so the policy that governs renderers has to exist before it.

## Verification

`apps/desktop/tests/startup-log.spec.ts` pins the ordered lines and their timestamp format, the failure record with its stack, directory creation, discarding an oversized previous log, and that a log which cannot be written throws nothing at its caller.

The reveal paths are not covered by a unit test: they are Electron `BrowserWindow` event wiring, which this package has no harness for. They are exercised by running the application.

## Alternatives considered

**Rely on stderr and ask users to launch from a terminal.** No new code, and it is what the desktop already did. A GUI application started from Explorer has no console to inherit, and asking a user to reproduce a startup failure from `cmd` is asking them to run a different launch than the one that failed.

**Log through Electron's `--enable-logging` switch.** Built in, and it captures Chromium's internals too. It writes what Chromium chooses to write, not the desktop's own startup steps, and it has to be enabled by the person who already cannot start the application.

**Show the unpainted window at construction, loading nothing into it.** Removes the invisible-window failure outright and needs no splash document. It presents an empty frame for the whole Host startup, which reads as a hung application rather than a starting one; a splash page costs one small inline document and says which of the two is happening.

**Keep revealing only after `loadURL` and add a timeout there.** Closer to the previous behavior. `ready-to-show` is the earlier and more accurate signal: it fires when there is something to display, whereas `loadURL` waits for every subresource before conceding the page is up.

## Consequences

A failed Windows launch now leaves a file that names the last step reached and how long it took, which is what the previous two rounds of this investigation lacked. Every launch writes that file, on every platform.

The window can now appear before its content is fully loaded, so a slow first launch shows an empty window rather than nothing. That is the intended trade: an application that appears and then fills in is diagnosable, while one that never appears is not.

The log accumulates across launches until it passes the cap, so it holds the recent history of a machine's launches rather than only the current one.
