/**
 * Plugin assembly: what `apply` registers, and what it reports when the
 * composition lacks a service.
 *
 * The Host's real `webServer` is replaced by a recording stand-in, so the test
 * checks the plugin's own behavior — route paths, disposer ownership, and the
 * manifest a client would actually read — without an HTTP server.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import { apply, Config, inject, name } from '../src/index.ts'
import type { HostWebRoute } from '../src/host-services.ts'
import { BRIDGE_BASE_PATH, EVENTS_PATH, MANIFEST_PATH, QUERY_PATH } from '../src/protocol/types.ts'

/** A recording web-server stand-in. */
function recordingWebServer(): {
  register(route: HostWebRoute): () => void
  readonly routes: HostWebRoute[]
  readonly disposed: string[]
} {
  const routes: HostWebRoute[] = []
  const disposed: string[] = []
  return {
    routes,
    disposed,
    register: (route) => {
      routes.push(route)
      return () => {
        disposed.push(route.path)
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }
}

/** A minimal Cordis-like context with the services the plugin reads. */
function fakeContext(services: Record<string, unknown>): {
  get(name: string): unknown
  effect(execute: () => unknown, label?: string): { dispose(): void }
  logger: { info(): void; warn(): void; error(): void }
  readonly effects: string[]
} {
  const effects: string[] = []
  return {
    effects,
    get: (serviceName: string) => services[serviceName],
    effect: (execute, label) => {
      effects.push(label ?? '')
      execute()
      return { dispose: () => {} }
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
}

/** Build a request the route handler can read. */
function request(options: { readonly method: string; readonly path: string; readonly body?: unknown }): IncomingMessage {
  const text = options.body === undefined ? '' : JSON.stringify(options.body)
  const stream = Readable.from(text === '' ? [] : [Buffer.from(text, 'utf8')]) as unknown as IncomingMessage
  stream.method = options.method
  stream.url = options.path
  stream.headers = options.body === undefined ? {} : { 'content-type': 'application/json' }
  return stream
}

/** A response recorder the route handler writes into. */
function recorder(): {
  statusCode: number
  headers: Record<string, string>
  setHeader(name: string, value: string): void
  end(body?: string): void
  readonly body: () => string
} {
  let text = ''
  const headers: Record<string, string> = {}
  return {
    statusCode: 200,
    headers,
    setHeader: (headerName, value) => { headers[headerName] = value },
    end: (body) => { text = body ?? '' },
    body: () => text,
  }
}

/** The plugin's declared identity. */
test('the plugin declares its name and its one required service', () => {
  assert.equal(name, 'dsh-mobile-bridge-plugin')
  assert.deepEqual(inject, ['webServer'])
})

test('the config schema supplies the documented defaults', () => {
  const resolved = new Config({}) as {
    enabled: boolean
    slotEntries: string[]
    maxIconSize: number
    iconViewBox: string
    localeTags: string[]
    rpcAllowlist: unknown[]
    requireHostSession: boolean
  }
  assert.equal(resolved.enabled, true)
  assert.deepEqual(resolved.slotEntries, [])
  assert.equal(resolved.maxIconSize, 256)
  assert.equal(resolved.iconViewBox, '0 0 24 24')
  assert.deepEqual(resolved.localeTags, ['zh', 'en'])
  assert.deepEqual(resolved.rpcAllowlist, [])
  assert.equal(resolved.requireHostSession, true)
})

test('apply registers the manifest, query, event, and base routes as effects', () => {
  const webServer = recordingWebServer()
  const ctx = fakeContext({ webServer })
  const config = new Config({}) as Parameters<typeof apply>[1]
  apply(ctx as unknown as Parameters<typeof apply>[0], config)
  assert.deepEqual(webServer.routes.map(route => `${route.kind} ${route.path}`), [
    `exact ${MANIFEST_PATH}`,
    `exact ${QUERY_PATH}`,
    `exact ${EVENTS_PATH}`,
    `prefix ${BRIDGE_BASE_PATH}`,
  ])
  assert.equal(ctx.effects.length, 4)
})

test('a disabled bridge registers no route at all', () => {
  const webServer = recordingWebServer()
  const ctx = fakeContext({ webServer })
  apply(
    ctx as unknown as Parameters<typeof apply>[0],
    new Config({ enabled: false }) as Parameters<typeof apply>[1],
  )
  assert.deepEqual(webServer.routes, [])
})

test('the manifest route answers every provider with its honest availability', async () => {
  const webServer = recordingWebServer()
  const ctx = fakeContext({ webServer })
  apply(ctx as unknown as Parameters<typeof apply>[0], new Config({}) as Parameters<typeof apply>[1])
  const route = webServer.routes.find(candidate => candidate.path === MANIFEST_PATH)!
  const res = recorder()
  await route.handler(request({ method: 'GET', path: MANIFEST_PATH }), res as never)
  const body = JSON.parse(res.body()) as {
    bridgeVersion: string
    dshVersion: string | null
    providers: { id: string; version: number; capabilities: string[]; authorization?: string }[]
    warnings: string[]
  }
  assert.equal(body.bridgeVersion, '1.0.0')
  // No client-modules package is installed in this checkout, so the release
  // label is absent rather than invented.
  assert.equal(body.dshVersion, null)
  assert.deepEqual(body.providers.map(provider => provider.id), [
    'client-assets', 'client-slots', 'host-slots', 'package-inventory', 'settings', 'events', 'native-plugins', 'rpc',
  ])
  assert.deepEqual(body.providers[0]!.capabilities, ['boot-graph', 'loader-rows', 'module-source', 'locale'])
  assert.deepEqual(body.providers[1]!.capabilities, ['list', 'describe', 'render-tree', 'icon-svg', 'dispatch'])
  assert.deepEqual(body.providers[2]!.capabilities, ['list'])
  assert.deepEqual(body.providers[3]!.capabilities, ['bundles', 'rows', 'meta-icon'])
  assert.deepEqual(body.providers[4]!.capabilities, ['describe', 'update'])
  assert.deepEqual(body.providers[5]!.capabilities, ['pending'])
  assert.deepEqual(body.providers[6]!.capabilities, ['list', 'for'])
  assert.deepEqual(body.providers[7]!.capabilities, ['invoke'])
  assert.equal(body.providers[7]!.authorization, 'host-session')
  // The assembly reports each missing service instead of failing to load.
  assert.ok(body.warnings.some(warning => warning.includes('client module registry')))
  assert.ok(body.warnings.some(warning => warning.includes('plugin manager')))
  assert.ok(body.warnings.some(warning => warning.includes('empty allowlist')))
})

test('the base route tells a probing client where the two real routes are', async () => {
  const webServer = recordingWebServer()
  const ctx = fakeContext({ webServer })
  apply(ctx as unknown as Parameters<typeof apply>[0], new Config({}) as Parameters<typeof apply>[1])
  const route = webServer.routes.find(candidate => candidate.path === BRIDGE_BASE_PATH)!
  const res = recorder()
  await route.handler(request({ method: 'GET', path: BRIDGE_BASE_PATH }), res as never)
  assert.deepEqual(JSON.parse(res.body()), {
    bridgeVersion: '1.0.0',
    manifest: MANIFEST_PATH,
    query: QUERY_PATH,
  })
})

test('the base prefix delegates anything deeper to the same handler', async () => {
  const webServer = recordingWebServer()
  const ctx = fakeContext({ webServer })
  apply(ctx as unknown as Parameters<typeof apply>[0], new Config({}) as Parameters<typeof apply>[1])
  const route = webServer.routes.find(candidate => candidate.path === BRIDGE_BASE_PATH)!
  const res = recorder()
  await route.handler(request({ method: 'GET', path: `${BRIDGE_BASE_PATH}/nope` }), res as never)
  const body = JSON.parse(res.body()) as { ok: boolean; error: { code: string } }
  assert.equal(res.statusCode, 404)
  assert.equal(body.error.code, 'request/malformed')
})

test('the connection fence refuses a caller the Host rejects', async () => {
  const webServer = recordingWebServer()
  const ctx = fakeContext({ webServer, connection: { requestRejection: () => 403 } })
  apply(ctx as unknown as Parameters<typeof apply>[0], new Config({}) as Parameters<typeof apply>[1])
  const route = webServer.routes.find(candidate => candidate.path === QUERY_PATH)!
  const res = recorder()
  await route.handler(
    request({ method: 'POST', path: QUERY_PATH, body: { provider: 'client-assets', op: 'boot-graph' } }),
    res as never,
  )
  assert.equal(res.statusCode, 403)
  assert.equal((JSON.parse(res.body()) as { error: { code: string } }).error.code, 'auth/required')
})

test('requireHostSession:false serves without asking the connection service', async () => {
  const webServer = recordingWebServer()
  let asked = false
  const ctx = fakeContext({
    webServer,
    connection: { requestRejection: () => { asked = true; return 403 } },
  })
  apply(
    ctx as unknown as Parameters<typeof apply>[0],
    new Config({ requireHostSession: false }) as Parameters<typeof apply>[1],
  )
  const route = webServer.routes.find(candidate => candidate.path === MANIFEST_PATH)!
  const res = recorder()
  await route.handler(request({ method: 'GET', path: MANIFEST_PATH }), res as never)
  assert.equal(res.statusCode, 200)
  assert.equal(asked, false)
})
