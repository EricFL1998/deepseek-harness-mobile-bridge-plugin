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
import { createHash } from 'node:crypto';
/** Default ceilings: generous enough for real cards, strict enough for a phone Host. */
export const DEFAULT_TRANSPILE_BUDGET = {
    maxSourceBytes: 8 * 1024 * 1024,
    maxDepth: 32,
    maxNodes: 4_000,
};
const KEYWORDS = new Set([
    'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
    'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for',
    'function', 'if', 'import', 'in', 'instanceof', 'new', 'return', 'switch',
    'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
    'let', 'static', 'of', 'true', 'false', 'null', 'undefined', 'get', 'set',
    'async', 'from', 'as',
]);
/** Punctuation sorted longest-first so `...` wins over `.` and `===` over `=`. */
const PUNCTS = [
    '>>>=', '...', '===', '!==', '>>>', '<<=', '>>=', '**=', '&&=', '||=', '??=',
    '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=',
    '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '**',
    '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%',
    '&', '|', '^', '!', '~', '?', ':', '=', '.',
];
/**
 * Tokenize one bundle into an array of tokens.
 *
 * The tokenizer is a scanner, not a parser: comments and strings are consumed
 * atomically, regex literals are distinguished from division by the previous
 * meaningful token, and everything else is an identifier, number, template
 * string, or punctuation. Source positions are kept on every token so warnings
 * can name a line.
 */
export function tokenize(source) {
    const tokens = [];
    const length = source.length;
    let index = 0;
    let line = 0;
    const push = (kind, value, start, end) => {
        tokens.push({ kind, value, start, end, line });
    };
    /** Regexes may start after these punctuations/keywords (division elsewhere). */
    const regexAllowedAfter = (previous) => {
        if (previous === undefined)
            return true;
        if (previous.kind === 'keyword') {
            return !['this', 'super', 'true', 'false', 'null', 'undefined'].includes(previous.value);
        }
        if (previous.kind !== 'punct')
            return false;
        return ![')', ']', '}', '++', '--'].includes(previous.value);
    };
    while (index < length) {
        const char = source[index];
        // Newlines / whitespace.
        if (char === '\n') {
            line += 1;
            index += 1;
            continue;
        }
        if (char === ' ' || char === '\t' || char === '\r' || char === '' || char === '') {
            index += 1;
            continue;
        }
        // Comments.
        if (char === '/' && source[index + 1] === '/') {
            while (index < length && source[index] !== '\n')
                index += 1;
            continue;
        }
        if (char === '/' && source[index + 1] === '*') {
            const end = source.indexOf('*/', index + 2);
            const stop = end < 0 ? length : end + 2;
            for (let at = index; at < stop; at += 1)
                if (source[at] === '\n')
                    line += 1;
            index = stop;
            continue;
        }
        // Strings.
        if (char === '"' || char === "'") {
            const start = index;
            index += 1;
            let value = '';
            while (index < length) {
                const c = source[index];
                if (c === '\\') {
                    value += source[index] + (source[index + 1] ?? '');
                    if (source[index + 1] === '\n')
                        line += 1;
                    index += 2;
                    continue;
                }
                if (c === char) {
                    index += 1;
                    break;
                }
                if (c === '\n') {
                    line += 1;
                }
                value += c;
                index += 1;
            }
            push('string', value, start, index);
            continue;
        }
        // Template literals (with `${…}` nesting).
        if (char === '`') {
            const start = index;
            index += 1;
            let value = '';
            let depth = 0;
            while (index < length) {
                const c = source[index];
                if (c === '\\') {
                    value += source[index] + (source[index + 1] ?? '');
                    index += 2;
                    continue;
                }
                if (c === '`' && depth === 0) {
                    index += 1;
                    break;
                }
                if (c === '$' && source[index + 1] === '{') {
                    depth += 1;
                    value += '${';
                    index += 2;
                    continue;
                }
                if (c === '}' && depth > 0) {
                    depth -= 1;
                    value += c;
                    index += 1;
                    continue;
                }
                if (c === '\n')
                    line += 1;
                value += c;
                index += 1;
            }
            push('template', value, start, index);
            continue;
        }
        // Regex literals.
        if (char === '/' && regexAllowedAfter(tokens[tokens.length - 1])) {
            const start = index;
            index += 1;
            let inClass = false;
            while (index < length) {
                const c = source[index];
                if (c === '\\') {
                    index += 2;
                    continue;
                }
                if (c === '\n')
                    break;
                if (c === '[')
                    inClass = true;
                else if (c === ']')
                    inClass = false;
                else if (c === '/' && !inClass) {
                    index += 1;
                    break;
                }
                index += 1;
            }
            while (index < length && /[a-z]/i.test(source[index]))
                index += 1;
            push('regex', source.slice(start, index), start, index);
            continue;
        }
        // Numbers (decimal, hex/oct/bin, exponents, separators).
        if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(source[index + 1] ?? ''))) {
            const start = index;
            const match = /^(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.[\d_]+)(?:[eE][+-]?[\d_]+)?n?)/.exec(source.slice(index));
            index += match?.[0].length ?? 1;
            push('number', source.slice(start, index), start, index);
            continue;
        }
        // Identifiers.
        if (/[A-Za-z_$]/.test(char)) {
            const start = index;
            while (index < length && /[\w$]/.test(source[index]))
                index += 1;
            const value = source.slice(start, index);
            push(KEYWORDS.has(value) ? 'keyword' : 'ident', value, start, index);
            continue;
        }
        // Punctuation.
        let matched;
        for (const punct of PUNCTS) {
            if (source.startsWith(punct, index)) {
                matched = punct;
                break;
            }
        }
        if (matched === undefined) {
            // Unknown byte: skip it so one exotic character never aborts the pass.
            index += 1;
            continue;
        }
        push('punct', matched, index, index + matched.length);
        index += matched.length;
    }
    return tokens;
}
// ---------------------------------------------------------------------------
// Token cursor
// ---------------------------------------------------------------------------
/** A forward-only walk over one token list with lookahead and matching helpers. */
class Cursor {
    tokens;
    at = 0;
    constructor(tokens) {
        this.tokens = tokens;
    }
    get done() { return this.at >= this.tokens.length; }
    peek(offset = 0) { return this.tokens[this.at + offset]; }
    next() { return this.tokens[this.at++]; }
    /** Consume one token when it is the given punctuation. */
    eat(punct) {
        const token = this.tokens[this.at];
        if (token !== undefined && token.kind === 'punct' && token.value === punct) {
            this.at += 1;
            return true;
        }
        return false;
    }
    /** Consume one token when it is the given identifier/keyword. */
    eatWord(word) {
        const token = this.tokens[this.at];
        if (token !== undefined && (token.kind === 'ident' || token.kind === 'keyword') && token.value === word) {
            this.at += 1;
            return true;
        }
        return false;
    }
    /** Index of the token whose `start` is at-or-after the source offset. */
    indexAtOffset(offset) {
        let lo = this.at;
        let hi = this.tokens.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (this.tokens[mid].start < offset)
                lo = mid + 1;
            else
                hi = mid;
        }
        return lo;
    }
    /** Index one past the punct-balanced region opened at `openIndex` (which holds `open`). */
    matchDelimiter(openIndex) {
        const openToken = this.tokens[openIndex];
        if (openToken === undefined || openToken.kind !== 'punct')
            return openIndex + 1;
        const close = { '(': ')', '{': '}', '[': ']' }[openToken.value];
        if (close === undefined)
            return openIndex + 1;
        let depth = 0;
        for (let at = openIndex; at < this.tokens.length; at += 1) {
            const token = this.tokens[at];
            if (token.kind !== 'punct')
                continue;
            if (token.value === openToken.value)
                depth += 1;
            else if (token.value === close) {
                depth -= 1;
                if (depth === 0)
                    return at + 1;
            }
        }
        return this.tokens.length;
    }
    /** Index one past the current statement: up to `;` or the closing `}` of a block. */
    skipStatement() {
        let at = this.at;
        while (at < this.tokens.length) {
            const token = this.tokens[at];
            if (token.kind === 'punct') {
                if (token.value === ';')
                    return at + 1;
                if (token.value === '{' || token.value === '(' || token.value === '[') {
                    at = this.matchDelimiter(at);
                    continue;
                }
                if (token.value === '}')
                    return at;
            }
            at += 1;
        }
        return at;
    }
}
// ---------------------------------------------------------------------------
// Bundle analysis
// ---------------------------------------------------------------------------
/**
 * Parse one compiled client bundle into registrations and component shapes.
 *
 * @param entryId - the bundle's entry id (package name).
 * @param source - the bundle's JavaScript text.
 * @param budget - ceilings for the pass.
 * @returns the static model.
 */
export function analyzeBundle(entryId, source, budget = DEFAULT_TRANSPILE_BUDGET) {
    const warnings = [];
    if (Buffer.byteLength(source, 'utf8') > budget.maxSourceBytes) {
        return {
            entryId,
            digest: createHash('sha256').update(source).digest('hex'),
            jsxNames: [],
            registrations: [],
            components: [],
            warnings: [`bundle exceeds the ${budget.maxSourceBytes}-byte source ceiling; not parsed`],
        };
    }
    const model = buildModel(source, budget, warnings);
    return {
        entryId,
        digest: createHash('sha256').update(source).digest('hex'),
        jsxNames: [...model.jsxNames],
        registrations: model.registrations,
        components: [...model.components.values()].map(shape => ({
            name: shape.name,
            offset: shape.offset,
        })),
        warnings,
    };
}
/** Digest of one bundle's source, recorded so a client can tell a redeploy from a rename. */
export function bundleSourceDigest(source) {
    return createHash('sha256').update(source).digest('hex');
}
/**
 * Build the internal model: tokenize, then walk every statement collecting
 * bindings, components and registrations.
 */
function buildModel(source, budget, warnings) {
    const cursor = new Cursor(tokenize(source));
    const model = {
        injected: {},
        cursor,
        source,
        jsxNames: new Set(),
        registrations: [],
        components: new Map(),
        warnings,
        budget,
        dictionaries: new Map(),
        globals: new Map(),
    };
    collectBindings(cursor, model);
    collectDictionaries(cursor, model);
    collectGlobals(cursor, model);
    // Pass 1: bind function declarations and `const Name = …` component
    // initializers everywhere, so a `register(…, Component)` call and a JSX
    // `<Child/>` reference resolve no matter which appears first in the source.
    bindComponents(cursor, 0, cursor.tokens.length, model);
    // Pass 2: find every `register(…)` call. A second pass is required because
    // the calls live inside `apply`, which pass 1 deliberately does not treat as
    // a component (its `return` yields no tree).
    scanRegistrations(cursor, model);
    return model;
}
/**
 * Learn the bundler's helper names from its `var … = …` preamble:
 * the JSX-runtime aliases (`jsx`, `jsxs`, `jsxDEV`) are the identifiers whose
 * initializer is a `require(…)` call, plus the `React`-named namespace object.
 */
function collectBindings(cursor, model) {
    // Always know the canonical runtime names; a bundler preamble adds its own
    // aliases on top (they share these spellings in rolldown's default output,
    // and the extras cost nothing when absent).
    model.jsxNames.add('jsx');
    model.jsxNames.add('jsxs');
    model.jsxNames.add('jsxDEV');
    model.jsxNames.add('React.createElement');
    for (let at = 0; at < cursor.tokens.length; at += 1) {
        const token = cursor.tokens[at];
        if (token.kind !== 'ident')
            continue;
        if (token.value !== 'React')
            continue;
        const next = cursor.tokens[at + 1];
        if (next === undefined || next.kind !== 'punct' || next.value !== '=')
            continue;
        model.jsxNames.add('React.createElement');
    }
}
/**
 * Name a bundle gives its copy dictionary, most bundles following one of these.
 *
 * The dictionary is recognised by shape (a top-level object of string values),
 * so a bundle that names it `copy` or `strings` is found too; these names simply
 * decide which candidates are checked first when several string-objects exist.
 */
const DICTIONARY_NAMES = new Set(['en', 'zh', 'copy', 'messages', 'strings', 'locale', 'dict', 'translations']);
/**
 * Names a bundle uses for its translate helper. A client bundle binds
 * `const t = ctx.locale.bind(ns)` or falls back to a local `fallbackTranslate`,
 * and every call site then reads `t('key')`.
 */
const TRANSLATE_NAMES = new Set(['t', 'tr', 'translate', 'fallbackTranslate', 'fallback', '$t', '_t']);
/**
 * Collect every top-level string-object literal that looks like a locale table.
 *
 * A locale table is recognised structurally: a `const|let|var` initializer whose
 * object literal holds at least a handful of properties and whose values are all
 * quoted strings. Anything else (a config object, a style map) has mixed values
 * and is skipped, so a bundle is never mistranslated as a dictionary.
 */
