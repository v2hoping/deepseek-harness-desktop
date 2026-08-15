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
import { createResponseTracker } from './response-tracker.ts'
import { ACCOUNT_PARTITION, PLATFORM_PAGES } from './platform-pages.ts'

const WINDOW_WIDTH = 1100
const WINDOW_HEIGHT = 820

/** Only the platform's own API responses are inspected. */
const OBSERVED_URL = '/api/v0/'

/**
 * Replace every complete key in a body with its last four characters, so a
 * diagnostic can show which field carried the value without logging a live
 * secret.
 * @param body - the response text.
 * @returns the same text with each key redacted.
 */
function redactSecrets(body: string): string {
  return body.replace(/sk-[A-Za-z0-9]{16,}/gu, match => `sk-****${match.slice(-4)}`)
}

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

/** Diagnostics the account window reports while it observes. */
export interface AccountWindowOptions {
  /** Receives one line when a response body cannot be read. */
  readonly log?: (line: string) => void
}

/** Watch one window's network responses for a created key, until it closes. */
function watchForKey(window: BrowserWindow, options: AccountWindowOptions): Promise<AccountResult<CapturedApiKey>> {
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
    const tracker = createResponseTracker(OBSERVED_URL)
    attached.on('message', (_event, method, params) => {
      if (settled) return
      // Only a creation carries a usable secret, and only a creation is a
      // POST: the list refresh that follows it is a GET returning masked
      // values, which must never be mistaken for the new key.
      if (method === 'Network.requestWillBeSent') {
        const detail = params as { requestId?: string; request?: { url?: string; method?: string } }
        const { requestId } = detail
        const url = detail.request?.url
        if (requestId === undefined || url === undefined) return
        if (detail.request?.method !== 'POST') return
        tracker.observe(requestId, url)
        return
      }
      // Only now does the body exist: at responseReceived the protocol answers
      // "No data found for resource with given identifier".
      if (method !== 'Network.loadingFinished') return
      const { requestId } = params as { requestId?: string }
      if (requestId === undefined) return
      const url = tracker.claim(requestId)
      if (url === undefined) return
      void attached.sendCommand('Network.getResponseBody', { requestId })
        .then((result: unknown) => {
          const { body, base64Encoded } = result as { body?: string; base64Encoded?: boolean }
          if (body === undefined) return
          const text = base64Encoded === true ? Buffer.from(body, 'base64').toString('utf8') : body
          const captured = captureApiKey(text)
          if (captured === undefined) {
            options.log?.(`account window: no key in the response to ${url}\n`)
            return
          }
          // The tail is enough to match against the platform's own display
          // without putting a live secret in a log; the redacted body shows
          // which field the value came from when it turns out to be wrong.
          options.log?.(
            `account window: captured a key ending ${captured.secret.slice(-4)} from ${url}\n`
            + `  body: ${redactSecrets(text).slice(0, 600)}\n`,
          )
          settle({ ok: true, value: captured })
        })
        .catch((error: unknown) => {
          // Report rather than swallow: a body this window cannot read is the
          // one failure that looks like "creating a key simply did nothing".
          options.log?.(`account window could not read ${url}: ${error instanceof Error ? error.message : String(error)}\n`)
        })
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
 * @param options - diagnostics sink for unreadable responses.
 * @returns The captured key, or why none arrived.
 */
export function provisionKey(options: AccountWindowOptions = {}): Promise<AccountResult<CapturedApiKey>> {
  const window = createAccountWindow('api-keys')
  window.show()
  return watchForKey(window, options)
}
