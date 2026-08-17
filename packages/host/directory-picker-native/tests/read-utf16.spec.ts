/**
 * The COM path decoder. Its span is the whole point: `CoTaskMemAlloc` sizes a
 * path to its own length, so viewing more memory than the string occupies
 * reads pages the process never allocated — an access violation that kills the
 * dialog worker before it can report anything.
 */

import { describe, expect, it, vi } from 'vitest'
import { readUtf16 } from '../src/win32-dialog-bindings.ts'

/** A koffi stand-in whose `view` only exposes the bytes actually allocated. */
function fakeKoffi(allocated: Buffer) {
  const view = vi.fn((_address: unknown, length: number) => {
    if (length > allocated.length) {
      throw new Error(`access violation: viewed ${String(length)} of ${String(allocated.length)} allocated bytes`)
    }
    return allocated.buffer.slice(allocated.byteOffset, allocated.byteOffset + length)
  })
  return { koffi: { view } as never, view }
}

/** The allocation a COM string of `text` occupies, terminator included. */
function comString(text: string): Buffer {
  return Buffer.from(`${text}\0`, 'utf16le')
}

describe('readUtf16', () => {
  it('decodes a path without reading past its allocation', () => {
    const allocated = comString('D:\\dsh\\workspace')
    const { koffi, view } = fakeKoffi(allocated)
    const measure = vi.fn(() => 'D:\\dsh\\workspace'.length)

    expect(readUtf16(koffi, measure, 0x1000)).toBe('D:\\dsh\\workspace')
    // Exactly the string, terminator excluded — a fixed-size window here is
    // what crashed the worker on real Windows.
    expect(view).toHaveBeenCalledWith(0x1000, 'D:\\dsh\\workspace'.length * 2)
  })

  it('decodes non-ASCII path segments', () => {
    const path = 'D:\\项目\\工作区'
    const allocated = comString(path)
    const { koffi } = fakeKoffi(allocated)

    expect(readUtf16(koffi, vi.fn(() => path.length), 0x2000)).toBe(path)
  })

  it('reads nothing when the string is empty or unmeasurable', () => {
    const { koffi, view } = fakeKoffi(comString(''))

    expect(readUtf16(koffi, vi.fn(() => 0), 0x3000)).toBe('')
    expect(readUtf16(koffi, vi.fn(() => -1), 0x3000)).toBe('')
    expect(readUtf16(koffi, vi.fn(() => Number.NaN), 0x3000)).toBe('')
    // Nothing is viewed at all, so a bogus length cannot become a bad read.
    expect(view).not.toHaveBeenCalled()
  })
})
