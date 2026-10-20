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
import { type Provider } from '../protocol/provider.ts';
import { type TranspileBudget } from '../slots/transpile.ts';
/** `transpile` configuration. */
export interface TranspileOptions {
    /** Directories whose packages may ship a `lib/client.js` client half. */
    readonly clientRoots: () => readonly string[];
    /** Ceilings applied to one parse/render. */
    readonly budget?: TranspileBudget;
    /**
     * Preferred language tags for the bundle's own copy dictionary, most
     * preferred first. `t('key')` text resolves through the first tag the bundle
     * carries, so a card arrives in the language the client asked for.
     */
    readonly localeTags?: readonly string[];
}
/**
 * Build the `transpile` provider.
 * @param options - client-bundle roots and budgets.
 * @returns the provider to register.
 */
export declare function createTranspileProvider(options: TranspileOptions): Provider;
