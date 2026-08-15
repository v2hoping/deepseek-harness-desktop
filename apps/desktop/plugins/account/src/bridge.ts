/**
 * The account capability contract shared by the Electron main process, the
 * preload bridge, and the browser half. Types only: the renderer reaches the
 * implementation through `window.dshDesktop.account`, never by import.
 *
 * The shell never authenticates as the user and issues no request of its own.
 * Account pages open in a window that carries the platform's own session,
 * every request comes from that page, and the shell only observes the response
 * that carries a newly created key.
 */

/** Why an account operation could not produce a value. */
export type AccountFailure =
  /** The user closed the account window before finishing. */
  | 'cancelled'
  /** The window could not be observed, so no key could be captured. */
  | 'request-failed'

/** Outcome of one account operation, discriminated so the UI can degrade precisely. */
export type AccountResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: AccountFailure; readonly message: string }

/** A key the user created on the official page, captured from its response. */
export interface CapturedApiKey {
  /** The full secret, readable only in the creation response. */
  readonly secret: string
}

/** Official pages the shell opens in a window sharing the platform session. */
export type AccountPage = 'sign-in' | 'api-keys' | 'usage' | 'top-up' | 'billing'

/**
 * The account surface the Electron preload exposes to the renderer. Every
 * method resolves; failures arrive as {@link AccountResult} so the UI never
 * has to read an Error message.
 */
export interface AccountBridge {
  /**
   * Open one official page in a window that carries the platform session.
   * @param page - Which page to open.
   * @returns Settlement once the window has been opened.
   */
  openPage(page: AccountPage): Promise<void>
  /**
   * Open the official API keys page and settle with the key the user creates
   * there. The shell reads only that page's own creation response; it sends no
   * request of its own and stores no platform credential.
   * @returns The captured key, or why no key arrived.
   */
  provisionKey(): Promise<AccountResult<CapturedApiKey>>
}

/** The desktop shell's renderer-visible surface. */
export interface DesktopBridge {
  /** Account capability, present only in the Electron shell. */
  readonly account: AccountBridge
}

declare global {
  interface Window {
    /** Present in the Electron shell; absent in an ordinary browser tab. */
    dshDesktop?: DesktopBridge
  }
}
