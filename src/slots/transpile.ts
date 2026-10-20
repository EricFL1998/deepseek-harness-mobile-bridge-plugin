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

import { createHash } from 'node:crypto'
import type { ElementNode, RenderNode } from '../protocol/types.ts'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One slot registration discovered by static analysis. */
export interface TranspiledRegistration {
  readonly slot: string
  readonly id?: string
  readonly key?: string
  readonly order?: number
  readonly priority?: number
  readonly locale?: string
  readonly label?: string
  /** Name of the component reference passed as the second argument. */
  readonly componentName?: string
  /** Whether the call was `register` or `registerFactory`. */
  readonly kind: 'component' | 'factory'
}

/** One function/arrow component found in the bundle. */
export interface TranspiledComponent {
  /** Source-level name (identifier or variable the arrow is assigned to). */
  readonly name: string
  /** Where in the source the component's expression starts (diagnostics). */
  readonly offset: number
}

/** Everything a static pass over one bundle learns. */
export interface TranspiledBundle {
  /** Entry id (`<dirName>#lib/client.js`) this bundle was read as. */
  readonly entryId: string
  /** Bundle source digest, so a client can tell a redeploy from a rename. */
  readonly digest: string
  /** Factory-local identifier a bundler gave its JSX runtime (`jsx`, `jsxs`). */
  readonly jsxNames: readonly string[]
  readonly registrations: readonly TranspiledRegistration[]
  readonly components: readonly TranspiledComponent[]
  readonly warnings: readonly string[]
}

/** Result of building one component's tree. */
export interface TranspiledTree {
  readonly componentId: string
  readonly tree: RenderNode | null
  readonly warnings: readonly string[]
  /** True when a budget stopped the walk; the tree is then a prefix. */
  readonly truncated: boolean
}

/** Ceilings applied to one parse / render. */
export interface TranspileBudget {
  /** Maximum bundle bytes the parser accepts. */
  readonly maxSourceBytes: number
  /** Maximum element depth a component tree may reach. */
  readonly maxDepth: number
  /** Maximum nodes one serialized tree may hold. */
  readonly maxNodes: number
}

/** Default ceilings: generous enough for real cards, strict enough for a phone Host. */
export const DEFAULT_TRANSPILE_BUDGET: TranspileBudget = {
  maxSourceBytes: 8 * 1024 * 1024,
  maxDepth: 32,
  maxNodes: 4_000,
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/** One lexical token of the compiled bundle. */
interface Token {
  readonly kind: 'ident' | 'keyword' | 'string' | 'number' | 'template' | 'regex' | 'punct'
  readonly value: string
  readonly start: number
  readonly end: number
  /** Source line (0-based) of `start`; diagnostics only. */
  readonly line: number
}

const KEYWORDS = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for',
  'function', 'if', 'import', 'in', 'instanceof', 'new', 'return', 'switch',
  'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
  'let', 'static', 'of', 'true', 'false', 'null', 'undefined', 'get', 'set',
  'async', 'from', 'as',
])

/** Punctuation sorted longest-first so `...` wins over `.` and `===` over `=`. */
const PUNCTS = [
  '>>>=', '...', '===', '!==', '>>>', '<<=', '>>=', '**=', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=',
  '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '**',
  '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%',
  '&', '|', '^', '!', '~', '?', ':', '=', '.',
]

/**
 * Tokenize one bundle into an array of tokens.
 *
 * The tokenizer is a scanner, not a parser: comments and strings are consumed
 * atomically, regex literals are distinguished from division by the previous
 * meaningful token, and everything else is an identifier, number, template
 * string, or punctuation. Source positions are kept on every token so warnings
 * can name a line.
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  const length = source.length
  let index = 0
  let line = 0

  const push = (kind: Token['kind'], value: string, start: number, end: number): void => {
    tokens.push({ kind, value, start, end, line })
  }

  /** Regexes may start after these punctuations/keywords (division elsewhere). */
  const regexAllowedAfter = (previous: Token | undefined): boolean => {
    if (previous === undefined) return true
    if (previous.kind === 'keyword') {
      return !['this', 'super', 'true', 'false', 'null', 'undefined'].includes(previous.value)
    }
    if (previous.kind !== 'punct') return false
    return ![')', ']', '}', '++', '--'].includes(previous.value)
  }

  while (index < length) {
    const char = source[index]!
    // Newlines / whitespace.
    if (char === '\n') { line += 1; index += 1; continue }
    if (char === ' ' || char === '\t' || char === '\r' || char === '' || char === '') { index += 1; continue }
    // Comments.
    if (char === '/' && source[index + 1] === '/') {
      while (index < length && source[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      const stop = end < 0 ? length : end + 2
      for (let at = index; at < stop; at += 1) if (source[at] === '\n') line += 1
      index = stop
      continue
    }
    // Strings.
    if (char === '"' || char === "'") {
      const start = index
      index += 1
      let value = ''
      while (index < length) {
        const c = source[index]!
        if (c === '\\') {
          value += source[index]! + (source[index + 1] ?? '')
          if (source[index + 1] === '\n') line += 1
          index += 2
          continue
        }
        if (c === char) { index += 1; break }
        if (c === '\n') { line += 1 }
        value += c
        index += 1
      }
      push('string', value, start, index)
      continue
    }
    // Template literals (with `${…}` nesting).
    if (char === '`') {
      const start = index
      index += 1
      let value = ''
      let depth = 0
      while (index < length) {
        const c = source[index]!
        if (c === '\\') { value += source[index]! + (source[index + 1] ?? ''); index += 2; continue }
        if (c === '`' && depth === 0) { index += 1; break }
        if (c === '$' && source[index + 1] === '{') { depth += 1; value += '${'; index += 2; continue }
        if (c === '}' && depth > 0) { depth -= 1; value += c; index += 1; continue }
        if (c === '\n') line += 1
        value += c
        index += 1
      }
      push('template', value, start, index)
      continue
    }
    // Regex literals.
    if (char === '/' && regexAllowedAfter(tokens[tokens.length - 1])) {
      const start = index
      index += 1
      let inClass = false
      while (index < length) {
        const c = source[index]!
        if (c === '\\') { index += 2; continue }
        if (c === '\n') break
        if (c === '[') inClass = true
        else if (c === ']') inClass = false
        else if (c === '/' && !inClass) { index += 1; break }
        index += 1
      }
      while (index < length && /[a-z]/i.test(source[index]!)) index += 1
      push('regex', source.slice(start, index), start, index)
      continue
    }
    // Numbers (decimal, hex/oct/bin, exponents, separators).
    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(source[index + 1] ?? ''))) {
      const start = index
      const match = /^(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.[\d_]+)(?:[eE][+-]?[\d_]+)?n?)/.exec(source.slice(index))
      index += match?.[0].length ?? 1
      push('number', source.slice(start, index), start, index)
      continue
    }
    // Identifiers.
    if (/[A-Za-z_$]/.test(char)) {
      const start = index
      while (index < length && /[\w$]/.test(source[index]!)) index += 1
      const value = source.slice(start, index)
      push(KEYWORDS.has(value) ? 'keyword' : 'ident', value, start, index)
      continue
    }
    // Punctuation.
    let matched: string | undefined
    for (const punct of PUNCTS) {
      if (source.startsWith(punct, index)) { matched = punct; break }
    }
    if (matched === undefined) {
      // Unknown byte: skip it so one exotic character never aborts the pass.
      index += 1
      continue
    }
    push('punct', matched, index, index + matched.length)
    index += matched.length
  }
  return tokens
}

