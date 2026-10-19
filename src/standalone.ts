/**
 * Standalone carrier: serve `bridge/v1` from a plain Node process with no Host.
 *
 * This exists so a native client can be developed and contract-tested against
 * the exact same handler the Host composes. It is a development carrier, not a
 * product surface: it binds loopback only, serves no static files, and reports
 * an empty provider catalog unless a fixture supplies one.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { writeReply, type BridgeReply } from './handler.ts'

/** A handler the standalone carrier serves. */
export type StandaloneHandler = (request: IncomingMessage) => Promise<BridgeReply>

/** Standalone carrier configuration. */
export interface StandaloneOptions {
  /** The handler, normally `createBridgeHandler(...)`. */
  readonly handler: StandaloneHandler
  /** Loopback port; zero requests an OS-assigned one. */
  readonly port?: number
  /** Loopback host literal. Only loopback is accepted, by construction. */
  readonly host?: string
}

/** A running standalone carrier. */
export interface StandaloneServer {
  /** Bound port. */
  readonly port: number
  /** Origin a client dials, such as `http://127.0.0.1:43121`. */
  readonly origin: string
  /** Stop the listener and release the port. */
  close(): Promise<void>
}

/**
 * Start the standalone carrier.
 * @param options - handler and bind choice.
 * @returns the running server with its bound port.
 * @throws {Error} when the bind host is not a loopback literal.
 */
export async function startStandalone(options: StandaloneOptions): Promise<StandaloneServer> {
  const host = options.host ?? '127.0.0.1'
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    throw new Error(`dsh-mobile-bridge: the standalone carrier binds loopback only, not ${host}`)
  }
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    options.handler(req)
      .then(reply => { writeReply(res, reply) })
      .catch((error: unknown) => {
        res.statusCode = 500
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: false, error: { code: 'internal/error', message: String(error) } }))
      })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    port,
    origin: `http://${host === '::1' ? '[::1]' : host}:${port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => { error === undefined ? resolve() : reject(error) })
    }),
  }
}
