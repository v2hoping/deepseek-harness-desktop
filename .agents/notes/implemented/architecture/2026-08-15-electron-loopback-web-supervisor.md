# Agent Note: Electron desktop starts as a replaceable loopback Web supervisor

Status: implemented

English | [中文](2026-08-15-electron-loopback-web-supervisor.zh.md)

## Problem

The desktop application needs an Electron window and a tray-owned application lifetime without making the window the owner of Harness work. Closing the window must leave sessions and background work running, while an explicit application quit must dispose the Harness process and wait for its descendants. Building the final Electron IPC carrier at the same time would also require a packaged client-module loader, an IPC streaming transport, native-operation routing, and a new renderer security boundary before the first usable shell could ship.

The existing Web profile already provides the complete interactive client, ApiProxy validation, session replay, approval handling, configuration UI, and native Host operations. The first desktop implementation needs to reuse those behaviors without making its process arrangement permanent or weakening the [channel-independent GUI protocol](2026-07-19-gui-layering-and-rpc-protocol.md).

## Decision

`@deepseek-ai/dsh-desktop` in `apps/desktop` is a private Electron application and a replaceable supervisor, not a new Harness composition or protocol carrier. It starts one `dsh web` child bound to loopback on an operating-system-assigned port, then loads the canonical URL from the child's `dsh web: <url>` readiness line. The readiness parser follows stream chunks rather than stdout callback boundaries, ignores unrelated output and the optional LAN annotation, and accepts only an HTTP loopback authority with a valid nonzero port. A malformed readiness line, startup error, early child exit, or end-of-stream before readiness fails startup instead of navigating to an inferred address.

The root `dev:desktop` command is the complete source-launch entry. Before Electron starts, it builds the Host and client package faces, the Web frontend, and the Electron main process, so a fresh dependency installation does not require a separate repository build.

The root `package:desktop` command is the complete local packaging entry. It performs the same repository build, then `apps/desktop/scripts/stage-runtime.ts` creates an ignored `apps/desktop/runtime-host` tree from the dependency-only `apps/desktop/runtime/package.json` manifest. The stager runs a production-only hoisted `pnpm deploy`, restores direct dependencies omitted by legacy deploy, materializes package links, and rejects every remaining symbolic link. Electron Builder copies that closed tree into the application's `resources/host` directory together with the built Web frontend.

The packaged supervisor starts `resources/host/node_modules/@deepseek-ai/dsh/lib/bin.js` with the packaged Electron executable and `ELECTRON_RUN_AS_NODE=1`; source launches continue to use the host `node` command and workspace CLI entry. Electron's Node mode provides the separate Host process without adding a second Node executable to the application. The shipped Electron Node ABI therefore owns compatibility with native dependencies in the staged closure.

macOS and Windows use the same tracked `apps/desktop/build/icon.png` input without repository-side conversion. Local `package:desktop` output is unpacked and unsigned, so it requires no distribution credentials.

The child remains the sole owner of the Web profile's Cordis tree, sessions, settings, credentials, filesystem and shell services, HTTP/WebSocket carrier, and quiescent disposal. Electron does not import those services into its main or renderer process. The BrowserWindow loads the validated loopback URL with Node integration disabled and context isolation and renderer sandboxing enabled. Its one preload exposes the desktop account methods and no raw IPC channel ([account provisioning](../feature/2026-08-15-desktop-account-key-provisioning.md)). This is still the existing local Web security model: the desktop shell adds no authentication or IPC authorization layer.

The tray and Host supervisor own application lifetime independently of BrowserWindow visibility. A user window close is intercepted and hides the window; it neither quits Electron nor signals the child. Tray activation and macOS application activation show the existing window again. `window-all-closed` is not an exit request. The single-instance lock prevents a second desktop process and second Host child; a second launch only restores and focuses the primary window.

Every explicit exit path converges on one idempotent quit operation. It stops accepting window-restoration work, sends `SIGTERM` to the child, and waits for the child to exit. The ordinary `dsh` launcher handles that signal by disposing the root Cordis fiber, whose owned persistence and subprocess services drain before process exit. A bounded timeout escalates an unresponsive child to `SIGKILL` once and still waits for child settlement before Electron exits. Repeated quit requests join the same operation rather than starting another signal or timer sequence.

An unexpected child exit after readiness reports its exact code and signal, then enters the same application quit operation. The shell does not leave a live window attached to a dead Host and does not restart an execution environment without an explicit recovery policy.

The supervisor presents start/readiness/shutdown facts to the Electron application instead of exposing child-process mechanics to window and tray handlers. A later local custom-protocol plus IPC carrier may replace the loopback child behind this ownership point. That migration replaces asset loading and transport while retaining the tray/window lifetime rules and the existing ApiProxy message model; the first phase does not introduce a compatibility promise for the child arrangement.

### Repository placement

`apps/desktop` is a workspace member whose product is an installable application, not an npm package, so it is the first `apps/*` member outside the dsh npm release family. `scripts/release/families.ts` names the published app assemblies explicitly (`apps/cli` and `apps/web`) and `scripts/check-workspace-constraints.ts` consumes that list, so a private application manifest is accepted while every published member still states its publish access and repository directory.

The package keeps its own compiler face rather than joining `tsconfig.host.json`: the Electron type package declares browser globals that must not reach the Host aggregate's program. `apps/desktop/runtime` is a separate nested workspace member so the deploy-only manifest stays outside application build and release-family scans.

### Distribution