function collectDictionaries(cursor, model) {
    for (let at = 0; at < cursor.tokens.length - 3; at += 1) {
        const keyword = cursor.tokens[at];
        if (keyword.kind !== 'keyword' || (keyword.value !== 'const' && keyword.value !== 'let' && keyword.value !== 'var'))
            continue;
        const name = cursor.tokens[at + 1];
        const assign = cursor.tokens[at + 2];
        const open = cursor.tokens[at + 3];
        if (name?.kind !== 'ident' || assign?.value !== '=' || open?.kind !== 'punct' || open.value !== '{')
            continue;
        const close = cursor.matchDelimiter(at + 3) - 1;
        const table = readStringTable(cursor, at + 3, close);
        if (table === undefined)
            continue;
        // A style map and a nested config both pass the "string values" test when
        // shallow; a real locale table is wide, so width is the discriminator.
        const isNamed = DICTIONARY_NAMES.has(name.value);
        if (!isNamed && table.size < 24)
            continue;
        if (table.size < 6)
            continue;
        model.dictionaries.set(name.value, table);
    }
}
/**
 * Read one object literal as a flat string table.
 *
 * A real locale table is mostly `key: 'text'`, but it may also carry a nested
 * group or a computed value. Those members are skipped rather than rejecting the
 * whole table: dropping a dictionary because one entry is nested would silently
 * turn every `t(key)` on the page into an opaque node.
 */
function readStringTable(cursor, openAt, closeAt) {
    const table = new Map();
    for (const [a, b] of splitTopLevel(cursor, openAt + 1, closeAt)) {
        const key = cursor.tokens[a];
        if (key === undefined || (key.kind !== 'ident' && key.kind !== 'string'))
            continue;
        if (cursor.tokens[a + 1]?.kind !== 'punct' || cursor.tokens[a + 1]?.value !== ':')
            continue;
        const value = cursor.tokens[a + 2];
        if (b !== a + 3 || value === undefined || value.kind !== 'string')
            continue;
        table.set(key.value, decodeEscapes(value.value));
    }
    return table.size === 0 ? undefined : table;
}
/**
 * Choose the dictionary `t(key)` resolves through: the first configured locale
 * tag that names a table (or a base language it starts with), else `en`, else the
 * widest table.
 */
function chooseDictionary(model, localeTags) {
    const pick = (name) => {
        const exact = model.dictionaries.get(name);
        if (exact !== undefined)
            return exact;
        const base = name.split('-')[0] ?? name;
        return model.dictionaries.get(base);
    };
    for (const tag of localeTags) {
        const found = pick(tag);
        if (found !== undefined) {
            model.dictionary = found;
            model.dictionaryName = tag;
            return;
        }
    }
    const fallbackOrder = ['en', 'zh', 'copy', 'strings', 'messages'];
    for (const name of fallbackOrder) {
        const found = model.dictionaries.get(name);
        if (found !== undefined) {
            model.dictionary = found;
            model.dictionaryName = name;
            return;
        }
    }
    let widest;
    let widestName;
    for (const [name, table] of model.dictionaries) {
        if (widest === undefined || table.size > widest.size) {
            widest = table;
            widestName = name;
        }
    }
    model.dictionary = widest;
    model.dictionaryName = widestName;
}
/**
 * Collect module-level `const NAME = { … }` / `= [ … ]` bindings that hold plain
 * JSON. Components read style tables and constant lists this way; without them
 * every `styles.name` read is opaque, and the client loses the styling and the
 * static content alike.
 */
function collectGlobals(cursor, model) {
    for (let at = 0; at < cursor.tokens.length - 3; at += 1) {
        const keyword = cursor.tokens[at];
        if (keyword.kind !== 'keyword')
            continue;
        if (keyword.value !== 'const' && keyword.value !== 'let' && keyword.value !== 'var')
            continue;
        const name = cursor.tokens[at + 1];
        if (name?.kind !== 'ident')
            continue;
        if (cursor.tokens[at + 2]?.value !== '=')
            continue;
        const open = cursor.tokens[at + 3];
        if (open === undefined || open.kind !== 'punct')
            continue;
        if (open.value !== '{' && open.value !== '[')
            continue;
        const close = cursor.matchDelimiter(at + 3);
        const value = readStaticValue(cursor, at + 3, close, model, emptyEnv());
        if (value.t === 'value')
            model.globals.set(name.value, value.v);
    }
}
/**
 * Scan one token region for `register(…)` calls.
 */
function scanRegistrations(cursor, model) {
    for (let at = 0; at < cursor.tokens.length; at += 1) {
        const token = cursor.tokens[at];
        if (token.kind === 'ident' && (token.value === 'register' || token.value === 'registerFactory')) {
            const before = cursor.tokens[at - 1];
            const open = cursor.tokens[at + 1];
            if (before?.kind === 'punct' && before.value === '.' && open?.kind === 'punct' && open.value === '(') {
                const registration = readRegistration(cursor, at, model, token.value === 'registerFactory');
                if (registration !== undefined)
                    model.registrations.push(registration);
            }
        }
    }
}
/**
 * Read one `register({…}, Component)` call starting at the `register` token.
 */
function readRegistration(cursor, registerAt, model, factory) {
    const openAt = registerAt + 1;
    const closeAt = cursor.matchDelimiter(openAt) - 1;
    const argStart = openAt + 1;
    // Split the arguments on top-level commas.
    const args = splitTopLevel(cursor, argStart, closeAt);
    if (args.length === 0)
        return undefined;
    const record = readStaticObject(cursor, args[0][0], args[0][1], model);
    if (record === undefined)
        return undefined;
    const slot = record.get('name');
    const slotName = slot !== undefined && slot.t === 'text' ? slot.text
        : slot !== undefined && slot.t === 'value' && typeof slot.v === 'string' ? slot.v
            : undefined;
    if (slotName === undefined)
        return undefined;
    const component = args[1] === undefined ? undefined : readStaticValue(cursor, args[1][0], args[1][1], model, emptyEnv());
    const text = (key) => {
        const value = record.get(key);
        if (value === undefined)
            return undefined;
        if (value.t === 'text')
            return value.text;
        return value.t === 'value' && typeof value.v === 'string' ? value.v : undefined;
    };
    const num = (key) => {
        const value = record.get(key);
        return value !== undefined && value.t === 'value' && typeof value.v === 'number' ? value.v : undefined;
    };
    return {
        slot: slotName,
        ...(text('id') === undefined ? {} : { id: text('id') }),
        ...(text('key') === undefined ? {} : { key: text('key') }),
        ...(num('order') === undefined ? {} : { order: num('order') }),
        ...(num('priority') === undefined ? {} : { priority: num('priority') }),
        ...(text('locale') === undefined ? {} : { locale: text('locale') }),
        ...(text('label') === undefined ? {} : { label: text('label') }),
        ...(component !== undefined && component.t === 'component-ref' ? { componentName: component.n } : {}),
        kind: factory ? 'factory' : 'component',
    };
}
/**
 * Bind every component definition in one token region.
 *
 * Two definition shapes count: `function Name(…) {…}` declarations (named
 * function expressions are reached through their binding) and
 * `const|let|var Name = (arrow|function)` initializers. `apply` itself is
 * recorded too — a plugin could register a component under any name, and the
 * tree builder simply finds no JSX in bodies that are not components.
 */
function bindComponents(cursor, start, end, model) {
    let at = start;
    while (at < end) {
        const token = cursor.tokens[at];
        // `function Name(…) {…}`.
        if (token.kind === 'keyword' && token.value === 'function') {
            const shape = readFunction(cursor, at, model);
            if (shape !== undefined)
                model.components.set(shape.name, shape);
        }
        // `const|let|var Name = …` declaration lists.
        if (token.kind === 'keyword' && (token.value === 'const' || token.value === 'let' || token.value === 'var')) {
            at = readVariableDeclarations(cursor, at, end, model);
            continue;
        }
        at += 1;
    }
}
/**
 * Read a `function` declaration/expression starting at its keyword.
 */
function readFunction(cursor, functionAt, model) {
    const nameToken = cursor.tokens[functionAt + 1];
    // Anonymous function expressions are reached through their binding instead.
    if (nameToken === undefined || nameToken.kind !== 'ident')
        return undefined;
    const paramsOpen = functionAt + 2;
    if (cursor.tokens[paramsOpen]?.value !== '(')
        return undefined;
    const paramsClose = cursor.matchDelimiter(paramsOpen) - 1;
    const bodyOpen = cursor.tokens[paramsClose + 1]?.value === '{' ? paramsClose + 1 : undefined;
    if (bodyOpen === undefined)
        return undefined;
    const bodyClose = cursor.matchDelimiter(bodyOpen) - 1;
    const returnAt = findReturn(cursor, bodyOpen + 1, bodyClose);
    const props = readParams(cursor, paramsOpen + 1, paramsClose);
    return {
        name: nameToken.value,
        paramProps: props.names,
        paramKeys: props.keys,
        paramIsIdentifier: props.identifier,
        bodyStart: returnAt,
        bodyEnd: returnAt >= 0 ? expressionEnd(cursor, returnAt, bodyClose) : -1,
        bodyOpen: bodyOpen ?? -1,
        bodyClose,
        offset: nameToken.start,
    };
}
/**
 * Read one `const|let|var` declaration list; every PascalCase binding whose
 * initializer is an arrow or function becomes a component candidate.
 * @returns the token index to continue the scan from.
 */
function readVariableDeclarations(cursor, at, end, model) {
    let index = at + 1;
    while (index < end) {
        const token = cursor.tokens[index];
        if (token.kind === 'punct' && token.value === ';')
            return index + 1;
        if (token.kind === 'punct' && (token.value === '}' || token.value === ')'))
            return index;
        if (token.kind === 'ident') {
            const eq = cursor.tokens[index + 1];
            if (eq?.kind === 'punct' && eq.value === '=') {
                const shape = readFunctionLike(cursor, token, index + 2, model);
                if (shape !== undefined && /^[A-Z]/.test(shape.name)) {
                    model.components.set(shape.name, shape);
                }
            }
        }
        index += 1;
        // Never run past the statement's end.
        if (cursor.tokens[index - 1]?.kind === 'punct' && cursor.tokens[index - 1]?.value === ',')
            continue;
    }
    return index;
}
/**
 * Read an arrow or anonymous-function initializer at `initAt` for binding `name`.
 */
function readFunctionLike(cursor, nameToken, initAt, model) {
    const first = cursor.tokens[initAt];
    if (first === undefined)
        return undefined;
    // `Name = function (…) {…}`
    if (first.kind === 'keyword' && first.value === 'function') {
        let at = initAt + 1;
        if (cursor.tokens[at]?.kind === 'ident')
            at += 1;
        if (cursor.tokens[at]?.value !== '(')
            return undefined;
        const paramsClose = cursor.matchDelimiter(at) - 1;
        if (cursor.tokens[paramsClose + 1]?.value !== '{')
            return undefined;
        const bodyOpen = paramsClose + 1;
        const bodyClose = cursor.matchDelimiter(bodyOpen) - 1;
        const props = readParams(cursor, at + 1, paramsClose);
        const returnAt = findReturn(cursor, bodyOpen + 1, bodyClose);
        return {
            name: nameToken.value,
            paramProps: props.names,
            paramKeys: props.keys,
            paramIsIdentifier: props.identifier,
            bodyStart: returnAt,
            bodyEnd: returnAt >= 0 ? expressionEnd(cursor, returnAt, bodyClose) : -1,
            bodyOpen,
            bodyClose,
            offset: nameToken.start,
        };
    }
    // `Name = (…) => …` or `Name = x => …`
    let paramsOpen = initAt;
    if (first.kind === 'ident' && cursor.tokens[initAt + 1]?.value === '=>') {
        const props = { names: [first.value], keys: [first.value], identifier: true };
        return arrowShape(cursor, nameToken, props, initAt + 2);
    }
    if (first.kind !== 'punct' || first.value !== '(')
        return undefined;
    const paramsClose = cursor.matchDelimiter(paramsOpen) - 1;
    if (cursor.tokens[paramsClose + 1]?.value !== '=>')
        return undefined;
    const props = readParams(cursor, paramsOpen + 1, paramsClose);
    return arrowShape(cursor, nameToken, props, paramsClose + 2);
}
/** Build the shape of one arrow component from the start of its body expression. */
function arrowShape(cursor, nameToken, props, bodyStart) {
    let start = bodyStart;
    let end = cursor.tokens.length;
    if (cursor.tokens[start]?.kind === 'punct' && cursor.tokens[start]?.value === '{') {
        const bodyOpen = start;
        const bodyClose = cursor.matchDelimiter(bodyOpen) - 1;
        const returnAt = findReturn(cursor, bodyOpen + 1, bodyClose);
        return {
            name: nameToken.value,
            paramProps: props.names,
            paramKeys: props.keys,
            paramIsIdentifier: props.identifier,
            bodyStart: returnAt,
            bodyEnd: returnAt >= 0 ? expressionEnd(cursor, returnAt, bodyClose) : -1,
            bodyOpen,
            bodyClose,
            offset: nameToken.start,
        };
    }
    end = expressionEnd(cursor, start, end);
    return {
        name: nameToken.value,
        paramProps: props.names,
        paramKeys: props.keys,
        paramIsIdentifier: props.identifier,
        bodyStart: start,
        bodyEnd: end,
        bodyOpen: -1,
        bodyClose: -1,
        offset: nameToken.start,
    };
}
/**
 * Parameter names of one parameter list.
 *
 * A destructured parameter yields two parallel lists:
 * - `keys` — the *property path*, in declaration order. A flat member is its own
 *   name (`{title:e}` → `title`); a nested destructuring is a dotted path
 *   (`{status:{displayName:d}}` → `status.displayName`). Minification never
 *   renames object keys, so this is the identity a value can be looked up by;
 * - `names` — the *binding* identifiers an expression reads (`{title:e}` → `e`,
 *   `{used}` → `used`). These are what `readStaticValue` resolves.
 *
 * `identifier` is true for the `props` form, where reads are `props.x` members
 * instead of destructured bindings.
 */
