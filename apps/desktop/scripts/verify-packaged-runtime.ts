/** Reject a packaged desktop shell that omitted the staged Host entrypoints. */

import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { AfterPackContext } from 'electron-builder'

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
}

export default afterPack
