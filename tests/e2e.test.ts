/**
 * End-to-end check: a Host-like composition, the real handler over a real
 * socket, and the exact requests a native client sends.
 *
 * This is the one test that exercises the whole path a phone takes: manifest
 * negotiation, then each provider query, with the answers shaped as the client
 * decodes them. Everything below the socket is the shipped code.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { rm } from 'node:fs/promises'
import { createBridgeHandler } from '../src/handler.ts'
import { ProviderRegistry } from '../src/protocol/provider.ts'
import { MANIFEST_PATH, QUERY_PATH } from '../src/protocol/types.ts'
import { startStandalone } from '../src/standalone.ts'
import { createClientAssetsProvider } from '../src/providers/client-assets.ts'
import { createClientSlotsProvider } from '../src/providers/client-slots.ts'
import { createPackageInventoryProvider } from '../src/providers/package-inventory.ts'
import { createRpcProvider } from '../src/providers/rpc.ts'
import { createEchoGateway, createFixtureComposition } from './fixtures.ts'

const cleanup: (() => Promise<void>)[] = []
after(async () => {
  for (const dispose of cleanup) await dispose()
})

test('a phone client can negotiate and read the plugin catalog end to end', async () => {
  const fixture = await createFixtureComposition()
  cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))

  const registry = new ProviderRegistry()
  registry.add(createClientAssetsProvider({
    maxModuleBytes: 64 * 1024,
    localeTags: ['zh', 'en'],
    clientModules: () => fixture.clientModules,
  }))
  registry.add(createClientSlotsProvider({
    clientModules: () => fixture.clientModules,
    entryIds: [],
    renderBudget: { maxDepth: 16, maxNodes: 500, maxBytes: 64 * 1024 },
    maxIconSize: 256,
    iconViewBox: '0 0 24 24',
    executeBundles: true,
  }))
  registry.add(createPackageInventoryProvider({
    pluginManager: () => fixture.pluginManager,
    pluginInventory: () => fixture.pluginInventory,
  }))
  const gateway = createEchoGateway()
  registry.add(createRpcProvider({
    gateway: () => gateway,
    allowlist: [{ namespace: 'settings', method: 'describe' }],
    maxResultBytes: 4096,
    timeoutMs: 1_000,
    peer: undefined,
  }))

  const server = await startStandalone({
    handler: createBridgeHandler({ registry, pluginVersion: () => '1.1.0', dshVersion: () => '0.2.1-rc.2', assemblyWarnings: [] }),
  })
  cleanup.push(() => server.close())

  /** One query, decoded the way the Kotlin client decodes it. */
  const query = async (provider: string, op: string, args?: Record<string, unknown>): Promise<unknown> => {
    const response = await fetch(`${server.origin}${QUERY_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider, op, ...(args === undefined ? {} : { args }) }),
    })
    const body = await response.json() as { ok: boolean; data?: unknown; warnings?: string[] }
    assert.equal(body.ok, true, `query ${provider}/${op} failed`)
    return body.data
  }

  // 1. Negotiate.
  const manifest = await (await fetch(`${server.origin}${MANIFEST_PATH}`)).json() as {
    providers: { id: string; capabilities: string[] }[]
  }
  assert.deepEqual(manifest.providers.map(provider => provider.id), [
    'client-assets', 'client-slots', 'package-inventory', 'rpc',
  ])

  // 2. The boot graph, as the shell receives it.
  const graph = await query('client-assets', 'boot-graph') as {
    entries: { id: string; rev: string }[]
    release: { version: string }
  }
  assert.equal(graph.entries[0]!.id, 'sample-plugin')
  assert.equal(graph.release.version, '0.2.1-rc.2')

  // 3. The plugin categories, with official labels and artwork.
  const list = await query('client-slots', 'list', { slot: 'plugins.item' }) as {
    registrations: { id: string; label: string; order: number; render: { componentId: string } }[]
  }
  assert.deepEqual(list.registrations.map(registration => registration.id), ['sample-two', 'sample-one'])
  assert.deepEqual(list.registrations.map(registration => registration.label), ['Sample Two', 'Sample One'])
  const icon = await query('client-slots', 'icon-svg', {
    componentId: list.registrations[1]!.render.componentId,
    size: 40,
  }) as { svg: string | null; size: number }
  assert.equal(icon.size, 40)
  assert.match(icon.svg!, /^<svg /)
  assert.match(icon.svg!, /<path /)

  // 4. The element tree a renderer would turn into native widgets.
  const tree = await query('client-slots', 'render-tree', {
    componentId: 'sample-one',
    props: { view: 'summary' },
  }) as { tree: { type: string; children: { type: string }[] } }
  assert.equal(tree.tree.type, 'component:SampleCard')

  // 5. The Host's own bundle list, including third-party icons.
  const inventory = await query('package-inventory', 'bundles') as {
    bundles: { name: string; icon?: string; version?: string }[]
  }
  assert.equal(inventory.bundles[0]!.name, 'sample-plugin')
  assert.equal(inventory.bundles[0]!.version, '1.2.3')
  assert.equal(inventory.bundles[0]!.icon, 'data:image/png;base64,AAAA')

  // 6. A locale dictionary for the same package.
  const locale = await query('client-assets', 'locale', { namespace: 'sample-plugin', locale: 'zh' }) as {
    dictionary: Record<string, string>
  }
  assert.equal(locale.dictionary['meta.title'], '示例插件')

  // 7. One allowlisted remote call.
  const invoked = await query('rpc', 'invoke', {
    namespace: 'settings',
    method: 'describe',
    args: { scope: 'all' },
  }) as { result: unknown }
  assert.deepEqual(invoked.result, { echoed: { scope: 'all' } })

  // 8. A method outside the allowlist is refused, not silently attempted.
  const refused = await fetch(`${server.origin}${QUERY_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'rpc', op: 'invoke', args: { namespace: 'settings', method: 'write' } }),
  })
  const refusedBody = await refused.json() as { ok: boolean; error: { code: string } }
  assert.equal(refusedBody.ok, false)
  assert.equal(refusedBody.error.code, 'args/invalid')
  assert.deepEqual(gateway.calls.map(call => call.method), ['describe'])
})