function readParams(cursor, start, close) {
    const names = [];
    const keys = [];
    if (cursor.tokens[start]?.kind === 'punct' && cursor.tokens[start]?.value === '{') {
        collectDestructured(cursor, start, close, '', names, keys);
        return { names, keys, identifier: false };
    }
    const single = cursor.tokens[start]?.kind === 'ident' ? cursor.tokens[start].value : undefined;
    return {
        names: single === undefined ? [] : [single],
        keys: single === undefined ? [] : [single],
        identifier: single !== undefined,
    };
}
/**
 * Collect one destructuring group, recursing into nested object patterns.
 * @param prefix dotted path of the group, empty at the parameter's top level.
 */
function collectDestructured(cursor, openAt, close, prefix, names, keys) {
    let at = openAt + 1;
    while (at < close) {
        const token = cursor.tokens[at];
        if (token.kind !== 'ident' && token.kind !== 'string') {
            at += 1;
            continue;
        }
        const key = token.value;
        const path = prefix.length === 0 ? key : `${prefix}.${key}`;
        const next = cursor.tokens[at + 1];
        if (next?.kind === 'punct' && next.value === ':') {
            const binding = cursor.tokens[at + 2];
            if (binding === undefined)
                return;
            // `{ outer: { inner } }` — recurse, keeping the dotted prefix.
            if (binding.kind === 'punct' && binding.value === '{') {
                const groupClose = cursor.matchDelimiter(at + 2) - 1;
                collectDestructured(cursor, at + 2, groupClose, path, names, keys);
                at = groupClose + 1;
                continue;
            }
            if (binding.kind === 'ident') {
                names.push(binding.value);
                keys.push(path);
            }
            // Skip a default `= <expr>` and any following member.
            at += 3;
            while (at < close) {
                const skip = cursor.tokens[at];
                if (skip.kind === 'punct' && (skip.value === ',' || skip.value === '}'))
                    break;
                if (skip.kind === 'punct' && (skip.value === '(' || skip.value === '[' || skip.value === '{')) {
                    at = cursor.matchDelimiter(at);
                    continue;
                }
                at += 1;
            }
            continue;
        }
        // Shorthand `{ title }` (optionally with a default).
        names.push(key);
        keys.push(path);
        at += 1;
        while (at < close) {
            const skip = cursor.tokens[at];
            if (skip.kind === 'punct' && (skip.value === ',' || skip.value === '}'))
                break;
            if (skip.kind === 'punct' && (skip.value === '(' || skip.value === '[' || skip.value === '{')) {
                at = cursor.matchDelimiter(at);
                continue;
            }
            at += 1;
        }
    }
}
/**
 * The `return` whose expression is the component's main render, or -1.
 *
 * A component commonly opens with early returns for empty/loading/error states
 * and returns the real layout last. Taking the *first* return therefore
 * produces a nearly empty tree for exactly the components worth rendering, so
 * the widest top-level return wins: among several branches, the main render is
 * the one carrying the most structure. Ties keep the earlier (source) order.
 */
function findReturn(cursor, start, close) {
    const candidates = [];
    let depth = 0;
    for (let at = start; at < close; at += 1) {
        const token = cursor.tokens[at];
        if (token.kind === 'punct' && token.value === '{')
            depth += 1;
        else if (token.kind === 'punct' && token.value === '}')
            depth -= 1;
        else if (depth === 0 && token.kind === 'keyword' && token.value === 'return') {
            candidates.push(at + 1);
        }
        // Nested function bodies are skipped entirely.
        if (token.kind === 'keyword' && token.value === 'function') {
            let at2 = at + 1;
            if (cursor.tokens[at2]?.kind === 'ident')
                at2 += 1;
            if (cursor.tokens[at2]?.value === '(') {
                const paramsClose = cursor.matchDelimiter(at2) - 1;
                if (cursor.tokens[paramsClose + 1]?.value === '{') {
                    at = cursor.matchDelimiter(paramsClose + 1) - 1;
                    continue;
                }
            }
        }
    }
    if (candidates.length === 0)
        return -1;
    let best = candidates[0];
    let bestWidth = -1;
    for (const candidate of candidates) {
        const width = expressionEnd(cursor, candidate, close) - candidate;
        if (width > bestWidth) {
            bestWidth = width;
            best = candidate;
        }
    }
    return best;
}
/**
 * One-past-the-end token index of the expression starting at `start`, bounded
 * by `limit`. Stops at a top-level `;`, `,` at depth 0 of a statement, or a
 * closing `}`/`]` that closes the enclosing statement context.
 */
function expressionEnd(cursor, start, limit) {
    let at = start;
    while (at < limit) {
        const token = cursor.tokens[at];
        if (token.kind === 'punct') {
            // A delimited region belongs to the expression…
            if (token.value === '(' || token.value === '[') {
                at = cursor.matchDelimiter(at);
                continue;
            }
            // …and so does an object literal — but only in expression position. A
            // `{` that opens a *statement* block (an if/else body, the function's own
            // closing context) ends the expression, which the callers that bound us
            // by a block's closing `}` already encoded in `limit`.
            if (token.value === '{') {
                const prev = cursor.tokens[at - 1];
                const opensBlock = prev === undefined
                    || (prev.kind === 'punct' && (prev.value === ')' || prev.value === '{' || prev.value === ';' || prev.value === '}'))
                    || (prev.kind === 'keyword' && (prev.value === 'else' || prev.value === 'do' || prev.value === 'try' || prev.value === 'finally'));
                if (opensBlock)
                    return at;
                at = cursor.matchDelimiter(at);
                continue;
            }
            if (token.value === ';' || token.value === '}' || token.value === ']')
                return at;
            if (token.value === ',') {
                // A top-level comma ends a returned expression but not an arrow body in
                // a variable declaration list; both cases want the expression to stop.
                return at;
            }
        }
        at += 1;
    }
    return limit;
}
/** Split one token range into top-level comma-separated spans. */
function splitTopLevel(cursor, start, end) {
    const spans = [];
    let spanStart = start;
    let at = start;
    while (at < end) {
        const token = cursor.tokens[at];
        if (token.kind === 'punct') {
            if (token.value === '(' || token.value === '{' || token.value === '[') {
                at = cursor.matchDelimiter(at);
                continue;
            }
            if (token.value === ',') {
                spans.push([spanStart, at]);
                spanStart = at + 1;
            }
        }
        at += 1;
    }
    if (spanStart < end)
        spans.push([spanStart, end]);
    return spans.filter(([a, b]) => a < b);
}
/** Read one object-literal span into a property map, when every value is static. */
function readStaticObject(cursor, start, end, model) {
    const open = cursor.tokens[start];
    if (open === undefined || open.kind !== 'punct' || open.value !== '{')
        return undefined;
    // The span may end at the closing `}` itself (a top-level-comma split) or one
    // past it (a matchDelimiter result); both describe the same object body.
    const close = cursor.tokens[end - 1]?.kind === 'punct' && cursor.tokens[end - 1]?.value === '}' ? end - 1 : end;
    const record = new Map();
    for (const [a, b] of splitTopLevel(cursor, start + 1, close)) {
        const name = cursor.tokens[a];
        if (name === undefined || (name.kind !== 'ident' && name.kind !== 'string'))
            continue;
        if (cursor.tokens[a + 1]?.kind !== 'punct' || cursor.tokens[a + 1]?.value !== ':')
            continue;
        record.set(name.value, readStaticValue(cursor, a + 2, b, model, emptyEnv()));
    }
    return record;
}
function emptyEnv() {
    return {
        destructured: new Set(),
        bindings: [],
        keys: [],
        identifier: false,
        values: {},
        locals: new Map(),
    };
}
/** Build the environment one component's parameters read from. */
function envOf(shape, props, globals) {
    return {
        destructured: new Set(shape.paramProps),
        bindings: shape.paramProps,
        keys: shape.paramKeys,
        identifier: shape.paramIsIdentifier,
        values: props,
        locals: new Map(globals ?? []),
    };
}
/** A copy of one environment with additional local bindings. */
function withLocals(env, locals) {
    return {
        destructured: env.destructured,
        bindings: env.bindings,
        keys: env.keys,
        identifier: env.identifier,
        values: env.values,
        locals,
    };
}
/**
 * Apply the statements a function body runs before its return.
 *
 * A component commonly takes `props` and destructures inside the body
 * (`function Card(props) { const { status, t } = props; … }`), and a page derives
 * its data with a local (`const rows = props.status.providers`). Without this pass
 * every such name is unknown, which is exactly why a data-driven card rendered as
 * empty placeholders.
 *
 * Only what a static pass can answer is evaluated: `const|let|var` bindings whose
 * initializer resolves to a JSON value, including object and array destructuring.
 * Anything else is skipped, leaving the name unresolved rather than guessed.
 */
function evaluateBody(cursor, model, shape, props) {
    let env = envOf(shape, props, model.globals);
    if (shape.bodyOpen < 0 || shape.bodyClose < 0)
        return env;
    const locals = new Map(env.locals);
    env = withLocals(env, locals);
    let at = shape.bodyOpen + 1;
    while (at < shape.bodyClose) {
        const token = cursor.tokens[at];
        if (token.kind === 'punct' && token.value === '{') {
            // A nested block, or a destructuring pattern: only a declaration list is
            // interesting here, so skip the group and keep scanning at its end.
            at = cursor.matchDelimiter(at);
            continue;
        }
        if (token.kind === 'keyword' && (token.value === 'const' || token.value === 'let' || token.value === 'var')) {
            at = readLocalDeclaration(cursor, model, at, shape.bodyClose, env, locals, props);
            continue;
        }
        at += 1;
    }
    return env;
}
/**
 * Read one `const|let|var` declaration list into `locals`.
 * @returns the token index to continue scanning from.
 */
