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
export const PROFILE_ROOT_BUNDLES = new Set([
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    '@deepseek-ai/dsh-headless',
    '@deepseek-ai/dsh-sdk-app',
    '@deepseek-ai/dsh-acp-app',
    '@deepseek-ai/dsh-sdk-minimal',
]);
/** Optional bundles pinned to the main Experimental group, in display order. */
export const PINNED_BUNDLES = [
    '@deepseek-ai/dsh-experimental-agent-team-profile',
    '@deepseek-ai/dsh-experimental-voice-input-bundle',
    '@deepseek-ai/dsh-experimental-auto-review',
    '@deepseek-ai/dsh-experimental-inspector-profile',
];
/** Optional bundles folded into "More plugins", in display order. */
export const MORE_BUNDLES = [
    '@deepseek-ai/dsh-experimental-tool-worktree',
    '@deepseek-ai/dsh-experimental-cot-translation-bundle',
    '@deepseek-ai/dsh-experimental-terminal-bundle',
    '@deepseek-ai/dsh-experimental-session-search',
    '@deepseek-ai/dsh-experimental-session-titles-bundle',
    '@deepseek-ai/dsh-experimental-badge-skill-bundle',
    '@deepseek-ai/dsh-experimental-ralph-bundle',
    '@deepseek-ai/dsh-experimental-plugin-market-bundle',
    '@deepseek-ai/dsh-subagent-codex',
    '@deepseek-ai/dsh-subagent-claude-code',
];
/** Bundles that never appear in the phone plugin list. */
export const HIDDEN_BUNDLES = new Set([
    '@deepseek-ai/dsh-cordis-client-runner',
]);
/** The bundle whose enablement shows the Plugin Market tab. */
export const MARKET_BUNDLE = '@deepseek-ai/dsh-experimental-plugin-market-bundle';
/** Bundles the app must not let the user disable or uninstall. */
export const LOCKED_BUNDLES = new Set([
    'dsh-mobile-bridge-plugin',
]);
/** Resolve the policy for one bundle name. */
export function bundlePolicy(name) {
    const pinnedIndex = PINNED_BUNDLES.indexOf(name);
    const moreIndex = MORE_BUNDLES.indexOf(name);
    const order = pinnedIndex >= 0
        ? pinnedIndex
        : moreIndex >= 0 ? PINNED_BUNDLES.length + 1 + moreIndex : PINNED_BUNDLES.length;
    return {
        profileRoot: PROFILE_ROOT_BUNDLES.has(name),
        pinned: pinnedIndex >= 0,
        order,
        hidden: HIDDEN_BUNDLES.has(name),
        market: name === MARKET_BUNDLE,
        locked: LOCKED_BUNDLES.has(name),
    };
}
