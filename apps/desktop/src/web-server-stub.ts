/**
 * A `webServer` service that owns a route table but binds no socket.
 *
 * The packages that serve the browser surface — [`dsh-client-modules`], which
 * publishes `/plugins/<id>/client.js` and taps `__DSH_BOOT__` into index.html,
 * and [`dsh-host-frontend-static`], which serves the built frontend — reach
 * the outside world exclusively through `ctx.webServer`. Reimplementing what
 * they do would duplicate bundle-graph composition and SPA semantics and would
 * drift from upstream, so the desktop surface gives them the seam they expect
 * and drives the resulting route table from Electron's custom protocol
 * instead of a TCP listener. The application therefore serves the identical
 * asset and plugin routes the Web surface serves, with no port bound and no
 * LAN surface.
 *
 * Route matching mirrors the real implementation: exact table first, then
 * longest-prefix wins, then the single fallback seat.
 *
 * Upgrade routes are accepted and never driven — the desktop carrier has no
 * WebSocket downlink, since event streams ride the IPC carrier's SSE body.
 * Registering one is not an error (the composed graph may contain a row that
 * registers upgrades regardless of surface); it simply never fires.
 */

import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

/** Route match kind, mirroring the real service. */
type RouteKind = 'exact' | 'prefix'

/** One registered route. */
interface Route {
  kind: RouteKind
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** One registered upgrade route; accepted for compatibility, never driven. */
interface UpgradeRoute {
  path: string
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
}

/**
 * Stand in for `ServerResponse` and turn what a handler writes into a
 * `Response`.
 *
 * The response resolves at `writeHead`, not at `end`: an event stream never
 * ends, and waiting for it would hang every SSE request. Body writes after
 * that point flow into the response's stream, which is what makes a downlink
 * work with no socket underneath.
 *
 * It is an `EventEmitter` because the HTTP bridge subscribes to `close` to
 * detect a client going away, and to `drain` for backpressure. Writes are
 * always accepted (`write` returns true), so `drain` never has to fire.
 */
class ResponseCapture extends EventEmitter {
  private readonly headers: Record<string, string> = {}
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined
  private readonly pending: Uint8Array[] = []
  private closed = false
  private readonly started: Promise<Response>
  private begin!: (response: Response) => void

  /** True once `end` ran, distinguishing a normal finish from a teardown. */
  writableEnded = false

  constructor() {
    super()
    this.started = new Promise((resolve) => { this.begin = resolve })
  }

  /** @returns the response, available as soon as the handler wrote its head. */
  get response(): Promise<Response> {
    return this.started
  }

  /**
   * @param status - HTTP status code.
   * @param headers - optional response headers.
   * @returns this, matching the node:http signature.
   */
  writeHead(status: number, headers?: Record<string, string | number>): this {
    for (const [name, value] of Object.entries(headers ?? {})) this.headers[name.toLowerCase()] = String(value)
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller
        for (const chunk of this.pending) controller.enqueue(chunk)
        this.pending.length = 0
        if (this.closed) controller.close()
      },
      cancel: () => {
        // The consumer went away; the handler learns of it the way it would
        // from a dropped socket.
        this.emit('close')
      },
    })
    const bodiless = status === 204 || status === 304
    this.begin(new Response(bodiless ? null : body, { status, headers: this.headers }))
    return this
  }

  /**
   * @param name - header name.
   * @param value - header value.
   */
  setHeader(name: string, value: string | number): void {
    this.headers[name.toLowerCase()] = String(value)
  }

  /**
   * @param chunk - body chunk.
   * @returns always true: nothing here applies backpressure.
   */
  write(chunk: string | Uint8Array): boolean {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    if (this.controller === undefined) this.pending.push(bytes)
    else this.controller.enqueue(bytes)
    return true
  }

  /**
   * @param chunk - optional final body chunk.
   */
  end(chunk?: string | Uint8Array): void {
    if (chunk !== undefined) this.write(chunk)
    this.writableEnded = true
    this.closed = true
    this.controller?.close()
    this.emit('close')
  }
}

/**
 * Present one Fetch request to a node:http-shaped handler. The body is a real
 * readable stream, since the bridge consumes it with `for await`.
 * @param request - the incoming request.
 * @param body - the already-read request body.
 * @returns an object carrying the members handlers read.
 */
