/**
 * Static transpiler: turn a plugin's *compiled* client bundle into a
 * Compose-renderable JSON tree without executing it.
 *
 * The runtime evaluator (`evaluate.ts`) answers the same question by running the
 * bundle inside a Node VM. That is exact but unsafe on a phone Host — one client
 * half's mount work has taken the process down — so it stays behind the
 * `clientBundleScan` switch. This module is the static-first path the design in
 * `docs/plugin-ui-transpile.md` describes: it reads the bundle text, finds the
 * rolldown IIFE's `window.__ModuleLoader__.load({ id, factory })` registration,
 * walks the factory's statements with a small purpose-built tokenizer, and turns
 * the JSX-runtime calls (`_jsx`/`_jsxs`/`React.createElement`) a component
 * returns into the same `RenderNode` tree `render-tree` produces.
 *
 * ## What it handles
 *
 * - **Registration discovery**: every `…slots.register({…}, Component)` call,
 *   wherever it sits inside the factory (nested inside `ctx.effect(…)` /
 *   `ctx.inject(…)` callbacks included).
 * - **Component bodies**: the first `return <expr>` of a function or arrow
 *   component, and arrow components whose body is the expression itself.
 * - **JSX runtime calls**: `_jsx(type, props)` / `_jsxs(type, props, key)` and
 *   `React.createElement(type, props, ...children)` become `ElementNode`s;
 *   nested calls become children.
 * - **Literal data**: strings, numbers, booleans, null, template literals
 *   without substitutions, static arrays/objects, and parenthesized/comma/
 *   conditional/sequence expressions with statically-known branches.
 * - **Props passed by the caller**: an expression that reads a request prop
 *   (`props.title`, `{ title }` destructured in the component's parameter)
 *   resolves to the value `component-tree` was called with; one that reads
 *   nothing the caller supplied becomes an `OpaqueNode`.
 *
 * ## What it cannot handle (reported, never guessed)
 *
 * - State, effects, timers, network, dynamic imports — the tree is the declared
 *   structure only; live data arrives through the dispatch/refresh channel.
 * - Arbitrary expression evaluation (arithmetic, `.map`, method calls whose
 *   result is not a JSX call, identifiers bound outside the component).
 * - CSS fidelity: `className` strings and static `style={{…}}` objects pass
 *   through as props; computed styles become placeholders.
 *
 * Anything unresolved becomes `{ kind: 'opaque', reason }` or a warning, so the
 * client can show “插件控制” instead of a blank area.
 */
import type { RenderNode } from '../protocol/types.ts';
/** One slot registration discovered by static analysis. */
export interface TranspiledRegistration {
    readonly slot: string;
    readonly id?: string;
    readonly key?: string;
    readonly order?: number;
    readonly priority?: number;
    readonly locale?: string;
    readonly label?: string;
    /** Name of the component reference passed as the second argument. */
    readonly componentName?: string;
    /** Whether the call was `register` or `registerFactory`. */
    readonly kind: 'component' | 'factory';
}
/** One function/arrow component found in the bundle. */
export interface TranspiledComponent {
    /** Source-level name (identifier or variable the arrow is assigned to). */
    readonly name: string;
    /** Where in the source the component's expression starts (diagnostics). */
    readonly offset: number;
}
/** Everything a static pass over one bundle learns. */
export interface TranspiledBundle {
    /** Entry id (`<dirName>#lib/client.js`) this bundle was read as. */
    readonly entryId: string;
    /** Bundle source digest, so a client can tell a redeploy from a rename. */
    readonly digest: string;
    /** Factory-local identifier a bundler gave its JSX runtime (`jsx`, `jsxs`). */
    readonly jsxNames: readonly string[];
    readonly registrations: readonly TranspiledRegistration[];
    readonly components: readonly TranspiledComponent[];
    readonly warnings: readonly string[];
}
/** Result of building one component's tree. */
export interface TranspiledTree {
    readonly componentId: string;
    readonly tree: RenderNode | null;
    readonly warnings: readonly string[];
    /** True when a budget stopped the walk; the tree is then a prefix. */
    readonly truncated: boolean;
}
/** Ceilings applied to one parse / render. */
export interface TranspileBudget {
    /** Maximum bundle bytes the parser accepts. */
    readonly maxSourceBytes: number;
    /** Maximum element depth a component tree may reach. */
    readonly maxDepth: number;
    /** Maximum nodes one serialized tree may hold. */
    readonly maxNodes: number;
}
/** Default ceilings: generous enough for real cards, strict enough for a phone Host. */
export declare const DEFAULT_TRANSPILE_BUDGET: TranspileBudget;
/** One lexical token of the compiled bundle. */
interface Token {
    readonly kind: 'ident' | 'keyword' | 'string' | 'number' | 'template' | 'regex' | 'punct';
    readonly value: string;
    readonly start: number;
    readonly end: number;
    /** Source line (0-based) of `start`; diagnostics only. */
    readonly line: number;
}
/**
 * Tokenize one bundle into an array of tokens.
 *
 * The tokenizer is a scanner, not a parser: comments and strings are consumed
 * atomically, regex literals are distinguished from division by the previous
 * meaningful token, and everything else is an identifier, number, template
 * string, or punctuation. Source positions are kept on every token so warnings
 * can name a line.
 */
export declare function tokenize(source: string): Token[];
/**
 * Parse one compiled client bundle into registrations and component shapes.
 *
 * @param entryId - the bundle's entry id (package name).
 * @param source - the bundle's JavaScript text.
 * @param budget - ceilings for the pass.
 * @returns the static model.
 */
export declare function analyzeBundle(entryId: string, source: string, budget?: TranspileBudget): TranspiledBundle;
/** Digest of one bundle's source, recorded so a client can tell a redeploy from a rename. */
export declare function bundleSourceDigest(source: string): string;
/**
 * Build the render tree of one statically-found component.
 *
 * The component's returned expression is resolved with the caller's props as the
 * only environment; anything the expression reads beyond those props becomes an
 * `OpaqueNode`. Component references are inlined up to the depth budget so a
 * `<Card><Row/></Card>` composition still renders.
 *
 * @param source - the bundle's JavaScript text (re-parsed per call; callers that
 *   serve several components from one bundle should keep the parsed model).
 * @param componentName - source-level component name.
 * @param props - JSON-safe props from the request.
 * @param budget - ceilings for the build.
 * @returns the tree, its warnings, and whether a budget stopped the walk.
 */
export declare function buildComponentTree(source: string, componentName: string, props: Readonly<Record<string, unknown>>, budget?: TranspileBudget): TranspiledTree;
export {};
