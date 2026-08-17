import { describe, expect, it, vi } from 'vitest'
import { createFallbackResolve, isBareSpecifier } from '../src/host-resolver/resolve.ts'

/** A resolution failure carrying one of the two not-found codes. */
function notFound(code: 'ERR_MODULE_NOT_FOUND' | 'MODULE_NOT_FOUND'): Error {
  const error = new Error('Cannot find module')
  ;(error as Error & { code: string }).code = code
  return error
}

const toUrl = (path: string): string => `file://${path}`

describe('isBareSpecifier', () => {
  it('accepts package names and rejects everything with its own resolution', () => {
    expect(isBareSpecifier('@deepseek-ai/dsh-agent')).toBe(true)
    expect(isBareSpecifier('react/jsx-runtime')).toBe(true)
    expect(isBareSpecifier('./local.js')).toBe(false)
    expect(isBareSpecifier('../up.js')).toBe(false)
    expect(isBareSpecifier('/abs/path.js')).toBe(false)
    expect(isBareSpecifier('node:fs')).toBe(false)
    expect(isBareSpecifier('file:///x.js')).toBe(false)
    // Windows drive paths parse as URLs, which is what excludes them.
    expect(isBareSpecifier('C:\\apps\\x.js')).toBe(false)
  })
})

describe('createFallbackResolve', () => {
  it('passes a resolvable specifier through untouched', () => {
    const fromAnchor = vi.fn()
    const resolve = createFallbackResolve(fromAnchor, toUrl)
    const next = vi.fn(() => ({ url: 'file:///found.js' }))

    expect(resolve('@deepseek-ai/dsh-agent', { parentURL: 'file:///profile/x.js' }, next))
      .toEqual({ url: 'file:///found.js' })
    expect(fromAnchor).not.toHaveBeenCalled()
  })

  it('answers a failed bare specifier from the archive, for both module systems\u2019 codes', () => {
    for (const code of ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'] as const) {
      const fromAnchor = vi.fn(() => '/resources/host.asar/node_modules/@deepseek-ai/dsh-agent/lib/index.js')
      const resolve = createFallbackResolve(fromAnchor, toUrl)
      const next = vi.fn(() => { throw notFound(code) })

      expect(resolve('@deepseek-ai/dsh-agent', {}, next)).toEqual({
        shortCircuit: true,
        url: 'file:///resources/host.asar/node_modules/@deepseek-ai/dsh-agent/lib/index.js',
      })
    }
  })

  it('never consults the archive for relative, absolute, or builtin specifiers', () => {
    const fromAnchor = vi.fn()
    const resolve = createFallbackResolve(fromAnchor, toUrl)
    const next = vi.fn(() => { throw notFound('ERR_MODULE_NOT_FOUND') })

    for (const specifier of ['./missing.js', '/abs/missing.js', 'node:missing']) {
      expect(() => resolve(specifier, {}, next)).toThrow('Cannot find module')
    }
    expect(fromAnchor).not.toHaveBeenCalled()
  })

  it('rethrows non-resolution failures unchanged', () => {
    const fromAnchor = vi.fn()
    const resolve = createFallbackResolve(fromAnchor, toUrl)
    const syntax = new SyntaxError('bad package.json')
    const next = vi.fn(() => { throw syntax })

    expect(() => resolve('@deepseek-ai/dsh-agent', {}, next)).toThrow(syntax)
    expect(fromAnchor).not.toHaveBeenCalled()
  })

  it('reports the original failure when the archive misses too', () => {
    const original = notFound('ERR_MODULE_NOT_FOUND')
    const resolve = createFallbackResolve(() => { throw notFound('MODULE_NOT_FOUND') }, toUrl)
    const next = vi.fn(() => { throw original })

    // The first failure names the module and where it was first looked for,
    // which is the useful report; the archive miss adds nothing.
    expect(() => resolve('not-shipped', {}, next)).toThrow(original)
  })
})
