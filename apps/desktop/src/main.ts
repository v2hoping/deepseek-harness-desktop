/** Electron application shell for the loopback DeepSeek Harness Web Host. */

import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  session,
  shell,
  Tray,
  type Event,
  type MenuItemConstructorOptions,
} from 'electron'
import { ensureAccountPlugin } from './account/ensure-plugin.ts'
import { registerAccountIpc } from './account/ipc.ts'
import { registerDirectoryIpc } from './directory-picker/ipc.ts'
import { createHostSupervisor, spawnDshWeb, type HostSupervisor } from './host-supervisor.ts'
import { LOOPBACK_HOST, probeLoopbackOrigin, reserveLoopbackPort } from './loopback.ts'
import { splashUrl } from './splash.ts'
import { createStartupLog, type StartupLog } from './startup-log.ts'
import { createDesktopLifecycle, type DesktopLifecycle } from './window-lifecycle.ts'

const APP_NAME = 'DeepSeek Harness'

/** Per-attempt timeout for one Host readiness probe. */
const HOST_PROBE_TIMEOUT_MS = 2_000
const WINDOW_WIDTH = 1440
const WINDOW_HEIGHT = 920

/** Longest a created window stays hidden waiting for its first paint. */
const WINDOW_REVEAL_TIMEOUT_MS = 15_000
const DESKTOP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPOSITORY_ROOT = resolve(DESKTOP_DIR, '../..')

let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let host: HostSupervisor | undefined
let lifecycle: DesktopLifecycle | undefined
let hostOrigin: string | undefined
let bootQuitPromise: Promise<void> | undefined
let quitReleased = false
let startupLog: StartupLog | undefined

/** Resolve artifacts from the checkout in development and resourcesPath when packaged. */
function hostPaths(): {
  nodeExecutable: string
  cliEntry: string
  cwd: string
  electronRunAsNode: boolean
  accountPluginDir: string
  importScript?: string
} {
  if (!app.isPackaged) {
    return {
      nodeExecutable: process.env.DSH_DESKTOP_NODE_EXECUTABLE ?? 'node',
      cliEntry: join(REPOSITORY_ROOT, 'apps/cli/lib/bin.js'),
      cwd: process.cwd(),
      electronRunAsNode: false,
      accountPluginDir: join(DESKTOP_DIR, 'plugins/account'),
    }
  }
  // The packaged installation is one asar archive; the Host reads it through
  // Electron's patched fs and resolves bare plugin names through the resolver
  // shipped beside it (as a URL: a Windows drive path is not a valid --import
  // specifier).
  return {
    nodeExecutable: process.execPath,
    cliEntry: join(process.resourcesPath, 'host.asar/node_modules/@deepseek-ai/dsh/lib/bin.js'),
    cwd: app.getPath('home'),
    electronRunAsNode: true,
    accountPluginDir: join(process.resourcesPath, 'account-plugin'),
    importScript: pathToFileURL(join(process.resourcesPath, 'host-resolver.mjs')).href,
  }
}

function assertHostArtifacts(paths: ReturnType<typeof hostPaths>): void {
  // A bare command name resolves through PATH at spawn time; only a path can be checked here.
  if (isAbsolute(paths.nodeExecutable) && !existsSync(paths.nodeExecutable)) {
    throw new Error(`desktop Node runtime is missing: ${paths.nodeExecutable}`)
  }
  if (!existsSync(paths.cliEntry)) {
    throw new Error(`desktop Host entry is missing: ${paths.cliEntry}; run pnpm run build first`)
  }
}

/** Load the app-local tray template, with an empty fallback for incomplete staging. */
function trayImage(): Electron.NativeImage {
  const path = app.isPackaged
    ? join(process.resourcesPath, 'desktop-resources/trayTemplate.png')
    : join(DESKTOP_DIR, 'resources/trayTemplate.png')
  const image = existsSync(path) ? nativeImage.createFromPath(path) : nativeImage.createEmpty()
  if (process.platform === 'darwin') image.setTemplateImage(true)
  return image
}

function isExternalUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function hasOrigin(raw: string, expected: string): boolean {
  try {
    return new URL(raw).origin === expected
  } catch {
    return false
  }
}

