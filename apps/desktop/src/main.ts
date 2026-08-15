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

import { app, BrowserWindow, protocol } from 'electron'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { startHost, type DesktopHost } from './host.ts'
import { registerFetchBridge } from './ipc-fetch.ts'

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

/**
 * Probe the booted Host through its own RPC surface, exactly as the renderer
 * will: an unroutable method must come back as a structured refusal rather
 * than a crash, which proves the Fetch entry is wired to the API plane.
 * @param booted - the booted Host.
 * @returns the probe's HTTP status.
 */
async function probeRpcSurface(booted: DesktopHost): Promise<number> {
  const response = await booted.routes.dispatch(new Request('http://127.0.0.1/api/host.describe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: '127.0.0.1' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'selftest-0', method: 'host.describe', payload: {} }),
  }))
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

/**
 * Load the real page and write a screenshot, then exit. The acceptance
 * question for the browser roster is whether it renders at all under this
 * carrier, and only a painted window answers it.
 * @param target - file path for the PNG.
 * @returns a short report of what the page settled into.
 */
async function captureWindow(target: string): Promise<string> {
  const window = createWindow()
  // Renderer diagnostics are the only account of a bundle that failed to load;
  // without them a stuck loading page reports nothing at all.
  const problems: string[] = []
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') problems.push(event.message.slice(0, 200))
  })
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    problems.push(`did-fail-load ${String(code)} ${description} ${url}`)
  })
  await new Promise<void>((resolve) => { window.webContents.once('did-finish-load', () => { resolve() }) })
  // The shell boots in two stages — module prefetch, then the loader tree — and
  // only flips to the real UI once every fiber is active. Poll for the settled
  // marker rather than guessing a delay.
  const settled = await window.webContents.executeJavaScript(`new Promise((resolve) => {
    const deadline = Date.now() + 30000
    const tick = () => {
      const root = document.getElementById('root')
      const text = root === null ? '' : root.innerText.slice(0, 200)
      const painted = root !== null && root.childElementCount > 0
      if (painted && !text.includes('Loading') && !text.includes('加载')) return resolve({ ok: true, text })
      if (Date.now() > deadline) return resolve({ ok: false, text })
      setTimeout(tick, 250)
    }
    tick()
  })`) as { ok: boolean; text: string }

  const image = await window.webContents.capturePage()
  await writeFile(target, image.toPNG())
  window.destroy()
  const report = `${settled.ok ? 'settled' : 'TIMED OUT'} — ${JSON.stringify(settled.text.replaceAll('\n', ' ').slice(0, 160))}`
  if (problems.length === 0) return report
  return `${report}\n  renderer problems:\n${problems.slice(0, 12).map(line => `    - ${line}`).join('\n')}`
}

/** Boot the Host, then either self-test and exit or open the shell window. */
async function main(): Promise<void> {
  const selftest = process.env.DSH_DESKTOP_SELFTEST === '1'
  const started = Date.now()
  host = await startHost({ profile: PROFILE, exit: (code) => { app.exit(code) } })
  // Both carriers drive the same route table: the protocol serves the frontend
  // and its plugin bundles, the IPC bridge carries `/api`. Registered after the
  // boot so a request can never arrive before the roster claimed its routes.
  const routes = host.routes
  const disposeBridge = registerFetchBridge(request => routes.dispatch(request))
  disposeFetchBridge = disposeBridge
  protocol.handle(APP_SCHEME, request => routes.dispatch(request))
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
    const capturePath = process.env.DSH_DESKTOP_CAPTURE
    if (capturePath !== undefined && capturePath !== '') {
      console.log(`dsh-desktop: window ${await captureWindow(capturePath)}`)
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
