/**
 * Provider behavior: what each of the four providers answers from a Host-like
 * composition, including the failure it reports when its service is absent.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { rm } from 'node:fs/promises'
import { createClientAssetsProvider } from '../src/providers/client-assets.ts'
import { createClientSlotsProvider } from '../src/providers/client-slots.ts'
import { createPackageInventoryProvider } from '../src/providers/package-inventory.ts'
import { createRpcProvider } from '../src/providers/rpc.ts'
import { BridgeFailure, type WarningSink } from '../src/protocol/provider.ts'
import { createEchoGateway, createFixtureComposition } from './fixtures.ts'

/** A warning sink that records what a provider reported. */
function sink(): WarningSink & { readonly messages: string[] } {
  const messages: string[] = []
  return { messages, warn: (message: string) => { messages.push(message) } }
}

const cleanup: (() => Promise<void>)[] = []
after(async () => {
  for (const dispose of cleanup) await dispose()
})

test('client-assets/boot-graph reports the graph the shell receives', async () => {
  const fixture = await createFixtureComposition()
  cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))
  const provider = createClientAssetsProvider({
    maxModuleBytes: 1024,
    localeTags: ['zh', 'en'],
    clientModules: () => fixture.clientModules,
  })
  const data = await provider.ops['boot-graph']!({}, sink())
  assert.deepEqual(data, {
    rev: 'rev-1',
    release: { version: '0.2.1-rc.2', commit: 'deadbeef' },
    entries: [
      { id: 'sample-plugin', url: 'plugins/??sample-plugin/client.js&rev=abc123', rev: 'abc123', immediately: true },
      { id: 'not-on-disk', url: 'plugins/??not-on-disk/client.js&rev=def456', rev: 'def456' },
    ],
    batches: [{ phase: 'bootstrap', url: 'plugins/??x', rev: 'abc123', entries: ['sample-plugin'] }],
  })
})

test('client-assets/boot-graph reports provider/unavailable without a registry', async () => {
  const provider = createClientAssetsProvider({
    maxModuleBytes: 1024,
    localeTags: ['en'],
    clientModules: () => undefined,
  })
  await assert.rejects(
    async () => provider.ops['boot-graph']!({}, sink()),
    (error: unknown) => error instanceof BridgeFailure && error.code === 'provider/unavailable',
  )
})

test('client-assets/module-source bounds the bytes it returns and digests them', async () => {
  const fixture = await createFixtureComposition()
  cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))
  const full = createClientAssetsProvider({
    maxModuleBytes: 64 * 1024,
    localeTags: ['en'],
    clientModules: () => fixture.clientModules,
  })
  const complete = await full.ops['module-source']!({ id: 'sample-plugin' }, sink()) as {
    bytes: number
    complete: boolean
    sha256: string
    source: string
  }
  assert.equal(complete.complete, true)
  assert.equal(complete.source.length > 0, true)
  assert.match(complete.sha256, /^[0-9a-f]{64}$/)

  const truncated = createClientAssetsProvider({
    maxModuleBytes: 40,
    localeTags: ['en'],
    clientModules: () => fixture.clientModules,
  })
  const head = await truncated.ops['module-source']!({ id: 'sample-plugin' }, sink()) as {
    bytes: number
    complete: boolean
    sha256: string
  }
  assert.equal(head.bytes, 40)
  assert.equal(head.complete, false)
  assert.notEqual(head.sha256, complete.sha256)
})

test('client-assets/module-source refuses an id the graph does not compose', async () => {
  const fixture = await createFixtureComposition()
  cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))
  const provider = createClientAssetsProvider({
    maxModuleBytes: 1024,
    localeTags: ['en'],
    clientModules: () => fixture.clientModules,
  })
  await assert.rejects(
    async () => provider.ops['module-source']!({ id: 'not-on-disk' }, sink()),
    (error: unknown) => error instanceof BridgeFailure && error.code === 'args/invalid',
  )
})

test('client-assets/locale flattens nested groups and honors the requested tag', async () => {
  const fixture = await createFixtureComposition()
  cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))
  const provider = createClientAssetsProvider({
    maxModuleBytes: 1024,
    localeTags: ['zh', 'en'],
    clientModules: () => fixture.clientModules,
  })
  const zh = await provider.ops.locale!({ namespace: 'sample-plugin', locale: 'zh' }, sink())
  assert.deepEqual(zh, {
    namespace: 'sample-plugin',
    locale: 'zh',
    available: ['zh', 'en'],
    dictionary: { 'meta.title': '示例插件', panel: '示例', 'nested.label': '嵌套标签' },
  })
  const fallback = await provider.ops.locale!({ namespace: 'sample-plugin', locale: 'fr' }, sink()) as {
    locale: string
  }
  assert.equal(fallback.locale, 'en')
})