// ---------------------------------------------------------------------------
// Token cursor
// ---------------------------------------------------------------------------

/** A forward-only walk over one token list with lookahead and matching helpers. */
class Cursor {
  readonly tokens: readonly Token[]
  at = 0

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens
  }

  get done(): boolean { return this.at >= this.tokens.length }
  peek(offset = 0): Token | undefined { return this.tokens[this.at + offset] }
  next(): Token | undefined { return this.tokens[this.at++] }

  /** Consume one token when it is the given punctuation. */
  eat(punct: string): boolean {
    const token = this.tokens[this.at]
    if (token !== undefined && token.kind === 'punct' && token.value === punct) {
      this.at += 1
      return true
    }
    return false
  }

  /** Consume one token when it is the given identifier/keyword. */
  eatWord(word: string): boolean {
    const token = this.tokens[this.at]
    if (token !== undefined && (token.kind === 'ident' || token.kind === 'keyword') && token.value === word) {
      this.at += 1
      return true
    }
    return false
  }

  /** Index of the token whose `start` is at-or-after the source offset. */
  indexAtOffset(offset: number): number {
    let lo = this.at
    let hi = this.tokens.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.tokens[mid]!.start < offset) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /** Index one past the punct-balanced region opened at `openIndex` (which holds `open`). */
  matchDelimiter(openIndex: number): number {
    const openToken = this.tokens[openIndex]
    if (openToken === undefined || openToken.kind !== 'punct') return openIndex + 1
    const close = { '(': ')', '{': '}', '[': ']' }[openToken.value]
    if (close === undefined) return openIndex + 1
    let depth = 0
    for (let at = openIndex; at < this.tokens.length; at += 1) {
      const token = this.tokens[at]!
      if (token.kind !== 'punct') continue
      if (token.value === openToken.value) depth += 1
      else if (token.value === close) {
        depth -= 1
        if (depth === 0) return at + 1
      }
    }
    return this.tokens.length
  }

  /** Index one past the current statement: up to `;` or the closing `}` of a block. */
  skipStatement(): number {
    let at = this.at
    while (at < this.tokens.length) {
      const token = this.tokens[at]!
      if (token.kind === 'punct') {
        if (token.value === ';') return at + 1
        if (token.value === '{' || token.value === '(' || token.value === '[') {
          at = this.matchDelimiter(at)
          continue
        }
        if (token.value === '}') return at
      }
      at += 1
    }
    return at
  }
}

// ---------------------------------------------------------------------------
// Static value model
// ---------------------------------------------------------------------------

/**
 * What one expression statically resolves to.
 *
 * - `{ t: 'value', v }` — a JSON-safe literal (string/number/boolean/null) or
 *   nested static array/object.
 * - `{ t: 'element', e }` — a render-tree element produced by a JSX call.
 * - `{ t: 'component-ref', n }` — a reference to a component function; rendered
 *   by inlining its own returned expression.
 * - `{ t: 'children', c }` — several sibling nodes (array spread / variadic
 *   `createElement` children).
 * - `{ t: 'opaque', r }` — known to be dynamic; `r` names why.
 */
type StaticValue =
  | { readonly t: 'value'; readonly v: unknown }
  | { readonly t: 'element'; readonly e: ElementNode }
  | { readonly t: 'text'; readonly text: string }
  | { readonly t: 'component-ref'; readonly n: string }
  | { readonly t: 'children'; readonly c: readonly RenderNode[] }
  | { readonly t: 'opaque'; readonly r: string }

/** Function-shape the analyzer recovered for one component. */
interface ComponentShape {
  readonly name: string
  /** Binding identifiers the component's body reads (`{title:e}` → `e`). */
  readonly paramProps: readonly string[]
  /** Destructured *property* names in declaration order (`{title:e}` → `title`). */
  readonly paramKeys: readonly string[]
  /** True when the parameter is one plain identifier (`props.x` reads). */
  readonly paramIsIdentifier: boolean
  /** Token index of the expression the component returns, or -1 when none. */
  readonly bodyStart: number
  readonly bodyEnd: number
  readonly offset: number
}

/** Everything one bundle pass keeps. */
interface BundleModel {
  readonly cursor: Cursor
  readonly source: string
  readonly jsxNames: Set<string>
  readonly registrations: TranspiledRegistration[]
  readonly components: Map<string, ComponentShape>
  readonly warnings: string[]
  readonly budget: TranspileBudget
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
export function analyzeBundle(
  entryId: string,
  source: string,
  budget: TranspileBudget = DEFAULT_TRANSPILE_BUDGET,
): TranspiledBundle {
  const warnings: string[] = []
  if (Buffer.byteLength(source, 'utf8') > budget.maxSourceBytes) {
    return {
      entryId,
      digest: createHash('sha256').update(source).digest('hex'),
      jsxNames: [],
      registrations: [],
      components: [],
      warnings: [`bundle exceeds the ${budget.maxSourceBytes}-byte source ceiling; not parsed`],
    }
  }
  const model = buildModel(source, budget, warnings)
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
  }
}

/** Digest of one bundle's source, recorded so a client can tell a redeploy from a rename. */
export function bundleSourceDigest(source: string): string {
  return createHash('sha256').update(source).digest('hex')
}