function toIncomingMessage(request: Request, body: Buffer): IncomingMessage {
  const url = new URL(request.url)
  const headers: Record<string, string> = {}
  request.headers.forEach((value, name) => { headers[name] = value })
  if (body.byteLength > 0) headers['content-length'] = String(body.byteLength)
  const message = Readable.from(body.byteLength > 0 ? [body] : []) as unknown as IncomingMessage
  Object.assign(message, {
    url: `${url.pathname}${url.search}`,
    method: request.method,
    headers,
  })
  return message
}

/** The `webServer` seam, minus the socket. */
export class StubWebServer {
  private readonly exact = new Map<string, Route>()
  private readonly prefixes = new Map<string, Route>()
  private readonly upgrades = new Map<string, UpgradeRoute>()
  private readonly indexTaps: ((html: string) => string)[] = []
  private fallback: Route['handler'] | undefined

  /** No socket is bound; reported for callers that log an address. */
  get port(): number {
    return 0
  }

  /** No socket is bound; reported for callers that log an address. */
  get host(): string {
    return 'desktop.invalid'
  }

  /**
   * @param route - kind, path, and the owning handler.
   * @returns the disposer removing the route.
   * @throws on a duplicate (kind, path), matching the real service.
   */
  register(route: Route): () => void {
    const table = route.kind === 'exact' ? this.exact : this.prefixes
    if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
    table.set(route.path, route)
    return () => { table.delete(route.path) }
  }

  /**
   * @param route - pathname and handler.
   * @returns the disposer removing the route.
   * @throws on a duplicate path, matching the real service.
   */
  registerUpgrade(route: UpgradeRoute): () => void {
    if (this.upgrades.has(route.path)) throw new Error(`webserver: duplicate upgrade route "${route.path}"`)
    this.upgrades.set(route.path, route)
    return () => { this.upgrades.delete(route.path) }
  }

  /**
   * @param handler - owns every request no named route matches.
   * @returns the disposer releasing the seat.
   * @throws when the single seat is already claimed.
   */
  registerFallback(handler: Route['handler']): () => void {
    if (this.fallback !== undefined) throw new Error('webserver: fallback already registered')
    this.fallback = handler
    return () => { this.fallback = undefined }
  }

  /**
   * @param transform - pure html-to-html function.
   * @returns the disposer removing the transform.
   */
  tapIndex(transform: (html: string) => string): () => void {
    this.indexTaps.push(transform)
    return () => {
      const at = this.indexTaps.indexOf(transform)
      if (at !== -1) this.indexTaps.splice(at, 1)
    }
  }

  /**
   * @param html - the raw index.html body.
   * @returns the body after every registered tap, in registration order.
   */
  applyIndexTaps(html: string): string {
    let out = html
    for (const transform of this.indexTaps) out = transform(out)
    return out
  }

  /**
   * Route one request through the table and return what the handler produced.
   * @param request - the request, as Electron's protocol handler received it.
   * @returns the handler's response, or 404 when nothing claims the path.
   */
  async dispatch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname
    const handler = this.match(pathname)?.handler ?? this.fallback
    if (handler === undefined) return new Response('not found', { status: 404 })
    const body = Buffer.from(await request.arrayBuffer())
    const capture = new ResponseCapture()
    // Not awaited: a handler serving an event stream stays running for the
    // life of the stream, and the response is ready as soon as it writes its
    // head. A handler that rejects before that leaves the response pending,
    // so its failure is surfaced here rather than becoming a silent hang.
    const running = Promise.resolve(handler(toIncomingMessage(request, body), capture as unknown as ServerResponse))
    const outcome = await Promise.race([
      capture.response.then(response => ({ kind: 'response' as const, response })),
      running.then(
        () => ({ kind: 'returned' as const, error: undefined }),
        (error: unknown) => ({ kind: 'returned' as const, error }),
      ),
    ])
    if (outcome.kind === 'returned') {
      // The handler finished without ever writing a head — a throw, or a path
      // that answered nothing at all.
      const detail = outcome.error instanceof Error ? outcome.error.message : 'handler wrote no response'
      return new Response(detail, { status: 500 })
    }
    // A HEAD response carries the headers of its GET without the body.
    if (request.method !== 'HEAD') return outcome.response
    return new Response(null, { status: outcome.response.status, headers: outcome.response.headers })
  }

  /** Longest-prefix-wins over the prefix table after an exact-table miss. */
  private match(pathname: string): Route | undefined {
    const exact = this.exact.get(pathname)
    if (exact !== undefined) return exact
    let best: Route | undefined
    for (const [prefix, route] of this.prefixes) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
      if (best === undefined || prefix.length > best.path.length) best = route
    }
    return best
  }
}
