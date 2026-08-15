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
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  boot,
  healProfilesModuleFallback,
  loadLayeredEnv,
  loadOptionalPatches,
  loadProfile,
  PROFILE_PATCH_FILENAME,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import { installBareSpecifierResolution } from './module-resolution.ts'

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

/** A booted desktop Host and the handles the shell needs to drive it. */
export interface DesktopHost {
  /** The settled root context; disposing its fiber tears the Host down. */
  ctx: Context
  /**
   * Fetch-shaped entry to the Host's RPC surface. Requests arriving over IPC
   * are dispatched here, so the renderer runs the same wire serialization,
   * validation, and SSE framing the browser carrier runs.
   */
  fetch: typeof fetch
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
  const patches = structuredClone([...bundlePatches, ...profile.patches, ...homePatches])

  // The same three layers the CLI resolves — inherited process environment,
  // the invoking directory's `.env`, then the Harness home's. Building the
  // snapshot by hand would drop the file layers, and credential resolution
  // reports which layer supplied a value, so a key in `.env` would go missing.
  const environment = loadLayeredEnv(NAME)

  const ctx = await boot(NAME, join(profile.dir, PROFILE_ROOT_FILENAME), patches, (hostCtx) => {
    // Before any row mounts: Electron denies the Loader Node's internal module
    // loader, and without this every plugin specifier fails to import.
    installBareSpecifierResolution(hostCtx)
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
    // Rows configured from flags inject `cmdlineArgs` and stay unresolved until
    // it exists, so the tree never settles without this. The desktop shell
    // parses no flags of its own yet and passes an empty argument list.
    provideCmdline(hostCtx, { args: [], exit: options.exit })
  })

  const apiProxy = ctx.get('apiProxy')
  if (apiProxy === undefined) {
    await ctx.fiber.dispose()
    throw new Error(`${NAME}-desktop: profile "${profileName}" mounted no apiProxy; the desktop surface needs the API plane`)
  }

  return { ctx, fetch: toFetchHandler(apiProxy).fetch }
}
