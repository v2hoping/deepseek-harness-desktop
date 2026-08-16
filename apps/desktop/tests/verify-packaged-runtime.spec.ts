import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { afterPack } from '../scripts/verify-packaged-runtime.ts'

function context(appOutDir: string, electronPlatformName = 'darwin') {
  return {
    appOutDir,
    electronPlatformName,
    packager: { appInfo: { productFilename: 'DeepSeek Harness' } },
  } as Parameters<typeof afterPack>[0]
}

/** Stage a complete packaged tree, then remove one path to stage a failure. */
async function stageResources(appOutDir: string, omit?: string): Promise<void> {
  const resources = join(appOutDir, 'DeepSeek Harness.app', 'Contents', 'Resources')
  const files = [
    join(resources, 'host', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    join(resources, 'host', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'),
    join(resources, 'account-plugin', 'package.json'),
    join(resources, 'account-plugin', 'cordis.patch.yml'),
    join(resources, 'account-plugin', 'lib', 'client.js'),
  ]
  for (const file of files) {
    if (file === (omit === undefined ? undefined : join(resources, omit))) continue
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, '')
  }
}

describe('packaged desktop runtime verification', () => {
  it('accepts a tree carrying the Host entrypoints and the account plugin', async () => {
    const appOutDir = await mkdtemp(join(tmpdir(), 'dsh-packaged-runtime-'))
    try {
      await stageResources(appOutDir)

      await expect(afterPack(context(appOutDir))).resolves.toBeUndefined()
    } finally {
      await rm(appOutDir, { recursive: true, force: true })
    }
  })

  it('rejects a shell whose Host dependency tree was filtered out', async () => {
    const appOutDir = await mkdtemp(join(tmpdir(), 'dsh-packaged-runtime-'))
    try {
      await expect(afterPack(context(appOutDir))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(appOutDir, { recursive: true, force: true })
    }
  })

  it('rejects a shell whose account plugin was never built', async () => {
    const appOutDir = await mkdtemp(join(tmpdir(), 'dsh-packaged-runtime-'))
    try {
      // The plugin's lib/ is untracked build output: a packaging run that
      // skipped its build ships everything else and loses only the Account
      // section, which is exactly the failure this gate has to catch.
      await stageResources(appOutDir, join('account-plugin', 'lib', 'client.js'))

      await expect(afterPack(context(appOutDir))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(appOutDir, { recursive: true, force: true })
    }
  })
})
