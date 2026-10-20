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
import {
  extractStaticRegistrations, resolveStaticLabel, resolveStaticLabelFor, toSlotRegistration,
} from '../src/slots/static-slots.ts'
import { bundleDictionaries } from '../src/slots/bundle-locale.ts'
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

test('an uncarried module is stubbed and recorded instead of failing the bundle', () => {
  // Throwing on the import would discard the bundle's slot declarations along with
  // it, so the request is answered with a stub and named in `missingExternals`.
  const evaluated = evaluateBundleSource('probe', `
window.__ModuleLoader__.load({ id: "probe", factory: (require) => {
  const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
  return { name: "probe", apply: () => { primitives.anything() } };
} });
`)
  assert.equal(evaluated.entryId, 'probe')
  assert.ok(evaluated.missingExternals.includes('@deepseek-ai/dsh-client-ui-primitives'))
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
  const handler = createBridgeHandler({ registry, pluginVersion: () => '1.1.0', dshVersion: () => '1.2.3', assemblyWarnings: [] })
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
        pluginVersion: () => '1.1.0', dshVersion: () => null,
        assemblyWarnings: [],
      }),
      host: '0.0.0.0',
    }),
    /loopback only/,
  )
})

test('static extraction reads registrations without running the bundle', () => {
  const source = `
    var A = class {
      apply(t) {
        t.slots.register({ name: "plugins.item", id: "agent-loop", order: 30 }, X)
        t.slots.register({ name: "settings.section", key: "general", order: 10, locale: "ns" }, Y)
        t.slots.register({ name: "not a slot" }, Z)
      }
    };
  `
  const found = extractStaticRegistrations(source)
  assert.deepEqual(found, [
    { slot: 'plugins.item', id: 'agent-loop', order: 30 },
    { slot: 'settings.section', key: 'general', order: 10, locale: 'ns' },
  ])
})

test('a static registration lands in the native placement its slot names', () => {
  const projected = toSlotRegistration('@deepseek-ai/dsh-client-x', { slot: 'sidebar.panellist', id: 'p' })
  assert.equal(projected.placement, 'drawer')
  assert.equal(projected.package, '@deepseek-ai/dsh-client-x')
})

test('static extraction reads template-literal registrations (minified bundles)', () => {
  // The genui client is minified with backtick strings; reading only quoted
  // strings missed its keyed toolview entirely.
  const source = `
    function apply(e) {
      e.slots.inject(\`tool.call.toolview\`, () => e.slots.register({ name: \`tool.call.toolview\`, key: \`render_ui\` }, X));
      e.slots.inject(\`conversation.input.dock\`, () => e.slots.register({ name: \`conversation.input.dock\`, id: \`genui-panel\`, order: 50 }, Y));
    }
  `
  const found = extractStaticRegistrations(source)
  assert.deepEqual(found, [
    { slot: 'tool.call.toolview', key: 'render_ui' },
    { slot: 'conversation.input.dock', id: 'genui-panel', order: 50 },
  ])
})

test('a keyed registration gets its keyed component identity', () => {
  const projected = toSlotRegistration('@changfenhuang/dsh-genui', {
    slot: 'tool.call.toolview',
    key: 'render_ui',
  })
  assert.equal(projected.render?.componentId, '@changfenhuang/dsh-genui#render_ui')
})

test('static extraction captures literal and thunk labels', () => {
  const source = `
    var A = class {
      apply(t) {
        t.slots.register({ name: "settings.section", id: "subscriptions", order: 92,
                           label: () => t("nav") }, X)
        t.slots.register({ name: "plugins.item", id: "literal", label: "Sample One" }, Y)
        t.slots.register({ name: "plugins.item", id: "text-thunk", label: () => "Sample Two" }, Z)
        t.slots.register({
          name: "plugins.item",
          id: "computed",
          label: () => names[kind],
          inject: () => ({ label: "not this one" })
        }, W)
        t.slots.register({ name: "plugins.item", id: "minified",
                           label: () => (0, x.t)("nav") }, V)
      }
    };
  `
  const found = extractStaticRegistrations(source)
  assert.deepEqual(found, [
    { slot: 'settings.section', id: 'subscriptions', order: 92, labelKey: 'nav' },
    { slot: 'plugins.item', id: 'literal', label: 'Sample One' },
    { slot: 'plugins.item', id: 'text-thunk', label: 'Sample Two' },
    // A computed label and a label inside `inject()` both yield nothing.
    { slot: 'plugins.item', id: 'computed' },
    { slot: 'plugins.item', id: 'minified', labelKey: 'nav' },
  ])
})

test('a thunk label resolves through the bundle inline dictionaries per language', () => {
  const source = `
    window.__ModuleLoader__.load({ id: "probe", factory: (require) => {
      const en = { nav: "Subscriptions", a: "a", b: "b", c: "c", d: "d", e: "e" };
      const zh = { nav: "订阅", a: "a", b: "b", c: "c", d: "d", e: "e" };
      return { apply(ctx) {
        ctx.slots.register({ name: "settings.section", id: "subscriptions",
                             label: () => t("nav") }, X);
      } };
    } });
  `
  const dictionaries = bundleDictionaries(source)
  const [registration] = extractStaticRegistrations(source)
  assert.equal(
    resolveStaticLabelFor(registration!, dictionaries, [], ['zh-Hans-CN', 'zh']),
    '订阅',
  )
  assert.equal(
    resolveStaticLabelFor(registration!, dictionaries, [], ['en-US', 'en']),
    'Subscriptions',
  )
  // Nothing the preference reaches names the key: no invented label.
  assert.equal(
    resolveStaticLabelFor({ slot: 'settings.section', id: 'x', labelKey: 'absent' }, dictionaries, [], ['en']),
    undefined,
  )
})

test('a registration label is read from the package locale dictionary', () => {
  const zh = { items: { 'agent-loop': { title: '智能体运行设置' } }, meta: { title: '包名' } }
  assert.equal(resolveStaticLabel([zh], 'agent-loop'), '智能体运行设置')
  // No entry for the id: the package title is not a stand-in for it.
  assert.equal(resolveStaticLabel([zh], 'unknown-id'), '包名')
  // Nothing at all: no label, rather than a made-up one.
  assert.equal(resolveStaticLabel([{}], 'unknown-id'), undefined)
  assert.equal(resolveStaticLabel([zh], undefined), undefined)
})
