/**
 * Main-process half of the IPC fetch carrier.
 *
 * The renderer holds no network access to the Host: it sends a serialized
 * request over IPC, this module dispatches it through the Host's own Fetch
 * entry, and streams the response back chunk by chunk. Requests therefore run
 * the same wire serialization, zod validation, and SSE framing the browser
 * carrier runs — the transport is the only thing that changed.
 *
 * The renderer-side contract is `DesktopFetchBridge` in
 * `@deepseek-ai/dsh-client-connection`; the two agree by structure, since the
 * Client and Host planes never share an import.
 */

import { ipcMain, type WebContents } from 'electron'

/** IPC channel names; the preload script mirrors them. */
export const FETCH_CHANNELS = {
  start: 'dsh:fetch:start',
  abort: 'dsh:fetch:abort',
  head: 'dsh:fetch:head',
  chunk: 'dsh:fetch:chunk',
  end: 'dsh:fetch:end',
  error: 'dsh:fetch:error',
} as const

/** One request as the preload script serializes it. */
interface WireRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

/**
 * Read a response body to completion, forwarding each chunk to the renderer.
 * Sends stop when the renderer is gone, so a closed window cannot keep a
 * stream draining into nothing.
 * @param sender - the requesting renderer.
 * @param id - the request correlation id.
 * @param response - the Host's response.
 */
async function pumpBody(sender: WebContents, id: number, response: Response): Promise<void> {
  if (response.body === null) {
    if (!sender.isDestroyed()) sender.send(FETCH_CHANNELS.end, id)
    return
  }
  // Annotated because the platform `Response.body` is typed loosely enough
  // that `value` would otherwise arrive as `any`.
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (sender.isDestroyed()) return
      if (done) break
      // Copy out of the reader's buffer: the structured clone happens
      // asynchronously and the underlying ArrayBuffer may be reused.
      sender.send(FETCH_CHANNELS.chunk, id, new Uint8Array(value))
    }
    sender.send(FETCH_CHANNELS.end, id)
  } finally {
    reader.releaseLock()
  }
}

/**
 * The authority IPC requests are presented under.
 *
 * The `/api` route guards itself with a fence that refuses any request whose
 * `Host` is neither loopback nor a declared authority — a DNS-rebinding
 * defence for the browser carrier. A request arriving over IPC came from this
 * application's own renderer through a channel no network peer can reach,
 * which is a stronger statement about its origin than any header, so the
 * bridge presents it as loopback. The renderer's own scheme (`dsh://app`) is
 * not an authority the fence knows, and forwarding it would refuse every
 * privileged call.
 */
const LOOPBACK_AUTHORITY = '127.0.0.1'

/**
 * Rewrite a renderer request into the loopback form the route table expects.
 * @param request - the request as the renderer serialized it.
 * @returns path and authority the Host sees.
 */
function toLoopbackRequest(request: WireRequest): { url: string; headers: Record<string, string> } {
  const source = new URL(request.url)
  const url = new URL(`${source.pathname}${source.search}`, `http://${LOOPBACK_AUTHORITY}`)
  return { url: url.href, headers: { ...request.headers, host: LOOPBACK_AUTHORITY } }
}

/**
 * Register the main-process fetch bridge over the Host's route table.
 * @param hostFetch - dispatches one request through the Host's routes.
 * @returns a disposer removing the IPC listeners and aborting in-flight requests.
 */
export function registerFetchBridge(hostFetch: (request: Request) => Promise<Response>): () => void {
  const inflight = new Map<number, AbortController>()

  const onStart = (event: Electron.IpcMainEvent, id: number, request: WireRequest): void => {
    const controller = new AbortController()
    inflight.set(id, controller)
    const sender = event.sender

    void (async () => {
      try {
        const local = toLoopbackRequest(request)
        const response = await hostFetch(new Request(local.url, {
          method: request.method,
          headers: local.headers,
          ...request.body === undefined ? {} : { body: request.body },
          signal: controller.signal,
        }))
        if (sender.isDestroyed()) return
        const headers: Record<string, string> = {}
        response.headers.forEach((value, name) => { headers[name] = value })
        sender.send(FETCH_CHANNELS.head, id, response.status, response.statusText, headers)
        await pumpBody(sender, id, response)
      } catch (error) {
        if (sender.isDestroyed()) return
        sender.send(FETCH_CHANNELS.error, id, error instanceof Error ? error.message : String(error))
      } finally {
        inflight.delete(id)
      }
    })()
  }

  const onAbort = (_event: Electron.IpcMainEvent, id: number): void => {
    inflight.get(id)?.abort()
    inflight.delete(id)
  }

  ipcMain.on(FETCH_CHANNELS.start, onStart)
  ipcMain.on(FETCH_CHANNELS.abort, onAbort)

  return () => {
    ipcMain.removeListener(FETCH_CHANNELS.start, onStart)
    ipcMain.removeListener(FETCH_CHANNELS.abort, onAbort)
    for (const controller of inflight.values()) controller.abort()
    inflight.clear()
  }
}
