/**
 * Provider behavior: what each of the four providers answers from a Host-like
 * composition, including the failure it reports when its service is absent.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClientAssetsProvider } from '../src/providers/client-assets.ts'
import { createClientSlotsProvider } from '../src/providers/client-slots.ts'
import { createHostSlotsProvider } from '../src/providers/host-slots.ts'
import { createPackageInventoryProvider } from '../src/providers/package-inventory.ts'
import { createRpcProvider } from '../src/providers/rpc.ts'
import { BridgeFailure, type WarningSink } from '../src/protocol/provider.ts'
import { createEchoGateway, createFixtureComposition } from './fixtures.ts'
import { createEventQueue } from '../src/events.ts'
import { createEventsProvider } from '../src/providers/events.ts'
import { createTranspileProvider } from '../src/providers/transpile.ts'

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
      placement: 'plugins.item',
      origin: 'evaluated',
      render: { kind: 'component', componentId: 'sample-two' },
    },
    {
      slot: 'plugins.item',
      id: 'sample-one',
      order: 10,
      label: 'Sample One',
      package: 'sample-plugin',
      placement: 'plugins.item',
      origin: 'evaluated',
      locale: 'sample',
      render: { kind: 'component', componentId: 'sample-one' },
    },
    {
      slot: 'sample.factory',
      id: 'sample-factory',
      package: 'sample-plugin',
      // An unmapped slot stays visible under `other` instead of being dropped.
      placement: 'other',
      origin: 'evaluated',
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

test('client-slots/list falls back to the official roster when the graph composes nothing', async () => {
  // A prebuilt web client composes no entry graph, so plugins.item would be empty
  // even though the page has an Official group. The roster's text comes from the
  // installed packages' own locale files, never from strings inside the bridge.
  const root = await mkdtemp(join(tmpdir(), 'bridge-official-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const modules = join(root, 'node_modules')
  for (const [pkg, title, description] of [
    ['dsh-client-ui-settings-agent-loop', '智能体运行设置', '配置同时执行的工具调用数量上限。'],
    ['dsh-client-ui-settings-shell', '命令执行设置', '配置命令执行超时和输出长度上限。'],
  ] as const) {
    const locale = join(modules, '@deepseek-ai', pkg, 'locale')
    await mkdir(locale, { recursive: true })
    await writeFile(join(locale, 'zh.json'), JSON.stringify({ meta: { title, description } }))
  }

  const provider = createClientSlotsProvider({
    // A prebuilt web client: the service exists, its graph is simply empty.
    clientModules: () => ({
      graph: () => ({ rev: 'empty', entries: [], batches: [] }),
      clientPath: () => undefined,
    }),
    entryIds: [],
    renderBudget: { maxDepth: 16, maxNodes: 500, maxBytes: 64 * 1024 },
    maxIconSize: 256,
    iconViewBox: '0 0 24 24',
    installModules: () => modules,
    localeTags: ['zh'],
  })
  const warningSink = sink()
  const data = await provider.ops.list!({ slot: 'plugins.item' }, warningSink) as {
    registrations: { id?: string; label?: string; order?: number; package?: string }[]
  }

  assert.deepEqual(data.registrations.map(({ id, label, order }) => ({ id, label, order })), [
    { id: 'agent-loop', label: '智能体运行设置', order: 30 },
    { id: 'shell', label: '命令执行设置', order: 40 },
  ])
  // The two packages that are not installed contribute nothing.
  assert.ok(warningSink.messages.some(message => message.includes('subagent')))

  const shell = data.registrations.find(registration => registration.id === 'shell')!
  assert.equal(shell.package, '@deepseek-ai/dsh-client-ui-settings-shell')

  // Artwork is available by the same id the registration carries.
  const icon = await provider.ops['icon-svg']!({ componentId: 'shell', size: 36 }, sink()) as { svg: string }
  assert.match(icon.svg, /^<svg viewBox="0 0 36 36"/)
})

test('client-slots/list prefers real registrations over the official roster', async () => {
  const fixture = await createFixtureComposition()
  cleanup.push(() => rm(fixture.root, { recursive: true, force: true }))
  const provider = createClientSlotsProvider({
    clientModules: () => fixture.clientModules,
    entryIds: [],
    renderBudget: { maxDepth: 16, maxNodes: 500, maxBytes: 64 * 1024 },
    maxIconSize: 256,
    iconViewBox: '0 0 24 24',
    installModules: () => fixture.root,
    localeTags: ['zh'],
  })
  const data = await provider.ops.list!({ slot: 'plugins.item' }, sink()) as {
    registrations: { id?: string }[]
  }
  assert.deepEqual(data.registrations.map(registration => registration.id), ['sample-two', 'sample-one'])
})

test('host-slots lists plugin-declared settings pages with their own titles', async () => {
  const provider = createHostSlotsProvider({
    settings: () => ({
      // Two active namespaces; the second has no Loader row meta, so it falls back
      // to the namespace instead of disappearing.
      describe: () => [{ ns: 'agent-loop' }, { ns: 'orphan-ns' }],
    }),
    pluginInventory: () => ({
      list: async () => ({
        entries: [
          {
            entryId: 'agent-loop',
            moduleName: '@deepseek-ai/dsh-client-ui-settings-agent-loop',
            enabled: true,
            meta: { title: { zh: '智能体循环', en: 'Agent loop' }, description: { zh: '控制派发方式' } },
          },
        ],
      }),
    }),
    localeTags: ['zh'],
  })
  const data = await provider.ops.list!({}, sink()) as {
    surfaces: { slot: string; id: string; title: string; description?: string; module?: string }[]
  }
  assert.deepEqual(data.surfaces, [
    {
      slot: 'settings.page',
      id: 'agent-loop',
      title: '智能体循环',
      description: '控制派发方式',
      module: '@deepseek-ai/dsh-client-ui-settings-agent-loop',
    },
    { slot: 'settings.page', id: 'orphan-ns', title: 'orphan-ns' },
  ])
})

test('host-slots reports no surfaces when the composition has no settings service', async () => {
  const provider = createHostSlotsProvider({ settings: () => undefined, pluginInventory: () => undefined })
  const data = await provider.ops.list!({}, sink()) as { surfaces: unknown[] }
  assert.deepEqual(data.surfaces, [])
})

test('events drain delivers each toast once and keeps only the newest few', async () => {
  const queue = createEventQueue()
  for (let index = 0; index < 20; index += 1) queue.push('toast', `m${index}`)
  const provider = createEventsProvider({ drain: () => queue.drain() })
  const first = await provider.ops.pending!({}, sink()) as { events: { text: string; seq: number }[] }
  // The cap keeps the queue bounded: a stale toast is not worth replaying.
  assert.equal(first.events.length, 16)
  assert.equal(first.events.at(-1)!.text, 'm19')
  const second = await provider.ops.pending!({}, sink()) as { events: unknown[] }
  assert.deepEqual(second.events, [])
})

test('transpile/component-tree builds the tree of a bundle on disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-transpile-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'sample-plugin', 'lib')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'client.js'), `(() => { window.__ModuleLoader__.load({ id: 'sample-plugin#lib/client.js', factory: (require) => {
var jsx = require('react/jsx-runtime').jsx, jsxs = require('react/jsx-runtime').jsxs;
function SampleCard({ title }) {
  return jsxs('div', { className: 'card', children: [
    jsx('h2', { children: title }),
    jsx('button', { onClick: 'login', children: 'Log in' }),
  ] });
}
return { apply(ctx) {
  ctx.effect(() => ctx.slots.register({ name: 'settings.section', id: 'sample-page', order: 3 }, SampleCard));
} };
} }); })();`)
  const provider = createTranspileProvider({ clientRoots: () => [root] })
  const data = await provider.ops['component-tree']!(
    { componentId: 'sample-plugin#sample-page', props: { title: 'Subscription' } },
    sink(),
  ) as { componentId: string; tree: Record<string, unknown>; truncated: boolean }
  assert.equal(data.componentId, 'sample-plugin#sample-page')
  assert.equal(data.truncated, false)
  assert.partialDeepStrictEqual(data.tree, {
    kind: 'element',
    type: 'div',
    props: { className: 'card' },
    children: [
      { kind: 'element', type: 'h2', children: [{ kind: 'text', value: 'Subscription' }] },
      { kind: 'element', type: 'button', children: [{ kind: 'text', value: 'Log in' }] },
    ],
  })
})

test('transpile/component-tree fails with its known ids for an unknown component', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-transpile-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'sample-plugin', 'lib')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'client.js'), `(() => { window.__ModuleLoader__.load({ id: 'x', factory: () => ({ apply(ctx) {
  ctx.slots.register({ name: 'settings.section', id: 'known-page' }, () => null);
} }) }); })();`)
  const provider = createTranspileProvider({ clientRoots: () => [root] })
  await assert.rejects(
    async () => provider.ops['component-tree']!({ componentId: 'sample-plugin#absent' }, sink()),
    (error: unknown) => error instanceof BridgeFailure && error.code === 'args/invalid',
  )
  await assert.rejects(
    async () => provider.ops['component-tree']!({ componentId: 'no-package#absent' }, sink()),
    (error: unknown) => error instanceof BridgeFailure && error.code === 'args/invalid',
  )
})

test('client-slots/dispatch re-broadcasts the event and queues a refresh', async () => {
  const queue = createEventQueue()
  const emitted: { name: string; payload: unknown }[] = []
  const provider = createClientSlotsProvider({
    clientModules: () => undefined,
    entryIds: [],
    renderBudget: { maxDepth: 16, maxNodes: 500, maxBytes: 64 * 1024 },
    maxIconSize: 256,
    iconViewBox: '0 0 24 24',
    notify: (kind, text) => { queue.push(kind, text) },
    emit: (name, payload) => { emitted.push({ name, payload }) },
  })
  const answer = await provider.ops.dispatch!(
    { componentId: 'sample-plugin#sample-page', event: 'press', payload: { id: 'login' } },
    sink(),
  ) as { ok: boolean }
  assert.equal(answer.ok, true)
  assert.deepEqual(emitted, [{ name: 'ui/sample-plugin#sample-page/press', payload: { id: 'login' } }])
  const pending = queue.drain()
  assert.equal(pending.length, 1)
  assert.equal(pending[0]!.kind, 'client/refresh')
  assert.equal(pending[0]!.text, 'sample-plugin#sample-page')
  await assert.rejects(
    async () => provider.ops.dispatch!({ componentId: 'x#y', event: 'explode' }, sink()),
    (error: unknown) => error instanceof BridgeFailure && error.code === 'args/invalid',
  )
})
