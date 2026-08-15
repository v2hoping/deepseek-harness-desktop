/**
 * Official DeepSeek pages and the one public endpoint this application uses.
 *
 * The shell never calls the platform's internal website endpoints. Account
 * pages open in a window that carries the platform's own session, so every
 * request the platform sees comes from its own page with its own device
 * identity. The only request this application issues is to the documented
 * public balance endpoint, authenticated by the user's own API key.
 */

import type { AccountPage } from '@deepseek-ai/dsh-desktop-account/bridge'

/** Platform website origin, which owns the sign-in session. */
const PLATFORM_ORIGIN = 'https://platform.deepseek.com'

/** Official pages the shell opens rather than redrawing. */
export const PLATFORM_PAGES: Readonly<Record<AccountPage, string>> = {
  'sign-in': `${PLATFORM_ORIGIN}/sign_in`,
  'api-keys': `${PLATFORM_ORIGIN}/api_keys`,
  usage: `${PLATFORM_ORIGIN}/usage`,
  'top-up': `${PLATFORM_ORIGIN}/top_up`,
  billing: `${PLATFORM_ORIGIN}/billing`,
}

/** The documented public endpoint that reports an API key's account balance. */
export const BALANCE_ENDPOINT = 'https://api.deepseek.com/user/balance'

/**
 * Session partition holding the platform sign-in, kept apart from the
 * application's own renderer session.
 */
export const ACCOUNT_PARTITION = 'persist:deepseek-platform'

/**
 * A complete API key as the platform's creation response carries it. Its
 * listing endpoint returns a masked form (`sk-75dc3***…0a11`), so a creation
 * response is the only place a usable key appears.
 */
export const FULL_KEY_PATTERN = /"(sk-[A-Za-z0-9]{20,})"/u
