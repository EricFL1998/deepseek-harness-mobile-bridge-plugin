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

import type { Provider } from '../protocol/provider.ts'
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

/** `host-slots` configuration. */
export interface HostSlotsOptions {
  /** Resolve the settings service, or undefined when this composition has none. */
  readonly settings: () => SettingsFace | undefined
  /** Resolve the plugin inventory, or undefined when absent. */
  readonly pluginInventory: () => SlotInventoryFace | undefined
  /** Locale tags used to resolve locale-mapped titles. */
  readonly localeTags?: readonly string[]
}

/** Where the native app puts a contribution. */
const SETTINGS_SURFACE = 'settings.page'

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
      list: async (): Promise<SlotSurfaceData> => {
        const settings = options.settings()
        const localeTags = options.localeTags ?? []
        if (settings === undefined) {
          // No settings service means no server-declared surfaces at all: report an
          // empty list rather than an error, because the rest of the bridge works.
          return { surfaces: [] }
        }
        const descriptors = settings.describe({ redactSecrets: true })
        const metaOf = await rowMetaById(options.pluginInventory?.(), localeTags)
        const surfaces: SlotSurface[] = []
        for (const descriptor of descriptors) {
          const meta = metaOf.get(descriptor.ns)
          // The namespace always exists; the title may not. Falling back to the
          // namespace keeps the entry usable instead of dropping a real page.
          surfaces.push({
            slot: SETTINGS_SURFACE,
            id: descriptor.ns,
            title: meta?.title ?? descriptor.ns,
            ...(meta?.description === undefined ? {} : { description: meta.description }),
            ...(meta?.moduleName === undefined ? {} : { module: meta.moduleName }),
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
