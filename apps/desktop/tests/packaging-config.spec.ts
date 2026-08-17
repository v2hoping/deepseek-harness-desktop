import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface DesktopPackage {
  readonly private: boolean
  readonly scripts: Readonly<Record<string, string>>
  readonly version: string
  readonly build: {
    readonly afterPack: string
    readonly artifactName: string
    readonly electronDist: string
    readonly extraResources: readonly {
      readonly from: string
      readonly to: string
      readonly filter?: readonly string[]
    }[]
    readonly mac: { readonly icon: string; readonly target: readonly string[] }
    readonly win: {
      readonly icon: string
      readonly target: readonly { readonly target: string; readonly arch: readonly string[] }[]
    }
    readonly nsis: {
      readonly oneClick: boolean
      readonly perMachine: boolean
      readonly createDesktopShortcut: boolean
      readonly createStartMenuShortcut: boolean
      readonly shortcutName: string
      readonly runAfterFinish: boolean
      readonly useZip: boolean
      readonly artifactName: string
    }
  }
}

interface RootPackage {
  readonly scripts: Readonly<Record<string, string>>
  readonly version: string
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
      expect.objectContaining({ from: 'runtime-host/node_modules', to: 'host/node_modules' }),
    ]))
    expect(desktopPackage.build.afterPack).toBe('./scripts/verify-packaged-runtime.ts')
  })

  it('ships the Host closure without its type declarations, sourcemaps, or prose', () => {
    const hostTree = desktopPackage.build.extraResources
      .find(entry => entry.to === 'host/node_modules')
    // Roughly half the staged files are these, and Windows pays for every one
    // of them at install time through on-access scanning.
    expect(hostTree?.filter).toEqual(['**/*', '!**/*.d.ts', '!**/*.map', '!**/*.md'])
  })

  it('renders every icon from the client fish mark and shares one source across platforms', () => {
    // Regenerate with `node --import tsx apps/desktop/scripts/gen-icons.ts`;
    // these digests are what makes an unintended icon swap fail.
    const digest = (file: string): string =>
      createHash('sha256').update(readFileSync(resolve(desktopRoot, file))).digest('hex')

    expect(digest('build/icon.png'))
      .toBe('62f1edb3e88dec3b5844ec2994a91bf5990931b51e4c3f11d33d2d2809c9224f')
    expect(digest('resources/trayTemplate.png'))
      .toBe('d6f333e2c67fbf6d0af3b4b0e783f6c48e5119e3caac71556a14cbab17a040df')
    expect(digest('resources/trayTemplate@2x.png'))
      .toBe('7c1109761fbe916ed7444d3197275998fb251c5d617096b8d83d397eb2ecc831')
    expect(desktopPackage.build.mac.icon).toBe('build/icon.png')
    expect(desktopPackage.build.win.icon).toBe('build/icon.png')
  })

  it('generates the icons from the mark the Web client already ships', () => {
    const generator = readFileSync(resolve(desktopRoot, 'scripts/gen-icons.ts'), 'utf8')

    expect(generator).toContain("'apps/web/public/favicon.svg'")
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
    // Electron Builder infers a GitHub publish target in CI; this release
    // uploads its own artifacts, so the packaging step must never publish.
    expect(desktopPackage.scripts.dist).toContain('--publish never')
    expect(desktopPackage.scripts.package).toContain('--publish never')
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

describe('release versioning', () => {
  it('versions the application on its own sequence', () => {
    // The desktop application is not part of the dsh npm release family, and
    // its `desktop-v` tags announce their own sequence. Inheriting the
    // repository version would name a disk image after an upstream prerelease.
    expect(desktopPackage.version).toBe('0.1.0')
    expect(desktopPackage.version).not.toBe(rootPackage.version)
    expect(desktopPackage.private).toBe(true)
  })
})

describe('release matrix', () => {
  const workflow = readFileSync(resolve(repositoryRoot, '.github/workflows/desktop-release.yml'), 'utf8')

  it('builds each target on its own platform', () => {
    // The staged Host closure resolves optional native packages for the
    // building platform, so a cross-built package ships the wrong binaries.
    expect(workflow).toMatch(/runner: macos-latest\n\s+target: macos-arm64/u)
    expect(workflow).toMatch(/runner: windows-latest\n\s+target: windows-x64/u)
  })

  it('ships Windows as an x64 installer', () => {
    // The architecture is declared rather than defaulted: the NSIS installer
    // stub is itself 32-bit, so the packaged architecture is not readable from
    // the produced executable.
    expect(desktopPackage.build.win.target).toEqual([{ target: 'nsis', arch: ['x64'] }])
    expect(desktopPackage.build.nsis.artifactName).toBe('DeepSeek-Harness-${version}-${arch}-Setup.${ext}')
  })

  it('installs once, into the user profile, with shortcuts and a launch', () => {
    const { nsis } = desktopPackage.build
    // A portable build unpacked its whole payload to %TEMP% on every launch;
    // installing writes it once, which is what keeps startup off that path.
    expect(nsis.oneClick).toBe(false)
    expect(nsis.runAfterFinish).toBe(true)
    expect(nsis.createDesktopShortcut).toBe(true)
    expect(nsis.createStartMenuShortcut).toBe(true)
    expect(nsis.shortcutName).toBe('DeepSeek Harness')
    // Per-user keeps the install off the elevation path entirely.
    expect(nsis.perMachine).toBe(false)
  })

  it('grants release write only to the publishing job', () => {
    expect(workflow).toContain('permissions:\n  contents: read')
    expect(workflow.split('publish:')[1]).toContain('contents: write')
  })
})

describe('cross-platform staging', () => {
  it('spawns the package manager through a shell on Windows', () => {
    // Node refuses to spawn a `.cmd` without one since CVE-2024-27980, and
    // pnpm is a `.cmd` on Windows.
    for (const file of ['scripts/stage-runtime.ts', 'scripts/upgrade-from-upstream.ts']) {
      expect(readFileSync(resolve(desktopRoot, file), 'utf8'))
        .toContain("shell: process.platform === 'win32'")
    }
  })
})
