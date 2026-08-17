import { createServer, type Server } from 'node:http'
import { describe, expect, it } from 'vitest'
import { LOOPBACK_HOST, probeLoopbackOrigin, reserveLoopbackPort } from '../src/loopback.ts'

/** Serve one loopback origin for the duration of `body`. */
async function withServer(
  respond: (statusCode: number) => number,
  body: (origin: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(respond(200))
    response.end()
  })
  await new Promise<void>((ready) => { server.listen({ host: LOOPBACK_HOST, port: 0 }, ready) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server has no port')
  try {
    await body(`http://${LOOPBACK_HOST}:${String(address.port)}`)
  } finally {
    await new Promise<void>((closed) => { server.close(() => { closed() }) })
  }
}

describe('loopback port reservation', () => {
  it('returns a port that is free to bind', async () => {
    const port = await reserveLoopbackPort()

    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThanOrEqual(65_535)
    // Free at the moment it is returned: the Host binds it next.
    const server = createServer()
    await new Promise<void>((ready, fail) => {
      server.on('error', fail)
      server.listen({ host: LOOPBACK_HOST, port }, ready)
    })
    await new Promise<void>((closed) => { server.close(() => { closed() }) })
  })

  it('does not hand the same port to two consecutive reservations', async () => {
    // Not a uniqueness guarantee the code makes, but a reservation returning a
    // port still held by the previous caller would defeat its purpose.
    const first = await reserveLoopbackPort()
    const server = createServer()
    await new Promise<void>((ready) => { server.listen({ host: LOOPBACK_HOST, port: first }, ready) })
    try {
      expect(await reserveLoopbackPort()).not.toBe(first)
    } finally {
      await new Promise<void>((closed) => { server.close(() => { closed() }) })
    }
  })
})

describe('loopback readiness probe', () => {
  it('reports ready once an origin answers', async () => {
    await withServer(status => status, async (origin) => {
      expect(await probeLoopbackOrigin(origin, 2_000)).toBe(true)
    })
  })

  it('reports ready for an error status, since the question is whether it answers', async () => {
    await withServer(() => 503, async (origin) => {
      expect(await probeLoopbackOrigin(origin, 2_000)).toBe(true)
    })
  })

  it('reports not ready when nothing is listening', async () => {
    const port = await reserveLoopbackPort()

    expect(await probeLoopbackOrigin(`http://${LOOPBACK_HOST}:${String(port)}`, 2_000)).toBe(false)
  })

  it('reports not ready when an accepted connection never answers', async () => {
    // A port that accepts but never responds is the shape a half-started Host
    // takes; the probe has to give up rather than hang the whole startup.
    const server = createServer(() => { /* accept, never respond */ })
    await new Promise<void>((ready) => { server.listen({ host: LOOPBACK_HOST, port: 0 }, ready) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('test server has no port')
    try {
      expect(await probeLoopbackOrigin(`http://${LOOPBACK_HOST}:${String(address.port)}`, 50)).toBe(false)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((closed) => { server.close(() => { closed() }) })
    }
  })
})
