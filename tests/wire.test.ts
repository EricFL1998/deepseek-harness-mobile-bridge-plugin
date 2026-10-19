/**
 * Wire-level contract tests: the two routes, their validation, and the failure
 * codes a client switches on.
 *
 * These exercise the handler directly rather than over a socket, so the wire
 * contract is checked without a carrier, and the standalone carrier is covered
 * separately.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import { createBridgeHandler } from '../src/handler.ts'
import { ProviderRegistry } from '../src/protocol/provider.ts'
import { MANIFEST_PATH, QUERY_PATH, BRIDGE_BASE_PATH } from '../src/protocol/types.ts'

/** Build a request stream the handler can read. */
function request(options: {
  readonly method: string
  readonly path: string
  readonly body?: unknown
  readonly contentType?: string
}): IncomingMessage {
  const text = options.body === undefined ? '' : JSON.stringify(options.body)
  const stream = Readable.from(text === '' ? [] : [Buffer.from(text, 'utf8')]) as unknown as IncomingMessage
  stream.method = options.method
  stream.url = options.path
  stream.headers = {
    ...(options.body === undefined ? {} : { 'content-type': options.contentType ?? 'application/json' }),
  }
  return stream
}

/** A registry with one trivial provider. */
function registryWith(ops: Record<string, (args: Record<string, unknown>) => unknown>): ProviderRegistry {
  const registry = new ProviderRegistry()
  registry.add({ id: 'demo', version: 7, readOnly: true, ops })
  return registry
}

test('manifest advertises every provider with its version and capabilities', async () => {
  const handler = createBridgeHandler({
    registry: registryWith({ list: () => [], other: () => 1 }),
    pluginVersion: () => '1.1.0', dshVersion: () => '9.9.9',
    assemblyWarnings: [],
  })
  const reply = await handler(request({ method: 'GET', path: MANIFEST_PATH }))
  assert.equal(reply.status, 200)
  const body = reply.body as {
    bridgeVersion: string
    dshVersion: string
    providers: { id: string; version: number; capabilities: string[]; readOnly?: boolean }[]
  }
  assert.equal(body.bridgeVersion, '1.0.0')
  assert.equal(body.dshVersion, '9.9.9')
  assert.deepEqual(body.providers, [
    { id: 'demo', version: 7, capabilities: ['list', 'other'], readOnly: true },
  ])
})

test('manifest reports a null release label when the Host publishes none', async () => {
  const handler = createBridgeHandler({
    registry: registryWith({ list: () => [] }),
    pluginVersion: () => '1.1.0', dshVersion: () => null,
    assemblyWarnings: ['no client module registry'],
  })
  const reply = await handler(request({ method: 'GET', path: MANIFEST_PATH }))
  const body = reply.body as { dshVersion: string | null; warnings?: string[] }
  assert.equal(body.dshVersion, null)
  assert.deepEqual(body.warnings, ['no client module registry'])
})

test('query answers ok:true with the provider version and empty warnings', async () => {
  const handler = createBridgeHandler({
    registry: registryWith({ list: () => [{ a: 1 }] }),
    pluginVersion: () => '1.1.0', dshVersion: () => '1.0.0',
    assemblyWarnings: [],
  })
  const reply = await handler(request({
    method: 'POST',
    path: QUERY_PATH,
    body: { provider: 'demo', op: 'list' },
  }))
  assert.equal(reply.status, 200)
  assert.deepEqual(reply.body, {
    ok: true,
    provider: 'demo',
    version: 7,
    data: [{ a: 1 }],
    warnings: [],
  })
})

test('query surfaces provider warnings beside its data', async () => {
  const handler = createBridgeHandler({
    registry: registryWith({
      list: (_args, warnings) => {
        warnings.warn('a note')
        return 'payload'
      },
    }),
    pluginVersion: () => '1.1.0', dshVersion: () => null,
    assemblyWarnings: [],
  })
  const reply = await handler(request({ method: 'POST', path: QUERY_PATH, body: { provider: 'demo', op: 'list' } }))
  assert.deepEqual(reply.body, {
    ok: true,
    provider: 'demo',
    version: 7,
    data: 'payload',
    warnings: ['a note'],
  })
})

test('unknown provider fails with provider/unknown and no data', async () => {
  const handler = createBridgeHandler({ registry: registryWith({}), pluginVersion: () => '1.1.0', dshVersion: () => null, assemblyWarnings: [] })
  const reply = await handler(request({ method: 'POST', path: QUERY_PATH, body: { provider: 'nope', op: 'list' } }))
  assert.deepEqual(reply.body, {
    ok: false,
    error: { code: 'provider/unknown', message: 'unknown provider: nope' },
  })
})

test('unknown op fails with op/unknown and lists the real capabilities', async () => {
  const handler = createBridgeHandler({
    registry: registryWith({ list: () => [] }),
    pluginVersion: () => '1.1.0', dshVersion: () => null,
    assemblyWarnings: [],
  })
  const reply = await handler(request({ method: 'POST', path: QUERY_PATH, body: { provider: 'demo', op: 'nope' } }))
  assert.deepEqual(reply.body, {
    ok: false,
    error: {
      code: 'op/unknown',
      message: 'provider demo has no operation nope',
      details: { capabilities: ['list'] },
    },
  })
})

test('a non-JSON content type is refused before the body is read', async () => {
  const handler = createBridgeHandler({ registry: registryWith({}), pluginVersion: () => '1.1.0', dshVersion: () => null, assemblyWarnings: [] })
  const reply = await handler(request({
    method: 'POST',
    path: QUERY_PATH,
    body: { provider: 'demo', op: 'list' },
    contentType: 'text/plain',
  }))
  assert.deepEqual(reply.body, {
    ok: false,
    error: { code: 'request/malformed', message: 'content-type must be application/json' },
  })
})

