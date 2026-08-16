# Agent Note: Desktop-only plugins reach a launch by staging plus a patch overlay

Status: implemented

English | [中文](2026-08-16-desktop-plugin-staging-and-overlay.zh.md)

The desktop application ships an account plugin the package tier does not carry. This records how that plugin reaches the Host it boots, after the first mechanism worked only on the machine that built it.

## Problem

The account plugin ships inside the application, but the Harness Loader anchors bare plugin specifiers at the profile directory, so a shipped plugin is not reachable just by being inside the application bundle. The first mechanism therefore installed it with `dsh plugin --profile web add file:<dir>`.

That command forwards to pnpm, which a packaged application cannot reach. `dsh plugin` spawns a bare `pnpm`, resolved through PATH, and a GUI launched from Finder or Explorer inherits a minimal PATH that excludes a user's own install; the staged Host ships no package manager either. The install therefore failed on every machine that was not a development checkout, and `ensureAccountPlugin` reports such a failure without throwing so the application still starts. The browser half then finds no account bridge and registers nothing. Both steps are silent, so the shipped result was an application whose Settings pages simply had no Account section and whose first-run step had no **Get an API key** action, with one line on a stderr no GUI user sees.

The mechanism also wrote the developer's own checkout path into `$DSH_HOME/profiles/web/package.json` as a `file:` dependency, and the installed check only asked whether that dependency key was present. A development machine therefore kept loading the checkout rather than the application's own copy, which is why the failure did not reproduce where it was introduced.

## Decision

The application stages the plugin and composes it per launch. Neither step runs a package manager.

**Staging** copies the shipped plugin directory to `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-desktop-account`. Node's module lookup from any profile directory reaches that directory one level up, which is the same flat fallback the CLI already maintains so in-box bundles resolve without pnpm managing them. The copy is refreshed whenever the shipped version differs from the staged one, and a development launch passes `alwaysRestage` because a checkout's version does not move as its source does.

**Composition** boots the Host with `dsh web --patch <staged>/cordis.patch.yml`, the overlay the plugin already declares for its own Loader row. `dsh web` stops parsing its own options at the first one it does not own, so the overlay precedes the flags the web app takes.

Composing per launch is what keeps the profile itself untouched. `$DSH_HOME/profiles/web` is shared with any `dsh web` the user runs from a separate installation, so a bundle row naming a package only this application can resolve would fail that CLI's Loader loud once the application moved or was removed.

Because an earlier build did write into that profile, staging first prunes what it left: the bundle row, the `file:` dependency pinning the plugin to the building machine, and the profile-local copy. All three have to go — a surviving bundle row composes the plugin a second time on top of the overlay, and a surviving profile-local copy wins the module lookup over the staged one.

A copy rather than a symlink is what survives the Windows portable build, which unpacks to a fresh directory on every run; a link into the application would dangle.

## Verification

`apps/desktop/tests/account.spec.ts` pins staging, the version-triggered restage, the unconditional restage, the exclusion of an install tree under the plugin directory, the absent-plugin report, and each part of the prune. `apps/desktop/tests/host-supervisor.spec.ts` pins the overlay's position ahead of the web app's flags.

The packaging gate now rejects a build missing the plugin's manifest, overlay, or built `lib/client.js`. That last file is untracked build output, so a packaging run over a clean checkout that skipped the plugin's build previously shipped everything else and lost only the Account section.

End to end, against an empty `$DSH_HOME` and with no package manager involved: the Host boots with the overlay and serves the plugin's browser bundle at `/plugins/@deepseek-ai/dsh-desktop-account/client.js`, carrying both the Account section and the `settings.onboarding.credentialAction` registration.

## Alternatives considered

**Ship pnpm with the application, or invoke it by absolute path.** Keeps the existing install path, and costs a package manager plus a network install in a desktop launch — for a plugin the application already carries on disk. It also leaves the failure mode intact wherever the install itself fails.

**Resolve the plugin from the application's own Host instead of `$DSH_HOME`.** `resolveBundleDir` tries the installation before the profile, so placing the plugin in `host/node_modules` would resolve without touching the user's home at all. It fails for the reason the profile is shared: the Loader anchors overlay specifiers at the profile directory, not at the installation, so the plugin would not resolve from an overlay row.

**Keep writing the profile's bundle list.** Self-contained, and it survives the application's removal. Rejected because the profile is shared: the user's own `dsh web` would then boot a profile listing a package that only the desktop application ships, and the Loader fails loud on a bundle it cannot resolve.

**Symlink the staged directory into the application.** Avoids copying on every version change. The Windows portable build unpacks to a new directory per run, so the link would dangle on the second launch.

**Give the desktop its own profile.** Removes the sharing constraint outright. Rejected because it silently drops the user's existing `web` profile patch layer, and the desktop deliberately reuses the Web profile ([loopback supervisor](2026-08-15-electron-loopback-web-supervisor.md)).

## Consequences

The account page now appears on any machine that installs a release, which is what the mechanism was for. The application no longer depends on a package manager at runtime, and the profile it boots stays byte-identical for every other consumer of that profile.

Staging duplicates the plugin into `$DSH_HOME` rather than reading it in place, so a moved or deleted application leaves its staged copy behind until a later launch refreshes it. A `dsh web` from another installation ignores that copy, since nothing composes the overlay that would mount it.

Removing the plugin's own `pnpm` install path also removed the only reason the desktop application knew how to run the CLI's `plugin` command; the remaining Host paths carry the CLI entry for booting the Host alone.

The silent-degradation surface is narrower but not gone: an application whose plugin fails to stage still starts without an account page, reporting one line to stderr. The packaging gate now catches the build-time cause of that failure, and the runtime cause left is a filesystem error in the user's own home.
