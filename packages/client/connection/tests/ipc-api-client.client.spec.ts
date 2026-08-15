/**
 * IPC carrier transport behaviour. The protocol itself is the base class's and
 * is covered elsewhere; what is specific here is how one bridge conversation
 * becomes a `Response` — header timing, body streaming, the pre/post-`head`
 * failure split, and abort.
 */

import { describe, expect, it, vi } from 'vitest'
import { IpcApiClient, type DesktopFetchBridge, type DesktopFetchRequest, type DesktopFetchSink } from '../src/client/ipc-api-client.ts'

/** A bridge that hands each request's sink to the test instead of Electron. */
function captureBridge(): {
  bridge: DesktopFetchBridge
  calls: { request: DesktopFetchRequest; sink: DesktopFetchSink }[]
  abort: ReturnType<typeof vi.fn>
} {
  const calls: { request: DesktopFetchRequest; sink: DesktopFetchSink }[] = []
  const abort = vi.fn()
  return {
    calls,
    abort,
    bridge: {
      fetch(request, sink) {
        calls.push({ request, sink })
        return abort
      },
    },
  }
}

/** `doFetch` is protected; the tests drive it as the base class would. */
class ProbeClient extends IpcApiClient {
  callDoFetch(input: URL, init?: RequestInit): Promise<Response> {
    return this.doFetch(input, init)
  }
}

const encoder = new TextEncoder()

describe('IpcApiClient transport', () => {
  it('serializes the request and resolves once headers arrive, before any body byte', async () => {
    const { bridge, calls } = captureBridge()
    const client = new ProbeClient(bridge)

    const pending = client.callDoFetch(new URL('http://desktop.invalid/api/session.list'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"rpcId":"r-1"}',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.request).toEqual({
      url: 'http://desktop.invalid/api/session.list',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"rpcId":"r-1"}',
    })

    calls[0]!.sink.head(200, 'OK', { 'content-type': 'application/json' })
    const response = await pending
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
  })

  it('streams body chunks in order, including ones that arrive before the reader attaches', async () => {
    const { bridge, calls } = captureBridge()
    const client = new ProbeClient(bridge)

    const pending = client.callDoFetch(new URL('http://desktop.invalid/api/events.mux'))
    const { sink } = calls[0]!
    sink.head(200, 'OK', {})
    // Both arrive before anything reads the body, exercising the buffer that
    // covers the gap between `head` and the stream's `start` callback.
    sink.chunk(encoder.encode('data: one\n\n'))
    sink.chunk(encoder.encode('data: two\n\n'))
    sink.end()

    const response = await pending
    expect(await response.text()).toBe('data: one\n\ndata: two\n\n')
  })

  it('rejects the request when the bridge fails before headers', async () => {
    const { bridge, calls } = captureBridge()
    const client = new ProbeClient(bridge)

    const pending = client.callDoFetch(new URL('http://desktop.invalid/api/session.list'), { method: 'POST' })
    calls[0]!.sink.error('host is gone')

    await expect(pending).rejects.toThrow('host is gone')
  })

  it('errors the body stream when the bridge fails after headers', async () => {
    const { bridge, calls } = captureBridge()
    const client = new ProbeClient(bridge)

    const pending = client.callDoFetch(new URL('http://desktop.invalid/api/events.mux'))
    const { sink } = calls[0]!
    sink.head(200, 'OK', {})
    const response = await pending
    sink.chunk(encoder.encode('data: partial\n\n'))
    sink.error('stream broke')

    // The caller already holds the Response, so the failure belongs to the body.
    await expect(response.text()).rejects.toThrow('stream broke')
  })

  it('carries no body on a status that forbids one', async () => {
    const { bridge, calls } = captureBridge()
    const client = new ProbeClient(bridge)

    const pending = client.callDoFetch(new URL('http://desktop.invalid/api/session.list'), { method: 'POST' })
    calls[0]!.sink.head(204, 'No Content', {})

    const response = await pending
    expect(response.body).toBeNull()
  })

  it('rejects immediately for an already-aborted signal without touching the bridge', async () => {
    const { bridge, calls } = captureBridge()
    const client = new ProbeClient(bridge)

    await expect(client.callDoFetch(
      new URL('http://desktop.invalid/api/session.list'),
      { signal: AbortSignal.abort(new Error('gone before start')) },
    )).rejects.toThrow('gone before start')
    expect(calls).toHaveLength(0)
  })

  it('aborts the bridge conversation when the signal fires', async () => {
    const { bridge, calls, abort } = captureBridge()
    const client = new ProbeClient(bridge)
    const controller = new AbortController()

    const pending = client.callDoFetch(new URL('http://desktop.invalid/api/session.list'), {
      method: 'POST',
      signal: controller.signal,
    })
    expect(calls).toHaveLength(1)

    controller.abort(new Error('caller cancelled'))
    await expect(pending).rejects.toThrow('caller cancelled')
    expect(abort).toHaveBeenCalledTimes(1)
  })

  it('defaults method and headers when the caller omits them', async () => {
    const { bridge, calls } = captureBridge()
    const client = new ProbeClient(bridge)

    void client.callDoFetch(new URL('http://desktop.invalid/api/events.host'))

    expect(calls[0]!.request.method).toBe('GET')
    expect(calls[0]!.request.headers).toEqual({})
    expect(calls[0]!.request.body).toBeUndefined()
  })
})
