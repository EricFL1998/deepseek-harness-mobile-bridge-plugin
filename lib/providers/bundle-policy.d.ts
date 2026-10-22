/**
 * Official plugin-page policy, owned by the bridge instead of the phone client.
 *
 * The official web client decides on its own which optional bundles sit in the
 * main Experimental group, their order, which ones are folded into "More", which
 * bundles are profile roots rather than plugins, and which single bundle gates
 * the market tab. Carrying that policy here keeps the native client a pure
 * projection of Host data, and updates it with the plugin release instead of an
 * APK rebuild.
 */
/** Bundles that are profile roots (patch layers), not user-installable plugins. */
export declare const PROFILE_ROOT_BUNDLES: ReadonlySet<string>;
/** Optional bundles pinned to the main Experimental group, in display order. */
export declare const PINNED_BUNDLES: readonly string[];
/** Optional bundles folded into "More plugins", in display order. */
export declare const MORE_BUNDLES: readonly string[];
/** Bundles that never appear in the phone plugin list. */
export declare const HIDDEN_BUNDLES: ReadonlySet<string>;
/** The bundle whose enablement shows the Plugin Market tab. */
export declare const MARKET_BUNDLE = "@deepseek-ai/dsh-experimental-plugin-market-bundle";
/** Bundles the app must not let the user disable or uninstall. */
export declare const LOCKED_BUNDLES: ReadonlySet<string>;
/** Policy facts projected onto one bundle row. */
export interface BundlePolicy {
    readonly profileRoot: boolean;
    readonly pinned: boolean;
    readonly order: number;
    readonly hidden: boolean;
    readonly market: boolean;
    readonly locked: boolean;
}
/** Resolve the policy for one bundle name. */
export declare function bundlePolicy(name: string): BundlePolicy;