`dist:desktop` produces an unsigned disk image. Electron Builder applies an ad-hoc signature because no Developer ID identity is configured, and macOS reports an ad-hoc bundle as damaged rather than as an unverified developer while the download quarantine attribute is present, so neither Finder's open-anyway path nor the security-settings override applies to it. Removing that attribute is the only way a downloaded build starts, which `apps/desktop/scripts/install.sh` does after copying the application.

A disk image is the distribution format because the bundle contains framework symbolic links that a plain archive flattens; the installer copies with `ditto` for the same reason. The artifact name omits spaces so a release URL needs no escaping.

The application carries its own version rather than the repository's. It is not a member of the dsh npm release family, and its `desktop-v` tags announce a sequence of their own, so inheriting the repository version would name a disk image after an upstream prerelease that says nothing about this application.

Every entry that needs Electron re-runs its idempotent binary unpack. pnpm runs that postinstall once when the package is installed and not again after the unpacked binary is removed, so a workspace that lost it would otherwise fail at packaging time instead of at install time.

### Upstream upgrades

The fork's cost of tracking upstream is the existing files it edits — repository configuration, four release and hygiene scripts, and one onboarding extension seat — so `apps/desktop/scripts/upgrade-from-upstream.ts` automates only what carries no decision. It merges the upstream ref, resolves conflicts in `pnpm-lock.yaml` and `THIRD_PARTY_NOTICES.md` by regenerating them, and stops on every other conflict with the paths that need a human. It then reinstalls, refreshes generated files, runs the desktop closure check, and packages the application, so a completed run has already proven the merge builds.

The readiness line is the one coupling no gate observes: an upstream format change merges cleanly and compiles. Starting the packaged application the run produces is what surfaces it.

## Verification

`apps/desktop/tests/host-supervisor.spec.ts` pins readiness across arbitrary stdout chunks and an unterminated final line, rejects invalid schemes, hosts, ports, and missing readiness, and covers one in-flight start, startup failures, early exits, idempotent shutdown, cooperative `SIGTERM` settlement, and the one-shot timeout escalation. `apps/desktop/tests/window-lifecycle.spec.ts` pins close-as-hide, coalesced window creation, quit-time restoration refusal, and one Host disposal before Electron's quit retry. `apps/desktop/tests/packaging-config.spec.ts` pins the shared source icon, the complete-build and runtime-staging commands, the packaged Host resource mapping, the pinned Electron distribution, and the repository-root entries. `apps/desktop/tests/verify-packaged-runtime.spec.ts` pins the pre-package rejection of missing Host entrypoints. Source checks and review pin the Electron event wiring, single-instance restoration, exact-origin navigation policy, and hardened BrowserWindow settings.

## Alternatives considered

**Build the IPC carrier before shipping any desktop application.** This is the target transport direction, but it combines process security, client-module packaging, bidirectional streaming, cancellation, native operations, and lifecycle work in one first release. The supervisor keeps that migration available without making all of it a prerequisite for a tray shell.

**Boot the Harness plugin tree inside Electron's main process.** This removes one child process and the loopback socket, but it couples model, persistence, and subprocess failures to the process that must keep the tray and quit controls responsive. It also creates a second application assembly instead of exercising the shipped Web profile, and it requires a module-resolution substitute because Electron does not expose Node's internal module loader to the Loader's builtin-require path.

**Terminate the child whenever the window closes.** This makes BrowserWindow visibility own agent lifetime, discards background work, and contradicts a tray-resident application. Only an explicit application quit owns Host disposal.

**Destroy and recreate the BrowserWindow on close.** Session replay can reconstruct durable conversation state, but transient client state and open controls would be lost. Hiding preserves the current client generation for the first shell; accepting its renderer memory cost is explicit.

**Use a fixed loopback port or infer the address from process arguments.** A fixed port creates avoidable collisions and an inferred URL can race a server that has not completed Loader activation. Port zero plus the existing post-settlement readiness line lets the child report the address it actually owns.

**Kill the child immediately on explicit quit.** Immediate termination shortens shutdown but skips session flushes and managed process-tree cleanup. `SIGTERM` delegates disposal to the child; forced termination remains only the bounded failure path.

**Give the first shell native platform chrome.** A frameless inset title bar, sidebar material, and caption controls placed inside the application header require presentation changes across the layout, theme, and conversation client packages. The window keeps the platform's ordinary system frame so the first shell's correctness rests on lifecycle and packaging alone.

## Consequences

The desktop application ships the existing interactive product with little Host or client risk, and closing its window leaves the agent runtime available from the tray. The extra process also isolates Electron's application controls from ordinary Harness failures and leaves one explicit point where the transport can later change.

This phase pays for a loopback listener, an additional Node process, readiness-line coupling, and the resource cost of a hidden renderer. It inherits the Web carrier's trust and exposure rules rather than gaining an Electron IPC security boundary. A distributable package carries the CLI production dependency closure and Web frontend, while Electron's Node mode avoids a duplicate Node binary at the cost of coupling native dependency compatibility to Electron's shipped ABI. Runtime staging also depends on legacy `pnpm deploy` behavior and therefore restores omitted direct dependencies and removes links before Builder consumes the tree. Desktop startup succeeds only after the child reports its post-Loader URL. A Host crash exits the shell instead of recovering the current window; automatic restart remains a later lifecycle decision.

Local packaging produces unsigned unpacked applications. Installer formats, distribution signing, and notarization remain separate release work, and the window keeps its ordinary system frame until platform chrome lands in the client packages.

The child arrangement is an implementation choice, not a public protocol. A future IPC-backed desktop still uses the four-quadrant ApiProxy contract and preserves close-as-hide, tray ownership, single-instance behavior, and ordered Host disposal, while replacing the loopback server, readiness line, and supervised CLI process.
