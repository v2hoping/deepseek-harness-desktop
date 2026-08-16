/**
 * Merge the upstream Harness repository into this desktop fork and rebuild the
 * application package. Conflicts in generated files are resolved by
 * regenerating them; every other conflict stops the run for a human decision.
 */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

const desktopRoot = resolve(import.meta.dirname, '..')
const repositoryRoot = resolve(desktopRoot, '../..')

/** Remote name this script owns for the upstream repository. */
const UPSTREAM_REMOTE = 'upstream'

/** Upstream repository this fork tracks. */
const UPSTREAM_URL = 'https://github.com/deepseek-ai/deepseek-harness.git'

/** Upstream branch merged when no `--ref` is supplied. */
const DEFAULT_REF = 'master'

/**
 * Conflicts in these paths are resolved by regenerating the file. Both are
 * machine-written: the lockfile from the manifests, the notices from the
 * installed dependency set.
 */
const REGENERABLE_CONFLICTS: ReadonlySet<string> = new Set([
  'pnpm-lock.yaml',
  'THIRD_PARTY_NOTICES.md',
])

/** Merge conflicts split by who resolves them. */
export interface ConflictClassification {
  /** Paths this script regenerates and stages. */
  readonly regenerable: readonly string[]
  /** Paths that carry a decision and stop the run. */
  readonly manual: readonly string[]
}

/**
 * Split conflicted paths into regenerable and human-owned sets.
 * @param paths - Conflicted repository-relative paths reported by git.
 * @returns The two disjoint path sets, each in the input's order.
 */
export function classifyConflicts(paths: readonly string[]): ConflictClassification {
  const regenerable: string[] = []
  const manual: string[] = []
  for (const path of paths) {
    if (REGENERABLE_CONFLICTS.has(path)) regenerable.push(path)
    else manual.push(path)
  }
  return { regenerable, manual }
}

/** One failed step, carrying the guidance printed before exit. */
class UpgradeError extends Error {
  /**
   * @param message - What failed.
   * @param guidance - Ordered lines telling the reader what to do next.
   */
  constructor(message: string, readonly guidance: readonly string[]) {
    super(message)
    this.name = 'UpgradeError'
  }
}

/** Run one command with inherited output, failing the upgrade on a nonzero exit. */
function run(command: string, args: readonly string[], guidance: readonly string[] = []): void {
  // `shell` on Windows for the same reason as the runtime stager: pnpm is a
  // `.cmd` there, and Node will not spawn one without a shell.
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.error !== undefined) throw new UpgradeError(`${command} could not start: ${result.error.message}`, guidance)
  if (result.status !== 0) {
    throw new UpgradeError(`${command} ${args.join(' ')} exited with ${String(result.status ?? result.signal)}`, guidance)
  }
}

/** Run one command and return its trimmed stdout. */
function capture(command: string, args: readonly string[]): string {
  const result = spawnSync(command, args, { cwd: repositoryRoot, encoding: 'utf8' })
  if (result.error !== undefined) throw new UpgradeError(`${command} could not start: ${result.error.message}`, [])
  if (result.status !== 0) {
    throw new UpgradeError(`${command} ${args.join(' ')} exited with ${String(result.status ?? result.signal)}`, [
      result.stderr.trim(),
    ])
  }
  return result.stdout.trim()
}

/** Run one command and report only whether it succeeded. */
function succeeds(command: string, args: readonly string[]): boolean {
  return spawnSync(command, args, { cwd: repositoryRoot, stdio: 'ignore' }).status === 0
}