test('package-inventory/bundles passes meta.icon and rows through untouched', async () => {
  const fixture = await createFixtureComposition()
  cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))
  const provider = createPackageInventoryProvider({
    pluginManager: () => fixture.pluginManager,
    pluginInventory: () => fixture.pluginInventory,
  })
  const data = await provider.ops.bundles!({}, sink()) as {
    managementAvailable: boolean
    bundles: Record<string, unknown>[]
  }
  assert.equal(data.managementAvailable, true)
  assert.deepEqual(data.bundles[0], {
    name: 'sample-plugin',
    official: false,
    optional: false,
    removable: true,
    enabled: true,
    installed: true,
    availability: 'profile',
    version: '1.2.3',
    title: 'Sample plugin',
    description: 'A sample',
    icon: 'data:image/png;base64,AAAA',
    rows: [{ rowId: 'sample-row', moduleName: 'sample-plugin', title: 'Row title' }],
  })
  assert.deepEqual(data.bundles[1], {
    name: 'broken-plugin',
    official: true,
    optional: true,
    removable: false,
    enabled: false,
    installed: false,
    availability: 'missing',
    errorCode: 'not-bundle',
    rows: [],
  })
})

test('package-inventory/bundles narrows to one name when asked', async () => {
  const fixture = await createFixtureComposition()
  cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))
  const provider = createPackageInventoryProvider({
    pluginManager: () => fixture.pluginManager,
    pluginInventory: () => fixture.pluginInventory,
  })
  const data = await provider.ops.bundles!({ name: 'broken-plugin' }, sink()) as {
    bundles: { name: string }[]
  }
  assert.deepEqual(data.bundles.map(bundle => bundle.name), ['broken-plugin'])
})

test('package-inventory/rows reports the Loader inventory', async () => {
  const fixture = await createFixtureComposition()
  cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))
  const provider = createPackageInventoryProvider({
    pluginManager: () => fixture.pluginManager,
    pluginInventory: () => fixture.pluginInventory,
  })
  const data = await provider.ops.rows!({}, sink()) as { rows: Record<string, unknown>[] }
  assert.deepEqual(data.rows, [
    {
      entryId: 'sample-plugin',
      moduleName: 'sample-plugin',
      enabled: true,
      fiberPhase: 'active',
      title: 'Sample plugin',
      icon: 'data:image/png;base64,BBBB',
    },
    { entryId: 'silent', moduleName: 'silent', enabled: false, fiberPhase: null },
  ])
})

test('package-inventory/meta-icon resolves a bundle first and a row second', async () => {
  const fixture = await createFixtureComposition()
  cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))
  const provider = createPackageInventoryProvider({
    pluginManager: () => fixture.pluginManager,
    pluginInventory: () => fixture.pluginInventory,
  })
  assert.deepEqual(
    await provider.ops['meta-icon']!({ name: 'sample-plugin' }, sink()),
    { name: 'sample-plugin', icon: 'data:image/png;base64,AAAA' },
  )
  assert.deepEqual(
    await provider.ops['meta-icon']!({ name: 'silent' }, sink()),
    { name: 'silent', icon: null },
  )
  await assert.rejects(
    async () => provider.ops['meta-icon']!({ name: 'absent' }, sink()),
    (error: unknown) => error instanceof BridgeFailure && error.code === 'args/invalid',
  )
})

test('package-inventory reports provider/unavailable with no manager', async () => {
  const provider = createPackageInventoryProvider({
    pluginManager: () => undefined,
    pluginInventory: () => undefined,
  })
  await assert.rejects(
    async () => provider.ops.bundles!({}, sink()),
    (error: unknown) => error instanceof BridgeFailure && error.code === 'provider/unavailable',
  )
  await assert.rejects(
    async () => provider.ops.rows!({}, sink()),
    (error: unknown) => error instanceof BridgeFailure && error.code === 'provider/unavailable',
  )
})