function readLocalDeclaration(cursor, model, declareAt, limit, env, locals, injected = {}) {
    let at = declareAt + 1;
    while (at < limit) {
        const target = cursor.tokens[at];
        if (target === undefined)
            return limit;
        if (target.kind === 'punct' && target.value === ';')
            return at + 1;
        // Object pattern: `const { a, b: c } = expr`.
        if (target.kind === 'punct' && target.value === '{') {
            const close = cursor.matchDelimiter(at) - 1;
            if (cursor.tokens[close + 1]?.value !== '=')
                return close + 1;
            const valueEnd = expressionEnd(cursor, close + 2, limit);
            const value = readStaticValue(cursor, close + 2, valueEnd, model, env);
            if (value.t === 'value') {
                const names = [];
                const keys = [];
                collectDestructured(cursor, at, close, '', names, keys);
                for (let index = 0; index < names.length; index += 1) {
                    const walked = walkPath(value.v, (keys[index] ?? '').split('.'));
                    if (walked !== undefined)
                        locals.set(names[index], walked);
                }
            }
            at = valueEnd;
            if (cursor.tokens[at]?.value === ',') {
                at += 1;
                continue;
            }
            return at;
        }
        // Array pattern: `const [a, b] = expr`.
        if (target.kind === 'punct' && target.value === '[') {
            const close = cursor.matchDelimiter(at) - 1;
            if (cursor.tokens[close + 1]?.value !== '=')
                return close + 1;
            const valueEnd = expressionEnd(cursor, close + 2, limit);
            // `const [open, setOpen] = useState(false)`: the first render's state is the
            // hook's initial value. Binding it makes `{open && …}` and a card's status
            // badge follow the real first paint instead of an unresolved conditional.
            const initial = readHookInitial(cursor, close + 2, valueEnd, model, env);
            if (initial !== undefined) {
                let index = 0;
                for (let slot = at + 1; slot < close; slot += 1) {
                    const name = cursor.tokens[slot];
                    if (name?.kind === 'ident') {
                        if (index === 0) {
                            // A client that already fetched this state's Host data passes it as a
                            // prop of the same name; that value wins over the declaration's initial.
                            const injectedValue = injected[name.value];
                            locals.set(name.value, injectedValue === undefined ? initial.value : injectedValue);
                        }
                        index += 1;
                    }
                }
                at = valueEnd;
                if (cursor.tokens[at]?.value === ',') {
                    at += 1;
                    continue;
                }
                return at;
            }
            const value = readStaticValue(cursor, close + 2, valueEnd, model, env);
            if (value.t === 'value' && Array.isArray(value.v)) {
                let index = 0;
                for (let slot = at + 1; slot < close; slot += 1) {
                    const name = cursor.tokens[slot];
                    if (name?.kind === 'ident') {
                        const item = value.v[index];
                        if (item !== undefined)
                            locals.set(name.value, item);
                        index += 1;
                    }
                }
            }
            at = valueEnd;
            if (cursor.tokens[at]?.value === ',') {
                at += 1;
                continue;
            }
            return at;
        }
        // Simple binding: `const rows = expr`.
        if (target.kind === 'ident' && cursor.tokens[at + 1]?.value === '=') {
            const valueEnd = expressionEnd(cursor, at + 2, limit);
            // A helper function the body declares: keep its shape so a later call can
            // be inlined (`const rank = provider => …` then `rank(left) - rank(right)`).
            const helper = readCallback(cursor, at + 2, valueEnd, model);
            if (helper !== undefined) {
                locals.set(target.value, { __dshLocalFunction: true, shape: helper });
                at = valueEnd;
                if (cursor.tokens[at]?.value === ',') {
                    at += 1;
                    continue;
                }
                return at;
            }
            const value = readStaticValue(cursor, at + 2, valueEnd, model, env);
            if (value.t === 'value')
                locals.set(target.value, value.v);
            else if (value.t === 'text')
                locals.set(target.value, value.text);
            at = valueEnd;
            if (cursor.tokens[at]?.value === ',') {
                at += 1;
                continue;
            }
            return at;
        }
        at += 1;
    }
    return at;
}
/**
 * Resolve one destructured binding against the request's props.
 *
 * Exact name first (`{used}` reads `used`); a minified rename (`{title:e}`)
 * falls back to the *property* name at the same position, which is the
 * identity minification preserves. `found: false` means the request supplied
 * no prop for this binding and the client renders the dynamic placeholder.
 */
function propValue(name, env) {
    if (name in env.values)
        return { found: true, value: env.values[name] };
    const position = env.bindings.indexOf(name);
    if (position >= 0 && position < env.keys.length) {
        // The key is a property *path*: a nested destructuring reads deeper than one
        // level (`{status:{displayName:d}}` binds `d` to `props.status.displayName`).
        const path = env.keys[position];
        if (path in env.values)
            return { found: true, value: env.values[path] };
        const walked = walkPath(env.values, path.split('.'));
        if (walked !== undefined)
            return { found: true, value: walked };
    }
    return { found: false, value: undefined };
}
/**
 * Walk one dotted property path through JSON data.
 * @returns the value, or undefined when any segment is missing.
 */
function walkPath(root, segments) {
    let current = root;
    for (const segment of segments) {
        if (current === null || current === undefined)
            return undefined;
        if (Array.isArray(current)) {
            const index = Number(segment);
            if (!Number.isInteger(index) || index < 0 || index >= current.length)
                return undefined;
            current = current[index];
            continue;
        }
        if (typeof current !== 'object')
            return undefined;
        const record = current;
        if (!Object.prototype.hasOwnProperty.call(record, segment))
            return undefined;
        current = record[segment];
    }
    return current;
}
/**
 * Statically resolve one expression span.
 *
 * The reader is deliberately small: it knows literals, arrays, objects,
 * parenthesized/conditional/sequence forms, JSX-runtime calls, identifier
 * references into the props environment, and component references. Everything
 * else is reported as opaque with a reason, never guessed.
 */
function readStaticValue(cursor, start, end, model, env, depth = 0) {
    if (start >= end)
        return { t: 'opaque', r: 'empty-expression' };
    if (depth > model.budget.maxDepth)
        return { t: 'opaque', r: 'depth-budget' };
    const first = cursor.tokens[start];
    // Parenthesized expression: transparent…
    if (first.kind === 'punct' && first.value === '(' && cursor.matchDelimiter(start) === end) {
        return readStaticValue(cursor, start + 1, end - 1, model, env, depth + 1);
    }
    // …unless it is a parenthesized *callee*: the minified `(0, n.jsx)(…)` /
    // `(0, n.jsxs)(…)` shape a bundler emits to keep the call's `this` undefined.
    // The leading `0,` is the comma trick, the member read names the runtime, and
    // the group is followed by the real argument list.
    if (first.kind === 'punct' && first.value === '(') {
        const groupClose = cursor.matchDelimiter(start); // one past `)`
        if (cursor.tokens[groupClose]?.kind === 'punct' && cursor.tokens[groupClose]?.value === '(') {
            const parts = splitTopLevel(cursor, start + 1, groupClose - 1);
            const calleeSpan = parts[parts.length - 1];
            if (calleeSpan !== undefined && readJsxCallee(cursor, calleeSpan[0], calleeSpan[1], model)) {
                const close = cursor.matchDelimiter(groupClose) - 1;
                const args = splitTopLevel(cursor, groupClose + 1, close);
                return elementFromArgs(cursor, args, model, env, depth, close);
            }
        }
    }
    // A span that *is* one balanced group is the expression itself: `{ … }`, `[…]`
    // or `(…)`. Scanning it for `? :` or operators would read members of the
    // object as syntax, so the group branches below own it.
    const first2 = cursor.tokens[start];
    const isGroup = first2.kind === 'punct'
        && (first2.value === '(' || first2.value === '[' || first2.value === '{')
        && cursor.matchDelimiter(start) === end;
    if (!isGroup) {
        // Conditional: pick the branch a known test selects. The test is read as
        // data, so `status.loggedIn ? … : …` follows the value the caller supplied.
        const cond = splitConditional(cursor, start, end);
        if (cond !== undefined) {
            const test = readStaticValue(cursor, cond[0], cond[1], model, env, depth + 1);
            const decided = truthiness(test);
            if (decided !== undefined) {
                return readStaticValue(cursor, decided ? cond[2] : cond[4], decided ? cond[3] : cond[5], model, env, depth + 1);
            }
            // 条件依赖运行时（`accounts.length === 0 ? t('connect') : t('addAccount')`）时，
            // 先按「主操作」取第一个分支：它通常是界面默认态要显示的那个动作，读出来让按钮
            // 有标签、能点，比整块留空有用；warning 标明这是回退，不是求值结果。
            const fallback = readStaticValue(cursor, cond[2], cond[3], model, env, depth + 1);
            if (fallback.t === 'value' && fallback.v !== null && fallback.v !== undefined) {
                model.warnings.push('conditional test could not be evaluated; rendered the first branch');
                return fallback;
            }
            return { t: 'opaque', r: 'conditional' };
        }
        // A logical or arithmetic operator over data: `a + b`, `x ?? y`, `a === b`.
        const binary = readBinary(cursor, start, end, model, env, depth);
        if (binary !== undefined)
            return binary;
        // An array method over data: `rows.map(cb)`, `rows.filter(cb)`.
        const methodCall = readArrayMethod(cursor, start, end, model, env, depth);
        if (methodCall !== undefined)
            return methodCall;
    }
    // Template literal with substitutions: build the string when every part is data.
    if (first.kind === 'template' && end === start + 1) {
        const interpolated = readTemplate(cursor, first, model, env, depth);
        if (interpolated !== undefined)
            return interpolated;
    }
    // Sequence expression `(a, b)`: only the last matters for rendering.
    if (!isGroup) {
        const top = splitTopLevel(cursor, start, end);
        if (top.length > 1) {
            const last = top[top.length - 1];
            return readStaticValue(cursor, last[0], last[1], model, env, depth + 1);
        }
    }
    // A hook that computes a value: `useMemo(() => …, deps)`. The callback runs once
    // with the data the body already bound, which is how a page derives its list.
    const memoized = readMemoCall(cursor, start, end, model, env, depth);
    if (memoized !== undefined)
        return memoized;
    // A call to a local helper declared in the body (`rank(provider)`).
    const localCall = readLocalFunctionCall(cursor, start, end, model, env, depth);
    if (localCall !== undefined)
        return localCall;
    switch (first.kind) {
        case 'string':
            return { t: 'text', text: decodeEscapes(first.value) };
        case 'number': {
            if (end === start + 1)
                return { t: 'value', v: Number(first.value.replace(/[_n]/g, '')) };
            return { t: 'opaque', r: 'number-expression' };
        }
        case 'template': {
            if (first.value.includes('${'))
                return { t: 'opaque', r: 'template-substitution' };
            return { t: 'text', text: decodeEscapes(first.value) };
        }
        case 'keyword': {
            if (end === start + 1) {
                if (first.value === 'true')
                    return { t: 'value', v: true };
                if (first.value === 'false')
                    return { t: 'value', v: false };
                if (first.value === 'null')
                    return { t: 'value', v: null };
                if (first.value === 'undefined')
                    return { t: 'value', v: undefined };
            }
            return { t: 'opaque', r: `keyword:${first.value}` };
        }
        case 'punct': {
            // Unary minus on a number literal.
            if (first.value === '-' && cursor.tokens[start + 1]?.kind === 'number' && end === start + 2) {
                return { t: 'value', v: -Number(cursor.tokens[start + 1].value.replace(/[_n]/g, '')) };
            }
            // Array literal, with spread: `[...providers]` copies the data array.
            if (first.value === '[' && cursor.matchDelimiter(start) === end) {
                const items = [];
                for (const [a, b] of splitTopLevel(cursor, start + 1, end - 1)) {
                    const spread = cursor.tokens[a];
                    const isSpread = spread?.kind === 'punct' && spread.value === '...';
                    const value = readStaticValue(cursor, isSpread ? a + 1 : a, b, model, env, depth + 1);
                    if (isSpread) {
                        if (value.t === 'value' && Array.isArray(value.v)) {
                            items.push(...value.v);
                            continue;
                        }
                        return { t: 'opaque', r: 'spread-item' };
                    }
                    if (value.t === 'value')
                        items.push(value.v);
                    else if (value.t === 'text')
                        items.push(value.text);
                    else
                        return { t: 'opaque', r: 'array-item' };
                }
                return { t: 'value', v: items };
            }
            // Object literal.
            if (first.value === '{' && cursor.matchDelimiter(start) === end) {
                const out = {};
                for (const [a, b] of splitTopLevel(cursor, start + 1, end - 1)) {
                    const name = cursor.tokens[a];
                    if (name === undefined)
                        continue;
                    // Spread: report the whole object as dynamic rather than partial.
                    if (name.kind === 'punct' && name.value === '...')
                        return { t: 'opaque', r: 'object-spread' };
                    if (name.kind !== 'ident' && name.kind !== 'string')
                        continue;
                    // Shorthand `{ title }` reads the environment.
                    if (a + 1 === b) {
                        const value = readIdentifier(name.value, env);
                        if (value.t !== 'value' && value.t !== 'text')
                            return { t: 'opaque', r: 'object-shorthand' };
                        out[name.value] = value.t === 'value' ? value.v : value.text;
                        continue;
                    }
                    if (cursor.tokens[a + 1]?.kind !== 'punct' || cursor.tokens[a + 1]?.value !== ':')
                        continue;
                    const value = readStaticValue(cursor, a + 2, b, model, env, depth + 1);
                    if (value.t === 'value')
                        out[name.value] = value.v;
                    else if (value.t === 'text')
                        out[name.value] = value.text;
                    else
                        out[name.value] = `<${value.t}:${value.t === 'opaque' ? value.r : 'dynamic'}>`;
                }
                return { t: 'value', v: out };
            }
            return { t: 'opaque', r: `punct:${first.value}` };
        }
        case 'ident': {
            // JSX-runtime call: `jsx(…)`, `jsxs(…)`, `React.createElement(…)`.
            if (model.jsxNames.has(first.value) && cursor.tokens[start + 1]?.value === '(') {
                return readJsxCall(cursor, start, end, model, env, depth);
            }
            if (first.value === 'React'
                && cursor.tokens[start + 1]?.value === '.'
                && cursor.tokens[start + 2]?.kind === 'ident'
                && cursor.tokens[start + 2]?.value === 'createElement'
                && cursor.tokens[start + 3]?.value === '(') {
                return readCreateElementCall(cursor, start, end, model, env, depth);
            }
            // Member read into the props environment: `props.title`.
            if (first.value === 'props'
                && cursor.tokens[start + 1]?.value === '.'
                && cursor.tokens[start + 2]?.kind === 'ident'
                && end === start + 3) {
                if (env.identifier) {
                    const value = env.values[cursor.tokens[start + 2].value];
                    if (value !== undefined)
                        return { t: 'value', v: value };
                    return { t: 'opaque', r: `prop:${cursor.tokens[start + 2].value}` };
                }
                return { t: 'opaque', r: 'member-expression' };
            }
            // A member chain over data the caller supplied: `status.displayName`,
            // `provider.accounts.length`, `row[0].name`. This is the binding that makes
            // a data-driven card render from RPC data without executing plugin code.
            const chained = readMemberChain(cursor, start, end, model, env);
            if (chained !== undefined)
                return chained;
            if (end === start + 1) {
                // Prop read by destructured name. A prop the caller did not supply stays
                // dynamic data the plugin controls at runtime — reported as
                // `prop:<name>` so the client can say so, not a resolution failure.
                if (env.destructured.has(first.value)) {
                    const resolved = propValue(first.value, env);
                    if (resolved.found)
                        return { t: 'value', v: resolved.value };
                    return { t: 'opaque', r: `prop:${first.value}` };
                }
                // Component reference: render it inline at the use site. A name that is
                // not (yet) bound in this bundle still reads as a reference — the
                // registration's component may live behind a variable the pass skipped,
                // and the renderer reports it as opaque when it truly resolves nowhere.
                if (/^[A-Z]/.test(first.value) || model.components.has(first.value)) {
                    return { t: 'component-ref', n: first.value };
                }
                // A local binding the body declared: `const { status } = props`.
                if (env.locals.has(first.value))
                    return { t: 'value', v: env.locals.get(first.value) };
                // The whole props object, for `const { a } = props` and `props.rows`.
                if (env.identifier && first.value === 'props')
                    return { t: 'value', v: env.values };
                // A bare identifier can still be environment data the caller supplied.
                if (first.value in env.values)
                    return { t: 'value', v: env.values[first.value] };
                return { t: 'opaque', r: 'identifier' };
            }
            // A translate helper call resolves through the bundle's own dictionary:
            // `t('nav')` is a plain table lookup, so the text a card shows is static
            // data even though the expression is a call.
            const translated = readTranslateCall(cursor, start, end, model, env);
            if (translated !== undefined)
                return translated;
            // Calls whose callee is not the JSX runtime are not statically known.
            return { t: 'opaque', r: 'call-expression' };
        }
        default:
            return { t: 'opaque', r: `token:${first.kind}` };
    }
}
/**
 * Truth value of one statically-read test, or undefined when it is not data.
 * JavaScript truthiness for the values JSON can hold.
 */
