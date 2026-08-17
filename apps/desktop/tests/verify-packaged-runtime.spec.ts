import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPackageWithOptions } from '@electron/asar'
import { describe, expect, it } from 'vitest'
import { afterPack } from '../scripts/verify-packaged-runtime.ts'

function context(appOutDir: string, projectDir: string, electronPlatformName = 'darwin') {
  return {
    appOutDir,
    electronPlatformName,
    packager: { appInfo: { productFilename: 'DeepSeek Harness' }, projectDir },
  } as Parameters<typeof afterPack>[0]
}

/** Stage a complete packaged tree; `omit` names one piece to leave out. */
async function stageResources(
  appOutDir: string,
  omit?: 'archived-entry' | 'account-lib' | 'unpacked-native',
): Promise<void> {
  const resources = join(appOutDir, 'DeepSeek Harness.app', 'Contents', 'Resources')
  const closure = join(appOutDir, 'closure-source')
  const archived = [
    join(closure, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    join(closure, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'),
  ]
  for (const file of archived) {
    if (omit === 'archived-entry' && file.endsWith('bin.js')) continue
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, '')
  }
  await mkdir(resources, { recursive: true })
  await createPackageWithOptions(closure, join(resources, 'host.asar'), {})

  // afterPack copies the unpacked tree from the project's staging output.
  await mkdir(join(appOutDir, 'runtime-host-natives', 'node_modules', 'nat'), { recursive: true })
  if (omit !== 'unpacked-native') {
    await writeFile(join(appOutDir, 'runtime-host-natives', 'node_modules', 'nat', 'native.node'), '')
  }

  const plain = [
    join(resources, 'host-resolver.mjs'),
    join(resources, 'account-plugin', 'package.json'),
    join(resources, 'account-plugin', 'cordis.patch.yml'),
    join(resources, 'account-plugin', 'lib', 'client.js'),
  ]
  for (const file of plain) {
    if (omit === 'account-lib' && file.endsWith('client.js')) continue
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, '')
  }
}

describe('packaged desktop runtime verification', () => {
  it('accepts a tree carrying the archived Host, its binaries, and the account plugin', async () => {
    const appOutDir = await mkdtemp(join(tmpdir(), 'dsh-packaged-runtime-'))
    try {
      await stageResources(appOutDir)

      await expect(afterPack(context(appOutDir, appOutDir))).resolves.toBeUndefined()
    } finally {
      await rm(appOutDir, { recursive: true, force: true })
    }
  })

  it('rejects a shell whose archive lost the Host entry', async () => {
    const appOutDir = await mkdtemp(join(tmpdir(), 'dsh-packaged-runtime-'))
    try {
      await stageResources(appOutDir, 'archived-entry')

      await expect(afterPack(context(appOutDir, appOutDir))).rejects.toThrow()
    } finally {
      await rm(appOutDir, { recursive: true, force: true })
    }
  })

  it('rejects a build whose unpack patterns shipped no native beside the archive', async () => {
    const appOutDir = await mkdtemp(join(tmpdir(), 'dsh-packaged-runtime-'))
    try {
      // A .node inside an asar cannot be dlopened, so rotted unpack patterns
      // ship natives nothing can load.
      await stageResources(appOutDir, 'unpacked-native')

      await expect(afterPack(context(appOutDir, appOutDir))).rejects.toThrow(/no unpacked \.node/u)
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
      await stageResources(appOutDir, 'account-lib')

      await expect(afterPack(context(appOutDir, appOutDir))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(appOutDir, { recursive: true, force: true })
    }
  })
})
