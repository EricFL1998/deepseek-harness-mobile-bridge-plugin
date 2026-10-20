/**
 * `transpile`: the static-first component-tree provider.
 *
 * Where `client-slots/render-tree` answers "what does this component draw" by
 * *executing* the bundle inside the bridge VM, this provider answers the same
 * question by *reading* the bundle's text: the rolldown IIFE is tokenized, its
 * `slots.register` calls are recovered as data, and the JSX-runtime calls a
 * component returns are turned into the same `RenderNode` tree — with no plugin
 * code ever running. That makes it the only component-tree path available on a
 * phone Host, where `clientBundleScan` stays off.
 *
 * The wire model is `render-tree`'s, so a native client consumes both sources
 * with one renderer. Anything the static pass cannot resolve arrives as an
 * `opaque` node or a warning, and `truncated: true` says a budget stopped the
 * walk; the client shows "暂不支持/已截断" instead of a blank area.
 */
import { stat } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BridgeFailure, optionalObject, requiredString, } from "../protocol/provider.js";
import { analyzeBundle, buildComponentTree, DEFAULT_TRANSPILE_BUDGET, } from "../slots/transpile.js";
/**
 * Build the `transpile` provider.
 * @param options - client-bundle roots and budgets.
 * @returns the provider to register.
 */
export function createTranspileProvider(options) {
    const budget = options.budget ?? DEFAULT_TRANSPILE_BUDGET;
    const cache = new Map();
    /** Parse one bundle file, reusing the cached pass for the same revision. */
    const bundleOf = async (record) => {
        const key = `${record.path}@${record.rev}`;
        const cached = cache.get(key);
        if (cached !== undefined)
            return cached;
        const source = await readFile(record.path, 'utf8');
        const analyzed = analyzeBundle(record.packageName, source, budget);
        const registrationComponents = new Map();
        for (const registration of analyzed.registrations) {
            if (registration.componentName !== undefined) {
                registrationComponents.set(registration.id ?? registration.key ?? registration.slot, registration.componentName);
            }
        }
        const bundle = {
            source,
            componentNames: new Set(analyzed.components.map(component => component.name)),
            registrationComponents,
        };
        cache.set(key, bundle);
        return bundle;
    };
    /** Every `lib/client.js` under the configured roots, lazily catalogued. */
    const catalogue = async () => {
        const records = [];
        for (const root of options.clientRoots()) {
            for (const dir of await packageDirs(root)) {
                const path = join(dir.dir, 'lib', 'client.js');
                try {
                    const info = await stat(path);
                    if (!info.isFile())
                        continue;
                    records.push({
                        packageName: dir.name,
                        path,
                        rev: `${info.mtimeMs}:${info.size}`,
                    });
                }
                catch {
                    // No client half: most packages are Host-only.
                }
            }
        }
        return records;
    };
    return {
        id: 'transpile',
        version: 1,
        readOnly: true,
        ops: {
            /**
             * Statically build one component's render tree.
             *
             * `componentId` is the same `<package>#<id>` identity `client-slots`
             * reports; the `<id>` half names either a registration id (resolved to the
             * component it registered) or the component's own source name.
             */
            'component-tree': async (args, warnings) => {
                const componentId = requiredString(args, 'componentId');
                const props = optionalObject(args, 'props') ?? {};
                const hash = componentId.indexOf('#');
                if (hash <= 0 || hash === componentId.length - 1) {
                    throw new BridgeFailure('args/invalid', `componentId ${componentId} is not a <package>#<id> identity`);
                }
                const packageName = componentId.slice(0, hash);
                const member = componentId.slice(hash + 1);
                const records = await catalogue();
                const record = records.find(candidate => candidate.packageName === packageName);
                if (record === undefined) {
                    // The failure names what the scan saw, so a client (or a human) can
                    // tell "the plugin is not installed" from "the bridge is looking in
                    // the wrong place" without a second round trip.
                    throw new BridgeFailure('args/invalid', `no client bundle for package ${packageName}`, 200, {
                        roots: options.clientRoots(),
                        packages: records.map(candidate => candidate.packageName).sort(),
                    });
                }
                const bundle = await bundleOf(record);
                // The id names a registration first; a bare component name is accepted
                // too, so a client can ask for a component it learned another way.
                const componentName = bundle.registrationComponents.get(member)
                    ?? (bundle.componentNames.has(member) ? member : undefined);
                if (componentName === undefined) {
                    throw new BridgeFailure('args/invalid', `no component ${componentId}`, 200, {
                        known: [...bundle.registrationComponents.keys(), ...bundle.componentNames].sort(),
                    });
                }
                const built = buildComponentTree(bundle.source, componentName, props, budget);
                for (const note of built.warnings)
                    warnings.warn(note);
                return {
                    componentId,
                    tree: built.tree,
                    warnings: built.warnings,
                    truncated: built.truncated,
                };
            },
            /**
             * What the bundle scan sees: the roots it walks and the packages it found.
             *
             * This is the diagnostic counterpart of `component-tree`'s
             * `details.packages`: when a plugin's UI does not appear, this answer says
             * whether the bridge is looking in the wrong place or the plugin ships no
             * client half.
             */
            bundles: async () => {
                const records = await catalogue();
                return {
                    roots: options.clientRoots(),
                    packages: records.map(candidate => candidate.packageName).sort(),
                };
            },
        },
    };
}
/**
 * Every package directory under one `node_modules` root, scopes expanded.
 *
 * Symlinked entries count: a pnpm layout links each package into place, and a
 * phone Host uses exactly that layout.
 */
async function packageDirs(root) {
    const { readdir } = await import('node:fs/promises');
    const out = [];
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    }
    catch {
        return out;
    }
    for (const entry of entries) {
        const isDir = entry.isDirectory() || entry.isSymbolicLink();
        if (!isDir)
            continue;
        if (entry.name.startsWith('@')) {
            let children;
            try {
                children = await readdir(join(root, entry.name), { withFileTypes: true });
            }
            catch {
                continue;
            }
            for (const child of children) {
                if (child.isDirectory() || child.isSymbolicLink()) {
                    out.push({ name: `${entry.name}/${child.name}`, dir: join(root, entry.name, child.name) });
                }
            }
        }
        else {
            out.push({ name: entry.name, dir: join(root, entry.name) });
        }
    }
    return out;
}