function truthiness(value) {
    switch (value.t) {
        case 'value':
            if (value.v === null || value.v === undefined)
                return false;
            if (typeof value.v === 'boolean')
                return value.v;
            if (typeof value.v === 'number')
                return value.v !== 0 && !Number.isNaN(value.v);
            if (typeof value.v === 'string')
                return value.v.length > 0;
            return true;
        case 'text':
            return value.text.length > 0;
        case 'element':
        case 'component-ref':
        case 'children':
            return true;
        case 'opaque':
            return undefined;
    }
}
/** Operators a data expression may carry, longest match first. */
const BINARY_OPERATORS = ['===', '!==', '>=', '<=', '==', '!=', '&&', '||', '??', '+', '>', '<'];
/**
 * Read one binary/logical expression over data: `a + b`, `x ?? y`, `a === b`.
 *
 * Scans for the *last* top-level operator so `a - b + c` groups right, which is
 * enough for the value expressions a card writes. An operand that is not data
 * makes the whole expression unknown rather than partially true.
 */
function readBinary(cursor, start, end, model, env, depth) {
    let at = start;
    let found;
    while (at < end) {
        const token = cursor.tokens[at];
        if (token.kind === 'punct') {
            if (token.value === '(' || token.value === '[' || token.value === '{') {
                at = cursor.matchDelimiter(at);
                continue;
            }
            const operator = BINARY_OPERATORS.find(candidate => candidate === token.value);
            if (operator !== undefined && at > start)
                found = { index: at, operator };
        }
        at += 1;
    }
    if (found === undefined)
        return undefined;
    const left = readStaticValue(cursor, start, found.index, model, env, depth + 1);
    const right = readStaticValue(cursor, found.index + 1, end, model, env, depth + 1);
    // Short-circuit forms only need one side.
    if (found.operator === '&&' || found.operator === '||' || found.operator === '??') {
        const leftTruth = truthiness(left);
        if (found.operator === '??') {
            if (left.t === 'value' && left.v === null)
                return right;
            if (left.t === 'value' && left.v === undefined)
                return right;
            if (left.t === 'value' || left.t === 'text')
                return left;
            return undefined;
        }
        if (leftTruth === undefined) {
            // `!busy && <button/>`：左值依赖运行时状态，但右侧是界面默认态要显示的内容
            // （例如「连接」按钮）。取右侧并记 warning，比整块吞掉有用。
            if (found.operator === '&&' && right.t !== 'opaque') {
                model.warnings.push('logical-and operand could not be evaluated; rendered the right side');
                return right;
            }
            return undefined;
        }
        if (found.operator === '&&')
            return leftTruth ? right : left;
        return leftTruth ? left : right;
    }
    const leftValue = jsonOf(left);
    const rightValue = jsonOf(right);
    if (leftValue === undefined || rightValue === undefined)
        return undefined;
    switch (found.operator) {
        case '===': return { t: 'value', v: leftValue.value === rightValue.value };
        case '!==': return { t: 'value', v: leftValue.value !== rightValue.value };
        case '==': return { t: 'value', v: leftValue.value === rightValue.value };
        case '!=': return { t: 'value', v: leftValue.value !== rightValue.value };
        case '+': {
            const a = leftValue.value;
            const b = rightValue.value;
            if (typeof a === 'number' && typeof b === 'number')
                return { t: 'value', v: a + b };
            if (typeof a === 'string' || typeof b === 'string')
                return { t: 'text', text: `${String(a)}${String(b)}` };
            return undefined;
        }
        case '>':
        case '<':
        case '>=':
        case '<=': {
            const a = leftValue.value;
            const b = rightValue.value;
            if ((typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string')) {
                const comparison = a < b ? -1 : a > b ? 1 : 0;
                if (found.operator === '>')
                    return { t: 'value', v: comparison > 0 };
                if (found.operator === '<')
                    return { t: 'value', v: comparison < 0 };
                if (found.operator === '>=')
                    return { t: 'value', v: comparison >= 0 };
                return { t: 'value', v: comparison <= 0 };
            }
            return undefined;
        }
        default:
            return undefined;
    }
}
/** The JSON value one static read carries, or undefined when it carries none. */
function jsonOf(value) {
    if (value.t === 'value')
        return { value: value.v };
    if (value.t === 'text')
        return { value: value.text };
    return undefined;
}
/**
 * Read a template literal with substitutions, e.g. `` `${row.name} · ${count}` ``.
 * Returns undefined when any interpolation is not data.
 */
function readTemplate(cursor, token, model, env, depth) {
    const body = token.value;
    if (!body.includes('${'))
        return undefined;
    let out = '';
    let at = 0;
    while (at < body.length) {
        const open = body.indexOf('${', at);
        if (open < 0) {
            out += decodeEscapes(body.slice(at));
            break;
        }
        out += decodeEscapes(body.slice(at, open));
        // Find the matching `}` for this substitution.
        let scan = open + 2;
        let level = 1;
        while (scan < body.length && level > 0) {
            if (body[scan] === '{')
                level += 1;
            else if (body[scan] === '}')
                level -= 1;
            scan += 1;
        }
        if (level !== 0)
            return undefined;
        const expression = body.slice(open + 2, scan - 1);
        const inner = tokenize(expression);
        if (inner.length === 0)
            return undefined;
        const sub = new Cursor(inner);
        const value = readStaticValue(sub, 0, inner.length, model, env, depth + 1);
        const json = jsonOf(value);
        if (json === undefined) {
            // A substitution the pass cannot read leaves a placeholder rather than a
            // wrong string: the client shows that a value is pending.
            out += '…';
        }
        else {
            out += String(json.value ?? '');
        }
        at = scan;
    }
    return { t: 'text', text: out };
}
/**
 * Read `rows.map(cb)` / `rows.filter(cb)` over data the caller supplied.
 *
 * The callback runs once per element with its parameter bound to that element, so
 * a card's `providers.map(provider => <ProviderCard …/>)` becomes one child node
 * per provider — the list a user came to see.
 */
function readArrayMethod(cursor, start, end, model, env, depth) {
    // Shape: <expression> . map|filter ( <callback> )
    let at = start;
    let dotAt = -1;
    while (at < end) {
        const token = cursor.tokens[at];
        if (token.kind === 'punct') {
            if (token.value === '(' || token.value === '[' || token.value === '{') {
                at = cursor.matchDelimiter(at);
                continue;
            }
            if (token.value === '.')
                dotAt = at;
        }
        at += 1;
    }
    if (dotAt < 0)
        return undefined;
    const method = cursor.tokens[dotAt + 1];
    if (method === undefined || method.kind !== 'ident')
        return undefined;
    if (method.value !== 'map' && method.value !== 'filter' && method.value !== 'sort')
        return undefined;
    const openAt = dotAt + 2;
    if (cursor.tokens[openAt]?.value !== '(')
        return undefined;
    const close = cursor.matchDelimiter(openAt) - 1;
    if (close !== end - 1)
        return undefined;
    const subject = readStaticValue(cursor, start, dotAt, model, env, depth + 1);
    if (subject.t !== 'value' || !Array.isArray(subject.v))
        return undefined;
    const args = splitTopLevel(cursor, openAt + 1, close);
    const callback = args[0];
    if (callback === undefined)
        return undefined;
    const callbackShape = readCallback(cursor, callback[0], callback[1], model);
    if (callbackShape === undefined)
        return undefined;
    // `sort` reorders data: run the comparator pairwise, which is exact for the
    // rank-style comparators a provider list uses.
    if (method.value === 'sort') {
        const sorted = [...subject.v];
        sorted.sort((left, right) => {
            const value = invokeLocalFunction(cursor, model, callbackShape, [left, right], env, depth);
            const numeric = jsonOf(value)?.value;
            return typeof numeric === 'number' ? numeric : 0;
        });
        return { t: 'value', v: sorted };
    }
    const children = [];
    const kept = [];
    for (let index = 0; index < subject.v.length; index += 1) {
        const element = subject.v[index];
        const inner = withLocals(env, new Map(env.locals));
        const locals = inner.locals;
        // The callback's parameters: element first, index second.
        if (callbackShape.firstParam !== undefined)
            locals.set(callbackShape.firstParam, element);
        if (callbackShape.secondParam !== undefined)
            locals.set(callbackShape.secondParam, index);
        const value = callbackShape.expression
            ? readStaticValue(cursor, callbackShape.bodyStart, callbackShape.bodyEnd, model, inner, depth + 1)
            : readCallbackReturn(cursor, callbackShape, model, inner, depth);
        if (method.value === 'filter') {
            if (truthiness(value) === true)
                kept.push(element);
            continue;
        }
        for (const node of childrenOf(value))
            children.push(node);
    }
    // `filter` yields data for the next step in a chain; `map` yields the nodes.
    if (method.value === 'filter')
        return { t: 'value', v: kept };
    return { t: 'children', c: children };
}
/** Read one arrow/function callback argument. */
function readCallback(cursor, start, end, model) {
    let at = start;
    // `function (a, b) { … }`
    if (cursor.tokens[at]?.kind === 'keyword' && cursor.tokens[at]?.value === 'function') {
        at += 1;
        if (cursor.tokens[at]?.kind === 'ident')
            at += 1;
        if (cursor.tokens[at]?.value !== '(')
            return undefined;
        const paramsClose = cursor.matchDelimiter(at) - 1;
        const names = paramNames(cursor, at + 1, paramsClose);
        if (cursor.tokens[paramsClose + 1]?.value !== '{')
            return undefined;
        const blockOpen = paramsClose + 1;
        const blockClose = cursor.matchDelimiter(blockOpen) - 1;
        const returnAt = findReturn(cursor, blockOpen + 1, blockClose);
        return {
            firstParam: names[0],
            secondParam: names[1],
            bodyStart: returnAt,
            bodyEnd: returnAt >= 0 ? expressionEnd(cursor, returnAt, blockClose) : -1,
            expression: false,
            blockOpen,
            blockClose,
        };
    }
    // `a => expr` / `(a, b) => expr`
    if (cursor.tokens[at]?.kind === 'ident' && cursor.tokens[at + 1]?.value === '=>') {
        const arrowAt = at + 2;
        return arrowCallback(cursor, [cursor.tokens[at].value], arrowAt, end);
    }
    if (cursor.tokens[at]?.value !== '(')
        return undefined;
    const paramsClose = cursor.matchDelimiter(at) - 1;
    if (cursor.tokens[paramsClose + 1]?.value !== '=>')
        return undefined;
    const names = paramNames(cursor, at + 1, paramsClose);
    return arrowCallback(cursor, names, paramsClose + 2, end);
}
/** Build a callback shape for an arrow body starting at `bodyStart`. */
function arrowCallback(cursor, names, bodyStart, end) {
    if (cursor.tokens[bodyStart]?.value === '{') {
        const blockOpen = bodyStart;
        const blockClose = cursor.matchDelimiter(blockOpen) - 1;
        const returnAt = findReturn(cursor, blockOpen + 1, blockClose);
        return {
            firstParam: names[0],
            secondParam: names[1],
            bodyStart: returnAt,
            bodyEnd: returnAt >= 0 ? expressionEnd(cursor, returnAt, blockClose) : -1,
            expression: false,
            blockOpen,
            blockClose,
        };
    }
    return {
        firstParam: names[0],
        secondParam: names[1],
        bodyStart,
        bodyEnd: end,
        expression: true,
        blockOpen: -1,
        blockClose: -1,
    };
}
/** Parameter names of a simple callback parameter list. */
function paramNames(cursor, start, close) {
    const names = [];
    for (let at = start; at < close; at += 1) {
        const token = cursor.tokens[at];
        if (token.kind === 'ident')
            names.push(token.value);
    }
    return names;
}
/** Read the `return` expression of a block-bodied callback. */
function readCallbackReturn(cursor, shape, model, env, depth) {
    if (shape.bodyStart < 0)
        return { t: 'opaque', r: 'callback-without-return' };
    return readStaticValue(cursor, shape.bodyStart, shape.bodyEnd, model, env, depth + 1);
}
/**
 * Read `useMemo(() => …, deps)`: run the callback once and read its result.
 *
 * A page commonly derives its data this way (`const rows = useMemo(() => […], [x])`).
 * The callback is a pure function of the data the body already bound, so inlining
 * it is equivalent to what the hook does on first render.
 */
function readMemoCall(cursor, start, end, model, env, depth) {
    let openAt = -1;
    const first = cursor.tokens[start];
    if (first.kind === 'ident' && cursor.tokens[start + 1]?.value === '(')
        openAt = start + 1;
    else {
        // `(0, react.useMemo)(…)`: the callee is parenthesized.
        if (first.kind !== 'punct' || first.value !== '(')
            return undefined;
        const groupClose = cursor.matchDelimiter(start);
        if (cursor.tokens[groupClose]?.value !== '(')
            return undefined;
        const parts = splitTopLevel(cursor, start + 1, groupClose - 1);
        const callee = parts[parts.length - 1];
        if (callee === undefined || !isMemoName(cursor, callee[0], callee[1]))
            return undefined;
        openAt = groupClose;
    }
    if (openAt < 0)
        return undefined;
    if (!isMemoCallee(cursor, start, openAt))
        return undefined;
    const close = cursor.matchDelimiter(openAt) - 1;
    const args = splitTopLevel(cursor, openAt + 1, close);
    const callback = args[0];
    if (callback === undefined)
        return undefined;
    const shape = readCallback(cursor, callback[0], callback[1], model);
    if (shape === undefined)
        return undefined;
    if (shape.expression) {
        return readStaticValue(cursor, shape.bodyStart, shape.bodyEnd, model, env, depth + 1);
    }
    // A block-bodied callback gets its own locals (it usually declares a few).
    const inner = evaluateBlock(cursor, model, shape, env);
    return readCallbackReturn(cursor, shape, model, inner, depth);
}
/** Whether one callee span names `useMemo`. */
function isMemoCallee(cursor, start, openAt) {
    if (openAt === start + 1)
        return isMemoName(cursor, start, start + 1);
    return isMemoName(cursor, start, openAt - 1);
}
/** Whether one span ends in the `useMemo` name. */
function isMemoName(cursor, start, end) {
    if (end <= start)
        return false;
    const last = cursor.tokens[end - 1];
    return last.kind === 'ident' && (last.value === 'useMemo' || last.value === 'useMemo$1');
}
/**
 * Read a call to a helper the body declared (`const rank = provider => …`).
 * The stored value is the helper's shape; calling it binds its parameters to the
 * argument values and reads the returned expression.
 */
function readLocalFunctionCall(cursor, start, end, model, env, depth) {
    const callee = cursor.tokens[start];
    if (callee === undefined || callee.kind !== 'ident')
        return undefined;
    if (cursor.tokens[start + 1]?.value !== '(')
        return undefined;
    const stored = env.locals.get(callee.value);
    if (!isLocalFunction(stored))
        return undefined;
    const openAt = start + 1;
    const close = cursor.matchDelimiter(openAt) - 1;
    if (close !== end - 1)
        return undefined;
    const args = splitTopLevel(cursor, openAt + 1, close);
    const values = args.map(([a, b]) => {
        const value = readStaticValue(cursor, a, b, model, env, depth + 1);
        return jsonOf(value)?.value;
    });
    return invokeLocalFunction(cursor, model, stored.shape, values, env, depth);
}
function isLocalFunction(value) {
    return typeof value === 'object' && value !== null && value.__dshLocalFunction === true;
}
/** Invoke a stored local function with positional arguments. */
function invokeLocalFunction(cursor, model, shape, values, env, depth) {
    const locals = new Map(env.locals);
    if (shape.firstParam !== undefined)
        locals.set(shape.firstParam, values[0]);
    if (shape.secondParam !== undefined)
        locals.set(shape.secondParam, values[1]);
    const inner = withLocals(env, locals);
    if (shape.expression) {
        return readStaticValue(cursor, shape.bodyStart, shape.bodyEnd, model, inner, depth + 1);
    }
    return readCallbackReturn(cursor, shape, model, inner, depth);
}
/**
 * Apply one callback body's `const` declarations.
 *
 * Blocks passed to hooks and array methods declare their own data
 * (`const providers = status?.providers ?? []`), so they need the same binding pass
 * a component body gets.
 */
function evaluateBlock(cursor, model, shape, env) {
    if (shape.blockOpen < 0)
        return env;
    const locals = new Map(env.locals);
    let localEnv = withLocals(env, locals);
    let at = shape.blockOpen + 1;
    while (at < shape.blockClose) {
        const token = cursor.tokens[at];
        if (token.kind === 'punct' && token.value === '{') {
            at = cursor.matchDelimiter(at);
            continue;
        }
        if (token.kind === 'keyword' && (token.value === 'const' || token.value === 'let' || token.value === 'var')) {
            at = readLocalDeclaration(cursor, model, at, shape.blockClose, localEnv, locals);
            localEnv = withLocals(env, locals);
            continue;
        }
        at += 1;
    }
    return localEnv;
}
/**
 * Read a member chain over caller-supplied data: `status.displayName`, * `provider.accounts.length`, `rows[0].name`, `props.status.providers`.
 *
 * This is what turns RPC data into a rendered card. The component reads a prop
 * object the way it would at runtime; the static pass performs the same property
 * reads against the JSON the client sent, so `{status.displayName}` becomes the
 * provider's real name instead of an opaque node.
 *
 * @returns the resolved value, an opaque reason when the data lacks that path,
 *   or undefined when the span is not a member chain at all.
 */
function readMemberChain(cursor, start, end, model, env) {
    const base = cursor.tokens[start];
    if (base === undefined || base.kind !== 'ident')
        return undefined;
    // `props.x` is handled before this call, and `props` itself is the environment.
    if (end <= start + 2)
        return undefined;
    const path = [];
    let at = start;
    // Walk `ident ( . ident | [ literal ] )*` to the end of the span. `at` starts
    // on the base identifier, so every continuation begins at the token *after* the
    // member that was just consumed.
    let scan = start + 1;
    while (scan < end) {
        const token = cursor.tokens[scan];
        if (token.kind === 'punct' && (token.value === '.' || token.value === '?.')) {
            const name = cursor.tokens[scan + 1];
            if (name === undefined || name.kind !== 'ident')
                return undefined;
            path.push(name.value);
            scan += 2;
            continue;
        }
        if (token.kind === 'punct' && token.value === '[') {
            const close = cursor.matchDelimiter(scan);
            const keyToken = cursor.tokens[scan + 1];
            if (keyToken === undefined || close !== scan + 3)
                return undefined;
            if (keyToken.kind === 'string')
                path.push(decodeEscapes(keyToken.value));
            else if (keyToken.kind === 'number')
                path.push(String(Number(keyToken.value)));
            else
                return undefined;
            scan = close;
            continue;
        }
        return undefined;
    }
    if (path.length === 0)
        return undefined;
    // Resolve the root through the environment the same way a runtime read would.
    let cursorValue;
    const root = base.value;
    if (root === 'props' && env.identifier) {
        cursorValue = env.values;
    }
    else if (env.locals.has(root)) {
        // A body-declared local holding the data: `const { status } = props`.
        cursorValue = env.locals.get(root);
    }
    else if (Object.prototype.hasOwnProperty.call(env.values, root)) {
        cursorValue = env.values[root];
    }
    else if (root === 'props') {
        cursorValue = env.values;
    }
    else if (model.components.has(root) || /^[A-Z]/.test(root)) {
        // A component or module namespace: not data this pass can read.
        return undefined;
    }
    else {
        return { t: 'opaque', r: `member:${root}` };
    }
    for (let index = 0; index < path.length; index += 1) {
        const key = path[index];
        if (cursorValue === null || cursorValue === undefined) {
            return { t: 'opaque', r: `member:${root}.${path.slice(0, index + 1).join('.')}` };
        }
        if (Array.isArray(cursorValue)) {
            if (key === 'length') {
                cursorValue = cursorValue.length;
                continue;
            }
            const numeric = Number(key);
            if (!Number.isInteger(numeric) || numeric < 0 || numeric >= cursorValue.length) {
                return { t: 'opaque', r: `member:${root}.${path.slice(0, index + 1).join('.')}` };
            }
            cursorValue = cursorValue[numeric];
            continue;
        }
        if (typeof cursorValue === 'string' && key === 'length') {
            cursorValue = cursorValue.length;
            continue;
        }
        if (typeof cursorValue === 'object') {
            const record = cursorValue;
            if (!Object.prototype.hasOwnProperty.call(record, key)) {
                return { t: 'opaque', r: `member:${root}.${path.slice(0, index + 1).join('.')}` };
            }
            cursorValue = record[key];
            continue;
        }
        // A primitive has no further members: report the path, do not guess.
        return { t: 'opaque', r: `member:${root}.${path.join('.')}` };
    }
    return { t: 'value', v: cursorValue };
}
/** Whether one span names a translate helper. */
function isTranslateCallee(cursor, start, end) {
    if (end === start + 1 && cursor.tokens[start]?.kind === 'ident') {
        const name = cursor.tokens[start].value;
        return TRANSLATE_NAMES.has(name) || name.endsWith('Translate');
    }
    // `locale.t('key')` / `i18n.t('key')`: the member name is the helper.
    if (end === start + 3
        && cursor.tokens[start]?.kind === 'ident'
        && cursor.tokens[start + 1]?.value === '.'
        && cursor.tokens[start + 2]?.kind === 'ident') {
        return TRANSLATE_NAMES.has(cursor.tokens[start + 2].value);
    }
    return false;
}
/**
 * Resolve `t('key')` / `t('key', { … })` against the chosen dictionary.
 *
 * Placeholders (`{count}`) are filled from a statically-visible params object;
 * one the caller cannot see stays in the text, which reads as "value pending"
 * rather than as a wrong number. A missing dictionary or key yields `undefined`
 * so the caller reports the ordinary dynamic-expression reason.
 */
function readTranslateCall(cursor, start, end, model, env) {
    const dictionary = model.dictionary;
    if (dictionary === undefined)
        return undefined;
    if (cursor.tokens[start]?.kind !== 'ident')
        return undefined;
    // Find the argument list: the callee span runs up to the `(` that opens it.
    let openAt = -1;
    if (cursor.tokens[start + 1]?.value === '(')
        openAt = start + 1;
    else if (cursor.tokens[start + 2]?.value === '(')
        openAt = start + 2;
    if (openAt < 0)
        return undefined;
    if (cursor.matchDelimiter(openAt) !== end)
        return undefined;
    if (!isTranslateCallee(cursor, start, openAt))
        return undefined;
    const args = splitTopLevel(cursor, openAt + 1, end - 1);
    const keyToken = args[0] === undefined ? undefined : cursor.tokens[args[0][0]];
    if (keyToken === undefined || args[0][1] !== args[0][0] + 1)
        return undefined;
    if (keyToken.kind !== 'string')
        return undefined;
    const key = decodeEscapes(keyToken.value);
    const template = dictionary.get(key);
    if (template === undefined)
        return { t: 'opaque', r: `untranslated:${key}` };
    const params = args[1] === undefined
        ? {}
        : readStaticParams(cursor, args[1][0], args[1][1], model, env);
    const text = template.replace(/\{(\w+)\}/g, (match, name) => {
        const value = params[name];
        return value === undefined ? match : String(value);
    });
    return { t: 'text', text };
}
/** Read a params object literal for `{…}` substitution, keeping only statics. */
function readStaticParams(cursor, start, end, model, env) {
    const out = {};
    if (cursor.tokens[start]?.value !== '{')
        return out;
    for (const [a, b] of splitTopLevel(cursor, start + 1, end - 1)) {
        const key = cursor.tokens[a];
        if (key === undefined || (key.kind !== 'ident' && key.kind !== 'string'))
            continue;
        if (cursor.tokens[a + 1]?.value !== ':')
            continue;
        const value = readStaticValue(cursor, a + 2, b, model, env);
        if (value.t === 'value')
            out[key.value] = value.v;
        else if (value.t === 'text')
            out[key.value] = value.text;
    }
    return out;
}
/**
 * Whether one span names the JSX runtime: `n.jsx`, `n.jsxs`, `n.jsxDEV` —
 * where the member itself carries the runtime name, as bundlers alias the
 * module object — or `React.createElement`.
 */
function readJsxCallee(cursor, start, end, model) {
    if (end === start + 3
        && cursor.tokens[start]?.kind === 'ident'
        && cursor.tokens[start + 1]?.kind === 'punct' && cursor.tokens[start + 1]?.value === '.'
        && cursor.tokens[start + 2]?.kind === 'ident') {
        const member = cursor.tokens[start + 2].value;
        if (model.jsxNames.has(member))
            return true;
        if (cursor.tokens[start].value === 'React' && member === 'createElement')
            return true;
    }
    return false;
}
/** Split `a ? b : c` at its top-level `?` and `:`; undefined when not a conditional. */
function splitConditional(cursor, start, end) {
    let questionAt = -1;
    let colonAt = -1;
    let at = start;
    while (at < end) {
        const token = cursor.tokens[at];
        if (token.kind === 'punct') {
            if (token.value === '(' || token.value === '{' || token.value === '[') {
                at = cursor.matchDelimiter(at);
                continue;
            }
            if (token.value === '?' && questionAt < 0)
                questionAt = at;
            else if (token.value === ':' && questionAt >= 0) {
                colonAt = at;
                break;
            }
        }
        at += 1;
    }
    if (questionAt < 0 || colonAt < 0)
        return undefined;
    return [start, questionAt, questionAt + 1, colonAt, colonAt + 1, end];
}
/** Resolve one bare identifier against the props environment. */
function readIdentifier(name, env) {
    if (env.destructured.has(name)) {
        const resolved = propValue(name, env);
        return resolved.found ? { t: 'value', v: resolved.value } : { t: 'opaque', r: `prop:${name}` };
    }
    if (name in env.values)
        return { t: 'value', v: env.values[name] };
    return { t: 'opaque', r: 'identifier' };
}
/**
 * Read one `jsx(type, props, key)` / `jsxs(type, props, key)` call into an element.
 *
 * The third argument is React's **key**, not a child: a bundler emits
 * `jsx(ProviderCard, { … }, provider.provider)` for a list, and reading that key
 * as a child put the provider id in place of the card.
 */
function readJsxCall(cursor, start, end, model, env, depth) {
    const close = cursor.matchDelimiter(start + 1) - 1;
    const args = splitTopLevel(cursor, start + 2, close);
    return elementFromArgs(cursor, args, model, env, depth, close, 'jsx');
}
/**
 * Read one `React.createElement(type, props, ...children)` call into an element.
 */
function readCreateElementCall(cursor, start, end, model, env, depth) {
    const close = cursor.matchDelimiter(start + 3) - 1;
    const args = splitTopLevel(cursor, start + 4, close);
    return elementFromArgs(cursor, args, model, env, depth, close);
}
/**
 * Build an `ElementNode` from the argument spans of a JSX-runtime call.
 */
function elementFromArgs(cursor, args, model, env, depth, closeAt, runtime = 'createElement') {
    if (args.length === 0)
        return { t: 'opaque', r: 'jsx-no-type' };
    const typeValue = readStaticValue(cursor, args[0][0], args[0][1], model, env, depth + 1);
    let type;
    if (typeValue.t === 'text')
        type = typeValue.text;
    else if (typeValue.t === 'value' && typeof typeValue.v === 'string')
        type = typeValue.v;
    else if (typeValue.t === 'component-ref')
        type = `component:${typeValue.n}`;
    else
        return { t: 'opaque', r: 'jsx-dynamic-type' };
    const props = {};
    let children = [];
    if (process.env.DEBUG_ELEM && type.startsWith('component:')) {
        const texts = args.map(([a, b]) => cursor.tokens.slice(a, Math.min(b, a + 6)).map(x => x.value).join(' '));
        console.error('ELEM', type, 'argc=', args.length, 'args=', JSON.stringify(texts).slice(0, 200));
    }
    if (args.length >= 2) {
        const propsSpan = args[1];
        const propsToken = cursor.tokens[propsSpan[0]];
        if (propsToken?.kind === 'keyword' && propsToken.value === 'null') {
            // No props.
        }
        else if (propsToken?.kind === 'punct' && propsToken.value === '{') {
            for (const [a, b] of splitTopLevel(cursor, propsSpan[0] + 1, propsSpan[1] - 1)) {
                const name = cursor.tokens[a];
                if (name === undefined)
                    continue;
                if (name.kind === 'punct' && name.value === '...') {
                    props['<spread>'] = true;
                    continue;
                }
                if (name.kind !== 'ident' && name.kind !== 'string')
                    continue;
                if (cursor.tokens[a + 1]?.kind !== 'punct' || cursor.tokens[a + 1]?.value !== ':')
                    continue;
                const value = name.value === 'children'
                    ? readChildrenValue(cursor, a + 2, b, model, env, depth)
                    : readStaticValue(cursor, a + 2, b, model, env, depth + 1);
                if (name.value === 'children') {
                    children = childrenOf(value);
                    continue;
                }
                props[name.value] = propJson(value);
            }
        }
        else {
            // Dynamic props expression: keep a marker, children are lost statically.
            props['<dynamic-props>'] = true;
        }
    }
    // `createElement(type, props, child1, child2, …)`: trailing args are children.
    // `jsx(type, props, key)`: the third arg is React's key, never a child.
    const keySpan = runtime === 'jsx' ? args[2] : undefined;
    let key = null;
    if (keySpan !== undefined) {
        const keyValue = readStaticValue(cursor, keySpan[0], keySpan[1], model, env, depth + 1);
        const raw = jsonOf(keyValue)?.value;
        if (typeof raw === 'string' || typeof raw === 'number')
            key = String(raw);
    }
    if (runtime === 'createElement') {
        for (const span of args.slice(2)) {
            children.push(...childrenOf(readStaticValue(cursor, span[0], span[1], model, env, depth + 1)));
        }
    }
    return {
        t: 'element',
        e: { kind: 'element', type, key, props, children },
    };
}
/**
 * Read a `children:` prop value: like `readStaticValue`, except that an array
 * literal is walked element-wise so `children: [jsx(…), jsx(…)]` yields sibling
 * nodes instead of failing the "static JSON only" array rule.
 */
function readChildrenValue(cursor, start, end, model, env, depth) {
    const first = cursor.tokens[start];
    if (first !== undefined && first.kind === 'punct' && first.value === '[' && cursor.matchDelimiter(start) === end) {
        const children = [];
        for (const [a, b] of splitTopLevel(cursor, start + 1, end - 1)) {
            children.push(...childrenOf(readStaticValue(cursor, a, b, model, env, depth + 1)));
        }
        return { t: 'children', c: children };
    }
    return readStaticValue(cursor, start, end, model, env, depth + 1);
}
/** Turn a statically-read value into child nodes. */
function childrenOf(value) {
    switch (value.t) {
        case 'element': return [value.e];
        case 'text': return [{ kind: 'text', value: value.text }];
        case 'children': return [...value.c];
        case 'value': {
            if (value.v === null || value.v === undefined || typeof value.v === 'boolean')
                return [];
            if (typeof value.v === 'string')
                return [{ kind: 'text', value: value.v }];
            if (typeof value.v === 'number')
                return [{ kind: 'text', value: String(value.v) }];
            if (Array.isArray(value.v)) {
                return value.v.flatMap(item => childrenOf({ t: 'value', v: item }));
            }
            return [{ kind: 'opaque', reason: 'object-child' }];
        }
        case 'component-ref': return [{ kind: 'element', type: `component:${value.n}`, key: null, props: {}, children: [] }];
        case 'opaque': return [{ kind: 'opaque', reason: value.r }];
    }
}
/** Turn a statically-read value into a JSON-safe prop value. */
function propJson(value) {
    switch (value.t) {
        case 'value': return value.v === undefined ? '<undefined>' : value.v;
        case 'text': return value.text;
        case 'element': return `<element:${value.e.type}>`;
        case 'component-ref': return `<component:${value.n}>`;
        case 'children': return `<children:${value.c.length}>`;
        case 'opaque': return `<opaque:${value.r}>`;
    }
}
/**
 * The subset of one element's props that may be forwarded into an inlined child.
 *
 * `propJson` writes `element`/`opaque`/… values as `<kind:…>` placeholder text.
 * That text is a *report*, not data: forwarding it would make a wrapper component
 * render the placeholder as if the plugin had written it, which is worse than the
 * honest "nothing here" the opaque node produces.
 */
function forwardedProps(props) {
    const out = {};
    for (const [key, value] of Object.entries(props)) {
        if (typeof value === 'string' && PLACEHOLDER_TEXT.test(value))
            continue;
        out[key] = value;
    }
    return out;
}
/** Matches the placeholder text `propJson` emits for a value it could not resolve. */
const PLACEHOLDER_TEXT = /^<(?:opaque|element|component|children|function|undefined|dynamic)[:>]/;
/** Decode the escape sequences of one string token body. */
function decodeEscapes(text) {
    return text
        .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\(.)/g, '$1');
}
// ---------------------------------------------------------------------------
// Component-tree building
// ---------------------------------------------------------------------------
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
export function buildComponentTree(source, componentName, props, budget = DEFAULT_TRANSPILE_BUDGET, localeTags = []) {
    const warnings = [];
    const model = buildModel(source, budget, warnings);
    chooseDictionary(model, localeTags);
    model.injected = props;
    const shape = model.components.get(componentName);
    if (shape === undefined || shape.bodyStart < 0) {
        return {
            componentId: componentName,
            tree: null,
            warnings: [...warnings, `component ${componentName} has no statically readable return`],
            truncated: false,
            data: [],
            actions: [],
        };
    }
    const env = evaluateBody(model.cursor, model, shape, props);
    const counter = { nodes: 0, truncated: false };
    const value = readStaticValue(model.cursor, shape.bodyStart, shape.bodyEnd, model, env);
    const tree = normalizeTree(renderValue(value, model, env, counter, 0), warnings);
    return {
        componentId: componentName,
        tree,
        warnings,
        truncated: counter.truncated,
        data: collectBundleDataSources(model),
        actions: collectActionMethods(model),
    };
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
export function extractDataSources(cursor, shape) {
    const found = [];
    if (shape.bodyOpen < 0 || shape.bodyClose < 0)
        return found;
    const seen = new Set();
    for (let at = shape.bodyOpen; at < shape.bodyClose; at += 1) {
        const token = cursor.tokens[at];
        if (token === undefined || token.kind !== "ident" || token.value !== "call")
            continue;
        const paren = cursor.tokens[at + 1];
        if (paren?.kind !== "punct" || paren.value !== "(")
            continue;
        const methodToken = cursor.tokens[at + 2];
        if (methodToken?.kind !== "string")
            continue;
        const method = methodToken.value;
        // 只把「读」的方法当数据源：checkin、setAutoOn 这类调用有副作用，客户端不能把
        // 它们当刷新数据反复打。
        if (!isReadMethod(method))
            continue;
        if (seen.has(method))
            continue;
        seen.add(method);
        const close = cursor.matchDelimiter(at + 1);
        const payload = readLiteralPayload(cursor, at + 2, close);
        // `call("usage", { provider })` 以「当前服务商」为参数：客户端要按 status 里的
        // 每个 provider 各取一次，结果合成 map 才能喂给展开面板。
        const providerScoped = takesProviderShorthand(cursor, at + 2, close);
        // state 名约定为方法名驼峰（`status` → `status`、`auto-state` → `autoState`）。
        // 官方插件的 useState 变量几乎总与方法同名，客户端以同名 prop 注入即可；
        // 按 setter 反推在多个取数调用并存时会互相错配，反而更不可靠。
        const state = method.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
        if (state === "")
            continue;
        found.push({
            state,
            method,
            ...(payload === undefined ? {} : { payload }),
            ...(providerScoped ? { scope: 'provider' } : {}),
        });
    }
    return found;
}
function readLiteralPayload(cursor, from, close) {
    const open = cursor.tokens[from + 1];
    if (open === undefined || open.kind !== 'punct' || open.value !== '{')
        return undefined;
    if (from + 2 >= close)
        return undefined;
    const value = readStaticValue(cursor, from + 1, close, undefined, undefined);
    if (value.t !== 'value')
        return undefined;
    const raw = value.v;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        return undefined;
    return raw;
}
/**
 * Inline the components one rendered element's children still carry.
 *
 * Children are read as nodes while the tree is being read, so a `<ProviderCard/>`
 * inside a `.map()` is a node whose type is `component:…` — it needs the same
 * inlining a component at the root gets, or a list of cards collapses into empty
 * shells.
 */
function inlineChildren(children, model, env, counter, depth) {
    return children.map(child => inlineNode(child, model, env, counter, depth));
}
/** Inline one already-read node when it is a component reference. */
function inlineNode(node, model, env, counter, depth) {
    if (node.kind !== 'element')
        return node;
    const type = node.type ?? '';
    if (!type.startsWith('component:')) {
        if (node.children.length === 0)
            return node;
        return { ...node, children: inlineChildren(node.children, model, env, counter, depth) };
    }
    const name = type.slice('component:'.length);
    const shape = model.components.get(name);
    if (shape === undefined || shape.bodyStart < 0)
        return node;
    counter.nodes += 1;
    if (counter.nodes > model.budget.maxNodes || depth > model.budget.maxDepth) {
        counter.truncated = true;
        return { kind: 'opaque', reason: counter.nodes > model.budget.maxNodes ? 'node-budget' : 'depth-budget' };
    }
    const inner = readStaticValue(model.cursor, shape.bodyStart, shape.bodyEnd, model, evaluateBody(model.cursor, model, shape, 
    // 注入的 Host 数据对内联子组件同样有效：用量等数值在子组件里算。
    forwardedProps(node.props)));
    const rendered = renderValue(inner, model, env, counter, depth + 1);
    if (rendered === null)
        return node;
    if (rendered.kind === 'element') {
        return { ...rendered, key: node.key ?? rendered.key };
    }
    return {
        kind: 'element',
        type,
        key: node.key,
        props: {},
        children: [rendered],
    };
}
/**
 * Drop empty child slots from a rendered tree.
 *
 * A child that turned out empty arrives as `null`/`undefined`; JSON has no
 * `undefined`, so it would serialize as a literal `null` child and the client's
 * strict decoder rejects the whole tree. The tree is cleaned once, here, instead
 * of relying on every producer to avoid the hole.
 */
function normalizeTree(node, warnings) {
    if (node === null || node === undefined)
        return null;
    if (node.kind !== 'element')
        return node;
    const children = [];
    for (const child of node.children ?? []) {
        const normalized = normalizeTree(child, warnings);
        if (normalized !== null)
            children.push(normalized);
    }
    return { ...node, children };
}
/**
 * Turn one statically-read value into a `RenderNode`, inlining component
 * references until the budget stops the walk.
 */
function renderValue(value, model, env, counter, depth) {
    counter.nodes += 1;
    if (process.env.DEBUG_RENDER && value.t === 'element')
        console.error('RENDER-ELEMENT', value.e.type, value.e.children?.length ?? 0);
    if (counter.nodes > model.budget.maxNodes) {
        counter.truncated = true;
        return { kind: 'opaque', reason: 'node-budget' };
    }
    if (depth > model.budget.maxDepth) {
        counter.truncated = true;
        return { kind: 'opaque', reason: 'depth-budget' };
    }
    switch (value.t) {
        case 'element':
            if (value.e.type.startsWith('component:')) {
                // A JSX call whose type is a sibling component: inline its own returned
                // expression so a composed card renders as one tree.
                const name = value.e.type.slice('component:'.length);
                const shape = model.components.get(name);
                if (shape !== undefined && shape.bodyStart >= 0) {
                    // The element's own props are the inlined component's props: a wrapper
                    // that forwards `children`/`cells` keeps them visible one level down.
                    // Placeholder strings (`<opaque:…>`) are *not* data and are dropped, or
                    // the wrapper would print them as if the plugin had written that text.
                    const inner = readStaticValue(model.cursor, shape.bodyStart, shape.bodyEnd, model, evaluateBody(model.cursor, model, shape, forwardedProps(value.e.props)));
                    const rendered = renderValue(inner, model, env, counter, depth + 1);
                    return {
                        ...value.e,
                        children: rendered === null ? inlineChildren(value.e.children, model, env, counter, depth) : [rendered],
                    };
                }
            }
            return { ...value.e, children: inlineChildren(value.e.children, model, env, counter, depth) };
        case 'text': return { kind: 'text', value: value.text };
        case 'value': {
            if (value.v === null || value.v === undefined || typeof value.v === 'boolean')
                return null;
            if (typeof value.v === 'string')
                return { kind: 'text', value: value.v };
            if (typeof value.v === 'number')
                return { kind: 'text', value: String(value.v) };
            return { kind: 'opaque', reason: 'object-child' };
        }
        case 'children': {
            return { kind: 'element', type: 'fragment', key: null, props: {}, children: [...value.c] };
        }
        case 'component-ref': {
            const shape = model.components.get(value.n);
            if (shape === undefined || shape.bodyStart < 0) {
                return { kind: 'opaque', reason: `component:${value.n}` };
            }
            const inner = readStaticValue(model.cursor, shape.bodyStart, shape.bodyEnd, model, evaluateBody(model.cursor, model, shape, {}));
            const rendered = renderValue(inner, model, env, counter, depth + 1);
            return {
                kind: 'element',
                type: `component:${value.n}`,
                key: null,
                props: {},
                children: rendered === null ? [] : [rendered],
            };
        }
        case 'opaque':
            return { kind: 'opaque', reason: value.r };
    }
}
/**
 * Read the initial value of a `useState(initial)` call.
 *
 * A component's first paint uses exactly that value, so binding it is faithful:
 * `const [open, setOpen] = useState(false)` means the panel starts closed, and
 * `const [copied, setCopied] = useState(null)` means nothing was copied yet.
 *
 * @returns `{ value }` when the callee is `useState` and the argument is data,
 *   otherwise undefined (the caller falls back to its other patterns).
 */
function readHookInitial(cursor, start, end, model, env) {
    // Find the callee's opening `(`, skipping the `(0, react.useState)` wrapper a
    // bundler emits, then check the name that precedes it.
    let openAt = -1;
    let scan = start;
    while (scan < end) {
        const token = cursor.tokens[scan];
        if (token.kind === 'punct' && token.value === '(') {
            const close = cursor.matchDelimiter(scan);
            if (close > scan + 1) {
                // Parenthesized callee: look past it for the real argument list.
                const after = cursor.tokens[close];
                if (after?.kind === 'punct' && after.value === '(') {
                    openAt = close;
                    break;
                }
                scan = close;
                continue;
            }
            openAt = scan;
            break;
        }
        scan += 1;
    }
    if (openAt < 0)
        return undefined;
    const calleeEnd = openAt;
    const name = cursor.tokens[calleeEnd - 1];
    if (name === undefined || name.kind !== 'ident')
        return undefined;
    if (!name.value.startsWith('useState'))
        return undefined;
    const close = cursor.matchDelimiter(openAt) - 1;
    const args = splitTopLevel(cursor, openAt + 1, close);
    if (args.length === 0)
        return { value: undefined };
    const first = args[0];
    const value = readStaticValue(cursor, first[0], first[1], model, env);
    if (value.t === 'value')
        return { value: value.v };
    if (value.t === 'text')
        return { value: value.text };
    return { value: false };
}
/**
 * Whether a plugin method only reads.
 *
 * Data sources are fetched periodically and on every page open, so a method that
 * mutates (check-in, set, connect, refresh) must never be treated as one.
 *
 * @param method - the literal method name from `call("<method>")`.
 * @returns true when the name reads like a query.
 */
function isReadMethod(method) {
    return READ_METHOD_PATTERN.test(method) && !WRITE_METHOD_PATTERN.test(method);
}
/** Names that read: `status`, `auto-state`, `usage`, `accounts`, `getX`, … */
const READ_METHOD_PATTERN = /^(?:get|list|read|query|describe|fetch|status|state|info|me|usage|balance|accounts?|providers?|rows|inventory|models?|sessions?|files?|settings?)\b/i;
/** Names that mutate, even when they look like a query. */
const WRITE_METHOD_PATTERN = /^(?:set|add|remove|delete|create|update|login|logout|checkin|submit|start|stop|toggle|enable|disable|connect|disconnect|refresh|sync|save|upload|install|uninstall|run|exec|send|post|put|patch|cancel|resume|revoke|grant)/i;
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
export function collectBundleDataSources(model) {
    const found = [];
    const seen = new Set();
    for (const shape of model.components.values()) {
        for (const source of extractDataSources(model.cursor, shape)) {
            if (seen.has(source.state))
                continue;
            seen.add(source.state);
            found.push(source);
        }
    }
    return found;
}
/**
 * Whether a call passes only the current provider.
 *
 * Matches the shorthand object `{ provider }`: the shape official usage calls use.
 * It tells the client to fetch the method once per provider.
 *
 * @param cursor - token stream.
 * @param from - token index of the method string.
 * @param close - index of the call closing paren.
 * @returns true when the argument is exactly `{ provider }`.
 */
function takesProviderShorthand(cursor, from, close) {
    const open = cursor.tokens[from + 1];
    if (open === undefined || open.kind !== 'punct' || open.value !== '{')
        return false;
    const ident = cursor.tokens[from + 2];
    const end = cursor.tokens[from + 3];
    return ident?.kind === 'ident' && ident.value === 'provider' &&
        end?.kind === 'punct' && end.value === '}' && from + 3 === close - 1;
}
/**
 * Host methods a bundle's handlers call that do change something.
 *
 * The inverse of a data source: these are the calls behind buttons (`login`,
 * `checkin`, `setAutoOn`). A client cannot run the browser handler, but it can offer
 * to invoke the same Host method when the plugin has not registered a native action.
 *
 * @param model - the parsed bundle.
 * @returns one entry per distinct write method, with its literal payload when given.
 */
export function collectActionMethods(model) {
    const found = [];
    const seen = new Set();
    for (const shape of model.components.values()) {
        if (shape.bodyOpen < 0 || shape.bodyClose < 0)
            continue;
        for (let at = shape.bodyOpen; at < shape.bodyClose; at += 1) {
            const token = model.cursor.tokens[at];
            if (token === undefined || token.kind !== 'ident' || token.value !== 'call')
                continue;
            const paren = model.cursor.tokens[at + 1];
            if (paren?.kind !== 'punct' || paren.value !== '(')
                continue;
            const methodToken = model.cursor.tokens[at + 2];
            if (methodToken?.kind !== 'string')
                continue;
            const method = methodToken.value;
            if (isReadMethod(method))
                continue;
            if (seen.has(method))
                continue;
            seen.add(method);
            const close = model.cursor.matchDelimiter(at + 1);
            const payload = readLiteralPayload(model.cursor, at + 2, close);
            found.push(payload === undefined ? { method } : { method, payload });
        }
    }
    return found;
}
