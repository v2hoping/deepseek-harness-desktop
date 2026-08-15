/**
 * Recognize a newly created API key in a platform response body.
 *
 * The platform's key listing returns masked values (`sk-75dc3***…0a11`) and
 * only a creation response carries a usable secret, so matching the unmasked
 * form is what distinguishes the two. Matching the value rather than a fixed
 * endpoint path keeps this working when the platform renames its endpoints.
 */

import type { CapturedApiKey } from '@deepseek-ai/dsh-desktop-account/bridge'
import { FULL_KEY_PATTERN } from './platform-pages.ts'

/** Key name in the same response object, when the platform records one. */
const NAME_PATTERN = /"name"\s*:\s*"([^"]{1,120})"/u

/**
 * Extract a complete API key from one response body.
 * @param body - Raw response text from the platform page's own request.
 * @returns The captured key, or `undefined` when the body carries none.
 */
export function captureApiKey(body: string): CapturedApiKey | undefined {
  const secret = FULL_KEY_PATTERN.exec(body)?.[1]
  if (secret === undefined) return undefined
  const name = NAME_PATTERN.exec(body)?.[1]
  return name === undefined ? { secret } : { secret, name }
}
