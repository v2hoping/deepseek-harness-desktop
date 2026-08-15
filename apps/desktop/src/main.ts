/**
 * Electron main-process entry for the dsh desktop shell.
 *
 * Owns process lifetime, the single-instance lock, and the browser window;
 * the Host itself is assembled by {@link startHost}. Window closing does not
 * tear the Host down — agent work outlives the window, and only an explicit
 * quit disposes the context.
 *
 * `DSH_DESKTOP_SELFTEST=1` runs the acceptance probes in `selftest.ts` and
 * exits instead of opening the window.
 */

import { app, BrowserWindow, protocol } from 'electron'
import { fileURLToPath } from 'node:url'
import { startHost, type DesktopHost } from './host.ts'
import { registerFetchBridge } from './ipc-fetch.ts'
import { captureWindow, probeConversation, probeIpcCarrier, probeRpcSurface, probeUiConversation } from './selftest.ts'

/** The profile this shell boots. */
const PROFILE = process.env.DSH_DESKTOP_PROFILE ?? 'web'

/**
 * Scheme the renderer loads from. A custom scheme rather than `file://`: the
 * frontend is a single-page application whose asset and plugin requests are
 * root-absolute paths, and it is the Host's own route table that answers them.
 * Registering it as standard and secure gives the page an ordinary origin, so
 * the platform treats it like any https document for storage and fetch.
 */
const APP_SCHEME = 'dsh'

/** The page the shell opens; the path is what the static fallback serves. */
const APP_URL = `${APP_SCHEME}://app/index.html`

/**
 * The downlink paths that bypass the `/api` route. Mirrors `MUX_EVENTS_PATH`
 * and `HOST_EVENTS_PATH` in the connection package, which are wire constants
 * rather than configuration.
 */
const EVENT_STREAM_PATHS = new Set(['/api/events.mux', '/api/events.host'])

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
  const window = new BrowserWindow({
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
  void window.loadURL(APP_URL)
  return window
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

/** Boot the Host, then either self-test and exit or open the shell window. */
async function main(): Promise<void> {
  const selftest = process.env.DSH_DESKTOP_SELFTEST === '1'
  const started = Date.now()
  host = await startHost({ profile: PROFILE, exit: (code) => { app.exit(code) } })
  // Both carriers drive the same route table: the protocol serves the frontend
  // and its plugin bundles, the IPC bridge carries `/api`. Registered after the
  // boot so a request can never arrive before the roster claimed its routes.
  const { routes, events } = host
  const disposeBridge = registerFetchBridge(request => (
    // The two event-stream paths must reach the proxy's SSE codec directly:
    // the `/api` route answers 426 to a plain GET on them, because in a
    // browser they are WebSocket downlinks. Everything else goes through the
    // route for its fence and Typert interceptor.
    EVENT_STREAM_PATHS.has(new URL(request.url).pathname)
      ? events(request)
      : routes.dispatch(request)
  ))
  disposeFetchBridge = disposeBridge
  protocol.handle(APP_SCHEME, request => routes.dispatch(request))
  console.log(`dsh-desktop: host booted from profile "${PROFILE}" in ${String(Date.now() - started)}ms`)

  if (selftest) {
    const status = await probeRpcSurface(host)
    console.log(`dsh-desktop: /api/host.describe answered ${String(status)}`)
    const transcript = await probeIpcCarrier(PRELOAD)
    console.log(`dsh-desktop: IPC carrier transcript ${JSON.stringify(transcript)}`)
    const carrierOk = Array.isArray(transcript)
      && transcript.some(entry => entry === 'head:200')
      && transcript.some(entry => typeof entry === 'string' && entry.startsWith('chunk:'))
    console.log(`dsh-desktop: IPC carrier ${carrierOk ? 'OK' : 'FAILED'}`)
    if (process.env.DSH_DESKTOP_PROBE_UI === '1') {
      try {
        for (const line of await probeUiConversation(createWindow, '/tmp/dsh-desktop-chat.png')) console.log(`dsh-desktop: ui | ${line}`)
      } catch (error) {
        console.error('dsh-desktop: UI probe failed —', error instanceof Error ? error.message : error)
      }
    }
    if (process.env.DSH_DESKTOP_PROBE_CHAT === '1') {
      try {
        for (const line of await probeConversation(host)) console.log(`dsh-desktop: ${line}`)
      } catch (error) {
        console.error('dsh-desktop: conversation probe failed —', error instanceof Error ? error.message : error)
      }
    }
    const capturePath = process.env.DSH_DESKTOP_CAPTURE
    if (capturePath !== undefined && capturePath !== '') {
      console.log(`dsh-desktop: window ${await captureWindow(createWindow, capturePath)}`)
      console.log(`dsh-desktop: screenshot written to ${capturePath}`)
    }
    disposeBridge()
    disposeFetchBridge = undefined
    await host.ctx.fiber.dispose()
    host = undefined
    app.exit(status === 200 && carrierOk ? 0 : 1)
    return
  }

  createWindow()
}

// Must precede `app.whenReady()`: a scheme's privileges are fixed before the
// first page loads. `standard` gives the page an ordinary origin (so relative
// asset paths and storage behave), `secure` puts it on the same footing as
// https, `stream` allows the streaming bodies event responses need, and
// `supportFetchAPI` lets page code fetch from it.
protocol.registerSchemesAsPrivileged([{
  scheme: APP_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}])

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
