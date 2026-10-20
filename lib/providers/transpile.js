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
    /**
     * Read a plugin's own native-layout binding for one component.
     *
     * A statically read tree is the declared structure. A chip that shows live
     * numbers has no such structure to read: the numbers are computed by the plugin
     * at runtime. A plugin can declare, in its manifest, which native component the
     * client should draw instead and which result paths fill it.
     *
     * @param packageName - the `<package>` half of the component identity.
     * @param member - the `<id>` half.
     * @returns the binding, or undefined when the plugin declares none.
     */
    /**
     * The API prefix a package's own methods are served under.
     *
     * The browser `call('status')` reaches `<prefix>.status`. A package can state the
     * prefix itself (`dsh.pluginId`); otherwise the conventional `dsh-plugin-` prefix is
     * stripped. Reporting it here keeps the client from guessing from the package name.
     *
     * @param packageName - the `<package>` half of the component identity.
     * @returns the prefix, or the package name when nothing better is declared.
     */
    const apiPrefix = async (packageName) => {
        for (const root of options.clientRoots()) {
            try {
                const pkg = JSON.parse(await readFile(join(root, packageName, 'package.json'), 'utf8'));
                const declared = pkg.dsh?.pluginId ?? pkg.dsh?.id;
                if (typeof declared === 'string' && declared.length > 0)
                    return declared;
                const name = pkg.name ?? packageName;
                if (name.startsWith('dsh-plugin-'))
                    return name.slice('dsh-plugin-'.length);
                return name;
            }
            catch {
                continue;
            }
        }
        return packageName;
    };
    const mobileLayout = async (packageName, member) => {
        for (const root of options.clientRoots()) {
            const manifest = join(root, packageName, 'package.json');
            let pkg;
            try {
                pkg = JSON.parse(await readFile(manifest, 'utf8'));
            }
            catch {
                continue;
            }
            const dsh = pkg.dsh;
            if (dsh === null || typeof dsh !== 'object')
                return undefined;
            const mobile = dsh.mobile;
            if (mobile === null || typeof mobile !== 'object')
                return undefined;
            const layout = mobile.layout;
            if (layout === null || typeof layout !== 'object')
                return undefined;
            for (const [key, value] of Object.entries(layout)) {
                // Keys are `<slot>/<id>` or a bare `<id>`; either way the id half must match.
                const id = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key;
                if (id !== member)
                    continue;
                if (value === null || typeof value !== 'object')
                    continue;
                return value;
            }
            return undefined;
        }
        return undefined;
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
                const built = buildComponentTree(bundle.source, componentName, props, budget, options.localeTags ?? []);
                for (const note of built.warnings)
                    warnings.warn(note);
                return {
                    componentId,
                    tree: sanitizeTree(built.tree),
                    warnings: built.warnings,
                    truncated: built.truncated,
                    layout: (await mobileLayout(packageName, member)) ?? null,
                    data: built.data,
                    apiPrefix: await apiPrefix(packageName),
                    actions: built.actions,
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
/**
 * Drop empty slots from a render tree before it goes on the wire.
 *
 * A child that rendered to nothing is `null` in JavaScript, and JSON cannot carry
 * `undefined`: either one serializes as a literal `null` array element, which the
 * client's strict node decoder rejects — the whole page then reads as unsupported.
 * The wire model is "no child here", so empty slots are removed at the boundary.
 *
 * @param node the tree (or a subtree) about to be returned.
 * @returns the same tree with object children only.
 */
function sanitizeTree(node) {
    if (node === null || node === undefined)
        return null;
    if (typeof node !== 'object')
        return node;
    const record = node;
    if (!Array.isArray(record.children))
        return node;
    const children = [];
    for (const child of record.children) {
        if (child === null || child === undefined || typeof child !== 'object')
            continue;
        children.push(sanitizeTree(child));
    }
    return { ...record, children };
}
