/**
 * Loopback port reservation and HTTP readiness probing for the desktop-owned Host.
 *
 * The desktop learns the Host is serving by asking its origin over HTTP rather
 * than by reading the Host's stdout. Electron does not deliver a child
 * process's piped stdout on Windows (electron/electron#28492), so a readiness
 * line the Host prints never reaches the supervisor there and the window would
 * never open. An HTTP answer is also the stronger evidence: it shows the Host
 * serving requests, not merely having reached its own log statement.
 *
 * Probing an origin requires knowing the port before the Host binds it, so the
 * desktop reserves one instead of letting the Host take an OS-assigned port.
 */

import { createServer } from 'node:net'
import { get } from 'node:http'

/** Loopback address the Host binds and the renderer loads. */
export const LOOPBACK_HOST = '127.0.0.1'

/**
 * Reserve a free loopback port by binding and releasing it.
 *
 * The port is free when it is returned, not when the Host binds it. Nothing
 * can hold the reservation across that gap without becoming the listener
 * itself, so a port taken in between surfaces as the Host failing to bind and
 * exiting before readiness, which the supervisor already reports.
 * @returns A port number free at the moment of the call.
 */
export async function reserveLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen({ host: LOOPBACK_HOST, port: 0 }, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => { reject(new Error('desktop could not reserve a loopback port')) })
        return
      }
      const { port } = address
      server.close((error) => { if (error === undefined) resolve(port); else reject(error) })
    })
  })
}

/**
 * Ask one origin whether it is serving HTTP.
 *
 * Any complete response counts, including an error status: the question is
 * whether the Host is listening and answering, not what it says about the
 * requested path.
 * @param origin - The loopback origin to probe.
 * @param timeoutMs - Per-attempt timeout before the probe reports not ready.
 * @returns `true` once the origin answers, `false` for a refused or timed-out attempt.
 */
export async function probeLoopbackOrigin(origin: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const request = get(`${origin}/`, { timeout: timeoutMs }, (response) => {
      response.resume()
      resolve(true)
    })
    request.on('timeout', () => { request.destroy() })
    request.on('error', () => { resolve(false) })
  })
}
