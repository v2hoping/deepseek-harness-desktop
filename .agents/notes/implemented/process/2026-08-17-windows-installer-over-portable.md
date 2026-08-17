# Agent Note: Windows ships an installer instead of a portable executable

Status: implemented

English | [中文](2026-08-17-windows-installer-over-portable.zh.md)

## Problem

The Windows target was electron-builder's `portable`, which wraps the whole application in a self-extracting NSIS stub. Nothing is installed: every launch unpacks the complete payload — 112 MB of Electron, the staged Host closure, and its native packages — into `%TEMP%` before the application's own startup can begin, and Windows Defender scans what was just written. Launches were reported as very slow, while macOS, where a disk image is mounted and copied once, was not.

The stub also misrepresents what was built. It is a 32-bit executable regardless of the payload's architecture, so Task Manager shows a 32-bit process for an x64 application, and the architecture cannot be read back from the produced file.

Nothing about the application benefited from being portable. It writes to `$DSH_HOME` and to its own user data on every launch, so it was never the no-footprint tool the format is for.

## Decision

Windows ships an NSIS installer, `DeepSeek-Harness-<version>-x64-Setup.exe`.

It installs per user (`perMachine: false`), so no administrator prompt stands between a download and a running application, and it keeps the install out of `Program Files` where a per-machine write would need elevation. `oneClick: false` shows the wizard and lets the user choose the directory; `runAfterFinish` starts the application when the wizard closes. Start menu and desktop shortcuts are created under the product name.

`useZip: true` trades installer size for extraction speed, which is the whole point of the change: the payload is written once, at install time, instead of on every launch.

The macOS side is unchanged. It already had this property — a disk image is copied to Applications once — which is why the slowness was reported on one platform only.

## Verification

`apps/desktop/tests/packaging-config.spec.ts` pins the target, the declared x64 architecture, the artifact name, and the four installer behaviors this change exists to provide: a wizard rather than a one-click install, a launch when it finishes, both shortcuts, and a per-user install.

The startup cost this removes is not measurable from a macOS machine and was confirmed by the reporting user's Windows install.

## Alternatives considered

**Keep `portable` and shrink the payload.** Attacks the same cost from the other side, and the payload is a full Electron runtime plus a Node dependency closure. Nothing in it is large by accident, and any reduction still pays the unpack on every launch rather than once.

**Ship both a portable build and an installer.** Serves users who cannot install software. It doubles the Windows release surface and the support burden for a case nobody has asked for, and the portable path would keep its startup cost for whoever chose it.

**Use `nsis-web`.** A small downloader that fetches the payload during installation, which is what a large application usually wants. It requires the package to be hosted where the installer can reach it at install time, adding a release-hosting dependency to a release that is currently one GitHub asset.

**One-click install (`oneClick: true`).** Fewer steps, and it is electron-builder's default. It gives the user no control over the install location and no visible confirmation of what is happening, which for an unsigned installer that SmartScreen has already warned about reads worse, not better.

## Consequences

A Windows launch now starts the application instead of unpacking it first, and the application appears in Start menu, desktop, and the installed-programs list with a working uninstaller.

Users of the previous portable executable are not migrated: it never registered anything, so there is nothing to upgrade in place. They run the installer and delete the old `.exe`. Their `$DSH_HOME` profile and account credential are untouched, since neither ever lived inside the application.

The release now carries an installer, so the Windows artifact is no longer runnable straight from the download without installing.
