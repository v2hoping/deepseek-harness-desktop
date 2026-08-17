/** Supervise the loopback Web Host used by the first desktop application. */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { LOOPBACK_HOST } from './loopback.ts'

const DEFAULT_READINESS_TIMEOUT_MS = 90_000
// Each attempt is one loopback connection that fails fast while the Host is
// still booting, so a tight cadence costs almost nothing and decides how long
// a ready Host sits undetected.
const DEFAULT_READINESS_INTERVAL_MS = 100
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000
const MAX_STARTUP_OUTPUT_CHARS = 32_768

/** Child process operations the supervisor owns. */
export interface HostChild {
  /** Standard output carrying startup diagnostics. */
  readonly stdout: { onData(listener: (chunk: string) => void): () => void }
  /** Standard error carrying startup diagnostics. */
  readonly stderr: { onData(listener: (chunk: string) => void): () => void }
  /**
   * Observe process exit.
   * @param listener - Receives the exit code or terminating signal.
   * @returns The listener disposer.
   */
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void
  /**
   * Observe a spawn failure.
   * @param listener - Receives the spawn error.
   * @returns The listener disposer.
   */
  onError(listener: (error: Error) => void): () => void
  /**
   * Terminate the process.
   * @param signal - Graceful stop, or the escalation after the grace period.
   */
  kill(signal: 'SIGTERM' | 'SIGKILL'): void
}

/** Configuration and platform operations for one Host supervisor. */
export interface HostSupervisorOptions {
  /** Spawn one Host process. */
  readonly spawnHost: () => HostChild
  /**
   * The loopback origin the Host is told to bind, which the renderer loads
   * once {@link HostSupervisorOptions.probeReady} answers.
   */
  readonly origin: string
  /**
   * Ask whether the Host is serving yet.
   *
   * Readiness is a question asked of the Host, not a line read from its
   * stdout: Electron does not deliver a child's piped stdout on Windows, so a
   * printed readiness line never arrives there.
   * @returns `true` once the Host answers on its origin.
   */
  readonly probeReady: () => Promise<boolean>
  /** Delay between readiness attempts. */
  readonly readinessIntervalMs?: number
  /** Maximum startup time before the Host is terminated. */
  readonly readinessTimeoutMs?: number
  /** Grace after SIGTERM before SIGKILL. */
  readonly shutdownTimeoutMs?: number
  /** Receives bounded Host output for desktop diagnostics. */
  readonly log?: (line: string) => void
  /** Called when a ready Host exits outside an application-owned shutdown. */
  readonly onUnexpectedExit?: (detail: { code: number | null; signal: NodeJS.Signals | null }) => void
}

/** Handle for the desktop-owned Host process. */
export interface HostSupervisor {
  /**
   * Start once, or join the in-flight start.
   * @returns The loopback origin the renderer loads.
   */
  start(): Promise<string>
  /**
   * Gracefully stop once, escalating after the configured timeout.
   * @returns Settlement once the Host process has exited.
   */
  shutdown(): Promise<void>
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

/**
 * Create a single-owner Host supervisor.
 * @param options - Child-process operations and bounded lifecycle timings.
 * @returns A supervisor that coalesces concurrent start and shutdown calls.
 */
export function createHostSupervisor(options: HostSupervisorOptions): HostSupervisor {
  const readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
  const readinessIntervalMs = options.readinessIntervalMs ?? DEFAULT_READINESS_INTERVAL_MS
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  let child: HostChild | undefined
  let startPromise: Promise<string> | undefined
  let shutdownPromise: Promise<void> | undefined
  let exited: Promise<void> | undefined
  let exitResult: Deferred<void> | undefined
  let ready = false
  let shuttingDown = false
  let output = ''

  const forward = (chunk: string): void => { options.log?.(chunk) }
  const buffer = (chunk: string): void => {
    output = `${output}${chunk}`.slice(-MAX_STARTUP_OUTPUT_CHARS)
  }

  const start = (): Promise<string> => {
    if (startPromise !== undefined) return startPromise
    if (shutdownPromise !== undefined) return Promise.reject(new Error('desktop Host cannot start after shutdown'))

    startPromise = new Promise<string>((resolve, reject) => {
      const spawned = options.spawnHost()
      child = spawned
      exitResult = deferred<void>()
      exited = exitResult.promise
      let settled = false
      const startupCleanups: Array<() => void> = []

      const cleanupStartup = (): void => {
        clearTimeout(timer)
        for (const dispose of startupCleanups.splice(0)) dispose()
      }
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        cleanupStartup()
        const diagnostic = output === '' ? '' : `\nHost output:\n${output}`
        reject(new Error(`${error instanceof Error ? error.message : String(error)}${diagnostic}`))
      }
      const succeed = (): void => {
        if (settled) return
        settled = true
        ready = true
        cleanupStartup()
        resolve(options.origin)
      }

      const timer = setTimeout(() => {
        fail(new Error(`desktop Host readiness timed out after ${String(readinessTimeoutMs)}ms`))
        spawned.kill('SIGTERM')
      }, readinessTimeoutMs)
      // Forwarding outlives startup. Everything the Host and its own children
      // write — a native dialog worker that failed to load, a plugin that threw
      // an hour in — reaches stderr, which a packaged Windows application has
      // no console for; dropping the listener at readiness would leave those
      // failures with nowhere to be seen.
      spawned.stdout.onData(forward)
      spawned.stderr.onData(forward)
      // Buffering is startup-only: it exists to attach recent output to a
      // start that failed, not to accumulate a running Host's whole history.
      startupCleanups.push(spawned.stdout.onData(buffer))
      startupCleanups.push(spawned.stderr.onData(buffer))

      // Polling starts immediately: a Host that is already serving when the
      // first attempt lands needs no further wait.
      void (async () => {
        while (!settled) {
          let answered: boolean
          try {
            answered = await options.probeReady()
          } catch (error) {
            fail(error)
            spawned.kill('SIGTERM')
            return
          }
          if (answered) {
            succeed()
            return
          }
          // A start settled by timeout or exit during the attempt above is
          // caught by the loop condition after this wait.
          await new Promise<void>((wake) => { setTimeout(wake, readinessIntervalMs) })
        }
      })()
      spawned.onError((error) => {
        fail(new Error(`desktop Host failed to spawn: ${error.message}`))
        exitResult?.resolve()
      })
      spawned.onExit((code, signal) => {
        exitResult?.resolve()
        if (ready) {
          if (!shuttingDown) options.onUnexpectedExit?.({ code, signal })
          return
        }
        fail(new Error(`desktop Host exited before readiness (code ${String(code)}, signal ${String(signal)})`))
      })
    })
    return startPromise
  }

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise
    shutdownPromise = (async () => {
      const spawned = child
      if (spawned === undefined) return
      shuttingDown = true
      spawned.kill('SIGTERM')
      const closed = exited ?? Promise.resolve()
      let timer: ReturnType<typeof setTimeout> | undefined
      const outcome = await Promise.race([
        closed.then(() => 'closed' as const),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => {
            resolve('timeout')
          }, shutdownTimeoutMs)
        }),
      ])
      if (timer !== undefined) clearTimeout(timer)
      if (outcome === 'timeout') {
        spawned.kill('SIGKILL')
        await closed
      }
    })()
    return shutdownPromise
  }

  return { start, shutdown }
}

