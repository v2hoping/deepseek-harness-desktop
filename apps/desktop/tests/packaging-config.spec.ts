import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface DesktopPackage {
  readonly scripts: Readonly<Record<string, string>>
  readonly build: {
    readonly afterPack: string
    readonly electronDist: string
    readonly extraResources: readonly {
      readonly from: string
      readonly to: string
    }[]
    readonly mac: { readonly icon: string }
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

  it('reaches the desktop build, typecheck and run commands from the repository root', () => {
    expect(rootPackage.scripts.build).toContain('npm run build:desktop')
    expect(rootPackage.scripts.typecheck).toContain('npm run typecheck:desktop')
    expect(rootPackage.scripts['dev:desktop'])
      .toBe('pnpm --filter @deepseek-ai/dsh-desktop run dev')
    expect(rootPackage.scripts['package:desktop'])
      .toBe('pnpm --filter @deepseek-ai/dsh-desktop run package')
  })
})
