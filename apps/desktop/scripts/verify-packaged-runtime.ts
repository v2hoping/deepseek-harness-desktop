/** Reject a packaged desktop shell that omitted the staged Host entrypoints. */

import { access, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { AfterPackContext } from 'electron-builder'

/**
 * Longest path Windows accepts without per-process long-path support. The
 * staged Host is a deep dependency tree, so how much of that budget it spends
 * decides how long an install directory may be.
 */
const WINDOWS_MAX_PATH = 260

const REQUIRED_HOST_FILES = [
  ['@deepseek-ai', 'dsh', 'lib', 'bin.js'],
  ['@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'],
] as const

// The account plugin's lib/ is build output the repository does not track, so
// a packaging run over a clean checkout that skipped its build would otherwise
// ship an application whose Settings pages silently lose the Account section.
const REQUIRED_RESOURCES = [
  ['account-plugin', 'package.json'],
  ['account-plugin', 'cordis.patch.yml'],
  ['account-plugin', 'lib', 'client.js'],
] as const

/**
 * Verify the files required before the packaged application can start with all
 * of its shipped surfaces.
 * @param context - Electron Builder's completed application directory.
 * @returns A promise that rejects when a staged entrypoint or plugin file is absent.
 */
export async function afterPack(context: AfterPackContext): Promise<void> {
  const resources = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  for (const segments of REQUIRED_HOST_FILES) {
    await access(join(resources, 'host', 'node_modules', ...segments))
  }
  for (const segments of REQUIRED_RESOURCES) {
    await access(join(resources, ...segments))
  }
  await reportPathBudget(context, resources)
}

/**
 * Report how much of the Windows path budget the packaged tree already spends.
 *
 * The deepest file decides the longest install directory that can still be
 * written: an installer whose extractor does not opt into long paths silently
 * drops whatever crosses the limit, which surfaces much later as a missing
 * module. Printing the number makes that budget visible at build time instead.
 * @param context - Electron Builder's completed application directory.
 * @param resources - the packaged resources directory to measure.
 */
async function reportPathBudget(context: AfterPackContext, resources: string): Promise<void> {
  if (context.electronPlatformName !== 'win32') return
  let longest = ''
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (path.length > longest.length) longest = path
    }
  }
  await walk(resources)
  // `resources` sits directly under the install directory, so what remains for
  // that directory is the limit minus everything below it.
  const deepest = relative(context.appOutDir, longest)
  console.log(
    `desktop packaging: deepest packaged path spends ${String(deepest.length)} characters `
    + `(${deepest}), leaving ${String(WINDOWS_MAX_PATH - deepest.length)} for the install directory`,
  )
}

export default afterPack
