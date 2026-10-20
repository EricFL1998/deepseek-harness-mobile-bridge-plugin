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
    /**
     * Host data this component fetches (`call("<method>")` paired with a setter).
     *
     * A client fills these with the method's result before rendering, so the tree can
     * show values the static pass cannot compute.
     */
    readonly data: readonly TranspiledDataSource[];
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
/** A forward-only walk over one token list with lookahead and matching helpers. */
declare class Cursor {
    readonly tokens: readonly Token[];
    at: number;
    constructor(tokens: readonly Token[]);
    get done(): boolean;
    peek(offset?: number): Token | undefined;
    next(): Token | undefined;
    /** Consume one token when it is the given punctuation. */
    eat(punct: string): boolean;
    /** Consume one token when it is the given identifier/keyword. */
    eatWord(word: string): boolean;
    /** Index of the token whose `start` is at-or-after the source offset. */
    indexAtOffset(offset: number): number;
    /** Index one past the punct-balanced region opened at `openIndex` (which holds `open`). */
    matchDelimiter(openIndex: number): number;
    /** Index one past the current statement: up to `;` or the closing `}` of a block. */
    skipStatement(): number;
}
/** Function-shape the analyzer recovered for one component. */
interface ComponentShape {
    readonly name: string;
    /** Binding identifiers the component's body reads (`{title:e}` → `e`). */
    readonly paramProps: readonly string[];
    /** Destructured *property* names in declaration order (`{title:e}` → `title`). */
    readonly paramKeys: readonly string[];
    /** True when the parameter is one plain identifier (`props.x` reads). */
    readonly paramIsIdentifier: boolean;
    /** Token index of the expression the component returns, or -1 when none. */
    readonly bodyStart: number;
    readonly bodyEnd: number;
    /** Token index of the function body's `{`, or -1 for an expression-body arrow. */
    readonly bodyOpen: number;
    /** Exclusive end of the body block, or -1 for an expression-body arrow. */
    readonly bodyClose: number;
    readonly offset: number;
}
/** Everything one bundle pass keeps. */
interface BundleModel {
    readonly cursor: Cursor;
    readonly source: string;
    readonly jsxNames: Set<string>;
    readonly registrations: TranspiledRegistration[];
    readonly components: Map<string, ComponentShape>;
    readonly warnings: string[];
    /** Host data injected for every component in this render (data RPC results). */
    readonly injected: Readonly<Record<string, unknown>>;
    readonly budget: TranspileBudget;
    /**
     * Locale dictionaries written as top-level string-object literals
     * (`const en = { nav: 'Subscriptions', … }`), keyed by their binding name.
     *
     * A client bundle carries its copy inside the bundle itself and reads it
     * through a `t(key)` helper, so the text a component shows is a plain lookup
     * the static pass can perform — no execution needed.
     */
    readonly dictionaries: Map<string, Map<string, string>>;
    /** The dictionary `t(key)` resolves through, chosen from the locale tags. */
    dictionary?: Map<string, string>;
    /** Binding name of {@link dictionary}; reported so a client knows the language. */
    dictionaryName?: string;
    /**
     * Module-level `const` bindings whose initializer is plain JSON
     * (`const styles = { … }`). Components read these freely; without them every
     * `styles.name` is an opaque member read.
     */
    readonly globals: Map<string, unknown>;
}
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
 * @param localeTags - preferred language tags, most preferred first. The first
 *   one naming a dictionary the bundle carries decides `t(key)` text.
 * @returns the tree, its warnings, and whether a budget stopped the walk.
 */
export declare function buildComponentTree(source: string, componentName: string, props: Readonly<Record<string, unknown>>, budget?: TranspileBudget, localeTags?: readonly string[]): TranspiledTree;
/**
 * Data a component reads from the Host: `const next = await call("status")` then
 * `setStatus(next)`.
 *
 * The renderer cannot compute what the plugin computes, but it can show the values
 * the plugin fetches. This pairing is what lets a client fetch the same method and
 * feed the result back as the state value.
 */
export interface TranspiledDataSource {
    /** Prop name the value is injected under (`status`, `usage`). */
    readonly state: string;
    /** Host method the plugin calls (`status` → `<plugin>.status`). */
    readonly method: string;
    /** Static payload argument, when the call passes an object literal. */
    readonly payload?: Record<string, unknown>;
    /**
     * Set when the call takes only `{ provider }`.
     *
     * The client then fetches the method once per provider in `status` and injects a
     * provider→result map, which is what the plugin's own usage state holds.
     */
    readonly scope?: 'provider';
}
/**
 * Pair every `call("<method>")` in a component body with the state it feeds.
 *
 * Only literal methods are reported: a computed method name has no stable identity
 * for the client to fetch.
 *
 * @param cursor - token stream of the bundle.
 * @param shape - the component to scan.
 * @returns one entry per discovered data source, in source order.
 */
export declare function extractDataSources(cursor: Cursor, shape: ComponentShape): TranspiledDataSource[];
/**
 * Every read-only data source any component in the bundle fetches.
 *
 * A page's values often come from its child components (the usage panel lives in a
 * provider card, not in the section that renders it), so the union is what a client
 * must fetch before rendering.
 *
 * @param model - the parsed bundle.
 * @returns one entry per distinct state name.
 */
export declare function collectBundleDataSources(model: BundleModel): TranspiledDataSource[];
export {};
