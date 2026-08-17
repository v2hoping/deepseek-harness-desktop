/** Materialize the packaged desktop Host dependency closure and archive it. */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { createPackageWithOptions } from '@electron/asar'

const desktopRoot = resolve(import.meta.dirname, '..')
const repositoryRoot = resolve(desktopRoot, '../..')
const staging = join(desktopRoot, 'runtime-host')
const archive = join(desktopRoot, 'runtime-host.asar')
// Electron Builder silently skips extraResources paths named `*.asar.unpacked`
// (it owns that pattern for app.asar), so the unpacked tree is staged under a
// neutral name and mapped back to `host.asar.unpacked` at copy time.
const unpackedStage = join(desktopRoot, 'runtime-host-natives')
const deployRoot = resolve(desktopRoot, 'runtime')
const deployPackage = '@deepseek-ai/dsh-desktop-runtime'
const entry = join(staging, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const frontend = join(staging, 'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html')
const workspaceState = join(repositoryRoot, 'node_modules/.pnpm-workspace-state-v1.json')

/** Files the Host never reads at runtime, pruned before archiving. */
const PRUNED_EXTENSIONS = new Set(['.md', '.map'])

/**
 * What must stay a real file beside the archive: anything the operating system
 * itself has to open — native modules `dlopen`ed, executables and libraries
 * spawned or loaded by name — plus the packages that ship such binaries under
 * their own directories (node-pty's console hosts, ripgrep's `rg`, the
 * Landlock launcher).
 */
const UNPACK_FILES = '{**/*.node,**/*.exe,**/*.dll,**/*.dylib,**/*.so,**/*.so.*}'
const UNPACK_DIRS = '{**/node-pty,**/node-pty/**,**/@vscode/ripgrep,**/@vscode/ripgrep/**,**/node-addon-landlock-run*,**/node-addon-landlock-run*/**}'

interface Manifest {
  readonly dependencies?: Readonly<Record<string, string>>
}

async function run(command: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: { ...process.env, CI: 'true' },
      stdio: 'inherit',
      // Windows resolves pnpm to a `.cmd`, which Node refuses to spawn
      // directly; every argument here is a repository-owned literal.
      shell: process.platform === 'win32',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) accept()
      else reject(new Error(`desktop runtime staging failed (${code === null ? `signal ${String(signal)}` : `exit ${String(code)}`}): ${command} ${args.join(' ')}`))
    })
  })
}

async function manifest(path: string): Promise<Manifest> {
  return JSON.parse(await readFile(path, 'utf8')) as Manifest
}

async function findSymlink(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/** Electron Builder copies the resource tree without following links, so no link may survive staging. */
async function materializeLinks(): Promise<void> {
  const nodeModules = join(staging, 'node_modules')
  for (let link = await findSymlink(nodeModules); link !== undefined; link = await findSymlink(nodeModules)) {
    const segments = link.slice(nodeModules.length + 1).split(sep)
    const bin = segments.lastIndexOf('.bin')
    if (bin >= 0) {
      await rm(join(nodeModules, ...segments.slice(0, bin + 1)), { recursive: true, force: true })
      continue
    }
    const source = await realpath(link)
    await rm(link, { recursive: true, force: true })
    await cp(source, link, {
      recursive: true,
      dereference: true,
      filter: path => path !== join(source, 'node_modules') && !path.startsWith(join(source, 'node_modules') + sep),
    })
  }
}

/** The hoisted deploy drops workspace roots that resolve through the source tree; copy them back by name. */
async function restoreLegacyHoists(): Promise<void> {
  const deployed = await manifest(join(staging, 'package.json'))
  const sourceModules = join(deployRoot, 'node_modules')
  for (const dependency of Object.keys(deployed.dependencies ?? {})) {
    const destination = join(staging, 'node_modules', dependency)
    if (existsSync(destination)) continue
    const source = join(sourceModules, dependency)
    if (!existsSync(source)) throw new Error(`desktop runtime dependency is missing after deploy: ${dependency}`)
    await mkdir(dirname(destination), { recursive: true })
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== join(source, 'node_modules') && !path.startsWith(join(source, 'node_modules') + sep),
    })
  }
}

/** pnpm deploy rewrites the workspace state file; restore it so the next ordinary install is not a full relink. */
async function deploy(): Promise<void> {
  const savedWorkspaceState = existsSync(workspaceState) ? await readFile(workspaceState) : undefined
  try {
    await run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', [
      '--config.verify-deps-before-run=false', '--filter', deployPackage, 'deploy', '--legacy', '--prod',
      '--config.node-linker=hoisted', '--config.auto-install-peers=false', '--config.link-workspace-packages=true', staging,
    ])
  } finally {
    if (savedWorkspaceState === undefined) await rm(workspaceState, { force: true })
    else await writeFile(workspaceState, savedWorkspaceState)
  }
}

/** Remove declaration, sourcemap, and prose files the Host never reads. */
async function prune(directory: string): Promise<void> {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name)
    if (item.isDirectory()) await prune(path)
    else if (PRUNED_EXTENSIONS.has(extname(item.name)) || item.name.endsWith('.d.ts')) {
      await rm(path, { force: true })
    }
  }
}

/**
 * Archive the staged closure into one asar plus its unpacked binaries.
 *
 * The archive is what makes startup pay for one file instead of thousands:
 * every module read resolves inside the archive through Electron's patched
 * `fs`, so per-file open costs — on Windows, an on-access virus scan per
 * first read — collapse to one.
 */
async function pack(): Promise<void> {
  await rm(archive, { force: true })
  await rm(`${archive}.unpacked`, { recursive: true, force: true })
  await rm(unpackedStage, { recursive: true, force: true })
  await createPackageWithOptions(staging, archive, {
    unpack: UNPACK_FILES,
    unpackDir: UNPACK_DIRS,
  })
  if (!existsSync(archive)) throw new Error(`desktop Host archive missing after packing: ${archive}`)
  await rename(`${archive}.unpacked`, unpackedStage)
}

async function main(): Promise<void> {
  await run(process.execPath, [
    '--import', 'tsx', 'scripts/verify-runtime-closure.ts',
    '--manifest', 'apps/desktop/runtime/package.json',
  ])
  await rm(staging, { recursive: true, force: true })
  await deploy()
  await restoreLegacyHoists()
  await materializeLinks()
  if (!existsSync(entry)) throw new Error(`desktop Host entry missing after staging: ${entry}`)
  if (!existsSync(frontend)) throw new Error(`desktop Web frontend missing after staging: ${frontend}`)
  await prune(staging)
  await pack()
  console.log(`desktop runtime staged at ${staging} and archived at ${archive}`)
}

await main()
