/**
 * Development carrier entry: serve `bridge/v1` with no Host.
 *
 * The providers read Host services, so a bare process has none of them: this
 * entry answers `/manifest` and reports every provider as unavailable through
 * its normal failure code. It exists to let a native client confirm the wire,
 * the CORS-free loopback shape, and its own decoding before a Host is running.
 *
 * Against a real Host the plugin registers on the Host's own `webServer`; this
 * file is not part of that path.
 */

import { createBridgeHandler } from '../src/handler.ts'
import { packageVersion } from '../src/index.ts'
import { ProviderRegistry } from '../src/protocol/provider.ts'
import { startStandalone } from '../src/standalone.ts'

const port = Number(process.env.DSH_BRIDGE_PORT ?? 0)

const server = await startStandalone({
  handler: createBridgeHandler({
    registry: new ProviderRegistry(),
    pluginVersion: packageVersion,
    dshVersion: () => null,
    assemblyWarnings: [
      'standalone carrier: no Host services are bound, so every provider is absent',
    ],
  }),
  ...(Number.isInteger(port) && port > 0 ? { port } : {}),
})

process.stdout.write(`dsh-mobile-bridge standalone carrier: ${server.origin}/dsh-mobile/bridge/v1\n`)