/** Options for the real `dsh web` child. */
export interface SpawnDshWebOptions {
  /** Node-compatible executable selected by the desktop app. */
  readonly nodeExecutable: string
  /** Built dsh CLI entry. */
  readonly cliEntry: string
  /** Working directory inherited by user-created sessions and tools. */
  readonly cwd: string
  /** Frozen environment for the Host process. */
  readonly env: NodeJS.ProcessEnv
  /** Run the Electron executable as its bundled Node runtime. */
  readonly electronRunAsNode?: boolean
  /**
   * Loader patch overlays composed after the profile's own layer, in order.
   * Composing the desktop-only plugins per launch is what leaves the profile
   * itself identical for a `dsh web` from any other installation.
   */
  readonly patches: readonly string[]
  /**
   * The reserved loopback port the Host binds. The desktop picks it rather
   * than letting the Host take an OS-assigned one, because it has to know the
   * origin before the Host is up in order to probe it.
   */
  readonly port: number
  /**
   * `--import` specifier (a `file:` URL) loaded before the CLI entry. The
   * packaged launch passes its archive resolver here; a development launch
   * passes nothing and resolves from the checkout as before.
   */
  readonly importScript?: string
}

function streamAdapter(stream: NodeJS.ReadableStream): HostChild['stdout'] {
  return {
    onData(listener) {
      const accept = (chunk: string | Buffer): void => { listener(chunk.toString()) }
      stream.on('data', accept)
      return () => { stream.off('data', accept) }
    },
  }
}

/**
 * Spawn the production Web Host on an OS-assigned loopback port.
 * @param options - Node runtime, built CLI and process environment.
 * @returns The child handle consumed by {@link createHostSupervisor}.
 */
export function spawnDshWeb(options: SpawnDshWebOptions): HostChild {
  const env = options.electronRunAsNode
    ? { ...options.env, ELECTRON_RUN_AS_NODE: '1' }
    : options.env
  // `dsh web` passes options through once it meets one it does not own, so its
  // own --patch has to precede the web app's flags.
  const overlays = options.patches.flatMap(patch => ['--patch', patch])
  const args = [
    '--expose-internals',
    ...(options.importScript === undefined ? [] : ['--import', options.importScript]),
    options.cliEntry, 'web', ...overlays,
    '--host', LOOPBACK_HOST, '--port', String(options.port),
  ]
  const child = spawn(options.nodeExecutable, args, {
    cwd: options.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  return nodeChildAdapter(child)
}

/** Adapt Node's event overloads to the supervisor's explicit ownership API. */
function nodeChildAdapter(child: ChildProcessByStdio<null, Readable, Readable>): HostChild {
  return {
    stdout: streamAdapter(child.stdout),
    stderr: streamAdapter(child.stderr),
    onExit(listener) {
      child.on('exit', listener)
      return () => { child.off('exit', listener) }
    },
    onError(listener) {
      child.on('error', listener)
      return () => { child.off('error', listener) }
    },
    kill(signal) {
      child.kill(signal)
    },
  }
}
