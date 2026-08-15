import { describe, expect, it } from 'vitest'
import { classifyConflicts, parseUpgradeArgs } from '../scripts/upgrade-from-upstream.ts'

describe('upstream merge conflict classification', () => {
  it('regenerates the lockfile and notices while every other path stops the run', () => {
    const classified = classifyConflicts([
      'pnpm-lock.yaml',
      'packages/core/session/src/index.ts',
      'THIRD_PARTY_NOTICES.md',
      'package.json',
    ])

    expect(classified.regenerable).toEqual(['pnpm-lock.yaml', 'THIRD_PARTY_NOTICES.md'])
    expect(classified.manual).toEqual(['packages/core/session/src/index.ts', 'package.json'])
  })

  it('treats the fork-owned integration points as human decisions', () => {
    const classified = classifyConflicts([
      'knip.json',
      'pnpm-workspace.yaml',
      'scripts/release/families.ts',
      'scripts/check-workspace-constraints.ts',
    ])

    expect(classified.regenerable).toEqual([])
    expect(classified.manual).toHaveLength(4)
  })

  it('reports no conflicts for a clean merge', () => {
    expect(classifyConflicts([])).toEqual({ regenerable: [], manual: [] })
  })
})

describe('upstream upgrade options', () => {
  it('defaults to merging the upstream master and packaging the result', () => {
    expect(parseUpgradeArgs([])).toEqual({
      ref: 'master',
      dryRun: false,
      skipMerge: false,
      skipPackage: false,
    })
  })

  it('accepts an explicit ref and each skip switch', () => {
    expect(parseUpgradeArgs(['--ref', 'main', '--dry-run', '--skip-merge', '--skip-package'])).toEqual({
      ref: 'main',
      dryRun: true,
      skipMerge: true,
      skipPackage: true,
    })
  })

  it('rejects an unknown switch instead of ignoring it', () => {
    expect(() => parseUpgradeArgs(['--rebase'])).toThrow(/rebase/u)
  })
})