/**
 * Build the internal model: tokenize, then walk every statement collecting
 * bindings, components and registrations.
 */
function buildModel(source: string, budget: TranspileBudget, warnings: string[]): BundleModel {
  const cursor = new Cursor(tokenize(source))
  const model: BundleModel = {
    cursor,
    source,
    jsxNames: new Set(),
    registrations: [],
    components: new Map(),
    warnings,
    budget,
  }
  collectBindings(cursor, model)
  // Pass 1: bind function declarations and `const Name = …` component
  // initializers everywhere, so a `register(…, Component)` call and a JSX
  // `<Child/>` reference resolve no matter which appears first in the source.
  bindComponents(cursor, 0, cursor.tokens.length, model)
  // Pass 2: find every `register(…)` call. A second pass is required because
  // the calls live inside `apply`, which pass 1 deliberately does not treat as
  // a component (its `return` yields no tree).
  scanRegistrations(cursor, model)
  return model
}

/**
 * Learn the bundler's helper names from its `var … = …` preamble:
 * the JSX-runtime aliases (`jsx`, `jsxs`, `jsxDEV`) are the identifiers whose
 * initializer is a `require(…)` call, plus the `React`-named namespace object.
 */
function collectBindings(cursor: Cursor, model: BundleModel): void {
  // Always know the canonical runtime names; a bundler preamble adds its own
  // aliases on top (they share these spellings in rolldown's default output,
  // and the extras cost nothing when absent).
  model.jsxNames.add('jsx')
  model.jsxNames.add('jsxs')
  model.jsxNames.add('jsxDEV')
  model.jsxNames.add('React.createElement')
  for (let at = 0; at < cursor.tokens.length; at += 1) {
    const token = cursor.tokens[at]!
    if (token.kind !== 'ident') continue
    if (token.value !== 'React') continue
    const next = cursor.tokens[at + 1]
    if (next === undefined || next.kind !== 'punct' || next.value !== '=') continue
    model.jsxNames.add('React.createElement')
  }
}

/**
 * Scan one token region for `register(…)` calls.
 */
function scanRegistrations(cursor: Cursor, model: BundleModel): void {
  for (let at = 0; at < cursor.tokens.length; at += 1) {
    const token = cursor.tokens[at]!
    if (token.kind === 'ident' && (token.value === 'register' || token.value === 'registerFactory')) {
      const before = cursor.tokens[at - 1]
      const open = cursor.tokens[at + 1]
      if (before?.kind === 'punct' && before.value === '.' && open?.kind === 'punct' && open.value === '(') {
        const registration = readRegistration(cursor, at, model, token.value === 'registerFactory')
        if (registration !== undefined) model.registrations.push(registration)
      }
    }
  }
}

/**
 * Read one `register({…}, Component)` call starting at the `register` token.
 */
function readRegistration(
  cursor: Cursor,
  registerAt: number,
  model: BundleModel,
  factory: boolean,
): TranspiledRegistration | undefined {
  const openAt = registerAt + 1
  const closeAt = cursor.matchDelimiter(openAt) - 1
  const argStart = openAt + 1
  // Split the arguments on top-level commas.
  const args = splitTopLevel(cursor, argStart, closeAt)
  if (args.length === 0) return undefined
  const record = readStaticObject(cursor, args[0]![0], args[0]![1], model)
  if (record === undefined) return undefined
  const slot = record.get('name')
  const slotName = slot !== undefined && slot.t === 'text' ? slot.text
    : slot !== undefined && slot.t === 'value' && typeof slot.v === 'string' ? slot.v
    : undefined
  if (slotName === undefined) return undefined
  const component = args[1] === undefined ? undefined : readStaticValue(cursor, args[1]![0], args[1]![1], model, emptyEnv())
  const text = (key: string): string | undefined => {
    const value = record.get(key)
    if (value === undefined) return undefined
    if (value.t === 'text') return value.text
    return value.t === 'value' && typeof value.v === 'string' ? value.v : undefined
  }
  const num = (key: string): number | undefined => {
    const value = record.get(key)
    return value !== undefined && value.t === 'value' && typeof value.v === 'number' ? value.v : undefined
  }
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
  }
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
function bindComponents(cursor: Cursor, start: number, end: number, model: BundleModel): void {
  let at = start
  while (at < end) {
    const token = cursor.tokens[at]!
    // `function Name(…) {…}`.
    if (token.kind === 'keyword' && token.value === 'function') {
      const shape = readFunction(cursor, at, model)
      if (shape !== undefined) model.components.set(shape.name, shape)
    }
    // `const|let|var Name = …` declaration lists.
    if (token.kind === 'keyword' && (token.value === 'const' || token.value === 'let' || token.value === 'var')) {
      at = readVariableDeclarations(cursor, at, end, model)
      continue
    }
    at += 1
  }
}

/**
 * Read a `function` declaration/expression starting at its keyword.
 */
function readFunction(cursor: Cursor, functionAt: number, model: BundleModel): ComponentShape | undefined {
  const nameToken = cursor.tokens[functionAt + 1]
  // Anonymous function expressions are reached through their binding instead.
  if (nameToken === undefined || nameToken.kind !== 'ident') return undefined
  const paramsOpen = functionAt + 2
  if (cursor.tokens[paramsOpen]?.value !== '(') return undefined
  const paramsClose = cursor.matchDelimiter(paramsOpen) - 1
  const bodyOpen = cursor.tokens[paramsClose + 1]?.value === '{' ? paramsClose + 1 : undefined
  if (bodyOpen === undefined) return undefined
  const bodyClose = cursor.matchDelimiter(bodyOpen) - 1
  const returnAt = findReturn(cursor, bodyOpen + 1, bodyClose)
  const props = readParams(cursor, paramsOpen + 1, paramsClose)
  return {
    name: nameToken.value,
    paramProps: props.names,
    paramKeys: props.keys,
    paramIsIdentifier: props.identifier,
    bodyStart: returnAt,
    bodyEnd: returnAt >= 0 ? expressionEnd(cursor, returnAt, bodyClose) : -1,
    offset: nameToken.start,
  }
}

/**
 * Read one `const|let|var` declaration list; every PascalCase binding whose
 * initializer is an arrow or function becomes a component candidate.
 * @returns the token index to continue the scan from.
 */
