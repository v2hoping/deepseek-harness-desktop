/**
 * Probe one API key against the documented public balance endpoint. This is
 * the only request this application issues to DeepSeek, and it authenticates
 * with the user's own key rather than any platform session.
 */

import type { AccountResult, BalanceSummary } from '@deepseek-ai/dsh-desktop-account/bridge'
import { BALANCE_ENDPOINT } from './platform-pages.ts'

/** Bounded wait for the balance probe. */
const PROBE_TIMEOUT_MS = 15_000

/** Response fields the public balance endpoint documents. */
interface BalanceResponse {
  is_available?: boolean
  balance_infos?: { total_balance?: string; currency?: string }[]
}

/**
 * The one fetch form this probe uses. Narrower than the global signature
 * because Electron's `net.fetch` accepts a string URL, not a `URL` object.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * Read the account balance an API key grants access to.
 * @param secret - The API key to authenticate with.
 * @param fetchImpl - Fetch implementation; the main process supplies Electron's `net.fetch`.
 * @returns The balance, or why the probe failed.
 */
export async function probeBalance(
  secret: string,
  fetchImpl: FetchLike,
): Promise<AccountResult<BalanceSummary>> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, PROBE_TIMEOUT_MS)
  try {
    const response = await fetchImpl(BALANCE_ENDPOINT, {
      signal: controller.signal,
      headers: { authorization: `Bearer ${secret}`, accept: 'application/json' },
    })
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'invalid-key', message: 'the platform rejected this API key' }
    }
    if (!response.ok) {
      return { ok: false, reason: 'request-failed', message: `the balance endpoint answered ${String(response.status)}` }
    }
    const body = await response.json() as BalanceResponse
    const first = body.balance_infos?.[0]
    return {
      ok: true,
      value: {
        available: body.is_available === true,
        total: first?.total_balance ?? '0',
        currency: first?.currency ?? 'CNY',
      },
    }
  } catch (error) {
    return { ok: false, reason: 'request-failed', message: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}
