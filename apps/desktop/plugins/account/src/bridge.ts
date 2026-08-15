/**
 * The account capability contract shared by the Electron main process, the
 * preload bridge, and the browser half. Types only: the renderer reaches the
 * implementation through `window.dshDesktop.account`, never by import.
 *
 * The shell never authenticates as the user. Account pages open in a window
 * that carries the platform's own session, every request comes from that
 * page, and the shell only observes the response that carries a newly created
 * key. Balance is read with the user's own API key through the public
 * endpoint, which needs no session at all.
 */

/** Why an account operation could not produce a value. */
export type AccountFailure =
  /** The user closed the account window before finishing. */
  | 'cancelled'
  /** The API key was refused by the public endpoint. */
  | 'invalid-key'
  /** The endpoint could not be reached, or its response did not parse. */
  | 'request-failed'

/** Outcome of one account operation, discriminated so the UI can degrade precisely. */
export type AccountResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: AccountFailure; readonly message: string }

/** A key the user created on the official page, captured from its response. */
export interface CapturedApiKey {
  /** The full secret, readable only in the creation response. */
  readonly secret: string
  /** Key name as the platform recorded it, when the response carries one. */
  readonly name?: string
}

/** Account balance from the public `GET /user/balance` endpoint. */
export interface BalanceSummary {
  /** Whether the account can serve requests. */
  readonly available: boolean
  /** Total balance as the endpoint reports it. */
  readonly total: string
  /** Currency code of {@link total}. */
  readonly currency: string
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
   * Check one API key against the public balance endpoint.
   * @param secret - The key the probe authenticates with.
   * @returns The balance when the key works, or why the probe failed.
   */
  checkKey(secret: string): Promise<AccountResult<BalanceSummary>>
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
