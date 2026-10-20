/** Shared fixtures: a fake Host composition the bridge reads in tests. */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClientModulesFace, HostBootGraph } from '../src/providers/client-assets.ts'
import type { PluginInventoryFace, PluginManagerFace } from '../src/providers/package-inventory.ts'

/** One client bundle written to disk, with the graph row that names it. */
export interface FixtureBundle {
  readonly id: string
  readonly rev: string
  readonly path: string
  readonly source: string
}

/** A temporary Host-like tree plus the service faces that read it. */
export interface FixtureComposition {
  readonly root: string
  readonly clientModules: ClientModulesFace
  readonly pluginManager: PluginManagerFace
  readonly pluginInventory: PluginInventoryFace
  readonly bundles: readonly FixtureBundle[]
  readonly graph: HostBootGraph
}

/**
 * A client bundle that registers two `plugins.item` entries and one factory.
 * Written the way the real build emits it: one `__ModuleLoader__.load` call
 * whose factory returns `{ name, inject, apply }`.
 */
export const SAMPLE_BUNDLE_SOURCE = `
window.__ModuleLoader__.load({
  id: "sample-plugin",
  factory: (require) => {
    const React = require("react");
    const module = { exports: {} };
    const exports = module.exports;

    function SampleIcon(props) {
      return React.createElement("svg", { viewBox: "0 0 24 24", width: props.size, height: props.size },
        React.createElement("path", { d: "M4 4h16v16H4z", fillRule: "evenodd" }));
    }

    function SampleCard(props) {
      return React.createElement("div", { className: "card" },
        React.createElement(SampleIcon, { size: 20 }),
        React.createElement("span", null, props.view === "summary" ? "summary text" : "page body"));
    }

    exports.name = "sample-plugin";
    exports.inject = [];
    exports.apply = function apply(ctx) {
      ctx.slots.inject("plugins.item", () => ctx.slots.register({
        name: "plugins.item",
        id: "sample-one",
        order: 10,
        label: "Sample One",
        locale: "sample",
      }, SampleCard));
      ctx.slots.register({
        name: "plugins.item",
        id: "sample-two",
        order: 5,
        label: () => "Sample Two",
      }, SampleCard);
      ctx.slots.registerFactory({
        name: "sample.factory",
        id: "sample-factory",
      }, SampleIcon);
    };
    return module.exports;
  }
});
`

/**
 * A bundle whose apply throws, so the evaluator's failure path is exercised.
 */
export const BROKEN_BUNDLE_SOURCE = `
window.__ModuleLoader__.load({
  id: "broken-plugin",
  factory: () => {
    return { name: "broken-plugin", apply: () => { throw new Error("apply exploded") } };
  }
});
`

/**
 * Build a temporary composition with one readable client bundle.
 * @param options - which bundle sources to write.
 * @returns the tree and the service faces over it.
 */
export async function createFixtureComposition(options?: {
  readonly bundleSource?: string
  readonly bundleId?: string
}): Promise<FixtureComposition> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-'))
  const id = options?.bundleId ?? 'sample-plugin'
  const source = options?.bundleSource ?? SAMPLE_BUNDLE_SOURCE
  const packageRoot = join(root, 'node_modules', id)
  await mkdir(join(packageRoot, 'lib'), { recursive: true })
  await mkdir(join(packageRoot, 'locale'), { recursive: true })
  const bundlePath = join(packageRoot, 'lib', 'client.js')
  await writeFile(bundlePath, source, 'utf8')
  await writeFile(join(packageRoot, 'locale', 'en.json'), JSON.stringify({
    meta: { title: 'Sample plugin' },
    panel: 'Sample',
    nested: { label: 'Nested label' },
  }), 'utf8')
  await writeFile(join(packageRoot, 'locale', 'zh.json'), JSON.stringify({
    meta: { title: '示例插件' },
    panel: '示例',
    nested: { label: '嵌套标签' },
  }), 'utf8')

  const graph: HostBootGraph = {
    rev: 'rev-1',
    release: { version: '0.2.1-rc.2', commit: 'deadbeef' },
    entries: [
      { id, url: `plugins/??${id}/client.js&rev=abc123`, rev: 'abc123', immediately: true },
      { id: 'not-on-disk', url: 'plugins/??not-on-disk/client.js&rev=def456', rev: 'def456' },
    ],
    batches: [
      { phase: 'bootstrap', url: 'plugins/??x', rev: 'abc123', entries: [id] },
    ],
  }

  const clientModules: ClientModulesFace = {
    graph: () => graph,
    clientPath: entryId => (entryId === id ? bundlePath : undefined),
  }

  const pluginManager: PluginManagerFace = {
    listBundles: async () => [
      {
        name: 'sample-plugin',
        official: false,
        optional: false,
        removable: true,
        enabled: true,
        installed: true,
        availability: 'profile',
        version: '1.2.3',
        meta: { title: 'Sample plugin', description: 'A sample', icon: 'data:image/png;base64,AAAA' },
        rows: [{ rowId: 'sample-row', moduleName: 'sample-plugin', entryId: 'include:sample-row', meta: { title: 'Row title' } }],
      },
      {
        name: 'broken-plugin',
        official: true,
        optional: true,
        removable: false,
        enabled: false,
        installed: false,
        availability: 'missing',
        error: { code: 'not-bundle' },
        rows: [],
      },
    ],
  }

  const pluginInventory: PluginInventoryFace = {
    list: async () => ({
      entries: [
        {
          entryId: 'sample-plugin',
          moduleName: 'sample-plugin',
          enabled: true,
          fiberPhase: 'active',
          meta: { title: 'Sample plugin', icon: 'data:image/png;base64,BBBB' },
        },
        { entryId: 'silent', moduleName: 'silent', enabled: false, fiberPhase: null },
        {
          entryId: 'include:sample-row',
          moduleName: 'sample-plugin',
          enabled: false,
          fiberPhase: 'active',
        },
      ],
    }),
  }

  return {
    root,
    clientModules,
    pluginManager,
    pluginInventory,
    bundles: [{ id, rev: 'abc123', path: bundlePath, source }],
    graph,
  }
}

/** A gateway stand-in that echoes its request, for the rpc provider. */
export function createEchoGateway(): {
  invoke(request: { namespace: string; method: string; args: Readonly<Record<string, unknown>> }): Promise<unknown>
  calls: { namespace: string; method: string; args: Readonly<Record<string, unknown>> }[]
} {
  const calls: { namespace: string; method: string; args: Readonly<Record<string, unknown>> }[] = []
  return {
    calls,
    invoke: async (request) => {
      calls.push({ namespace: request.namespace, method: request.method, args: request.args })
      return { echoed: request.args }
    },
  }
}

