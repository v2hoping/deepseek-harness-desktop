/**
 * Install the account plugin into the Harness profile the desktop Host boots.
 *
 * `dsh plugin --profile <name> add` is the supported entry for an out-of-tree
 * plugin: pnpm installs it into the profile directory, where the Loader's
 * bare-specifier resolution reaches it, and the CLI appends packages declaring
 * `dsh.bundle.patch` to the profile's layer stack. Doing it here rather than
 * shipping the plugin in the upstream package tier is what keeps this fork's
 * merge surface at zero for the feature.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** The profile `dsh web` boots, and therefore the one the desktop Host uses. */
const PROFILE = 'web'

/** The plugin package installed into that profile. */
const PLUGIN_PACKAGE = '@deepseek-ai/dsh-desktop-account'

/** Where the plugin and the CLI live for this launch. */
export interface EnsurePluginOptions {
  /** Node-compatible executable that runs the CLI. */
  readonly nodeExecutable: string
  /** Built dsh CLI entry. */
  readonly cliEntry: string
  /** Directory holding the plugin's package.json and built lib. */
  readonly pluginDir: string
  /** Run the Electron executable as its bundled Node runtime. */
  readonly electronRunAsNode: boolean
  /** Receives one line describing what happened. */
  readonly log?: (line: string) => void
}

/**
 * Whether the profile manifest already depends on the plugin. Reading the
 * manifest keeps an ordinary launch free of a pnpm process.
 * @param profileDir - the profile directory to inspect.
 * @returns `true` when the dependency is already recorded.
 */
export function isPluginInstalled(profileDir: string): boolean {
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) return false
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string> }
    return manifest.dependencies?.[PLUGIN_PACKAGE] !== undefined
  } catch {
    // An unreadable or malformed profile manifest means "not installed"; the
    // install below rewrites it through the CLI either way.
    return false
  }
}

/**
 * Install the account plugin unless the profile already carries it.
 *
 * A failure here leaves the Host fully functional without the account page, so
 * it is reported and not thrown: the desktop application must still start.
 * @param options - CLI location, plugin location, and the log sink.
 */
export function ensureAccountPlugin(options: EnsurePluginOptions): void {
  const profileDir = dshHomePath('profiles', PROFILE)
  if (isPluginInstalled(profileDir)) return
  if (!existsSync(join(options.pluginDir, 'package.json'))) {
    options.log?.(`desktop account plugin is missing at ${options.pluginDir}; the account page stays unavailable\n`)
    return
  }

  const result = spawnSync(
    options.nodeExecutable,
    [options.cliEntry, 'plugin', '--profile', PROFILE, 'add', `file:${options.pluginDir}`],
    {
      env: options.electronRunAsNode ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env,
      encoding: 'utf8',
      windowsHide: true,
    },
  )
  if (result.status === 0) {
    options.log?.(`desktop account plugin installed into the ${PROFILE} profile\n`)
    return
  }
  options.log?.(
    `desktop account plugin install failed (${String(result.status ?? result.signal)}); `
    + `the account page stays unavailable\n${result.stderr}\n`,
  )
}
