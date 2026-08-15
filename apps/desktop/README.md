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

## Known limitations

The first desktop assembly uses a loopback HTTP Host, so it binds one OS-assigned loopback port. The renderer and Host protocol remain unchanged so the application can replace the transport with the IPC carrier reserved by the GUI architecture without changing product features.

Packaging produces unsigned unpacked applications. Installer formats, distribution signing, and notarization remain release work.

The window uses the host platform's ordinary system frame. Native chrome — a frameless inset title bar, sidebar vibrancy, and caption buttons placed inside the application header — remains presentation work in the client packages.

## Model Experience

The desktop shell does not add model-visible input. The reused Web profile continues to own its existing Web runtime context.
