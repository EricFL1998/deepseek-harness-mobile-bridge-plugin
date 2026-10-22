/**
 * `package-inventory`: the Host's own plugin-management records.
 *
 * This provider reuses Host services rather than guessing from the filesystem,
 * so third-party bundle icons and titles stay fully backend-driven.
 */

import { BridgeFailure, optionalLocale, optionalString, preferredLocaleTags, requiredString, type Provider } from '../protocol/provider.ts'
import { bundlePolicy } from './bundle-policy.ts'
import { firstString, localizedString } from '../protocol/json.ts'
import type { InventoryBundle, InventoryBundleRow, InventoryData, InventoryRow } from '../protocol/types.ts'

/** One row a bundle's patch declares, as the Host reports it. */
export interface HostBundleRow {
  readonly rowId: string
  readonly moduleName: string
  readonly meta?: unknown
  /**
   * The Loader entry this row resolves to, when the Host reports one.
   *
   * Absent means the row is not live (typically because its bundle is off), so it
   * cannot be addressed through the profile patch either. Present means the entry
   * exists even while it is disabled, which is what makes a row toggle possible.
   */
  readonly entryId?: string
  /** Whether this row is enabled, when the Host reports it. */
  readonly enabled?: boolean
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
  /** Locale tags used to resolve locale-mapped titles and descriptions. */
  readonly localeTags?: readonly string[]
}

/** Localized display text of one package or row, as the Host resolves it. */
function displayText(
  meta: unknown,
  localeTags: readonly string[] = [],
): { title?: string; description?: string; icon?: string } {
  const title = localizedString(meta, ['title'], localeTags)
  const description = localizedString(meta, ['description'], localeTags)
  const icon = localizedString(meta, ['icon'], localeTags)
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(icon === undefined ? {} : { icon }),
  }
}

/**
 * 1500 ms snapshot cache with in-flight de-duplication.
 *
 * The App asks for one `meta-icon` per visible row, and each icon used to
 * trigger a full `listBundles()` + `list()` scan. The TTL keeps a burst of icon
 * requests on one snapshot while still letting a toggle take effect promptly.
 */
function cachedSnapshot<T>(load: () => Promise<T>): () => Promise<T> {
  const ttlMs = 1500
  let at = 0
  let value: T | undefined
  let inFlight: Promise<T> | undefined
  return async () => {
    if (value !== undefined && Date.now() - at < ttlMs) return value
    if (inFlight !== undefined) return inFlight
    const pending = load()
      .then((next) => {
        value = next
        at = Date.now()
        return next
      })
      .finally(() => {
        inFlight = undefined
      })
    inFlight = pending
    return pending
  }
}

/**
 * Build the `package-inventory` provider.
 * @param options - service accessors.
 * @returns the provider to register.
 */
export function createPackageInventoryProvider(options: PackageInventoryOptions): Provider {
  const managementAvailable = (): boolean => options.pluginManager() !== undefined
  const loadBundles = cachedSnapshot(async () => {
    const manager = options.pluginManager()
    if (manager === undefined) {
      throw new BridgeFailure('provider/unavailable', 'this Host composition has no plugin manager')
    }
    return manager.listBundles()
  })
  const loadInventory = cachedSnapshot(async () => {
    const inventory = options.pluginInventory()
    if (inventory === undefined) {
      throw new BridgeFailure('provider/unavailable', 'this Host composition has no plugin inventory')
    }
    return inventory.list()
  })

  return {
    id: 'package-inventory',
    version: 1,
    readOnly: true,
    ops: {
      /** Every bundle the Host knows about, with its rows and `meta.icon`. */
      bundles: async (args): Promise<InventoryData> => {
        if (options.pluginManager() === undefined) {
          throw new BridgeFailure('provider/unavailable', 'this Host composition has no plugin manager')
        }
        const localeTags = preferredLocaleTags(optionalLocale(args), options.localeTags ?? [])
        const name = optionalString(args, 'name')
        const bundles = await loadBundles()
        // A row's on/off state lives in the Loader inventory, not in the bundle
        // record: read it once and join by `entryId`, the same join the browser's
        // own Plugins page performs. A row whose entry is not inventoried is off.
        const entries = options.pluginInventory() === undefined
          ? undefined
          : new Map((await loadInventory()).entries.map(entry => [entry.entryId, entry]))
        const rows = (name === undefined ? bundles : bundles.filter(bundle => bundle.name === name))
          .map(bundle => projectBundle(bundle, localeTags, entries))
        return { bundles: rows, managementAvailable: true }
      },

      /** Every running Loader entry the Host reports. */
      rows: async (): Promise<InventoryData> => {
        if (options.pluginInventory() === undefined) {
          throw new BridgeFailure('provider/unavailable', 'this Host composition has no plugin inventory')
        }
        const snapshot = await loadInventory()
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
        if (options.pluginManager() !== undefined) {
          const bundle = (await loadBundles()).find(item => item.name === name)
          if (bundle !== undefined) return { name, icon: displayText(bundle.meta).icon ?? null }
        }
        if (options.pluginInventory() !== undefined) {
          const snapshot = await loadInventory()
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
 * @param localeTags - locale preference for title and description text.
 * @param entries - the Loader inventory, when the composition has one.
 * @returns the wire row, with absent optional fields omitted.
 */
function projectBundle(
  bundle: HostBundleInfo,
  localeTags: readonly string[],
  entries: ReadonlyMap<string, HostInventoryEntry> | undefined,
): InventoryBundle {
  const text = displayText(bundle.meta, localeTags)
  const rows: InventoryBundleRow[] = (bundle.rows ?? []).map(row => {
    const live = row.entryId === undefined ? undefined : entries?.get(row.entryId)
    // Same rule as the browser page: a row the Host resolved to an entry takes its
    // state from that entry; without an entry it cannot be running.
    const enabled = entries === undefined ? row.enabled : (live?.enabled ?? false)
    return {
      rowId: row.rowId,
      moduleName: row.moduleName,
      ...(row.entryId === undefined ? {} : { entryId: row.entryId }),
      ...(enabled === undefined ? {} : { enabled }),
      ...displayText(row.meta, localeTags),
    }
  })
  const policy = bundlePolicy(bundle.name)
  return {
    name: bundle.name,
    ...policy,
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
