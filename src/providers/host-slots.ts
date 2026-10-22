/**
 * `host-slots`: plugin contributions the Host itself can enumerate.
 *
 * A native client cannot run client bundles, so anything a plugin contributes to
 * the browser's slots is out of reach. Some surfaces, however, are declared on the
 * server side and are therefore visible here:
 *
 * - **A plugin's Settings page.** Any Loader row whose module declares a `Config`
 *   schema gets a settings namespace; the Host's settings service lists those
 *   namespaces and the row's `meta` supplies the title and description. That is
 *   exactly what the browser's Settings → Plugins list renders.
 *
 * Each reported surface names the native place it belongs in, so the client maps
 * data to a screen without a second table of its own.
 */

import { optionalLocale, preferredLocaleTags, type Provider } from '../protocol/provider.ts'
import type { SlotSurface, SlotSurfaceData } from '../protocol/types.ts'
import { localizedString } from '../protocol/json.ts'

/** The slice of the Host's `settings` service this provider reads. */
export interface SettingsFace {
  /** Every active namespace with a generated form, in registration order. */
  describe(options?: { redactSecrets?: boolean }): readonly SettingsDescriptor[]
}

/** One settings descriptor, structurally the Host's. */
export interface SettingsDescriptor {
  /** Namespace, which is also the Loader row id that owns it. */
  readonly ns: string
  /** Whether the Host generates the form itself. */
  readonly autoGenerate?: boolean
}

/** One Loader row, as `pluginInventory.list()` returns it. */
export interface SlotInventoryEntry {
  readonly entryId: string
  readonly moduleName: string
  readonly enabled: boolean
  readonly meta?: unknown
}

/** The slice of `pluginInventory` this provider reads. */
export interface SlotInventoryFace {
  list(): Promise<{ readonly entries: readonly SlotInventoryEntry[] }>
}

/** One bundle row, as `pluginManager.listBundles()` reports it. */
export interface SlotBundleRow {
  readonly rowId: string
  readonly moduleName: string
  readonly meta?: unknown
}

/** One bundle, reduced to the rows its patch declares. */
export interface SlotBundleInfo {
  readonly name: string
  readonly rows?: readonly SlotBundleRow[]
}

/** The slice of `pluginManager` this provider reads. */
export interface SlotBundleFace {
  listBundles(): Promise<readonly SlotBundleInfo[]>
}

/** `host-slots` configuration. */
export interface HostSlotsOptions {
  /** Resolve the settings service, or undefined when this composition has none. */
  readonly settings: () => SettingsFace | undefined
  /** Resolve the plugin inventory, or undefined when absent. */
  readonly pluginInventory: () => SlotInventoryFace | undefined
  /** Resolve the bundle manager, or undefined when this composition has none. */
  readonly pluginManager?: () => SlotBundleFace | undefined
  /** Locale tags used to resolve locale-mapped titles. */
  readonly localeTags?: readonly string[]
}

/**
 * Where the native app puts a contribution.
 *
 * The two placements differ by whether the namespace belongs to one bundle row: a
 * row's own configuration belongs on that row inside the Plugins page, while a
 * namespace without a row is a standalone Settings page.
 */
const SETTINGS_SURFACE = 'settings.page'
const ROW_CONFIG_SURFACE = 'plugins.row.config'

/**
 * Build the `host-slots` provider.
 * @param options - service accessors and locale preference.
 * @returns the provider to register.
 */
export function createHostSlotsProvider(options: HostSlotsOptions): Provider {
  return {
    id: 'host-slots',
    version: 1,
    readOnly: true,
    ops: {
      /** Every plugin-declared surface this Host can enumerate. */
      list: async (args): Promise<SlotSurfaceData> => {
        const settings = options.settings()
        const localeTags = preferredLocaleTags(optionalLocale(args), options.localeTags ?? [])
        if (settings === undefined) {
          // No settings service means no server-declared surfaces at all: report an
          // empty list rather than an error, because the rest of the bridge works.
          return { surfaces: [] }
        }
        const descriptors = settings.describe({ redactSecrets: true })
        const metaOf = await rowMetaById(options.pluginInventory?.(), localeTags)
        const rowOwners = await rowOwnersByName(options.pluginManager?.(), localeTags)
        const surfaces: SlotSurface[] = []
        for (const descriptor of descriptors) {
          const meta = metaOf.get(descriptor.ns)
          const owner = rowOwners.get(descriptor.ns)
          // An unknown namespace still becomes a surface: dropping it would hide a
          // page the Host really serves. Only the placement needs the owner.
          surfaces.push({
            slot: owner === undefined ? SETTINGS_SURFACE : ROW_CONFIG_SURFACE,
            id: owner === undefined ? descriptor.ns : `${owner.bundle}#${descriptor.ns}`,
            title: meta?.title ?? owner?.title ?? descriptor.ns,
            ...(owner?.description ?? meta?.description) === undefined
              ? {}
              : { description: owner?.description ?? meta?.description },
            ...(meta?.moduleName ?? owner?.moduleName) === undefined
              ? {}
              : { module: meta?.moduleName ?? owner?.moduleName },
          })
        }
        return { surfaces }
      },
    },
  }
}

/** Title, description and module of each inventory row, keyed by row id. */
async function rowMetaById(
  inventory: SlotInventoryFace | undefined,
  localeTags: readonly string[],
): Promise<Map<string, { title?: string; description?: string; moduleName?: string }>> {
  const out = new Map<string, { title?: string; description?: string; moduleName?: string }>()
  if (inventory === undefined) return out
  const snapshot = await inventory.list()
  for (const entry of snapshot.entries) {
    out.set(entry.entryId, {
      title: localizedString(entry.meta, ['title'], localeTags),
      description: localizedString(entry.meta, ['description'], localeTags),
      moduleName: entry.moduleName,
    })
  }
  return out
}

/**
 * Which bundle owns each row id, so a namespace can be placed on that row.
 *
 * Row ids are only unique inside their bundle patch; when two bundles declare the
 * same id the first wins, which keeps the mapping deterministic instead of guessing.
 * @param manager the bundle manager, when the composition has one.
 * @param localeTags locale preference for the row's own meta text.
 * @returns owner information keyed by row id.
 */
async function rowOwnersByName(
  manager: SlotBundleFace | undefined,
  localeTags: readonly string[],
): Promise<Map<string, { bundle: string; title?: string; description?: string; moduleName?: string }>> {
  const out = new Map<string, { bundle: string; title?: string; description?: string; moduleName?: string }>()
  if (manager === undefined) return out
  for (const bundle of await manager.listBundles()) {
    for (const row of bundle.rows ?? []) {
      if (out.has(row.rowId)) continue
      out.set(row.rowId, {
        bundle: bundle.name,
        title: localizedString(row.meta, ['title'], localeTags),
        description: localizedString(row.meta, ['description'], localeTags),
        moduleName: row.moduleName,
      })
    }
  }
  return out
}