/** Install navigation and permission policy before the first renderer loads. */
function hardenSession(): void {
  const desktopSession = session.defaultSession
  desktopSession.setPermissionCheckHandler(() => false)
  desktopSession.setPermissionRequestHandler((_webContents, _permission, callback) => { callback(false) })
}

/**
 * Create the application window and load `initialUrl`.
 * @param initialUrl - what to show first; the Host's origin once it answers,
 * and the splash page while it is still starting.
 * @returns the created window, once its first load has settled.
 */
async function createMainWindow(initialUrl?: string): Promise<BrowserWindow> {
  const target = initialUrl ?? hostOrigin
  if (target === undefined) throw new Error('desktop Host is not ready')
  startupLog?.step(`creating window for ${initialUrl === undefined ? target : 'the splash page'}`)
  const window = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: APP_NAME,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // The renderer's only shell capability is the account bridge; the
      // preload exposes those three methods and nothing else.
      preload: join(DESKTOP_DIR, 'lib/preload.cjs'),
    },
  })
  mainWindow = window
  window.on('close', (event) => { lifecycle?.onWindowClose(event) })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined
  })
  // The Host's origin is read per navigation rather than captured: the window
  // outlives the splash page it opens with, and nothing may navigate to that
  // origin before the Host has one.
  window.webContents.on('will-navigate', (event, url) => {
    if (hostOrigin !== undefined && hasOrigin(url, hostOrigin)) return
    event.preventDefault()
    if (isExternalUrl(url)) void shell.openExternal(url)
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Showing is driven by the first paint rather than by loadURL settling. A
  // renderer that is slow to finish every subresource — or a load that never
  // settles at all — would otherwise leave a created window permanently
  // invisible, which is indistinguishable from the application not starting.
  const reveal = (reason: string): void => {
    if (window.isDestroyed() || window.isVisible() || lifecycle?.isQuitting === true) return
    startupLog?.step(`showing window (${reason})`)
    window.show()
  }
  window.once('ready-to-show', () => { reveal('ready-to-show') })
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    startupLog?.step(`renderer load failed: ${String(errorCode)} ${errorDescription} for ${validatedURL}`)
    reveal('load failed')
  })
  const revealTimer = setTimeout(() => { reveal('first-paint timeout') }, WINDOW_REVEAL_TIMEOUT_MS)
  window.once('closed', () => { clearTimeout(revealTimer) })

  startupLog?.step('loading renderer')
  try {
    await window.loadURL(target)
    startupLog?.step('renderer loaded')
  } catch (error) {
    startupLog?.fail('renderer load', error)
    reveal('load rejected')
    throw error
  } finally {
    clearTimeout(revealTimer)
  }
  reveal('load settled')
  return window
}

function createTray(): void {
  tray = new Tray(trayImage())
  tray.setToolTip(APP_NAME)
  const template: MenuItemConstructorOptions[] = [
    { label: 'Show Window', click: () => { void lifecycle?.showWindow() } },
    { type: 'separator' },
    { label: 'Quit', click: () => { void requestAppQuit() } },
  ]
  tray.setContextMenu(Menu.buildFromTemplate(template))
  tray.on('click', () => { void lifecycle?.showWindow() })
}

function releaseAppQuit(): void {
  quitReleased = true
  tray?.destroy()
  tray = undefined
  app.quit()
}

/** Join explicit quit requests even while the Host or window is still starting. */
function requestAppQuit(): Promise<void> {
  if (lifecycle !== undefined) return lifecycle.requestQuit()
  bootQuitPromise ??= (host?.shutdown() ?? Promise.resolve()).catch((error: unknown) => {
    console.error('desktop shutdown failed:', error)
  }).then(() => {
    releaseAppQuit()
  })
  return bootQuitPromise
}