test('client-slots/list captures registrations, labels, order, and package', async () => {
  const fixture = await createFixtureComposition()
  cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))
  const provider = createClientSlotsProvider({
    clientModules: () => fixture.clientModules,
    entryIds: [],
    renderBudget: { maxDepth: 16, maxNodes: 500, maxBytes: 64 * 1024 },
    maxIconSize: 256,
    iconViewBox: '0 0 24 24',
  })
  const data = await provider.ops.list!({}, sink()) as {
    registrations: Record<string, unknown>[]
    emptySlots: string[]
  }
  assert.deepEqual(data.registrations, [
    {
      slot: 'plugins.item',
      id: 'sample-two',
      order: 5,
      label: 'Sample Two',
      package: 'sample-plugin',
      render: { kind: 'component', componentId: 'sample-two' },
    },
    {
      slot: 'plugins.item',
      id: 'sample-one',
      order: 10,
      label: 'Sample One',
      package: 'sample-plugin',
      locale: 'sample',
      render: { kind: 'component', componentId: 'sample-one' },
    },
    {
      slot: 'sample.factory',
      id: 'sample-factory',
      package: 'sample-plugin',
      render: { kind: 'factory', componentId: 'sample-factory' },
    },
  ])
  // `plugins.item` is occupied, so it is not an empty slot; nothing else was
  // injected, so the list is empty.
  assert.deepEqual(data.emptySlots, [])
})

test('client-slots/list narrows to one slot and names the slots it saw', async () => {
  const fixture = await createFixtureComposition()
  cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))
  const provider = createClientSlotsProvider({
    clientModules: () => fixture.clientModules,
    entryIds: [],
    renderBudget: { maxDepth: 16, maxNodes: 500, maxBytes: 64 * 1024 },
    maxIconSize: 256,
    iconViewBox: '0 0 24 24',
  })
  const data = await provider.ops.list!({ slot: 'sample.factory' }, sink()) as {
    slot: string
    registrations: { slot: string; render: { kind: string } }[]
  }
  assert.equal(data.slot, 'sample.factory')
  assert.equal(data.registrations.length, 1)
  assert.equal(data.registrations[0]!.render.kind, 'factory')
})

test('client-slots/describe returns one registration or fails', async () => {
  const fixture = await createFixtureComposition()
  cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))
  const provider = createClientSlotsProvider({
    clientModules: () => fixture.clientModules,
    entryIds: [],
    renderBudget: { maxDepth: 16, maxNodes: 500, maxBytes: 64 * 1024 },
    maxIconSize: 256,
    iconViewBox: '0 0 24 24',
  })
  const described = await provider.ops.describe!({ slot: 'plugins.item', id: 'sample-one' }, sink()) as {
    label: string
  }
  assert.equal(described.label, 'Sample One')
  await assert.rejects(
    async () => provider.ops.describe!({ slot: 'plugins.item', id: 'absent' }, sink()),
    (error: unknown) => error instanceof BridgeFailure && error.code === 'args/invalid',
  )
})

test('client-slots/render-tree serializes the component tree with props', async () => {
  const fixture = await createFixtureComposition()
  cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))
  const provider = createClientSlotsProvider({
    clientModules: () => fixture.clientModules,
    entryIds: [],
    renderBudget: { maxDepth: 16, maxNodes: 500, maxBytes: 64 * 1024 },
    maxIconSize: 256,
    iconViewBox: '0 0 24 24',
  })
  const data = await provider.ops['render-tree']!(
    { componentId: 'sample-one', props: { view: 'summary' } },
    sink(),
  ) as { componentId: string; tree: unknown }
  assert.equal(data.componentId, 'sample-one')
  assert.deepEqual(data.tree, {
    kind: 'element',
    type: 'component:SampleCard',
    key: null,
    props: { view: 'summary' },
    children: [{
      kind: 'element',
      type: 'div',
      key: null,
      props: { className: 'card' },
      children: [
        {
          kind: 'element',
          type: 'component:SampleIcon',
          key: null,
          props: { size: 20 },
          children: [{
            kind: 'element',
            type: 'svg',
            key: null,
            props: { viewBox: '0 0 24 24', width: 20, height: 20 },
            children: [{
              kind: 'element',
              type: 'path',
              key: null,
              props: { d: 'M4 4h16v16H4z', fillRule: 'evenodd' },
              children: [],
            }],
          }],
        },
        {
          kind: 'element',
          type: 'span',
          key: null,
          props: {},
          children: [{ kind: 'text', value: 'summary text' }],
        },
      ],
    }],
  })
})

test('client-slots/render-tree reports an unknown component and its known ids', async () => {
  const fixture = await createFixtureComposition()
  cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))
  const provider = createClientSlotsProvider({
    clientModules: () => fixture.clientModules,
    entryIds: [],
    renderBudget: { maxDepth: 16, maxNodes: 500, maxBytes: 64 * 1024 },
    maxIconSize: 256,
    iconViewBox: '0 0 24 24',
  })
  await assert.rejects(
    async () => provider.ops['render-tree']!({ componentId: 'absent' }, sink()),
    (error: unknown) => {
      if (!(error instanceof BridgeFailure)) return false
      const details = error.details as { known: string[] }
      return error.code === 'args/invalid' && details.known.includes('sample-one')
    },
  )
})