function readVariableDeclarations(cursor: Cursor, at: number, end: number, model: BundleModel): number {
  let index = at + 1
  while (index < end) {
    const token = cursor.tokens[index]!
    if (token.kind === 'punct' && token.value === ';') return index + 1
    if (token.kind === 'punct' && (token.value === '}' || token.value === ')')) return index
    if (token.kind === 'ident') {
      const eq = cursor.tokens[index + 1]
      if (eq?.kind === 'punct' && eq.value === '=') {
        const shape = readFunctionLike(cursor, token, index + 2, model)
        if (shape !== undefined && /^[A-Z]/.test(shape.name)) {
          model.components.set(shape.name, shape)
        }
      }
    }
    index += 1
    // Never run past the statement's end.
    if (cursor.tokens[index - 1]?.kind === 'punct' && cursor.tokens[index - 1]?.value === ',') continue
  }
  return index
}

/**
 * Read an arrow or anonymous-function initializer at `initAt` for binding `name`.
 */
function readFunctionLike(cursor: Cursor, nameToken: Token, initAt: number, model: BundleModel): ComponentShape | undefined {
  const first = cursor.tokens[initAt]
  if (first === undefined) return undefined
  // `Name = function (…) {…}`
  if (first.kind === 'keyword' && first.value === 'function') {
    let at = initAt + 1
    if (cursor.tokens[at]?.kind === 'ident') at += 1
    if (cursor.tokens[at]?.value !== '(') return undefined
    const paramsClose = cursor.matchDelimiter(at) - 1
    if (cursor.tokens[paramsClose + 1]?.value !== '{') return undefined
    const bodyClose = cursor.matchDelimiter(paramsClose + 1) - 1
    const props = readParams(cursor, at + 1, paramsClose)
    const returnAt = findReturn(cursor, paramsClose + 2, bodyClose)
    return {
      name: nameToken.value,
      paramProps: props.names,
    paramKeys: props.keys,
      paramIsIdentifier: props.identifier,
      bodyStart: returnAt,
      bodyEnd: returnAt >= 0 ? expressionEnd(cursor, returnAt, bodyClose) : -1,
      offset: nameToken.start,
    }
  }
  // `Name = (…) => …` or `Name = x => …`
  let paramsOpen = initAt
  if (first.kind === 'ident' && cursor.tokens[initAt + 1]?.value === '=>') {
    const props = { names: [first.value], keys: [first.value], identifier: true }
    return arrowShape(cursor, nameToken, props, initAt + 2)
  }
  if (first.kind !== 'punct' || first.value !== '(') return undefined
  const paramsClose = cursor.matchDelimiter(paramsOpen) - 1
  if (cursor.tokens[paramsClose + 1]?.value !== '=>') return undefined
  const props = readParams(cursor, paramsOpen + 1, paramsClose)
  return arrowShape(cursor, nameToken, props, paramsClose + 2)
}

/** Build the shape of one arrow component from the start of its body expression. */
function arrowShape(
  cursor: Cursor,
  nameToken: Token,
  props: { names: string[]; keys: string[]; identifier: boolean },
  bodyStart: number,
): ComponentShape {
  let start = bodyStart
  let end = cursor.tokens.length
  if (cursor.tokens[start]?.kind === 'punct' && cursor.tokens[start]?.value === '{') {
    const bodyClose = cursor.matchDelimiter(start) - 1
    const returnAt = findReturn(cursor, start + 1, bodyClose)
    return {
      name: nameToken.value,
      paramProps: props.names,
    paramKeys: props.keys,
      paramIsIdentifier: props.identifier,
      bodyStart: returnAt,
      bodyEnd: returnAt >= 0 ? expressionEnd(cursor, returnAt, bodyClose) : -1,
      offset: nameToken.start,
    }
  }
  end = expressionEnd(cursor, start, end)
  return {
    name: nameToken.value,
    paramProps: props.names,
    paramKeys: props.keys,
    paramIsIdentifier: props.identifier,
    bodyStart: start,
    bodyEnd: end,
    offset: nameToken.start,
  }
}

/**
 * Parameter names of one parameter list.
 *
 * A destructured parameter yields two parallel lists:
 * - `keys` — the *property* names, in declaration order (`{title:e}` → `title`).
 *   Minification never renames object keys, so this order matches the request's
 *   props order and is the positional-fallback basis;
 * - `names` — the *binding* identifiers an expression reads (`{title:e}` → `e`,
 *   `{used}` → `used`). These are what `readStaticValue` resolves.
 */
