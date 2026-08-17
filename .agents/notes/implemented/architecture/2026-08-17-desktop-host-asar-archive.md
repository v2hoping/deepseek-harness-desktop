# Agent Note: The packaged desktop Host ships as one asar archive

Status: implemented

English | [中文](2026-08-17-desktop-host-asar-archive.zh.md)

## Problem

Desktop startup on Windows was slow enough to interfere with using the application, and stayed slow after the installer removed the per-launch unpack.

The packaged Host closure was 31891 loose files. Starting the Host imports thousands of modules, and on Windows every first read of a file passes through Defender's on-access scan — a per-file cost that multiplies a millisecond-scale tax by the size of the dependency tree. macOS showed the same startup at ~600 ms because it has no such per-file tax; the mechanism the slowness rides on simply does not exist there, which is why it could not be reproduced or measured from the development machine.

Pruning declarations and sourcemaps had already cut the file count roughly in half, but the files startup actually reads are the `.js` modules that remained.

## Decision

The staged closure is packed into one `host.asar` beside the application, and the packaged launch runs the CLI entry from inside it. Electron's patched `fs` serves archive members to the Host process — `ELECTRON_RUN_AS_NODE` keeps that patching — so every module read lands in one already-open file, and the per-file open cost collapses to one.

What the operating system itself must open stays a real file in `host.asar.unpacked`: `dlopen`ed natives (`.node`, libraries), spawned executables, and the packages that ship such binaries under their own directories (node-pty's console hosts, ripgrep's `rg`, the Landlock launcher). Electron redirects archive paths to that sibling automatically. An `afterPack` gate requires at least one unpacked native, so rotted unpack patterns cannot ship natives nothing can load.

Bare plugin names reach into the archive through a resolver: `host-resolver.mjs`, one self-contained file beside the archive, loaded by the spawned Host via `--import`. It registers a `module.registerHooks` resolve hook whose fallback answers any failed bare specifier from a `createRequire` pinned at the archive's own `package.json`. The pinned `createRequire` — rather than retrying `nextResolve` with a rewritten `parentURL` — is load-bearing: the default resolver honors a rewritten parent for `import` but not for `require`, which was found empirically and is pinned by the client-manifest check below.

`healProfilesModuleFallback` skips an installation anchored inside an archive. The links it would create can never resolve — archive-internal paths exist only to Electron's patched `fs`, not to the operating system a symlink resolves through — and the launcher's resolver replaces what they provided. A `dsh web` from a separate CLI installation still heals and boots the shared profile exactly as before.

Two Electron Builder behaviors shape the packaging: the unpacked tree cannot travel through `extraResources` (mappings whose names involve `*.asar.unpacked` are silently dropped), so `afterPack` copies it from the staging output itself; and the archive is produced by `stage-runtime.ts`, which prunes `.d.ts`/`.map`/`.md` before packing.

## Verification

End to end on macOS against the real packaged application bundle: the Host boots from `host.asar` on an empty `$DSH_HOME` in ~2.5 s cold, serves `/` with 200, and lists all 38 client plugin bundles in the boot manifest — the same count as the loose-file baseline, which is the check that caught the `require`-retry failure above (the manifest was empty until the resolver used the pinned `createRequire`). The account plugin overlay flow — real files in the profile composing against the archived Host — serves its bundle with both settings registrations. A worker-thread entry inside an asar loads and reports.

macOS timings: loose files ~570 ms, archive ~715 ms — the archive parses a 170 MB header where macOS charges nothing per file. That overhead ships everywhere; the win this change exists for is the per-file scan tax, which only Windows charges and only a Windows launch can measure.

`tests/host-resolver.spec.ts` pins the fallback (both module systems' not-found codes, bare-only, original-error reporting); `profile.spec.ts` pins that an archive anchor heals nothing; `verify-packaged-runtime.spec.ts` pins the afterPack gates including the unpacked-native requirement.

## Alternatives considered

**Bundle the closure into a few JS files.** Collapses file count without asar and without Electron-specific machinery. It breaks the per-package identity the plugin system is built on: the Loader mounts plugins by package name, profiles add out-of-tree plugins resolved through `node_modules`, and `dsh-client-modules` serves per-package browser bundles. Bundling would be a re-architecture of composition to fix a packaging cost.

**Run the Host inside the Electron main process.** Saves the child Electron start and gives the window its URL directly. It abandons the supervised, independently runnable Host that is this desktop's deliberate architecture, and it does not touch the per-file cost — the in-process Host still reads the same files.

**Symlink stubs in the profile fallback pointing at archive paths.** Keeps the healing mechanism. Windows junctions require operating-system-real targets, which archive members are not; generated stub packages re-exporting archive paths would be a thousand small files regenerated per version — the shape this change removes.

**Ask users to exclude the install directory from scanning.** No code at all, and elevation-gated, security-hostile advice that most users will not apply. The application's own layout should not require it.

## Consequences

A Windows launch now opens one 170 MB archive instead of ~16 000 files, at every stage that touched them: NSIS extraction at install, Defender's first-read scans, and the Host's module loads. The same layout ships on macOS at ~150 ms of archive-header cost per launch, keeping one startup path on every platform.

The Host's installation is read-only in a stronger sense than before: nothing can write into the archive, which is true to how the installation was already treated.

The resolver is a launcher-owned seam: any future packaged surface that archives its installation needs the same `--import` hook, and the heal-skip in `app-boot` names the contract — an archived installation resolves through its launcher, not through profile links.
