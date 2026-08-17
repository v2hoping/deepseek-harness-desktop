/**
 * Timestamped startup progress written to a file the user can send back.
 *
 * A packaged GUI application has nowhere to write stderr on Windows: no
 * console is attached, so everything the desktop reports about a failed start
 * is lost and the only evidence left is "there is a process and no window".
 * Each startup step therefore appends a line to a file under the application's
 * user data, which names the last step reached and how long it took.
 *
 * The file is the diagnostic of last resort, so writing to it never fails a
 * launch: a log that cannot be written is dropped rather than raised.
 */

import { appendFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Size past which the previous log is discarded rather than grown forever. */
const MAX_LOG_BYTES = 256 * 1024

/** Startup progress sink for one launch. */
export interface StartupLog {
  /** Absolute path of the log file, for reporting it to the user. */
  readonly path: string
  /**
   * Record one completed step.
   * @param message - what just finished, in the order it happened.
   */
  step(message: string): void
  /**
   * Record a failure with its error text.
   * @param message - what was being attempted.
   * @param error - the thrown value.
   */
  fail(message: string, error: unknown): void
}

/**
 * Open the startup log for this launch, discarding an oversized previous one.
 * @param dir - directory to hold the log, created when absent.
 * @returns A sink that never throws, so logging cannot break a launch.
 */
export function createStartupLog(dir: string): StartupLog {
  const path = join(dir, 'startup.log')
  const started = Date.now()
  // The Host keeps writing for as long as it runs, so this launch's own budget
  // is enforced per write rather than only at open. Stopping at the cap keeps
  // the earliest lines, which are the ones that explain a startup.
  let budget = MAX_LOG_BYTES
  const write = (line: string): void => {
    if (budget <= 0) return
    const entry = `${new Date().toISOString()} +${String(Date.now() - started)}ms ${line}\n`
    budget -= entry.length
    try {
      appendFileSync(path, budget <= 0 ? `${entry}--- log truncated at ${String(MAX_LOG_BYTES)} bytes\n` : entry)
    } catch {
      // The log is the diagnostic of last resort; a launch must not fail
      // because its log directory is unwritable.
    }
  }
  try {
    mkdirSync(dir, { recursive: true })
    if (existsSync(path) && statSync(path).size > MAX_LOG_BYTES) rmSync(path, { force: true })
  } catch {
    // Same reason: an unusable log directory degrades to dropped lines below.
  }
  write(`--- launch: pid ${String(process.pid)}, electron ${process.versions.electron}, ${process.platform}/${process.arch}`)
  return {
    path,
    step: (message) => { write(message) },
    fail: (message, error) => {
      write(`FAILED ${message}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    },
  }
}
