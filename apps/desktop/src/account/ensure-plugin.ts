/**
 * Stage the account plugin where the Harness Loader resolves it, and report the
 * overlay that composes it into one launch.
 *
 * The plugin ships inside the application, but the Loader anchors bare plugin
 * specifiers at the profile directory, so the package must sit in a module
 * directory the profile's lookup walk reaches. `$DSH_HOME/profiles/node_modules`
 * is that directory: Node finds it one level above every profile, and the CLI
 * already maintains it as the installation fallback for in-box bundles.
 *
 * Staging copies the directory rather than running `dsh plugin add`, which
 * forwards to pnpm. A packaged application cannot reach pnpm: a GUI launched
 * from Finder or Explorer inherits a minimal PATH that excludes a user's own
 * install, and the staged Host ships no package manager. A copy rather than a
 * symlink is what keeps the staged plugin independent of the application's
 * own location: creating a symlink on Windows needs developer mode or
 * elevation, and a link into an application that is later moved or uninstalled
 * would dangle.
 *
 * The profile manifest stays out of it. Composing the plugin is the returned
 * `--patch` overlay's job, so a `dsh web` from a separate installation boots
 * the same profile exactly as it did before this application was installed.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** The plugin package staged into the profile module fallback. */
const PLUGIN_PACKAGE = '@deepseek-ai/dsh-desktop-account'

/** The plugin's own bundle patch, which inserts its Loader row. */
const PATCH_FILENAME = 'cordis.patch.yml'

/** The profile the desktop Host boots, and the one an earlier build wrote into. */
const PROFILE = 'web'

/** Where the plugin and the log sink live for this launch. */
export interface EnsurePluginOptions {
  /** Directory holding the plugin's package.json, built lib, and patch file. */
  readonly pluginDir: string
  /**
   * Copy even when the staged version matches. A development launch reads the
   * checkout, whose version does not change as its source does.
   */
  readonly alwaysRestage: boolean
  /** Receives one line describing what happened. */
  readonly log?: (line: string) => void
}

/**
 * Read a package directory's declared version.
 * @param dir - directory holding a package.json.
 * @returns the version, or `undefined` when the manifest is absent or unreadable.
 */
function readPackageVersion(dir: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string }
    return manifest.version
  } catch {
    // A missing or malformed manifest means "nothing usable is staged here";
    // the caller restages over it either way.
    return undefined
  }
}

/**
 * The directory the plugin is staged into.
 * @returns the absolute staged package directory.
 */
export function stagedPluginDir(): string {
  return dshHomePath('profiles', 'node_modules', PLUGIN_PACKAGE)
}

/** Whether a copied path belongs to the plugin rather than to an install tree under it. */
function isPluginContent(path: string): boolean {
  return basename(path) !== 'node_modules' && !path.includes(`${sep}node_modules${sep}`)
}

/**
 * Remove what an earlier build's `dsh plugin add` wrote into the profile: the
 * bundle row, the dependency pinning the plugin to a path on the machine that
 * built it, and the profile-local copy.
 *
 * All three have to go. A surviving bundle row composes the plugin a second
 * time on top of the overlay, and a surviving profile-local copy wins the
 * module lookup over the staged one, pinning the launch to whatever that
 * earlier install left behind.
 * @param log - receives one line when anything was removed.
 */
export function pruneLegacyProfileInstall(log?: (line: string) => void): void {
  const profileDir = dshHomePath('profiles', PROFILE)
  const manifestPath = join(profileDir, 'package.json')
  let pruned = false
  try {
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        dependencies?: Record<string, string>
        dsh?: { profile?: { bundles?: string[] } }
      }
      const profile = manifest.dsh?.profile
      if (profile?.bundles?.includes(PLUGIN_PACKAGE) === true) {
        profile.bundles = profile.bundles.filter(entry => entry !== PLUGIN_PACKAGE)
        pruned = true
      }
      const dependencies = manifest.dependencies
      if (dependencies?.[PLUGIN_PACKAGE] !== undefined) {
        manifest.dependencies = Object.fromEntries(
          Object.entries(dependencies).filter(([name]) => name !== PLUGIN_PACKAGE),
        )
        pruned = true
      }
      if (pruned) writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\n')
    }
    const local = join(profileDir, 'node_modules', PLUGIN_PACKAGE)
    if (existsSync(local)) {
      rmSync(local, { recursive: true, force: true })
      pruned = true
    }
  } catch (error) {
    // The profile belongs to the CLI, not to this application: a manifest it
    // cannot rewrite is reported and left alone, and the overlay below still
    // composes the staged plugin.
    log?.(`desktop account plugin could not clean its earlier profile install (${String(error)})\n`)
    return
  }
  if (pruned) log?.(`desktop account plugin removed its earlier ${PROFILE}-profile install\n`)
}

/**
 * Stage the plugin unless the staged copy already matches, then report its
 * overlay path.
 *
 * A failure here leaves the Host fully functional without the account page, so
 * it is reported and not thrown: the desktop application must still start.
 * @param options - plugin location, restage policy, and the log sink.
 * @returns the `--patch` overlay path to compose, or `undefined` when the
 * plugin is unavailable and the launch must proceed without the account page.
 */
export function ensureAccountPlugin(options: EnsurePluginOptions): string | undefined {
  const source = options.pluginDir
  const version = readPackageVersion(source)
  if (version === undefined) {
    options.log?.(`desktop account plugin is missing at ${source}; the account page stays unavailable\n`)
    return undefined
  }
  pruneLegacyProfileInstall(options.log)
  const staged = stagedPluginDir()
  try {
    if (options.alwaysRestage || readPackageVersion(staged) !== version) {
      rmSync(staged, { recursive: true, force: true })
      mkdirSync(dirname(staged), { recursive: true })
      cpSync(source, staged, { recursive: true, dereference: true, filter: isPluginContent })
      options.log?.(`desktop account plugin ${version} staged into ${staged}\n`)
    }
  } catch (error) {
    options.log?.(`desktop account plugin staging failed (${String(error)}); the account page stays unavailable\n`)
    return undefined
  }
  const patch = join(staged, PATCH_FILENAME)
  if (!existsSync(patch)) {
    options.log?.(`desktop account plugin declares no ${PATCH_FILENAME}; the account page stays unavailable\n`)
    return undefined
  }
  return patch
}
