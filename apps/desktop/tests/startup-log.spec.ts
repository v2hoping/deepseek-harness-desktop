import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createStartupLog } from '../src/startup-log.ts'

/** A temporary log directory removed after `body`. */
async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-startup-log-'))
  try {
    await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('desktop startup log', () => {
  it('records each step in order, with the launch header first', async () => {
    await withDir(async (dir) => {
      const log = createStartupLog(dir)
      log.step('reserved origin')
      log.step('host answered its origin')

      const lines = (await readFile(log.path, 'utf8')).trimEnd().split('\n')
      expect(lines[0]).toContain('--- launch: pid')
      expect(lines[1]).toContain('reserved origin')
      expect(lines[2]).toContain('host answered its origin')
      // Each line carries wall-clock time and elapsed milliseconds, so a log
      // shows which step stalled rather than only which step was last.
      for (const line of lines) expect(line).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z \+\d+ms /u)
    })
  })

  it('records a failure with its stack', async () => {
    await withDir(async (dir) => {
      const log = createStartupLog(dir)
      log.fail('renderer load', new Error('ERR_CONNECTION_REFUSED'))

      const text = await readFile(log.path, 'utf8')
      expect(text).toContain('FAILED renderer load')
      expect(text).toContain('ERR_CONNECTION_REFUSED')
    })
  })

  it('creates a missing log directory', async () => {
    await withDir(async (dir) => {
      const nested = join(dir, 'logs', 'DeepSeek Harness')
      const log = createStartupLog(nested)
      log.step('ready')

      expect(existsSync(log.path)).toBe(true)
    })
  })

  it('discards a previous log that grew past the cap', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'startup.log')
      await writeFile(path, 'x'.repeat(300 * 1024))

      createStartupLog(dir).step('fresh launch')

      // Only the new launch remains: an unbounded log would eventually be too
      // large for a user to send back.
      expect((await stat(path)).size).toBeLessThan(1024)
    })
  })

  it('drops lines instead of throwing when the log cannot be written', async () => {
    await withDir(async (dir) => {
      // A file where the directory is expected: every write fails, and the
      // launch must still proceed.
      const blocked = join(dir, 'blocked')
      await writeFile(blocked, '')
      const log = createStartupLog(blocked)

      expect(() => { log.step('still running') }).not.toThrow()
      expect(() => { log.fail('something', new Error('boom')) }).not.toThrow()
    })
  })
})
