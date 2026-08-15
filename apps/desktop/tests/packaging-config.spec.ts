import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface DesktopPackage {
  readonly scripts: Readonly<Record<string, string>>
  readonly build: {
    readonly afterPack: string
    readonly artifactName: string
    readonly electronDist: string
    readonly extraResources: readonly {
      readonly from: string
      readonly to: string
    }[]
    readonly mac: { readonly icon: string; readonly target: readonly string[] }
    readonly win: { readonly icon: string }
  }
}

interface RootPackage {
  readonly scripts: Readonly<Record<string, string>>
}

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(desktopRoot, '../..')
const workspaceConfiguration = readFileSync(resolve(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8')
const desktopPackage = JSON.parse(
  readFileSync(resolve(desktopRoot, 'package.json'), 'utf8'),
) as DesktopPackage
const rootPackage = JSON.parse(
  readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'),
) as RootPackage

describe('desktop packaging configuration', () => {
  it('packages the installed Electron distribution', () => {
    expect(desktopPackage.build.electronDist).toBe('node_modules/electron/dist')
    expect(workspaceConfiguration).toContain("'app-builder-lib@26.15.3>@electron/get': '3.1.0'")
  })

  it('stages the Host closure as its own deploy root', () => {
    expect(workspaceConfiguration).toContain('- apps/desktop/runtime')
  })

  it('maps the staged Host node_modules directory as the copy root', () => {
    expect(desktopPackage.build.extraResources).toEqual(expect.arrayContaining([
      { from: 'runtime-host/package.json', to: 'host/package.json' },
      { from: 'runtime-host/node_modules', to: 'host/node_modules' },
    ]))
    expect(desktopPackage.build.afterPack).toBe('./scripts/verify-packaged-runtime.ts')
  })

  it('keeps the supplied image byte-for-byte and shares it across macOS and Windows', () => {
    const icon = readFileSync(resolve(desktopRoot, 'build/icon.png'))

    expect(createHash('sha256').update(icon).digest('hex'))
      .toBe('e9fa2ac692491c051536fb5d322e7eefe874d3977892e82852295d137bf27d91')
    expect(desktopPackage.build.mac.icon).toBe('build/icon.png')
    expect(desktopPackage.build.win.icon).toBe('build/icon.png')
  })

  it('builds and stages the complete workspace before local packaging', () => {
    expect(desktopPackage.scripts.package).toContain('pnpm --workspace-root run build')
    expect(desktopPackage.scripts.package).toContain('scripts/stage-runtime.ts')
    expect(desktopPackage.scripts.package).toContain('electron-builder --dir')
  })

  it('unpacks the Electron binary before every command that needs it', () => {
    // pnpm runs Electron's postinstall once, when the package is first
    // installed, and not again after its unpacked binary is removed. Each
    // entry re-runs the idempotent unpack so a stale tree self-heals.
    expect(desktopPackage.scripts['ensure-electron']).toBe('node node_modules/electron/install.js')
    for (const name of ['dev', 'package', 'dist']) {
      expect(desktopPackage.scripts[name]).toContain('pnpm run ensure-electron')
    }
  })

  it('distributes a disk image whose name survives a URL', () => {
    expect(desktopPackage.build.mac.target).toEqual(['dmg'])
    expect(desktopPackage.build.artifactName).toBe('DeepSeek-Harness-${version}-${arch}.${ext}')
    expect(desktopPackage.build.artifactName).not.toMatch(/\s/u)
    expect(desktopPackage.scripts.dist).toContain('electron-builder')
    expect(desktopPackage.scripts.dist).not.toContain('--dir')
    expect(rootPackage.scripts['dist:desktop'])
      .toBe('pnpm --filter @deepseek-ai/dsh-desktop run dist')
  })

  it('installs with ditto and clears quarantine, which an unsigned bundle needs', () => {
    const installer = readFileSync(resolve(desktopRoot, 'scripts/install.sh'), 'utf8')

    // cp would flatten the framework symbolic links the bundle depends on.
    expect(installer).toContain('ditto "$staged" "$target"')
    expect(installer).toContain('xattr -dr com.apple.quarantine')
    expect(statSync(resolve(desktopRoot, 'scripts/install.sh')).mode & 0o111).not.toBe(0)
  })

  it('reaches the desktop build, typecheck and run commands from the repository root', () => {
    expect(rootPackage.scripts.build).toContain('npm run build:desktop')
    expect(rootPackage.scripts.typecheck).toContain('npm run typecheck:desktop')
    expect(rootPackage.scripts['dev:desktop'])
      .toBe('pnpm --filter @deepseek-ai/dsh-desktop run dev')
    expect(rootPackage.scripts['package:desktop'])
      .toBe('pnpm --filter @deepseek-ai/dsh-desktop run package')
  })
})
