/**
 * The window that shows official DeepSeek pages, and the passive observer that
 * notices when the user creates an API key on one of them.
 *
 * The window carries the platform's own session partition, so every request it
 * makes is the platform's own page acting with the platform's own device
 * identity. The shell attaches Chrome DevTools Protocol network events to read
 * response bodies; it enables `Network` only, injects no script, sends no
 * request of its own, and never reads or stores the page's session credential.
 */

import { BrowserWindow, type Debugger } from 'electron'
import type { AccountPage, AccountResult, CapturedApiKey } from '@deepseek-ai/dsh-desktop-account/bridge'
import { captureApiKey } from './key-capture.ts'
import { ACCOUNT_PARTITION, PLATFORM_PAGES } from './platform-pages.ts'

const WINDOW_WIDTH = 1100
const WINDOW_HEIGHT = 820

/** Only the platform's own API responses are inspected. */
const OBSERVED_URL = '/api/v0/'

/** Create the window that shows one official page. */
function createAccountWindow(page: AccountPage): BrowserWindow {
  const window = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    title: 'DeepSeek',
    autoHideMenuBar: true,
    webPreferences: {
      partition: ACCOUNT_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  void window.loadURL(PLATFORM_PAGES[page])
  return window
}

/**
 * Open one official page for the user.
 * @param page - Which page to open.
 */
export function openAccountPage(page: AccountPage): void {
  createAccountWindow(page).show()
}

/** Watch one window's network responses for a created key, until it closes. */
function watchForKey(window: BrowserWindow): Promise<AccountResult<CapturedApiKey>> {
  return new Promise((resolve) => {
    let settled = false
    let session: Debugger | undefined

    const settle = (result: AccountResult<CapturedApiKey>): void => {
      if (settled) return
      settled = true
      try {
        if (session?.isAttached() === true) session.detach()
      } catch {
        // The window tore the debugger down first; nothing else observes it.
      }
      resolve(result)
      if (!window.isDestroyed()) window.close()
    }

    window.on('closed', () => {
      settle({ ok: false, reason: 'cancelled', message: 'the account window was closed' })
    })

    try {
      session = window.webContents.debugger
      session.attach('1.3')
    } catch (error) {
      settle({
        ok: false,
        reason: 'request-failed',
        message: `could not observe the account window: ${error instanceof Error ? error.message : String(error)}`,
      })
      return
    }

    const attached = session
    attached.on('message', (_event, method, params) => {
      if (settled || method !== 'Network.responseReceived') return
      const detail = params as { requestId?: string; response?: { url?: string } }
      const requestId = detail.requestId
      if (requestId === undefined || detail.response?.url?.includes(OBSERVED_URL) !== true) return
      void attached.sendCommand('Network.getResponseBody', { requestId })
        .then((result: unknown) => {
          const body = (result as { body?: string }).body
          if (body === undefined) return
          const captured = captureApiKey(body)
          if (captured !== undefined) settle({ ok: true, value: captured })
        })
        // The body is gone (redirect, cache, or a torn-down request); the next
        // response is the only thing that matters.
        .catch(() => undefined)
    })

    void attached.sendCommand('Network.enable').catch((error: unknown) => {
      settle({
        ok: false,
        reason: 'request-failed',
        message: `could not observe the account window: ${error instanceof Error ? error.message : String(error)}`,
      })
    })
  })
}

/**
 * Open the official API keys page and settle with the key the user creates.
 * @returns The captured key, or why none arrived.
 */
export function provisionKey(): Promise<AccountResult<CapturedApiKey>> {
  const window = createAccountWindow('api-keys')
  window.show()
  return watchForKey(window)
}
