/**
 * `package-inventory`: the Host's own plugin-management records.
 *
 * This provider reuses Host services rather than guessing from the filesystem,
 * so third-party bundle icons and titles stay fully backend-driven.
 */

import { BridgeFailure, optionalString, requiredString, type Provider } from '../protocol/provider.ts'
import { firstString } from '../protocol/json.ts'
import type { InventoryBundle, InventoryBundleRow, InventoryData, InventoryRow } from '../protocol/types.ts'

/** One row a bundle's patch declares, as the Host reports it. */
export interface HostBundleRow {
  readonly rowId: string
  readonly moduleName: string
  readonly meta?: unknown
}

/** One bundle record, as the Host's `pluginManager.listBundles()` returns it. */
export interface HostBundleInfo {
  readonly name: string
  readonly official: boolean
  readonly optional: boolean
  readonly removable: boolean
  readonly enabled: boolean
  readonly installed: boolean
  readonly availability: string
  readonly version?: string
  readonly source?: string
  readonly meta?: unknown
  readonly description?: string
  readonly rows?: readonly HostBundleRow[]
  readonly error?: { readonly code?: string }
}

/** One Loader inventory entry, as `pluginInventory.list()` returns it. */
export interface HostInventoryEntry {
  readonly entryId: string
  readonly moduleName: string
  readonly enabled: boolean
  readonly fiberPhase: string | null
  readonly meta?: unknown
}

/** The slice of `pluginManager` this provider reads. */
export interface PluginManagerFace {
  listBundles(): Promise<readonly HostBundleInfo[]>
}

/** The slice of `pluginInventory` this provider reads. */
export interface PluginInventoryFace {
  list(): Promise<{ readonly entries: readonly HostInventoryEntry[] }>
}

/** `package-inventory` configuration. */
export interface PackageInventoryOptions {
  /** Resolve the manager service, or undefined when this profile has none. */
  readonly pluginManager: () => PluginManagerFace | undefined
  /** Resolve the inventory service, or undefined when absent. */
  readonly pluginInventory: () => PluginInventoryFace | undefined
}

/** Localized display text of one package or row, as the Host resolves it. */
function displayText(meta: unknown): { title?: string; description?: string; icon?: string } {
  const title = firstString(meta, ['title'])
  const description = firstString(meta, ['description'])
  const icon = firstString(meta, ['icon'])
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(icon === undefined ? {} : { icon }),
  }
}

/**
 * Build the `package-inventory` provider.
 * @param options - service accessors.
 * @returns the provider to register.
 */
export function createPackageInventoryProvider(options: PackageInventoryOptions): Provider {
  const managementAvailable = (): boolean => options.pluginManager() !== undefined

  return {
    id: 'package-inventory',
    version: 1,
    readOnly: true,
    ops: {
      /** Every bundle the Host knows about, with its rows and `meta.icon`. */
      bundles: async (args): Promise<InventoryData> => {
        const manager = options.pluginManager()
        if (manager === undefined) {
          throw new BridgeFailure('provider/unavailable', 'this Host composition has no plugin manager')
        }
        const name = optionalString(args, 'name')
        const bundles = await manager.listBundles()
        const rows = (name === undefined ? bundles : bundles.filter(bundle => bundle.name === name))
          .map(projectBundle)
        return { bundles: rows, managementAvailable: true }
      },

      /** Every running Loader entry the Host reports. */
      rows: async (): Promise<InventoryData> => {
        const inventory = options.pluginInventory()
        if (inventory === undefined) {
          throw new BridgeFailure('provider/unavailable', 'this Host composition has no plugin inventory')
        }
        const snapshot = await inventory.list()
        const rows: InventoryRow[] = snapshot.entries.map(entry => ({
          entryId: entry.entryId,
          moduleName: entry.moduleName,
          enabled: entry.enabled,
          fiberPhase: entry.fiberPhase,
          ...displayText(entry.meta),
        }))
        return { rows, managementAvailable: managementAvailable() }
      },

      /** One bundle's or row's `meta.icon` data URL, passed through untouched. */
      'meta-icon': async (args): Promise<{ name: string; icon: string | null }> => {
        const name = requiredString(args, 'name')
        const manager = options.pluginManager()
        if (manager !== undefined) {
          const bundle = (await manager.listBundles()).find(item => item.name === name)
          if (bundle !== undefined) return { name, icon: displayText(bundle.meta).icon ?? null }
        }
        const inventory = options.pluginInventory()
        if (inventory !== undefined) {
          const snapshot = await inventory.list()
          const row = snapshot.entries.find(entry => entry.entryId === name || entry.moduleName === name)
          if (row !== undefined) return { name, icon: displayText(row.meta).icon ?? null }
        }
        throw new BridgeFailure('args/invalid', `no bundle or row is named ${name}`)
      },
    },
  }
}

/**
 * Project one Host bundle record onto the wire row.
 * @param bundle - the Host record.
 * @returns the wire row, with absent optional fields omitted.
 */
function projectBundle(bundle: HostBundleInfo): InventoryBundle {
  const text = displayText(bundle.meta)
  const rows: InventoryBundleRow[] = (bundle.rows ?? []).map(row => ({
    rowId: row.rowId,
    moduleName: row.moduleName,
    ...displayText(row.meta),
  }))
  return {
    name: bundle.name,
    official: bundle.official,
    optional: bundle.optional,
    removable: bundle.removable,
    enabled: bundle.enabled,
    installed: bundle.installed,
    availability: bundle.availability,
    ...(bundle.version === undefined ? {} : { version: bundle.version }),
    ...(bundle.source === undefined ? {} : { source: bundle.source }),
    ...text,
    ...(bundle.description === undefined ? {} : { description: text.description ?? bundle.description }),
    ...(bundle.error?.code === undefined ? {} : { errorCode: bundle.error.code }),
    rows,
  }
}
