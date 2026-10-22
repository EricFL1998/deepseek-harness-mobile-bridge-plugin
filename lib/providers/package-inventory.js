/**
 * `package-inventory`: the Host's own plugin-management records.
 *
 * This provider reuses Host services rather than guessing from the filesystem,
 * so third-party bundle icons and titles stay fully backend-driven.
 */
import { BridgeFailure, optionalLocale, optionalString, preferredLocaleTags, requiredString } from "../protocol/provider.js";
import { bundlePolicy } from "./bundle-policy.js";
import { firstString, localizedString } from "../protocol/json.js";
/** Localized display text of one package or row, as the Host resolves it. */
function displayText(meta, localeTags = []) {
    const title = localizedString(meta, ['title'], localeTags);
    const description = localizedString(meta, ['description'], localeTags);
    const icon = localizedString(meta, ['icon'], localeTags);
    return {
        ...(title === undefined ? {} : { title }),
        ...(description === undefined ? {} : { description }),
        ...(icon === undefined ? {} : { icon }),
    };
}
/**
 * 1500 ms snapshot cache with in-flight de-duplication.
 *
 * The App asks for one `meta-icon` per visible row, and each icon used to
 * trigger a full `listBundles()` + `list()` scan. The TTL keeps a burst of icon
 * requests on one snapshot while still letting a toggle take effect promptly.
 */
function cachedSnapshot(load) {
    const ttlMs = 1500;
    let at = 0;
    let value;
    let inFlight;
    return async () => {
        if (value !== undefined && Date.now() - at < ttlMs)
            return value;
        if (inFlight !== undefined)
            return inFlight;
        const pending = load()
            .then((next) => {
            value = next;
            at = Date.now();
            return next;
        })
            .finally(() => {
            inFlight = undefined;
        });
        inFlight = pending;
        return pending;
    };
}
/**
 * Build the `package-inventory` provider.
 * @param options - service accessors.
 * @returns the provider to register.
 */
export function createPackageInventoryProvider(options) {
    const managementAvailable = () => options.pluginManager() !== undefined;
    const loadBundles = cachedSnapshot(async () => {
        const manager = options.pluginManager();
        if (manager === undefined) {
            throw new BridgeFailure('provider/unavailable', 'this Host composition has no plugin manager');
        }
        return manager.listBundles();
    });
    const loadInventory = cachedSnapshot(async () => {
        const inventory = options.pluginInventory();
        if (inventory === undefined) {
            throw new BridgeFailure('provider/unavailable', 'this Host composition has no plugin inventory');
        }
        return inventory.list();
    });
    return {
        id: 'package-inventory',
        version: 1,
        readOnly: true,
        ops: {
            /** Every bundle the Host knows about, with its rows and `meta.icon`. */
            bundles: async (args) => {
                if (options.pluginManager() === undefined) {
                    throw new BridgeFailure('provider/unavailable', 'this Host composition has no plugin manager');
                }
                const localeTags = preferredLocaleTags(optionalLocale(args), options.localeTags ?? []);
                const name = optionalString(args, 'name');
                const bundles = await loadBundles();
                // A row's on/off state lives in the Loader inventory, not in the bundle
                // record: read it once and join by `entryId`, the same join the browser's
                // own Plugins page performs. A row whose entry is not inventoried is off.
                const entries = options.pluginInventory() === undefined
                    ? undefined
                    : new Map((await loadInventory()).entries.map(entry => [entry.entryId, entry]));
                const rows = (name === undefined ? bundles : bundles.filter(bundle => bundle.name === name))
                    .map(bundle => projectBundle(bundle, localeTags, entries));
                return { bundles: rows, managementAvailable: true };
            },
            /** Every running Loader entry the Host reports. */
            rows: async () => {
                if (options.pluginInventory() === undefined) {
                    throw new BridgeFailure('provider/unavailable', 'this Host composition has no plugin inventory');
                }
                const snapshot = await loadInventory();
                const rows = snapshot.entries.map(entry => ({
                    entryId: entry.entryId,
                    moduleName: entry.moduleName,
                    enabled: entry.enabled,
                    fiberPhase: entry.fiberPhase,
                    ...displayText(entry.meta),
                }));
                return { rows, managementAvailable: managementAvailable() };
            },
            /** One bundle's or row's `meta.icon` data URL, passed through untouched. */
            'meta-icon': async (args) => {
                const name = requiredString(args, 'name');
                if (options.pluginManager() !== undefined) {
                    const bundle = (await loadBundles()).find(item => item.name === name);
                    if (bundle !== undefined)
                        return { name, icon: displayText(bundle.meta).icon ?? null };
                }
                if (options.pluginInventory() !== undefined) {
                    const snapshot = await loadInventory();
                    const row = snapshot.entries.find(entry => entry.entryId === name || entry.moduleName === name);
                    if (row !== undefined)
                        return { name, icon: displayText(row.meta).icon ?? null };
                }
                throw new BridgeFailure('args/invalid', `no bundle or row is named ${name}`);
            },
        },
    };
}
/**
 * Project one Host bundle record onto the wire row.
 * @param bundle - the Host record.
 * @param localeTags - locale preference for title and description text.
 * @param entries - the Loader inventory, when the composition has one.
 * @returns the wire row, with absent optional fields omitted.
 */
function projectBundle(bundle, localeTags, entries) {
    const text = displayText(bundle.meta, localeTags);
    const rows = (bundle.rows ?? []).map(row => {
        const live = row.entryId === undefined ? undefined : entries?.get(row.entryId);
        // Same rule as the browser page: a row the Host resolved to an entry takes its
        // state from that entry; without an entry it cannot be running.
        const enabled = entries === undefined ? row.enabled : (live?.enabled ?? false);
        return {
            rowId: row.rowId,
            moduleName: row.moduleName,
            ...(row.entryId === undefined ? {} : { entryId: row.entryId }),
            ...(enabled === undefined ? {} : { enabled }),
            ...displayText(row.meta, localeTags),
        };
    });
    const policy = bundlePolicy(bundle.name);
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
    };
}
