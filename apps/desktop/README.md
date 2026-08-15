# DeepSeek Harness Desktop

English | [中文](README.zh.md)

The desktop app supervises the existing loopback Web Host and keeps it alive from the system tray when its window is closed.

## Development

Install dependencies, then use the single desktop development command. It builds the Host and client packages, Web frontend, and Electron main process before launching the application:

```sh
pnpm run dev:desktop
```

Closing the window hides it. Use the tray menu to restore the window or quit the application. Explicit quit waits for the Host process to stop and escalates termination after the bounded Host grace period.

The desktop app accepts only the readiness URL emitted by `dsh web` for `127.0.0.1` or `localhost`. Navigation stays on that origin; HTTP and HTTPS links open in the system browser.

## Packaging

The local packaging command performs the complete repository build, stages the Host's closed production dependency tree, and creates an unpacked application for the current platform. A separate manual build is not required:

```sh
pnpm run package:desktop
```

Packaged applications run the staged `@deepseek-ai/dsh` CLI in a separate process through Electron's Node mode. The application therefore retains the supervised-Host lifecycle without shipping a second Node executable. An `afterPack` check rejects the package when the staged CLI entry or Web frontend entry is absent. Both macOS and Windows use the exact tracked `apps/desktop/build/icon.png` source; the repository does not preprocess or commit platform-specific icon variants.

## Upstream upgrades

One command merges the upstream Harness repository and rebuilds the application:

```sh
pnpm run upgrade:desktop
```

It requires a clean working tree, adds the `upstream` remote when absent, and prints the pre-merge commit so `git reset --hard` can undo the run. Conflicts in `pnpm-lock.yaml` and `THIRD_PARTY_NOTICES.md` are resolved by regenerating both files and committing the merge; a conflict anywhere else stops the run and names the files that need a decision. After the merge it reinstalls dependencies, refreshes generated files, verifies that `apps/desktop/runtime/package.json` still covers the upstream dependency graph, and packages the application.

`--dry-run` lists the incoming commits without merging. `--ref <branch>` merges a branch other than `master`. `--skip-merge` resumes after a hand-resolved conflict. `--skip-package` stops after the merge.

The one upstream change this cannot detect is a different `dsh web: <url>` readiness line: the merge is clean, the build succeeds, and only a launched application shows the failure. Reviewing the merge diff of `packages/bundle/web-app` covers it, as does starting the packaged application the run produces.

## Known limitations

The first desktop assembly uses a loopback HTTP Host, so it binds one OS-assigned loopback port. The renderer and Host protocol remain unchanged so the application can replace the transport with the IPC carrier reserved by the GUI architecture without changing product features.

Packaging produces unsigned unpacked applications. Installer formats, distribution signing, and notarization remain release work.

The window uses the host platform's ordinary system frame. Native chrome — a frameless inset title bar, sidebar vibrancy, and caption buttons placed inside the application header — remains presentation work in the client packages.

## Model Experience

The desktop shell does not add model-visible input. The reused Web profile continues to own its existing Web runtime context.
