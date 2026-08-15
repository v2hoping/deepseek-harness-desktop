/**
 * Track which platform responses are worth reading, and when their bodies
 * exist.
 *
 * `Network.getResponseBody` answers "No data found for resource with given
 * identifier" at `Network.responseReceived` — the body is only readable once
 * `Network.loadingFinished` reports the transfer complete. This tracker holds
 * the interesting request ids between those two events, so the body is read at
 * the one moment it exists.
 */

/** Requests whose body the account window still expects. */
export interface ResponseTracker {
  /**
   * Record one response whose body should be read when it finishes.
   * @param requestId - CDP request identifier.
   * @param url - Response URL, filtered against the platform's API prefix.
   * @returns `true` when the response is now tracked.
   */
  observe(requestId: string, url: string): boolean
  /**
   * Claim a finished request, removing it from the tracker.
   * @param requestId - CDP request identifier.
   * @returns The recorded URL, or `undefined` when the request was not tracked.
   */
  claim(requestId: string): string | undefined
}

/**
 * Bound on tracked requests, so a long-lived window cannot grow this map
 * without limit when responses never report completion.
 */
const MAX_TRACKED = 64

/**
 * Create a tracker for one window's platform responses.
 * @param urlFilter - Substring a response URL must contain to be tracked.
 * @returns A tracker holding at most a bounded number of pending requests.
 */
export function createResponseTracker(urlFilter: string): ResponseTracker {
  const pending = new Map<string, string>()

  return {
    observe(requestId, url) {
      if (!url.includes(urlFilter)) return false
      // Oldest first: the map preserves insertion order, so dropping its first
      // key evicts the least recent unfinished request.
      if (pending.size >= MAX_TRACKED) {
        const oldest = pending.keys().next()
        if (!oldest.done) pending.delete(oldest.value)
      }
      pending.set(requestId, url)
      return true
    },
    claim(requestId) {
      const url = pending.get(requestId)
      if (url === undefined) return undefined
      pending.delete(requestId)
      return url
    },
  }
}