test('client-slots/icon-svg converts artwork into one standalone document', async () => {
  const fixture = await createFixtureComposition()
  cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))
  const provider = createClientSlotsProvider({
    clientModules: () => fixture.clientModules,
    entryIds: [],
    renderBudget: { maxDepth: 16, maxNodes: 500, maxBytes: 64 * 1024 },
    maxIconSize: 256,
    iconViewBox: '0 0 24 24',
  })
  const data = await provider.ops['icon-svg']!({ componentId: 'sample-factory', size: 32 }, sink()) as {
    size: number
    svg: string | null
  }
  assert.equal(data.size, 32)
  assert.equal(
    data.svg,
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="currentColor">'
      + '<path d="M4 4h16v16H4z" fill-rule="evenodd" /></svg>',
  )
})

test('client-slots/icon-svg clamps the requested size to the ceiling', async () => {
  const fixture = await createFixtureComposition()
  cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))
  const provider = createClientSlotsProvider({
    clientModules: () => fixture.clientModules,
    entryIds: [],
    renderBudget: { maxDepth: 16, maxNodes: 500, maxBytes: 64 * 1024 },
    maxIconSize: 64,
    iconViewBox: '0 0 24 24',
  })
  const data = await provider.ops['icon-svg']!({ componentId: 'sample-factory', size: 4096 }, sink()) as {
    size: number
  }
  assert.equal(data.size, 64)
})

test('client-slots reports a bundle that throws as a warning, not a failure', async () => {
  const fixture = await createFixtureComposition({
    bundleId: 'broken-plugin',
    bundleSource: `
window.__ModuleLoader__.load({ id: "broken-plugin", factory: () => ({
  name: "broken-plugin", apply: () => { throw new Error("apply exploded") },
}) });
`,
  })
  cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))
  const warnings = sink()
  const provider = createClientSlotsProvider({
    clientModules: () => fixture.clientModules,
    entryIds: [],
    renderBudget: { maxDepth: 16, maxNodes: 500, maxBytes: 64 * 1024 },
    maxIconSize: 256,
    iconViewBox: '0 0 24 24',
  })
  const data = await provider.ops.list!({}, warnings) as { registrations: unknown[] }
  assert.deepEqual(data.registrations, [])
  assert.ok(warnings.messages.some(message => message.includes('apply exploded')))
})

test('rpc/invoke reaches an allowlisted method and refuses everything else', async () => {
  const gateway = createEchoGateway()
  const provider = createRpcProvider({
    gateway: () => gateway,
    allowlist: [{ namespace: 'settings', method: 'describe' }],
    maxResultBytes: 4096,
    timeoutMs: 1_000,
    peer: undefined,
  })
  const data = await provider.ops.invoke!(
    { namespace: 'settings', method: 'describe', args: { scope: 'all' } },
    sink(),
  )
  assert.deepEqual(data, { namespace: 'settings', method: 'describe', result: { echoed: { scope: 'all' } } })
  assert.deepEqual(gateway.calls, [{ namespace: 'settings', method: 'describe', args: { scope: 'all' } }])

  await assert.rejects(
    async () => provider.ops.invoke!({ namespace: 'settings', method: 'write' }, sink()),
    (error: unknown) => error instanceof BridgeFailure && error.code === 'args/invalid',
  )
})

test('rpc/invoke refuses every call when the allowlist is empty', async () => {
  const provider = createRpcProvider({
    gateway: () => createEchoGateway(),
    allowlist: [],
    maxResultBytes: 4096,
    timeoutMs: 1_000,
    peer: undefined,
  })
  await assert.rejects(
    async () => provider.ops.invoke!({ namespace: 'settings', method: 'describe' }, sink()),
    (error: unknown) => error instanceof BridgeFailure && error.code === 'provider/unavailable',
  )
})

test('rpc/invoke refuses a result above the byte ceiling', async () => {
  const provider = createRpcProvider({
    gateway: () => ({ invoke: async () => ({ payload: 'x'.repeat(2048) }) }),
    allowlist: [{ namespace: 'settings', method: 'describe' }],
    maxResultBytes: 1024,
    timeoutMs: 1_000,
    peer: undefined,
  })
  await assert.rejects(
    async () => provider.ops.invoke!({ namespace: 'settings', method: 'describe' }, sink()),
    (error: unknown) => error instanceof BridgeFailure && error.code === 'budget/exceeded',
  )
})