test('a malformed JSON body fails with request/malformed', async () => {
  const handler = createBridgeHandler({ registry: registryWith({}), pluginVersion: () => '1.1.0', dshVersion: () => null, assemblyWarnings: [] })
  const stream = Readable.from([Buffer.from('{not json', 'utf8')]) as unknown as IncomingMessage
  stream.method = 'POST'
  stream.url = QUERY_PATH
  stream.headers = { 'content-type': 'application/json' }
  const reply = await handler(stream)
  assert.deepEqual(reply.body, {
    ok: false,
    error: { code: 'request/malformed', message: 'request body is not JSON' },
  })
})

test('a body missing provider or op fails with request/malformed', async () => {
  const handler = createBridgeHandler({ registry: registryWith({}), pluginVersion: () => '1.1.0', dshVersion: () => null, assemblyWarnings: [] })
  const noProvider = await handler(request({ method: 'POST', path: QUERY_PATH, body: { op: 'list' } }))
  assert.deepEqual(noProvider.body, {
    ok: false,
    error: { code: 'request/malformed', message: 'provider must be a non-empty string' },
  })
  const noOp = await handler(request({ method: 'POST', path: QUERY_PATH, body: { provider: 'demo' } }))
  assert.deepEqual(noOp.body, {
    ok: false,
    error: { code: 'request/malformed', message: 'op must be a non-empty string' },
  })
})

test('args must be an object when present', async () => {
  const handler = createBridgeHandler({ registry: registryWith({}), pluginVersion: () => '1.1.0', dshVersion: () => null, assemblyWarnings: [] })
  const reply = await handler(request({
    method: 'POST',
    path: QUERY_PATH,
    body: { provider: 'demo', op: 'list', args: [1, 2] },
  }))
  assert.deepEqual(reply.body, {
    ok: false,
    error: { code: 'request/malformed', message: 'args must be an object when present' },
  })
})

test('an oversized body is refused with request/malformed', async () => {
  const handler = createBridgeHandler({ registry: registryWith({}), pluginVersion: () => '1.1.0', dshVersion: () => null, assemblyWarnings: [] })
  const huge = 'x'.repeat(300 * 1024)
  const stream = Readable.from([Buffer.from(JSON.stringify({ provider: 'demo', op: 'list', args: { huge } }), 'utf8')]) as unknown as IncomingMessage
  stream.method = 'POST'
  stream.url = QUERY_PATH
  stream.headers = { 'content-type': 'application/json' }
  const reply = await handler(stream)
  const body = reply.body as { ok: false; error: { code: string; message: string } }
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'request/malformed')
  assert.match(body.error.message, /exceeds/)
})

test('the wrong method on a route is 405 with an allow header', async () => {
  const handler = createBridgeHandler({ registry: registryWith({}), pluginVersion: () => '1.1.0', dshVersion: () => null, assemblyWarnings: [] })
  const manifestPost = await handler(request({ method: 'POST', path: MANIFEST_PATH, body: {} }))
  assert.equal(manifestPost.status, 405)
  assert.deepEqual(manifestPost.headers, { allow: 'GET' })
  const queryGet = await handler(request({ method: 'GET', path: QUERY_PATH }))
  assert.equal(queryGet.status, 405)
  assert.deepEqual(queryGet.headers, { allow: 'POST' })
})

test('an unknown path is 404 and names it', async () => {
  const handler = createBridgeHandler({ registry: registryWith({}), pluginVersion: () => '1.1.0', dshVersion: () => null, assemblyWarnings: [] })
  const reply = await handler(request({ method: 'GET', path: `${BRIDGE_BASE_PATH}/nope` }))
  assert.equal(reply.status, 404)
  assert.deepEqual(reply.body, {
    ok: false,
    error: { code: 'request/malformed', message: `no bridge route at ${BRIDGE_BASE_PATH}/nope` },
  })
})

test('the admission policy runs before any provider is touched', async () => {
  let touched = false
  const handler = createBridgeHandler({
    registry: registryWith({ list: () => { touched = true; return [] } }),
    pluginVersion: () => '1.1.0', dshVersion: () => null,
    assemblyWarnings: [],
    admit: () => 401,
  })
  const reply = await handler(request({ method: 'POST', path: QUERY_PATH, body: { provider: 'demo', op: 'list' } }))
  assert.equal(reply.status, 401)
  assert.equal(touched, false)
})

test('an unprojectable value is replaced rather than breaking the response', async () => {
  const cyclic: Record<string, unknown> = { name: 'loop' }
  cyclic.self = cyclic
  const handler = createBridgeHandler({
    registry: registryWith({ list: () => ({ ok: cyclic, fn: () => 1, big: 10n }) }),
    pluginVersion: () => '1.1.0', dshVersion: () => null,
    assemblyWarnings: [],
  })
  const reply = await handler(request({ method: 'POST', path: QUERY_PATH, body: { provider: 'demo', op: 'list' } }))
  const body = reply.body as { ok: true; data: Record<string, unknown>; warnings: string[] }
  // A cycle and a function are dropped by key; a bigint becomes its decimal
  // text, so the value survives a JSON round trip without inventing precision.
  assert.deepEqual(body.data, { ok: { name: 'loop' }, big: '10' })
  assert.equal(body.warnings.length, 3)
  assert.ok(body.warnings.some(warning => warning.includes('cycle')))
  assert.ok(body.warnings.some(warning => warning.includes('fn')))
  assert.ok(body.warnings.some(warning => warning.includes('coerced data.big to text')))
})
