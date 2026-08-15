/**
 * Electron main-process entry for the dsh desktop shell.
 *
 * Owns process lifetime, the single-instance lock, and the browser window;
 * the Host itself is assembled by {@link startHost}. Window closing does not
 * tear the Host down — agent work outlives the window, and only an explicit
 * quit disposes the context.
 *
 * `DSH_DESKTOP_SELFTEST=1` boots the Host, reports whether its RPC surface
 * answers, and exits — the M0 acceptance path, which needs no display.
 */

import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
import { startHost, type DesktopHost } from './host.ts'
import { registerFetchBridge } from './ipc-fetch.ts'

/** The profile this shell boots. */
const PROFILE = process.env.DSH_DESKTOP_PROFILE ?? 'web'

/** Live Host for this process; `undefined` until the boot settles. */
let host: DesktopHost | undefined

/** Removes the IPC fetch listeners; `undefined` until the Host is up. */
let disposeFetchBridge: (() => void) | undefined

/**
 * The preload script, resolved beside this module. `.cjs` because a sandboxed
 * preload is loaded as CommonJS whatever the package `type` says.
 */
const PRELOAD = fileURLToPath(new URL('./preload.cjs', import.meta.url))

/**
 * Create the shell window. The renderer stays blank until the client bundle
 * and its boot manifest are wired (M1); the window exists here so the Host's
 * lifetime and the window's are separated from the start.
 * @returns the created window.
 */
function createWindow(): BrowserWindow {
  return new BrowserWindow({
    width: 1280,
    height: 860,
    show: true,
    webPreferences: {
      // The renderer never touches Node: every Host call rides the IPC carrier.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: PRELOAD,
    },
  })
}

/**
 * Print a boot failure with its nested causes. The Loader reports a failed
 * tree as one `AggregateError` whose `errors` name the individual entries, and
 * each may carry its own `cause`; printing only the top-level message would
 * say that entries failed without ever saying which.
 * @param error - the rejection from the boot path.
 * @param depth - current nesting level, used for indentation.
 */
function reportBootFailure(error: unknown, depth = 0): void {
  const indent = '  '.repeat(depth)
  if (error instanceof AggregateError) {
    console.error(`${indent}${error.message}`)
    for (const inner of error.errors) reportBootFailure(inner, depth + 1)
    return
  }
  if (error instanceof Error) {
    console.error(`${indent}${error.message}`)
    if (error.cause !== undefined) reportBootFailure(error.cause, depth + 1)
    return
  }
  console.error(`${indent}${String(error)}`)
}

/**
 * Probe the booted Host through its own RPC surface, exactly as the renderer
 * will: an unroutable method must come back as a structured refusal rather
 * than a crash, which proves the Fetch entry is wired to the API plane.
 * @param booted - the booted Host.
 * @returns the probe's HTTP status.
 */
async function probeRpcSurface(booted: DesktopHost): Promise<number> {
  const response = await booted.fetch(new URL('http://desktop.invalid/api/host.describe'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rpcId: 'selftest-0', payload: {} }),
  })
  return response.status
}

/**
 * Drive one request from a real renderer through the whole IPC carrier —
 * preload bridge, main-process dispatch, Host, and the streamed response back.
 * Probing the Host's Fetch entry directly would skip every part that is new.
 * @returns the transcript of sink callbacks the renderer observed.
 */
async function probeIpcCarrier(): Promise<unknown> {
  const probe = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: PRELOAD },
  })
  try {
    await probe.loadURL('about:blank')
    return await probe.webContents.executeJavaScript(`new Promise((resolve) => {
      const seen = []
      const decoder = new TextDecoder()
      window.dshDesktop.fetch(
        {
          url: 'http://desktop.invalid/api/host.describe',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: 'ipc-selftest', method: 'host.describe', payload: {} }),
        },
        {
          head: (status) => { seen.push('head:' + status) },
          chunk: (bytes) => { seen.push('chunk:' + decoder.decode(bytes).slice(0, 60)) },
          end: () => { resolve(seen) },
          error: (message) => { resolve(seen.concat('error:' + message)) },
        },
      )
    })`)
  } finally {
    probe.destroy()
  }
}

/** Boot the Host, then either self-test and exit or open the shell window. */
async function main(): Promise<void> {
  const selftest = process.env.DSH_DESKTOP_SELFTEST === '1'
  const started = Date.now()
  host = await startHost({ profile: PROFILE, exit: (code) => { app.exit(code) } })
  const disposeBridge = registerFetchBridge(host.fetch)
  disposeFetchBridge = disposeBridge
  console.log(`dsh-desktop: host booted from profile "${PROFILE}" in ${String(Date.now() - started)}ms`)

  if (selftest) {
    const status = await probeRpcSurface(host)
    console.log(`dsh-desktop: /api/host.describe answered ${String(status)}`)
    const transcript = await probeIpcCarrier()
    console.log(`dsh-desktop: IPC carrier transcript ${JSON.stringify(transcript)}`)
    const carrierOk = Array.isArray(transcript)
      && transcript.some(entry => entry === 'head:200')
      && transcript.some(entry => typeof entry === 'string' && entry.startsWith('chunk:'))
    console.log(`dsh-desktop: IPC carrier ${carrierOk ? 'OK' : 'FAILED'}`)
    disposeBridge()
    disposeFetchBridge = undefined
    await host.ctx.fiber.dispose()
    host = undefined
    app.exit(status === 200 && carrierOk ? 0 : 1)
    return
  }

  createWindow()
}

// A second launch must reach the running instance rather than boot a second
// Host over the same session store. The exit is announced: a silent one is
// indistinguishable from a crash when the first instance is a stale process
// holding the lock with no visible window.
if (!app.requestSingleInstanceLock()) {
  console.log('dsh-desktop: another instance already holds the single-instance lock; focusing it and exiting')
  app.quit()
} else {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows()
    if (existing === undefined) return
    if (existing.isMinimized()) existing.restore()
    existing.focus()
  })

  app.on('window-all-closed', () => {
    // Deliberately empty on every platform: the Host keeps running with no
    // window so in-flight agent work survives, and the tray (M2) is what
    // brings the window back. Quitting is an explicit user action.
  })

  app.on('will-quit', (event) => {
    if (host === undefined) return
    const disposing = host
    host = undefined
    disposeFetchBridge?.()
    disposeFetchBridge = undefined
    event.preventDefault()
    void disposing.ctx.fiber.dispose().finally(() => { app.quit() })
  })

  // `.catch` rather than `then`'s second argument: an onRejected handler sees
  // only the upstream rejection, never one thrown inside `main` itself, which
  // would leave a boot failure as an unhandled rejection with the process
  // still alive and no window.
  app.whenReady().then(main).catch((error: unknown) => {
    reportBootFailure(error)
    app.exit(1)
  })
}