async function boot(): Promise<void> {
  if (bootQuitPromise !== undefined) return
  // The platform's own log location: ~/Library/Logs/<app> on macOS and
  // %APPDATA%\<app>\logs on Windows, so a user can find and send it.
  startupLog = createStartupLog(app.getPath('logs'))
  const record = (chunk: string): void => {
    process.stderr.write(chunk)
    startupLog?.step(`host: ${chunk.trimEnd()}`)
  }
  const paths = hostPaths()
  assertHostArtifacts(paths)
  // The path length is recorded, not just the path: Windows drops what an
  // installer could not write past its limit, and a module missing for that
  // reason is otherwise indistinguishable from one that was never packaged.
  startupLog.step(
    `artifacts present (packaged=${String(app.isPackaged)}, cliPathLength=${String(paths.cliEntry.length)}, cli=${paths.cliEntry})`,
  )
  // Before the Host boots: the plugin must be staged where the Loader resolves
  // it, so the overlay below can compose it into this launch. A development
  // launch reads the checkout, whose version does not move as its source does.
  const accountPatch = ensureAccountPlugin({
    pluginDir: paths.accountPluginDir,
    alwaysRestage: !app.isPackaged,
    log: record,
  })
  startupLog.step(`account plugin ${accountPatch === undefined ? 'unavailable' : 'staged'}`)
  // The desktop picks the port so it knows the origin to probe before the Host
  // is up; readiness is an HTTP answer, not a line read from the child's stdout.
  const port = await reserveLoopbackPort()
  const origin = `http://${LOOPBACK_HOST}:${String(port)}`
  startupLog.step(`reserved ${origin}`)
  host = createHostSupervisor({
    spawnHost: () => spawnDshWeb({
      ...paths,
      patches: accountPatch === undefined ? [] : [accountPatch],
      port,
      env: {
        ...process.env,
        DSH_DESKTOP: '1',
      },
    }),
    origin,
    probeReady: () => probeLoopbackOrigin(origin, HOST_PROBE_TIMEOUT_MS),
    log: record,
    onUnexpectedExit: ({ code, signal }) => {
      startupLog?.step(`host exited unexpectedly (code ${String(code)}, signal ${String(signal)})`)
      console.error(`desktop Host exited unexpectedly (code ${String(code)}, signal ${String(signal)})`)
      void requestAppQuit()
    },
  })
  // Policy is installed before any renderer exists, which now includes the
  // splash page below.
  hardenSession()
  registerAccountIpc()
  registerDirectoryIpc()
  lifecycle = createDesktopLifecycle({
    getWindow: () => mainWindow,
    createWindow: createMainWindow,
    disposeHost: async () => { await host?.shutdown() },
    quit: releaseAppQuit,
    reportError: (error) => { console.error('desktop shutdown failed:', error) },
  })
  createTray()
  startupLog.step('tray created')

  // The window opens before the Host is waited on. Loading the Host's plugin
  // tree past on-access virus scanning takes long enough on Windows that an
  // empty desktop reads as a failure to start; the splash page makes the wait
  // visible, and the window is already on screen when the Host answers.
  const window = await createMainWindow(splashUrl())
  startupLog.step('splash shown')

  startupLog.step('spawning host')
  hostOrigin = await host.start()
  startupLog.step('host answered its origin')

  if (window.isDestroyed()) {
    // Closed during the wait: the tray owns the application now, and asking
    // for the window again is what reopens it on the Host's own origin.
    startupLog.step('startup complete (window closed while starting)')
    return
  }
  await window.loadURL(hostOrigin)
  startupLog.step('startup complete')
}

if (!app.requestSingleInstanceLock()) {
  // Say so: a silent exit here is indistinguishable from a crash, and the
  // lock outlives a force-killed instance for a moment.
  console.error(`${APP_NAME} is already running; its existing window was raised instead.`)
  app.quit()
} else {
  app.on('second-instance', () => { void lifecycle?.showWindow() })
  app.on('activate', () => { void lifecycle?.showWindow() })
  app.on('window-all-closed', () => {
    // Tray and Host own application lifetime on every platform.
  })
  app.on('before-quit', (event: Event) => {
    if (quitReleased) return
    event.preventDefault()
    void requestAppQuit()
  })
  app.whenReady().then(boot).catch(async (error: unknown) => {
    console.error('desktop startup failed:', error)
    startupLog?.fail('startup', error)
    if (bootQuitPromise === undefined) {
      await dialog.showMessageBox({
        type: 'error',
        title: `${APP_NAME} failed to start`,
        message: error instanceof Error ? error.message : String(error),
        // The message alone rarely says which step failed; the log does, and a
        // user cannot report a file whose location they were never told.
        ...(startupLog === undefined ? {} : { detail: `Startup log: ${startupLog.path}` }),
      })
    }
    await requestAppQuit()
  })
}