function readParams(
  cursor: Cursor,
  start: number,
  close: number,
): { names: string[]; keys: string[]; identifier: boolean } {
  const names: string[] = []
  const keys: string[] = []
  if (cursor.tokens[start]?.kind === 'punct' && cursor.tokens[start]?.value === '{') {
    let at = start + 1
    while (at < close) {
      const token = cursor.tokens[at]!
      if (token.kind === 'ident' || token.kind === 'string') {
        const key = token.value
        keys.push(key)
        // `{ title }` shorthand binds the same name; `{ title: e }` binds `e`;
        // `{ title: e = 1 }` still binds `e`.
        if (cursor.tokens[at + 1]?.kind === 'punct' && cursor.tokens[at + 1]?.value === ':') {
          const binding = cursor.tokens[at + 2]
          if (binding !== undefined && binding.kind === 'ident') names.push(binding.value)
          at += 3
          continue
        }
        names.push(key)
      }
      at += 1
    }
    return { names, keys, identifier: false }
  }
  const single = cursor.tokens[start]?.kind === 'ident' ? cursor.tokens[start]!.value : undefined
  return {
    names: single === undefined ? [] : [single],
    keys: single === undefined ? [] : [single],
    identifier: single !== undefined,
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
function findReturn(cursor: Cursor, start: number, close: number): number {
  const candidates: number[] = []
  let depth = 0
  for (let at = start; at < close; at += 1) {
    const token = cursor.tokens[at]!
    if (token.kind === 'punct' && token.value === '{') depth += 1
    else if (token.kind === 'punct' && token.value === '}') depth -= 1
    else if (depth === 0 && token.kind === 'keyword' && token.value === 'return') {
      candidates.push(at + 1)
    }
    // Nested function bodies are skipped entirely.
    if (token.kind === 'keyword' && token.value === 'function') {
      let at2 = at + 1
      if (cursor.tokens[at2]?.kind === 'ident') at2 += 1
      if (cursor.tokens[at2]?.value === '(') {
        const paramsClose = cursor.matchDelimiter(at2) - 1
        if (cursor.tokens[paramsClose + 1]?.value === '{') {
          at = cursor.matchDelimiter(paramsClose + 1) - 1
          continue
        }
      }
    }
  }
  if (candidates.length === 0) return -1
  let best = candidates[0]!
  let bestWidth = -1
  for (const candidate of candidates) {
    const width = expressionEnd(cursor, candidate, close) - candidate
    if (width > bestWidth) {
      bestWidth = width
      best = candidate
    }
  }
  return best
}

/**
 * One-past-the-end token index of the expression starting at `start`, bounded
 * by `limit`. Stops at a top-level `;`, `,` at depth 0 of a statement, or a
 * closing `}`/`]` that closes the enclosing statement context.
 */
function expressionEnd(cursor: Cursor, start: number, limit: number): number {
  let at = start
  while (at < limit) {
    const token = cursor.tokens[at]!
    if (token.kind === 'punct') {
      // A delimited region belongs to the expression…
      if (token.value === '(' || token.value === '[') {
        at = cursor.matchDelimiter(at)
        continue
      }
      // …and so does an object literal — but only in expression position. A
      // `{` that opens a *statement* block (an if/else body, the function's own
      // closing context) ends the expression, which the callers that bound us
      // by a block's closing `}` already encoded in `limit`.
      if (token.value === '{') {
        const prev = cursor.tokens[at - 1]
        const opensBlock = prev === undefined
          || (prev.kind === 'punct' && (prev.value === ')' || prev.value === '{' || prev.value === ';' || prev.value === '}'))
          || (prev.kind === 'keyword' && (prev.value === 'else' || prev.value === 'do' || prev.value === 'try' || prev.value === 'finally'))
        if (opensBlock) return at
        at = cursor.matchDelimiter(at)
        continue
      }
      if (token.value === ';' || token.value === '}' || token.value === ']') return at
      if (token.value === ',') {
        // A top-level comma ends a returned expression but not an arrow body in
        // a variable declaration list; both cases want the expression to stop.
        return at
      }
    }
    at += 1
  }
  return limit
}

/** Split one token range into top-level comma-separated spans. */
function splitTopLevel(cursor: Cursor, start: number, end: number): [number, number][] {
  const spans: [number, number][] = []
  let spanStart = start
  let at = start
  while (at < end) {
    const token = cursor.tokens[at]!
    if (token.kind === 'punct') {
      if (token.value === '(' || token.value === '{' || token.value === '[') {
        at = cursor.matchDelimiter(at)
        continue
      }
      if (token.value === ',') {
        spans.push([spanStart, at])
        spanStart = at + 1
      }
    }
    at += 1
  }
  if (spanStart < end) spans.push([spanStart, end])
  return spans.filter(([a, b]) => a < b)
}

/** Read one object-literal span into a property map, when every value is static. */
function readStaticObject(
  cursor: Cursor,
  start: number,
  end: number,
  model: BundleModel,
): Map<string, StaticValue> | undefined {
  const open = cursor.tokens[start]
  if (open === undefined || open.kind !== 'punct' || open.value !== '{') return undefined
  // The span may end at the closing `}` itself (a top-level-comma split) or one
  // past it (a matchDelimiter result); both describe the same object body.
  const close = cursor.tokens[end - 1]?.kind === 'punct' && cursor.tokens[end - 1]?.value === '}' ? end - 1 : end
  const record = new Map<string, StaticValue>()
  for (const [a, b] of splitTopLevel(cursor, start + 1, close)) {
    const name = cursor.tokens[a]
    if (name === undefined || (name.kind !== 'ident' && name.kind !== 'string')) continue
    if (cursor.tokens[a + 1]?.kind !== 'punct' || cursor.tokens[a + 1]?.value !== ':') continue
    record.set(name.value, readStaticValue(cursor, a + 2, b, model, emptyEnv()))
  }
  return record
}

// ---------------------------------------------------------------------------
// Static expression reading
// ---------------------------------------------------------------------------

/** Caller-supplied props environment for one render. */
interface PropEnv {
  /** Binding identifiers an expression may read (`{title:e}` → `e`). */
  readonly destructured: ReadonlySet<string>
  /**
   * Binding identifiers in declaration order (`{title:e, used:t}` → `[e, t]`).
   * Parallel to `keys`.
   */
  readonly bindings: readonly string[]
  /**
   * Destructured *property* names in the same declaration order
   * (`{title:e, used:t}` → `[title, used]`). Minification never renames object
   * keys, so a binding's position here is its prop's identity even when the
   * binding itself was renamed.
   */
  readonly keys: readonly string[]
  /** Whether the parameter is one plain identifier, enabling `props.name` reads. */
  readonly identifier: boolean
  /** The props `component-tree` was called with. */
  readonly values: Readonly<Record<string, unknown>>
}

function emptyEnv(): PropEnv {
  return { destructured: new Set(), bindings: [], keys: [], identifier: false, values: {} }
}

/** Build the environment one component's parameters read from. */
function envOf(shape: ComponentShape, props: Readonly<Record<string, unknown>>): PropEnv {
  return {
    destructured: new Set(shape.paramProps),
    bindings: shape.paramProps,
    keys: shape.paramKeys,
    identifier: shape.paramIsIdentifier,
    values: props,
  }
}

/**
 * Resolve one destructured binding against the request's props.
 *
 * Exact name first (`{used}` reads `used`); a minified rename (`{title:e}`)
 * falls back to the *property* name at the same position, which is the
 * identity minification preserves. `found: false` means the request supplied
 * no prop for this binding and the client renders the dynamic placeholder.
 */
function propValue(name: string, env: PropEnv): { found: boolean; value: unknown } {
  if (name in env.values) return { found: true, value: env.values[name] }
  const position = env.bindings.indexOf(name)
  if (position >= 0 && position < env.keys.length) {
    const key = env.keys[position]!
    if (key in env.values) return { found: true, value: env.values[key] }
  }
  return { found: false, value: undefined }
}

/**
 * Statically resolve one expression span.
 *
 * The reader is deliberately small: it knows literals, arrays, objects,
 * parenthesized/conditional/sequence forms, JSX-runtime calls, identifier
 * references into the props environment, and component references. Everything
 * else is reported as opaque with a reason, never guessed.
 */
function readStaticValue(
  cursor: Cursor,
  start: number,
  end: number,
  model: BundleModel,
  env: PropEnv,
  depth = 0,
): StaticValue {
  if (start >= end) return { t: 'opaque', r: 'empty-expression' }
  if (depth > model.budget.maxDepth) return { t: 'opaque', r: 'depth-budget' }
  const first = cursor.tokens[start]!

  // Parenthesized expression: transparent…
  if (first.kind === 'punct' && first.value === '(' && cursor.matchDelimiter(start) === end) {
    return readStaticValue(cursor, start + 1, end - 1, model, env, depth + 1)
  }
  // …unless it is a parenthesized *callee*: the minified `(0, n.jsx)(…)` /
  // `(0, n.jsxs)(…)` shape a bundler emits to keep the call's `this` undefined.
  // The leading `0,` is the comma trick, the member read names the runtime, and
  // the group is followed by the real argument list.
  if (first.kind === 'punct' && first.value === '(') {
    const groupClose = cursor.matchDelimiter(start) // one past `)`
    if (cursor.tokens[groupClose]?.kind === 'punct' && cursor.tokens[groupClose]?.value === '(') {
      const parts = splitTopLevel(cursor, start + 1, groupClose - 1)
      const calleeSpan = parts[parts.length - 1]
      if (calleeSpan !== undefined && readJsxCallee(cursor, calleeSpan[0], calleeSpan[1], model)) {
        const close = cursor.matchDelimiter(groupClose) - 1
        const args = splitTopLevel(cursor, groupClose + 1, close)
        return elementFromArgs(cursor, args, model, env, depth, close)
      }
    }
  }

  // Conditional: resolve the statically-known branch, report the rest.
  const cond = splitConditional(cursor, start, end)
  if (cond !== undefined) {
    const test = readStaticValue(cursor, cond[0], cond[1], model, env, depth + 1)
    if (test.t === 'value' && typeof test.v === 'boolean') {
      return readStaticValue(cursor, test.v ? cond[2] : cond[4], test.v ? cond[3] : cond[5], model, env, depth + 1)
    }
    return { t: 'opaque', r: 'conditional' }
  }

  // Sequence expression `(a, b)`: only the last matters for rendering. A span
  // that *is* one balanced parenthesis/array/object group must not be mistaken
  // for a sequence — the group itself is the expression.
  const first2 = cursor.tokens[start]!
  const isGroup = first2.kind === 'punct'
    && (first2.value === '(' || first2.value === '[' || first2.value === '{')
    && cursor.matchDelimiter(start) === end
  if (!isGroup) {
    const top = splitTopLevel(cursor, start, end)
    if (top.length > 1) {
      const last = top[top.length - 1]!
      return readStaticValue(cursor, last[0], last[1], model, env, depth + 1)
    }
  }

  switch (first.kind) {
    case 'string':
      return { t: 'text', text: decodeEscapes(first.value) }
    case 'number': {
      if (end === start + 1) return { t: 'value', v: Number(first.value.replace(/[_n]/g, '')) }
      return { t: 'opaque', r: 'number-expression' }
    }
    case 'template': {
      if (first.value.includes('${')) return { t: 'opaque', r: 'template-substitution' }
      return { t: 'text', text: decodeEscapes(first.value) }
    }
    case 'keyword': {
      if (end === start + 1) {
        if (first.value === 'true') return { t: 'value', v: true }
        if (first.value === 'false') return { t: 'value', v: false }
        if (first.value === 'null') return { t: 'value', v: null }
        if (first.value === 'undefined') return { t: 'value', v: undefined }
      }
      return { t: 'opaque', r: `keyword:${first.value}` }
    }
    case 'punct': {
      // Unary minus on a number literal.
      if (first.value === '-' && cursor.tokens[start + 1]?.kind === 'number' && end === start + 2) {
        return { t: 'value', v: -Number(cursor.tokens[start + 1]!.value.replace(/[_n]/g, '')) }
      }
      // Array literal.
      if (first.value === '[' && cursor.matchDelimiter(start) === end) {
        const items: unknown[] = []
        for (const [a, b] of splitTopLevel(cursor, start + 1, end - 1)) {
          const value = readStaticValue(cursor, a, b, model, env, depth + 1)
          if (value.t === 'value') items.push(value.v)
          else if (value.t === 'text') items.push(value.text)
          else return { t: 'opaque', r: 'array-item' }
        }
        return { t: 'value', v: items }
      }
      // Object literal.
      if (first.value === '{' && cursor.matchDelimiter(start) === end) {
        const out: Record<string, unknown> = {}
        for (const [a, b] of splitTopLevel(cursor, start + 1, end - 1)) {
          const name = cursor.tokens[a]
          if (name === undefined) continue
          // Spread: report the whole object as dynamic rather than partial.
          if (name.kind === 'punct' && name.value === '...') return { t: 'opaque', r: 'object-spread' }
          if (name.kind !== 'ident' && name.kind !== 'string') continue
          // Shorthand `{ title }` reads the environment.
          if (a + 1 === b) {
            const value = readIdentifier(name.value, env)
            if (value.t !== 'value' && value.t !== 'text') return { t: 'opaque', r: 'object-shorthand' }
            out[name.value] = value.t === 'value' ? value.v : value.text
            continue
          }
          if (cursor.tokens[a + 1]?.kind !== 'punct' || cursor.tokens[a + 1]?.value !== ':') continue
          const value = readStaticValue(cursor, a + 2, b, model, env, depth + 1)
          if (value.t === 'value') out[name.value] = value.v
          else if (value.t === 'text') out[name.value] = value.text
          else out[name.value] = `<${value.t}:${value.t === 'opaque' ? value.r : 'dynamic'}>`
        }
        return { t: 'value', v: out }
      }
      return { t: 'opaque', r: `punct:${first.value}` }
    }
    case 'ident': {
      // JSX-runtime call: `jsx(…)`, `jsxs(…)`, `React.createElement(…)`.
      if (model.jsxNames.has(first.value) && cursor.tokens[start + 1]?.value === '(') {
        return readJsxCall(cursor, start, end, model, env, depth)
      }
      if (first.value === 'React'
        && cursor.tokens[start + 1]?.value === '.'
        && cursor.tokens[start + 2]?.kind === 'ident'
        && cursor.tokens[start + 2]?.value === 'createElement'
        && cursor.tokens[start + 3]?.value === '(') {
        return readCreateElementCall(cursor, start, end, model, env, depth)
      }
      // Member read into the props environment: `props.title`.
      if (cursor.tokens[start + 1]?.value === '.' && cursor.tokens[start + 2]?.kind === 'ident' && end === start + 3) {
        if (env.identifier) {
          const value = env.values[cursor.tokens[start + 2]!.value]
          if (value !== undefined) return { t: 'value', v: value }
          return { t: 'opaque', r: `prop:${cursor.tokens[start + 2]!.value}` }
        }
        return { t: 'opaque', r: 'member-expression' }
      }
      if (end === start + 1) {
        // Prop read by destructured name. A prop the caller did not supply stays
        // dynamic data the plugin controls at runtime — reported as
        // `prop:<name>` so the client can say so, not a resolution failure.
        if (env.destructured.has(first.value)) {
          const resolved = propValue(first.value, env)
          if (resolved.found) return { t: 'value', v: resolved.value }
          return { t: 'opaque', r: `prop:${first.value}` }
        }
        // Component reference: render it inline at the use site. A name that is
        // not (yet) bound in this bundle still reads as a reference — the
        // registration's component may live behind a variable the pass skipped,
        // and the renderer reports it as opaque when it truly resolves nowhere.
        if (/^[A-Z]/.test(first.value) || model.components.has(first.value)) {
          return { t: 'component-ref', n: first.value }
        }
        // A bare identifier can still be environment data the caller supplied.
        if (first.value in env.values) return { t: 'value', v: env.values[first.value] }
        return { t: 'opaque', r: 'identifier' }
      }
      // Calls whose callee is not the JSX runtime are not statically known.
      return { t: 'opaque', r: 'call-expression' }
    }
    default:
      return { t: 'opaque', r: `token:${first.kind}` }
  }
}

/**
 * Whether one span names the JSX runtime: `n.jsx`, `n.jsxs`, `n.jsxDEV` —
 * where the member itself carries the runtime name, as bundlers alias the
 * module object — or `React.createElement`.
 */
function readJsxCallee(cursor: Cursor, start: number, end: number, model: BundleModel): boolean {
  if (end === start + 3
    && cursor.tokens[start]?.kind === 'ident'
    && cursor.tokens[start + 1]?.kind === 'punct' && cursor.tokens[start + 1]?.value === '.'
    && cursor.tokens[start + 2]?.kind === 'ident') {
    const member = cursor.tokens[start + 2]!.value
    if (model.jsxNames.has(member)) return true
    if (cursor.tokens[start]!.value === 'React' && member === 'createElement') return true
  }
  return false
}

/** Split `a ? b : c` at its top-level `?` and `:`; undefined when not a conditional. */
function splitConditional(cursor: Cursor, start: number, end: number): [number, number, number, number, number, number] | undefined {
  let questionAt = -1
  let colonAt = -1
  let at = start
  while (at < end) {
    const token = cursor.tokens[at]!
    if (token.kind === 'punct') {
      if (token.value === '(' || token.value === '{' || token.value === '[') {
        at = cursor.matchDelimiter(at)
        continue
      }
      if (token.value === '?' && questionAt < 0) questionAt = at
      else if (token.value === ':' && questionAt >= 0) { colonAt = at; break }
    }
    at += 1
  }
  if (questionAt < 0 || colonAt < 0) return undefined
  return [start, questionAt, questionAt + 1, colonAt, colonAt + 1, end]
}

/** Resolve one bare identifier against the props environment. */
function readIdentifier(name: string, env: PropEnv): StaticValue {
  if (env.destructured.has(name)) {
    const resolved = propValue(name, env)
    return resolved.found ? { t: 'value', v: resolved.value } : { t: 'opaque', r: `prop:${name}` }
  }
  if (name in env.values) return { t: 'value', v: env.values[name] }
  return { t: 'opaque', r: 'identifier' }
}

/**
 * Read one `_jsx(type, props)` / `_jsxs(type, props, key)` call into an element.
 */
function readJsxCall(
  cursor: Cursor,
  start: number,
  end: number,
  model: BundleModel,
  env: PropEnv,
  depth: number,
): StaticValue {
  const close = cursor.matchDelimiter(start + 1) - 1
  const args = splitTopLevel(cursor, start + 2, close)
  return elementFromArgs(cursor, args, model, env, depth, close)
}

/**
 * Read one `React.createElement(type, props, ...children)` call into an element.
 */
function readCreateElementCall(
  cursor: Cursor,
  start: number,
  end: number,
  model: BundleModel,
  env: PropEnv,
  depth: number,
): StaticValue {
  const close = cursor.matchDelimiter(start + 3) - 1
  const args = splitTopLevel(cursor, start + 4, close)
  return elementFromArgs(cursor, args, model, env, depth, close)
}

/**
 * Build an `ElementNode` from the argument spans of a JSX-runtime call.
 */
function elementFromArgs(
  cursor: Cursor,
  args: [number, number][],
  model: BundleModel,
  env: PropEnv,
  depth: number,
  closeAt: number,
): StaticValue {
  if (args.length === 0) return { t: 'opaque', r: 'jsx-no-type' }
  const typeValue = readStaticValue(cursor, args[0]![0], args[0]![1], model, env, depth + 1)
  let type: string
  if (typeValue.t === 'text') type = typeValue.text
  else if (typeValue.t === 'value' && typeof typeValue.v === 'string') type = typeValue.v
  else if (typeValue.t === 'component-ref') type = `component:${typeValue.n}`
  else return { t: 'opaque', r: 'jsx-dynamic-type' }

  const props: Record<string, unknown> = {}
  let children: RenderNode[] = []
  if (args.length >= 2) {
    const propsSpan = args[1]!
    const propsToken = cursor.tokens[propsSpan[0]]
    if (propsToken?.kind === 'keyword' && propsToken.value === 'null') {
      // No props.
    } else if (propsToken?.kind === 'punct' && propsToken.value === '{') {
      for (const [a, b] of splitTopLevel(cursor, propsSpan[0] + 1, propsSpan[1] - 1)) {
        const name = cursor.tokens[a]
        if (name === undefined) continue
        if (name.kind === 'punct' && name.value === '...') {
          props['<spread>'] = true
          continue
        }
        if (name.kind !== 'ident' && name.kind !== 'string') continue
        if (cursor.tokens[a + 1]?.kind !== 'punct' || cursor.tokens[a + 1]?.value !== ':') continue
        const value = name.value === 'children'
          ? readChildrenValue(cursor, a + 2, b, model, env, depth)
          : readStaticValue(cursor, a + 2, b, model, env, depth + 1)
        if (name.value === 'children') {
          children = childrenOf(value)
          continue
        }
        props[name.value] = propJson(value)
      }
    } else {
      // Dynamic props expression: keep a marker, children are lost statically.
      props['<dynamic-props>'] = true
    }
  }
  // `createElement(type, props, child1, child2, …)`: trailing args are children.
  for (const span of args.slice(2)) {
    children.push(...childrenOf(readStaticValue(cursor, span[0], span[1], model, env, depth + 1)))
  }
  return {
    t: 'element',
    e: { kind: 'element', type, key: null, props, children },
  }
}

/**
 * Read a `children:` prop value: like `readStaticValue`, except that an array
 * literal is walked element-wise so `children: [jsx(…), jsx(…)]` yields sibling
 * nodes instead of failing the "static JSON only" array rule.
 */
function readChildrenValue(
  cursor: Cursor,
  start: number,
  end: number,
  model: BundleModel,
  env: PropEnv,
  depth: number,
): StaticValue {
  const first = cursor.tokens[start]
  if (first !== undefined && first.kind === 'punct' && first.value === '[' && cursor.matchDelimiter(start) === end) {
    const children: RenderNode[] = []
    for (const [a, b] of splitTopLevel(cursor, start + 1, end - 1)) {
      children.push(...childrenOf(readStaticValue(cursor, a, b, model, env, depth + 1)))
    }
    return { t: 'children', c: children }
  }
  return readStaticValue(cursor, start, end, model, env, depth + 1)
}

/** Turn a statically-read value into child nodes. */
function childrenOf(value: StaticValue): RenderNode[] {
  switch (value.t) {
    case 'element': return [value.e]
    case 'text': return [{ kind: 'text', value: value.text }]
    case 'children': return [...value.c]
    case 'value': {
      if (value.v === null || value.v === undefined || typeof value.v === 'boolean') return []
      if (typeof value.v === 'string') return [{ kind: 'text', value: value.v }]
      if (typeof value.v === 'number') return [{ kind: 'text', value: String(value.v) }]
      if (Array.isArray(value.v)) {
        return value.v.flatMap(item => childrenOf({ t: 'value', v: item }))
      }
      return [{ kind: 'opaque', reason: 'object-child' }]
    }
    case 'component-ref': return [{ kind: 'element', type: `component:${value.n}`, key: null, props: {}, children: [] }]
    case 'opaque': return [{ kind: 'opaque', reason: value.r }]
  }
}

/** Turn a statically-read value into a JSON-safe prop value. */
function propJson(value: StaticValue): unknown {
  switch (value.t) {
    case 'value': return value.v === undefined ? '<undefined>' : value.v
    case 'text': return value.text
    case 'element': return `<element:${value.e.type}>`
    case 'component-ref': return `<component:${value.n}>`
    case 'children': return `<children:${value.c.length}>`
    case 'opaque': return `<opaque:${value.r}>`
  }
}

/** Decode the escape sequences of one string token body. */
function decodeEscapes(text: string): string {
  return text
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\(.)/g, '$1')
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
 * @returns the tree, its warnings, and whether a budget stopped the walk.
 */
export function buildComponentTree(
  source: string,
  componentName: string,
  props: Readonly<Record<string, unknown>>,
  budget: TranspileBudget = DEFAULT_TRANSPILE_BUDGET,
): TranspiledTree {
  const warnings: string[] = []
  const model = buildModel(source, budget, warnings)
  const shape = model.components.get(componentName)
  if (shape === undefined || shape.bodyStart < 0) {
    return {
      componentId: componentName,
      tree: null,
      warnings: [...warnings, `component ${componentName} has no statically readable return`],
      truncated: false,
    }
  }
  const env: PropEnv = envOf(shape, props)
  const counter = { nodes: 0, truncated: false }
  const value = readStaticValue(model.cursor, shape.bodyStart, shape.bodyEnd, model, env)
  const tree = renderValue(value, model, env, counter, 0)
  return { componentId: componentName, tree, warnings, truncated: counter.truncated }
}

/**
 * Turn one statically-read value into a `RenderNode`, inlining component
 * references until the budget stops the walk.
 */
function renderValue(
  value: StaticValue,
  model: BundleModel,
  env: PropEnv,
  counter: { nodes: number; truncated: boolean },
  depth: number,
): RenderNode | null {
  counter.nodes += 1
  if (counter.nodes > model.budget.maxNodes) {
    counter.truncated = true
    return { kind: 'opaque', reason: 'node-budget' }
  }
  if (depth > model.budget.maxDepth) {
    counter.truncated = true
    return { kind: 'opaque', reason: 'depth-budget' }
  }
  switch (value.t) {
    case 'element':
      if (value.e.type.startsWith('component:')) {
        // A JSX call whose type is a sibling component: inline its own returned
        // expression so a composed card renders as one tree.
        const name = value.e.type.slice('component:'.length)
        const shape = model.components.get(name)
        if (shape !== undefined && shape.bodyStart >= 0) {
          const inner = readStaticValue(model.cursor, shape.bodyStart, shape.bodyEnd, model, envOf(shape, {}))
          const rendered = renderValue(inner, model, env, counter, depth + 1)
          return { ...value.e, children: rendered === null ? value.e.children : [rendered] }
        }
      }
      return value.e
    case 'text': return { kind: 'text', value: value.text }
    case 'value': {
      if (value.v === null || value.v === undefined || typeof value.v === 'boolean') return null
      if (typeof value.v === 'string') return { kind: 'text', value: value.v }
      if (typeof value.v === 'number') return { kind: 'text', value: String(value.v) }
      return { kind: 'opaque', reason: 'object-child' }
    }
    case 'children': {
      return { kind: 'element', type: 'fragment', key: null, props: {}, children: [...value.c] }
    }
    case 'component-ref': {
      const shape = model.components.get(value.n)
      if (shape === undefined || shape.bodyStart < 0) {
        return { kind: 'opaque', reason: `component:${value.n}` }
      }
      const inner = readStaticValue(model.cursor, shape.bodyStart, shape.bodyEnd, model, envOf(shape, {}))
      const rendered = renderValue(inner, model, env, counter, depth + 1)
      return {
        kind: 'element',
        type: `component:${value.n}`,
        key: null,
        props: {},
        children: rendered === null ? [] : [rendered],
      }
    }
    case 'opaque':
      return { kind: 'opaque', reason: value.r }
  }
}