function packageManager(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

function requireCleanTree(): void {
  const status = capture('git', ['status', '--porcelain'])
  if (status !== '') {
    throw new UpgradeError('the working tree has uncommitted changes', [
      'Commit or stash them first: an upstream merge must start from a clean tree.',
      status,
    ])
  }
}

/** Point the upstream remote at the tracked repository, adding it when absent. */
function ensureUpstreamRemote(): void {
  if (succeeds('git', ['remote', 'get-url', UPSTREAM_REMOTE])) return
  run('git', ['remote', 'add', UPSTREAM_REMOTE, UPSTREAM_URL])
  console.log(`upgrade: added remote ${UPSTREAM_REMOTE} -> ${UPSTREAM_URL}`)
}

/** Finish a merge whose only conflicts were regenerated files. */
function resolveRegenerableConflicts(paths: readonly string[]): void {
  console.log(`upgrade: regenerating ${paths.join(', ')}`)
  run(packageManager(), ['install'], [
    'The lockfile conflict is unresolved. Inspect pnpm-lock.yaml, then finish with:',
    '  pnpm install && git add pnpm-lock.yaml && git commit --no-edit',
  ])
  run(packageManager(), ['run', 'gen-third-party-notices'])
  run('git', ['add', ...paths])
  run('git', ['commit', '--no-edit'])
}

/** Merge the upstream ref, returning false when the run stops for manual conflicts. */
function mergeUpstream(ref: string): void {
  const target = `${UPSTREAM_REMOTE}/${ref}`
  const merged = spawnSync('git', ['merge', '--no-edit', target], { cwd: repositoryRoot, stdio: 'inherit' })
  if (merged.status === 0) return

  const conflicted = capture('git', ['diff', '--name-only', '--diff-filter=U'])
  const { regenerable, manual } = classifyConflicts(conflicted === '' ? [] : conflicted.split('\n'))
  if (manual.length > 0) {
    throw new UpgradeError(`merging ${target} left ${String(manual.length)} conflict(s) that need a decision`, [
      ...manual.map(path => `  ${path}`),
      '',
      'Resolve them, then finish the merge and rerun this script with --skip-merge:',
      '  git add <resolved files> && git commit --no-edit',
      '  pnpm run upgrade:desktop --skip-merge',
      '',
      'To abandon the merge instead:',
      '  git merge --abort',
    ])
  }
  if (regenerable.length === 0) {
    throw new UpgradeError(`merging ${target} failed without reporting conflicts`, [
      'Inspect the merge state with `git status`, then `git merge --abort` to start over.',
    ])
  }
  resolveRegenerableConflicts(regenerable)
}

/** Refresh generated files a clean merge may have invalidated, committing any change. */
function refreshGeneratedFiles(): void {
  run(packageManager(), ['install'])
  run(packageManager(), ['run', 'gen-third-party-notices'])
  if (capture('git', ['status', '--porcelain']) === '') return
  run('git', ['commit', '--all', '--message', 'chore(deps): refresh generated files after the upstream merge'])
  console.log('upgrade: committed refreshed generated files')
}

/** Verify the desktop deploy manifest still covers the upstream dependency graph. */
function verifyDesktopClosure(): void {
  run(process.execPath, [
    '--import', 'tsx', 'scripts/verify-runtime-closure.ts',
    '--manifest', 'apps/desktop/runtime/package.json',
  ], [
    'Upstream changed the Web profile dependency graph.',
    'Add each package printed above to apps/desktop/runtime/package.json as "workspace:^", then rerun.',
  ])
}

interface UpgradeOptions {
  readonly ref: string
  readonly dryRun: boolean
  readonly skipMerge: boolean
  readonly skipPackage: boolean
}

/**
 * Read the upgrade options from a process argument list.
 * @param argv - Arguments after the script path.
 * @returns The resolved options, with defaults applied.
 */
export function parseUpgradeArgs(argv: readonly string[]): UpgradeOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      ref: { type: 'string' },
      'dry-run': { type: 'boolean' },
      'skip-merge': { type: 'boolean' },
      'skip-package': { type: 'boolean' },
    },
  })
  return {
    ref: values.ref ?? DEFAULT_REF,
    dryRun: values['dry-run'] === true,
    skipMerge: values['skip-merge'] === true,
    skipPackage: values['skip-package'] === true,
  }
}

async function main(): Promise<void> {
  const options = parseUpgradeArgs(process.argv.slice(2))
  const target = `${UPSTREAM_REMOTE}/${options.ref}`

  if (!options.skipMerge) {
    requireCleanTree()
    ensureUpstreamRemote()
    run('git', ['fetch', UPSTREAM_REMOTE, options.ref])

    const incoming = capture('git', ['log', '--oneline', `HEAD..${target}`])
    if (incoming === '') {
      console.log(`upgrade: already current with ${target}; run pnpm run package:desktop to rebuild.`)
      return
    }
    const count = incoming.split('\n').length
    console.log(`upgrade: ${String(count)} upstream commit(s) to merge from ${target}:`)
    console.log(incoming)

    if (options.dryRun) {
      console.log('upgrade: dry run, nothing merged.')
      return
    }

    const before = capture('git', ['rev-parse', 'HEAD'])
    console.log(`upgrade: pre-merge HEAD is ${before} (git reset --hard ${before} restores it)`)
    mergeUpstream(options.ref)
  }

  refreshGeneratedFiles()
  verifyDesktopClosure()

  if (options.skipPackage) {
    console.log('upgrade: merge complete; packaging skipped.')
    return
  }
  run(packageManager(), ['run', 'package:desktop'])
  console.log(`upgrade: complete. The application is under ${resolve(desktopRoot, 'dist')}.`)
  console.log('upgrade: review the merge commits, then push when the packaged application starts.')
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  try {
    await main()
  } catch (error) {
    if (!(error instanceof UpgradeError)) throw error
    console.error(`upgrade failed: ${error.message}`)
    for (const line of error.guidance) console.error(line)
    process.exitCode = 1
  }
}
