/**
 * Desktop Host assembly: boots one dsh profile inside the Electron main
 * process and exposes its `/api` surface as a Fetch handler for the IPC
 * carrier. This is the desktop counterpart of the CLI's profile boot — an
 * assembly module, not a package, per the application-layering rule.
 *
 * No web server is mounted: the composed profile omits the HTTP carrier, so
 * the process binds no port and the renderer reaches the Host over Electron
 * IPC instead ({@link createFetchBridge}).
 */

import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  boot,
  composeEntries,
  healProfilesModuleFallback,
  loadLayeredEnv,
  loadOptionalPatches,
  loadProfile,
  PROFILE_PATCH_FILENAME,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import type WebServer from '@deepseek-ai/dsh-host-webserver'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { installBareSpecifierResolution } from './module-resolution.ts'
import { StubWebServer } from './web-server-stub.ts'

/** Diagnostic prefix for load failures, matching the CLI's `dsh`. */
const NAME = 'dsh'

/** Root config filename inside a profile directory. */
const PROFILE_ROOT_FILENAME = 'cordis.yml'

/**
 * The empty root entry list every profile tree patches over. Rewritten on each
 * boot for the same reason the CLI does: the Loader's tree write-back can bake
 * composed rows into this file, which would duplicate every bundle insert on
 * the next start.
 */
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml.
# Edit cordis.patch.yml, not this file.
[]
`

/** This installation's package.json, the anchor bundle specifiers resolve against. */
const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/**
 * The desktop surface's own patch layer, applied over the profile's bundles.
 *
 * The composition it overrides is the Web one, because the browser roster —
 * every `ui-*` row, the module system, the API plane — is exactly what the
 * desktop renders; only the carriage differs. Rather than restate that roster
 * in a bundle of its own (which would have to be kept in step with upstream
 * row by row), the surface disables the two rows that exist solely to serve
 * browsers over TCP and lets everything else stand.
 *
 * `webserver` goes because {@link StubWebServer} takes its place: the routes
 * the roster registers are driven from Electron's custom protocol instead of
 * a listening socket, so the process binds no port. `web-runtime` keeps its
 * seat — it is what resolves the built frontend and mounts the static
 * fallback — with its URL line silenced, since there is no URL to visit.
 */
const DESKTOP_OVERRIDES: PatchOptions[] = [
  { id: 'webserver', disabled: true },
  // The client reload chain holds a long-lived event-stream response open, a
  // shape the socket-free route table cannot serve. A packaged desktop build
  // has nothing to hot-reload anyway; development against a watcher is a
  // separate mode, not this one.
  { id: 'client-hmr', disabled: true },
  {
    id: 'web-runtime',
    config: {
      // No address to announce: the window is the surface.
      printUrl: false,
      // The Web-surface prompt section tells the model about a page the user
      // can visit and a server it must not replace; neither holds here.
      surfaceContext: false,
      trustedHosts: [],
    },
  },
]

/**
 * Point the preset roster at the presets this installation ships.
 *
 * Agent presets are product content, not configuration: without the shipped
 * root the roster holds only a person's own presets, and creating a session
 * against the default `standard` preset fails with `agent-preset-not-found`.
 * The CLI applies the same overlay; the path resolves through the `dsh`
 * package so the desktop shell reads the very presets that installation ships
 * rather than keeping a second copy in step by hand.
 *
 * A patch replaces the targeted row's whole `config`, so the row's existing
 * keys are carried over — dropping them would fail the row's own schema.
 * @param rows - the composed row index.
 * @returns the overlay, or nothing when the composition has no preset row.
 */
function shippedPresetPatch(rows: ReadonlyMap<string, EntryOptions>): PatchOptions[] {
  const existing = rows.get('agent-presets')
  if (existing === undefined) return []
  const cliManifest = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')
  const root = fileURLToPath(new URL('config/agent-presets/', pathToFileURL(cliManifest)))
  return [{
    id: 'agent-presets',
    config: {
      ...(existing.config ?? {}) as Record<string, unknown>,
      roots: [{ path: root, trust: 'system' }],
    },
  }]
}

/** A booted desktop Host and the handles the shell needs to drive it. */
export interface DesktopHost {
  /** The settled root context; disposing its fiber tears the Host down. */
  ctx: Context
  /**
   * The route table the browser roster registered: the built frontend, its
   * assets, `/plugins/<id>/client.js`, and `/api`. The shell drives it from
   * both the custom protocol (assets) and the IPC bridge (`/api`); nothing
   * here is reachable from outside the application.
   *
   * `/api` goes through this table rather than straight to the API proxy
   * because the route the roster registers is more than the proxy: it applies
   * the privileged-method fence and lets a registered Typert interceptor
   * claim its Remote endpoints before the proxy sees the request. Dispatching
   * to the proxy alone answers 404 for every Typert channel.
   */
  routes: StubWebServer
}

/** What the shell hands the Host at boot. */
export interface StartHostOptions {
  /** The profile to boot; its directory lives under `$DSH_HOME/profiles`. */
  profile: string
  /**
   * Bounded exit request from a mounted plugin (`ctx.appExit`). The desktop
   * shell routes it to Electron's own quit path rather than `process.exit`,
   * so window teardown and Host disposal still run.
   */
  exit: (code: number) => void
}

/**
 * Boot the named profile in this process and return its Host handles.
 * @param options - the profile to boot and the shell's exit hook.
 * @returns the settled context and the Fetch entry to its RPC surface.
 * @throws when the profile fails to load, or when the composed tree provides no API surface.
 */
export async function startHost(options: StartHostOptions): Promise<DesktopHost> {
  const profileName = options.profile
  // The Loader resolves bare plugin specifiers from the profiles directory, so
  // this installation's dependency closure must be linked there first. Without
  // it every row fails to import and the whole tree refuses to load.
  healProfilesModuleFallback(INSTALL_ANCHOR)
  const profile = loadProfile(NAME, profileName, INSTALL_ANCHOR)
  writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)

  const bundlePatches = profile.layers.flatMap(layer => layer.patches)
  const homePatches = loadOptionalPatches(NAME, join(resolveDshHome(), PROFILE_PATCH_FILENAME)) ?? []
  // The composed row index, for overlays that must extend a row's config
  // rather than replace it.
  const rows = new Map<string, EntryOptions>()
  for (const row of composeEntries([bundlePatches, profile.patches, homePatches])) {
    if (typeof row.id === 'string') rows.set(row.id, row)
  }

  // Desktop overrides ride above the user layers: which carrier the surface
  // uses is not a preference a cordis.patch.yml may flip.
  const patches = structuredClone([
    ...bundlePatches,
    ...profile.patches,
    ...homePatches,
    ...DESKTOP_OVERRIDES,
    ...shippedPresetPatch(rows),
  ])

  // The same three layers the CLI resolves — inherited process environment,
  // the invoking directory's `.env`, then the Harness home's. Building the
  // snapshot by hand would drop the file layers, and credential resolution
  // reports which layer supplied a value, so a key in `.env` would go missing.
  const environment = loadLayeredEnv(NAME)

  const assets = new StubWebServer()

  const ctx = await boot(NAME, join(profile.dir, PROFILE_ROOT_FILENAME), patches, (hostCtx) => {
    // Before any row mounts: Electron denies the Loader Node's internal module
    // loader, and without this every plugin specifier fails to import.
    installBareSpecifierResolution(hostCtx)
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
    // Stands in for the disabled `webserver` row, before the rows that inject
    // it mount. The assertion is the narrowing TypeScript cannot express for a
    // socket-free implementation of the same seam.
    hostCtx.provide('webServer', assets as unknown as WebServer)
    // Rows configured from flags inject `cmdlineArgs` and stay unresolved until
    // it exists, so the tree never settles without this. The desktop shell
    // parses no flags of its own yet and passes an empty argument list.
    provideCmdline(hostCtx, { args: [], exit: options.exit })
  })

  if (ctx.get('apiProxy') === undefined) {
    await ctx.fiber.dispose()
    throw new Error(`${NAME}-desktop: profile "${profileName}" mounted no apiProxy; the desktop surface needs the API plane`)
  }

  return { ctx, routes: assets }
}
