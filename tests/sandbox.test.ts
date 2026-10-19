/**
 * VM isolation and the standalone carrier.
 *
 * The isolation tests are the security claim: a client bundle runs with no DOM,
 * no timers, no network, and no dynamic import, so evaluating an official bundle
 * cannot reach the Host. The carrier test proves the same handler answers over a
 * real socket.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBridgeHandler } from '../src/handler.ts'
import { ProviderRegistry } from '../src/protocol/provider.ts'
import { MANIFEST_PATH, QUERY_PATH } from '../src/protocol/types.ts'
import { startStandalone } from '../src/standalone.ts'
import { evaluateBundleSource, BundleEvaluationError } from '../src/slots/evaluate.ts'
import { createReactStub } from '../src/slots/react-stub.ts'

/**
 * Evaluate a bundle source body, wrapping it in the loader call the real build
 * emits.
 * @param body - the factory body.
 * @returns the captured registrations.
 */
function evaluate(body: string): ReturnType<typeof evaluateBundleSource> {
  return evaluateBundleSource('probe', `
window.__ModuleLoader__.load({ id: "probe", factory: (require) => {
  const React = require("react");
  const module = { exports: {} };
  const exports = module.exports;
  ${body}
  return module.exports;
} });
`)
}

test('the VM exposes no document, window.fetch, timers, or dynamic import', () => {
  const bundle = evaluate(`
    const seen = {
      document: typeof document,
      fetch: typeof fetch,
      setTimeout: typeof setTimeout,
      setInterval: typeof setInterval,
      XMLHttpRequest: typeof XMLHttpRequest,
      WebSocket: typeof WebSocket,
      process: typeof process,
      require: typeof require,
    };
    exports.name = "probe";
    exports.apply = (ctx) => {
      ctx.slots.register({ name: "probe.slot", id: "probe" }, () => seen);
    };
  `)
  assert.equal(bundle.registrations.length, 1)
})

test('a bundle that reads document fails loudly instead of silently', () => {
  assert.throws(
    () => evaluate(`
      exports.name = "probe";
      exports.apply = (ctx) => {
        document.createElement("div");
        ctx.slots.register({ name: "probe.slot" }, () => null);
      };
    `),
    (error: unknown) => error instanceof BundleEvaluationError
      && error.message.includes('apply threw'),
  )
})

test('a bundle that schedules a timer fails loudly', () => {
  assert.throws(
    () => evaluate(`
      exports.name = "probe";
      exports.apply = (ctx) => {
        setTimeout(() => {}, 10);
        ctx.slots.register({ name: "probe.slot" }, () => null);
      };
    `),
    (error: unknown) => error instanceof BundleEvaluationError,
  )
})

test('a bundle that reaches the filesystem through process fails loudly', () => {
  assert.throws(
    () => evaluate(`
      exports.name = "probe";
      exports.apply = (ctx) => {
        process.mainModule.require("node:fs");
        ctx.slots.register({ name: "probe.slot" }, () => null);
      };
    `),
    (error: unknown) => error instanceof BundleEvaluationError,
  )
})

test('a bundle that registers no factory is reported, not guessed at', () => {
  assert.throws(
    () => evaluateBundleSource('probe', 'const x = 1;'),
    (error: unknown) => error instanceof BundleEvaluationError
      && error.message.includes('registered no module factory'),
  )
})

test('a bundle that exports no apply is reported', () => {
  assert.throws(
    () => evaluateBundleSource('probe', 'window.__ModuleLoader__.load({ id: "probe", factory: () => ({ name: "probe" }) })'),
    (error: unknown) => error instanceof BundleEvaluationError
      && error.message.includes('exports no apply function'),
  )
})

test('requesting a module the VM does not carry names it in the failure', () => {
  assert.throws(
    () => evaluateBundleSource('probe', `
window.__ModuleLoader__.load({ id: "probe", factory: (require) => {
  require("@deepseek-ai/dsh-client-ui-primitives");
  return { name: "probe", apply: () => {} };
} });
`),
    (error: unknown) => error instanceof BundleEvaluationError
      && error.message.includes('@deepseek-ai/dsh-client-ui-primitives'),
  )
})

test('the React stub resolves hooks once and numbers ids deterministically', () => {
  const stub = createReactStub()
  const [state] = stub.useState(7)
  assert.equal(state, 7)
  const [lazy] = stub.useState(() => 'computed')
  assert.equal(lazy, 'computed')
  assert.equal(stub.useMemo(() => 'memoized'), 'memoized')
  assert.equal(stub.useId(), 'dsh-stub-1')
  assert.equal(stub.useId(), 'dsh-stub-2')
  assert.equal(stub.isValidElement(stub.createElement('div', null, 'x')), true)
  assert.equal(stub.isValidElement({}), false)
  assert.equal(stub.Children.count(['a', ['b', 'c'], null]), 3)
})

test('the standalone carrier serves the same handler over a socket', async () => {
  const registry = new ProviderRegistry()
  registry.add({ id: 'demo', version: 3, readOnly: true, ops: { ping: () => 'pong' } })
  const handler = createBridgeHandler({ registry, dshVersion: () => '1.2.3', assemblyWarnings: [] })
  const server = await startStandalone({ handler })
  try {
    const manifest = await fetch(`${server.origin}${MANIFEST_PATH}`)
    assert.equal(manifest.status, 200)
    const manifestBody = await manifest.json() as { bridgeVersion: string; dshVersion: string }
    assert.equal(manifestBody.bridgeVersion, '1.0.0')
    assert.equal(manifestBody.dshVersion, '1.2.3')

    const query = await fetch(`${server.origin}${QUERY_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'demo', op: 'ping' }),
    })
    assert.equal(query.status, 200)
    assert.deepEqual(await query.json(), {
      ok: true,
      provider: 'demo',
      version: 3,
      data: 'pong',
      warnings: [],
    })
  } finally {
    await server.close()
  }
})

test('the standalone carrier refuses a non-loopback bind', async () => {
  await assert.rejects(
    async () => startStandalone({
      handler: createBridgeHandler({
        registry: new ProviderRegistry(),
        dshVersion: () => null,
        assemblyWarnings: [],
      }),
      host: '0.0.0.0',
    }),
    /loopback only/,
  )
})
