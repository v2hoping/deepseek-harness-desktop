# Agent Note: Desktop Host readiness is an HTTP answer, not a line of stdout

Status: implemented

English | [中文](2026-08-17-desktop-readiness-http-probe.zh.md)

The desktop supervises the Web Host as a child process and opens its window once the Host is serving. This records how it learns that, after the original mechanism turned out to be unavailable on Windows.

## Problem

The supervisor learned the Host was up by parsing its stdout for `dsh web: http://127.0.0.1:<port>`, then loaded that origin. Electron does not deliver a child process's piped stdout on Windows ([electron/electron#28492](https://github.com/electron/electron/issues/28492), [#5713](https://github.com/electron/electron/issues/5713)), so the line never arrived there.

The Host started correctly and served correctly; the desktop simply never noticed. Every Windows launch showed a process in Task Manager and no window at all, until the 90-second readiness timeout finally produced an error dialog. macOS was unaffected, and the repository has no Windows desktop test — the CI `windows` job runs the wine gates, not the application — so nothing caught it before release.

The readiness line was also weaker evidence than it appeared. It reports that the Host reached its own log statement, not that it can answer a request.

## Decision

The desktop reserves a loopback port, tells the Host to bind it, and polls that origin over HTTP until it answers. Any complete response counts, including an error status: the question is whether the Host is listening, not what it says about `/`.

Reserving the port is what makes probing possible — an origin cannot be probed before it is known, and an OS-assigned port is only knowable from the Host itself. `reserveLoopbackPort` binds port `0`, reads the assigned port, and releases it. The port is free when it is returned, not when the Host binds it; nothing can hold that reservation without becoming the listener. A port taken in the gap surfaces as the Host failing to bind and exiting before readiness, which the supervisor already reports with the Host's output attached.

The supervisor still reads stdout and stderr, but only to accumulate the diagnostic text attached to a startup failure. No control decision depends on it, which is what keeps the mechanism identical on every platform: there is no Windows-only path that only Windows users would exercise.

## Verification

`apps/desktop/tests/loopback.spec.ts` pins the reservation and the probe against real servers: a reserved port is free to bind, a probe answers `true` for a serving origin including a `503`, and `false` for a closed port and for a connection that is accepted but never answered.

`apps/desktop/tests/host-supervisor.spec.ts` pins that readiness ignores stdout entirely — a Host that printed its readiness line but is not answering is not ready, and one answering without printing anything is.

End to end on macOS against a real Host: the reservation, the `--port` handoff, and the probe bring startup to ready in about three seconds, and the origin then answers `GET /` with 200. The Windows behavior this change exists for cannot be verified from this machine and needs a real Windows run.

## Alternatives considered

**Keep parsing stdout.** No new moving parts, and it already worked on two of three platforms. It cannot work on the third, which is the one that reported the bug.

**Have the Host write its port to a file the desktop watches.** Keeps the OS-assigned port and makes the Host the authority on where it bound. It requires a new CLI flag and a written contract between the desktop and the Host about a file's location, lifetime, and cleanup — a cross-package change to fix a defect contained in the desktop.

**Poll on Windows and parse stdout elsewhere.** Preserves the existing path where it works. Rejected because it leaves the Windows path exercised only by Windows users: the platform with the fewest developers running it would be the platform with its own untested startup mechanism.

**Run the Host in an Electron `utilityProcess`.** Electron's own answer to child-process stdio, and it would keep an OS-assigned port. It replaces how the Host is launched rather than how its readiness is observed, giving up the plain-`node` child that makes the Host independently runnable and debuggable ([loopback supervisor](2026-08-15-electron-loopback-web-supervisor.md)).

## Consequences

Readiness now means the Host answered a request, which is what the window actually needs, and the same code path runs on every platform.

Startup does one extra bind/release before spawning, and readiness is observed at the polling interval rather than the instant the Host is up — 250 ms of granularity against a startup measured in seconds.

The reservation introduces a window in which another process can take the port. It is small, it fails loudly through the existing exit-before-readiness report, and closing it entirely would require the Host to own the port choice, which is the alternative rejected above.
