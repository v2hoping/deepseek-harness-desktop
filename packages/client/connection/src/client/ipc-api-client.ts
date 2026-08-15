/**
 * Desktop API carrier: every request rides the shell's IPC bridge instead of
 * the network, so the desktop application binds no port and exposes no LAN
 * surface. Only `doFetch` differs from any other carrier — the protocol
 * invariants (rpcId minting, envelope wrapping, zod parsing, SSE framing) stay
 * in {@link AbstractApiClient}.
 *
 * `openMux`/`openHost` are deliberately NOT overridden: the base class reads
 * event streams as SSE off the response body, which works as long as the
 * bridge delivers a streaming body. That is the same path the in-process
 * carrier takes, so the desktop shell needs no second downlink mechanism the
 * way the browser does with its WebSockets.
 */

import { AbstractApiClient } from './api.ts'

/** One request handed to the shell bridge; `body` is already-serialized JSON. */
export interface DesktopFetchRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

/**
 * Callbacks the bridge drives for one request, in order: `head` once, `chunk`
 * zero or more times, then exactly one of `end` or `error`. A failure before
 * `head` rejects the request; one after it errors the body stream, because by
 * then the caller already holds a `Response`.
 */
export interface DesktopFetchSink {
  /**
   * Response status and headers, before any body byte.
   * @param status - HTTP status code.
   * @param statusText - HTTP status text.
   * @param headers - response headers, lower-cased names.
   */
  head(status: number, statusText: string, headers: Record<string, string>): void
  /**
   * One body chunk.
   * @param bytes - the chunk, as transferred over IPC.
   */
  chunk(bytes: Uint8Array): void
  /** The body ended normally. */
  end(): void
  /**
   * The request failed.
   * @param message - failure description for the rejected promise or errored stream.
   */
  error(message: string): void
}

/**
 * The shell's request face, exposed through `contextBridge`. Declared here as
 * a structural contract rather than imported from the desktop application:
 * the shell is a Host-plane assembly and this is a Client-plane package, so
 * the two sides agree by structure, never by a shared import.
 */
export interface DesktopFetchBridge {
  /**
   * Start one request.
   * @param request - the serialized request.
   * @param sink - callbacks driven as the response arrives.
   * @returns an abort function; calling it after settlement is a no-op.
   */
  fetch(request: DesktopFetchRequest, sink: DesktopFetchSink): () => void
}

/** Status codes that must carry no body, per the Fetch specification. */
const BODILESS_STATUS = new Set([101, 103, 204, 205, 304])

/**
 * Normalize `RequestInit` headers into the flat record the bridge carries.
 * @param headers - headers in any of the shapes `RequestInit` accepts.
 * @returns lower-cased header names mapped to their values.
 */
function flattenHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const flat: Record<string, string> = {}
  if (headers === undefined) return flat
  new Headers(headers).forEach((value, name) => { flat[name] = value })
  return flat
}

/**
 * A fetch-shaped call over the bridge. Narrower than the platform `fetch`:
 * the connection layer only ever passes a `URL`.
 */
export type IpcFetch = (input: URL, init?: RequestInit) => Promise<Response>

/**
 * Build the fetch entry every desktop caller shares — {@link IpcApiClient} for
 * the typed API plane, and the generic RPC channel caller for the rest.
 * @param bridge - the shell's request face.
 * @returns a fetch-shaped function backed by one bridge conversation per call.
 */
export function createIpcFetch(bridge: DesktopFetchBridge): IpcFetch {
  return (input, init) => {
    const signal = init?.signal ?? undefined
    if (signal?.aborted === true) return Promise.reject(abortError(signal))

    return new Promise<Response>((resolve, reject) => {
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined
      // Buffers chunks that arrive between `head` and the stream's `start`
      // callback running; without this a fast bridge could drop the first
      // frames of an event stream.
      const pending: Uint8Array[] = []
      let ended = false
      let settled = false

      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          controller = streamController
          for (const chunk of pending) streamController.enqueue(chunk)
          pending.length = 0
          if (ended) streamController.close()
        },
        cancel() { abort() },
      })

      const abort = bridge.fetch({
        url: input.href,
        method: init?.method ?? 'GET',
        headers: flattenHeaders(init?.headers),
        ...typeof init?.body === 'string' ? { body: init.body } : {},
      }, {
        head: (status, statusText, headers) => {
          settled = true
          resolve(new Response(BODILESS_STATUS.has(status) ? null : body, { status, statusText, headers }))
        },
        chunk: (bytes) => {
          if (controller === undefined) pending.push(bytes)
          else controller.enqueue(bytes)
        },
        end: () => {
          ended = true
          controller?.close()
        },
        error: (message) => {
          const failure = new Error(message)
          // Before `head` the caller holds no Response, so the request itself
          // fails; after it, the failure belongs to the body stream.
          if (settled) controller?.error(failure)
          else reject(failure)
        },
      })

      if (signal !== undefined) {
        const onAbort = (): void => {
          abort()
          const failure = abortError(signal)
          if (settled) controller?.error(failure)
          else reject(failure)
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }
}

/** Desktop platform subclass: one IPC round trip per request, streaming body included. */
export class IpcApiClient extends AbstractApiClient {
  private readonly ipcFetch: IpcFetch

  /**
   * @param bridge - the shell's request face.
   * @param timeoutMs - optional unary timeout override.
   */
  constructor(bridge: DesktopFetchBridge, timeoutMs?: number) {
    super(timeoutMs)
    this.ipcFetch = createIpcFetch(bridge)
  }

  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return this.ipcFetch(input, init)
  }
}

/**
 * Mirror fetch's abort rejection: the signal's reason when present, else a
 * DOMException-style AbortError.
 * @param signal - the aborted signal.
 * @returns the error to reject or error the stream with.
 */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  if (typeof reason === 'string') return new Error(reason)
  return new Error('This operation was aborted')
}
