/**
 * Preload bridge: the renderer's entire view of the Host.
 *
 * Exposes one method — start a request, receive its response — and nothing
 * else. No general IPC channel, no `fs`, no `child_process`: a renderer
 * compromise gains the caller exactly the RPC surface the Host already guards,
 * and no filesystem or process access.
 *
 * The exposed object structurally satisfies `DesktopFetchBridge` in
 * `@deepseek-ai/dsh-client-connection`, which the renderer wraps in its
 * `IpcApiClient`.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

/** Channel names; mirrors `FETCH_CHANNELS` in the main-process half. */
const CHANNELS = {
  start: 'dsh:fetch:start',
  abort: 'dsh:fetch:abort',
  head: 'dsh:fetch:head',
  chunk: 'dsh:fetch:chunk',
  end: 'dsh:fetch:end',
  error: 'dsh:fetch:error',
} as const

/** Callbacks driven for one in-flight request. */
interface Sink {
  head(status: number, statusText: string, headers: Record<string, string>): void
  chunk(bytes: Uint8Array): void
  end(): void
  error(message: string): void
}

/** In-flight requests by correlation id. */
const pending = new Map<number, Sink>()

let nextId = 0

/**
 * Route one main-process message to its request's sink.
 * @param id - the request correlation id.
 * @param apply - what to do with the sink.
 * @param done - whether this message settles the request.
 */
function dispatch(id: number, apply: (sink: Sink) => void, done: boolean): void {
  const sink = pending.get(id)
  if (sink === undefined) return
  if (done) pending.delete(id)
  apply(sink)
}

ipcRenderer.on(CHANNELS.head, (
  _event: IpcRendererEvent,
  id: number,
  status: number,
  statusText: string,
  headers: Record<string, string>,
) => {
  dispatch(id, (sink) => { sink.head(status, statusText, headers) }, false)
})
ipcRenderer.on(CHANNELS.chunk, (_event: IpcRendererEvent, id: number, bytes: Uint8Array) => {
  dispatch(id, (sink) => { sink.chunk(bytes) }, false)
})
ipcRenderer.on(CHANNELS.end, (_event: IpcRendererEvent, id: number) => {
  dispatch(id, (sink) => { sink.end() }, true)
})
ipcRenderer.on(CHANNELS.error, (_event: IpcRendererEvent, id: number, message: string) => {
  dispatch(id, (sink) => { sink.error(message) }, true)
})

contextBridge.exposeInMainWorld('dshDesktop', {
  fetch(request: { url: string; method: string; headers: Record<string, string>; body?: string }, sink: Sink): () => void {
    const id = nextId++
    pending.set(id, sink)
    ipcRenderer.send(CHANNELS.start, id, request)
    return () => {
      // Dropping the sink first makes the abort idempotent: late frames for an
      // aborted request route nowhere instead of reaching a settled caller.
      if (!pending.delete(id)) return
      ipcRenderer.send(CHANNELS.abort, id)
    }
  },
})
