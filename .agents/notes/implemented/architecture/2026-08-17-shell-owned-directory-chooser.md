# Agent Note: A shell that owns a directory chooser answers without the Host

Status: implemented

English | [中文](2026-08-17-shell-owned-directory-chooser.zh.md)

## Problem

Choosing a workspace directory in the desktop application was slow enough to interfere with using it.

`WorkspacesService.pickDirectory` always reached the Host over the wire, and the Host's `native` capability opens the platform dialog by spawning a child process: the application executable run as Node, which then loads a native binding, initializes COM, and drives the Win32 dialog itself. Every pick therefore paid a cold Electron start before any dialog appeared, and on Windows an on-access virus scan of everything that start touched.

The desktop already had a dialog available. Electron's main process can open a directory chooser with one call, in a process that is already running.

## Decision

`pickDirectory` asks the surrounding shell first, and falls through to the Host when there is none:

```js
const shell = shellDirectories()
if (shell !== undefined) return await shell.pick()
```

The shell is read structurally from `window.dshDesktop.directories`, per call rather than captured, and only when its `pick` is callable. A browser tab has no such object and takes the Host path unchanged, which is what keeps `dsh web` identical wherever it runs. `dsh-client-runtime` gains no dependency on any shell package.

The desktop exposes that object through the same bridge the account feature uses: a preload surface over one IPC channel, whose main-process handler calls `dialog.showOpenDialog` modal to the window that asked, so a pick cannot be orphaned behind its own window.

Nothing about the Host's capability changes. It remains the picker for every consumer that is not inside a shell, and the browse capability — the in-page directory browser — is untouched.

## Verification

`packages/client/runtime/tests/workspaces-service.client.spec.ts` pins both directions: with a shell chooser present the Host is never called (`callsOf('host.pickDirectory')` is empty), and with an unrelated bridge exposed — a shell offering `account` but no `directories` — the Host answers as before.

The Electron half is IPC and `dialog` wiring, which this package has no harness for; it is exercised by running the application.

## Alternatives considered

**Make the desktop a Host-side `native` provider.** Puts the choice where the capability seam already is. The Host runs as its own process with no channel back to the shell, so serving it would mean inventing one for a call the renderer can already make directly.

**Ship a desktop-only client plugin registering into the directory-flow slots.** Matches how the account page is delivered, and keeps the shell branch out of `dsh-client-runtime`. It needs a second staged plugin — the staging path handles one — plus an overlay disabling the shipped flow so two do not register into the same slot, which is a large amount of composition to move one call.

**Expose the chooser as an optional client service read through `ctx.get`.** The repository's own idiom for an optional capability, and it would keep the lookup out of the service body. It requires a plugin to provide the service, which is the alternative above; with one consumer and one provider, the structural read is the whole of it.

**Keep the Host path and make the worker cheaper.** Leaves one picker for every surface. The cost is starting a process at all, and the cheapest process available to a packaged application is the application executable itself.

## Consequences

A pick inside the desktop opens immediately, and no longer loads a native binding to do it — so the crash class that binding produced cannot be reached from this path either.

`WorkspacesService` now has one branch that knows a shell may exist. It names no shell and imports nothing to check, but it is a lookup in a service that otherwise only talks over the wire.

The Host's native picker keeps its only remaining consumers: `dsh web` in a browser, and any other surface outside a shell. It is no longer exercised by the desktop, which is where it was being exercised most.
