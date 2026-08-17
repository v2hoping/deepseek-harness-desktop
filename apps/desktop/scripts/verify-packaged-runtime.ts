/** Reject a packaged desktop shell that omitted the staged Host entrypoints. */

import { access, cp, readdir, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { statFile } from '@electron/asar'
import type { AfterPackContext } from 'electron-builder'

/**
 * Longest path Windows accepts without per-process long-path support. Only the
 * unpacked binaries and the account plugin spend it now — everything inside
 * the archive is invisible to the operating system's path handling.
 */
const WINDOWS_MAX_PATH = 260

/** Entrypoints that must exist inside the Host archive. */
const REQUIRED_ARCHIVED_FILES = [
  'node_modules/@deepseek-ai/dsh/lib/bin.js',
  'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
] as const

// The account plugin's lib/ is build output the repository does not track, so
// a packaging run over a clean checkout that skipped its build would otherwise
// ship an application whose Settings pages silently lose the Account section.
const REQUIRED_RESOURCES = [
  ['host-resolver.mjs'],
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
  const archive = join(resources, 'host.asar')
  // The unpacked tree is copied here, not through extraResources: Electron
  // Builder silently drops mappings involving `*.asar.unpacked` names, which
  // are exactly the sibling name Electron's archive redirection requires.
  const stagedNatives = join(context.packager.projectDir, 'runtime-host-natives')
  await rm(`${archive}.unpacked`, { recursive: true, force: true })
  await cp(stagedNatives, `${archive}.unpacked`, { recursive: true })
  await access(archive)
  for (const file of REQUIRED_ARCHIVED_FILES) {
    // statFile throws when the archive lacks the member.
    statFile(archive, file, false)
  }
  for (const segments of REQUIRED_RESOURCES) {
    await access(join(resources, ...segments))
  }
  await requireUnpackedNative(join(resources, 'host.asar.unpacked'))
  await reportPathBudget(context, resources)
}

/**
 * Require at least one native module beside the archive. A `.node` file inside
 * an asar cannot be `dlopen`ed, so a build whose unpack patterns rotted would
 * ship natives nothing can load.
 * @param unpacked - the `host.asar.unpacked` directory.
 */
async function requireUnpackedNative(unpacked: string): Promise<void> {
  const found = await findFirst(unpacked, name => name.endsWith('.node'))
  if (found === undefined) throw new Error(`desktop packaging: no unpacked .node beside the archive at ${unpacked}`)
}

/** Depth-first search for one file matching `matches`. */
async function findFirst(dir: string, matches: (name: string) => boolean): Promise<string | undefined> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = await findFirst(path, matches)
      if (nested !== undefined) return nested
    } else if (matches(entry.name)) return path
  }
  return undefined
}

/**
 * Report how much of the Windows path budget the packaged tree still spends.
 *
 * The deepest real file decides the longest install directory that can be
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
  const deepest = relative(context.appOutDir, longest)
  console.log(
    `desktop packaging: deepest packaged path spends ${String(deepest.length)} characters `
    + `(${deepest}), leaving ${String(WINDOWS_MAX_PATH - deepest.length)} for the install directory`,
  )
}

export default afterPack
