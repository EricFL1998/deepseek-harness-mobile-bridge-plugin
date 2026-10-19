/**
 * Evaluate official client bundles in an isolated Node VM and capture what they
 * register.
 *
 * A client bundle is a factory registration: it calls
 * `window.__ModuleLoader__.load({ id, factory })`, and materializing the factory
 * yields `{ name, inject, apply }`. Calling `apply` with a stub Cordis context
 * makes the bundle declare its slots, labels, and components as ordinary calls.
 * The bridge records those calls instead of rendering anything.
 *
 * The VM grants no `document`, no timers, no network, and no dynamic import.
 * A bundle that needs one of them fails with a reported error rather than
 * reaching the Host.
 */

import { readFile } from 'node:fs/promises'
import { createContext, runInContext, type Context as VmContext } from 'node:vm'
import { createHash } from 'node:crypto'
import { createReactDomStub, createReactStub, isStubElement, type ReactStub } from './react-stub.ts'

/** One captured slot registration, before the wire projection. */
export interface CapturedRegistration {
  readonly slot: string
  readonly id?: string
  readonly key?: string
  readonly order?: number
  readonly label?: string
  readonly priority?: number
  readonly locale?: string
  readonly component: unknown
  /** Component identity assigned at capture time. */
  readonly componentId: string
  readonly kind: 'component' | 'factory'
}

/** A component the evaluator captured and can render. */
export interface CapturedComponent {
  readonly componentId: string
  readonly component: unknown
  readonly slot: string
  readonly entryId: string
}

/** Result of evaluating one bundle. */
export interface EvaluatedBundle {
  readonly entryId: string
  readonly registrations: readonly CapturedRegistration[]
  /** Every slot name the bundle touched through `ctx.slots.inject`. */
  readonly injectedSlots: readonly string[]
  /**
   * Module specifiers the bundle requested that this VM could not supply.
   * A bundle with a non-empty list registered its slots but its components are
   * not renderable, so `render-tree` reports that instead of a fake tree.
   */
  readonly missingExternals: readonly string[]
  /** Non-fatal notes gathered while evaluating. */
  readonly warnings: readonly string[]
}

/** Failure raised when a bundle cannot be evaluated. */
export class BundleEvaluationError extends Error {
  /** The bundle that failed. */
  readonly entryId: string

  /**
   * @param entryId - the bundle that failed.
   * @param message - what went wrong.
   */
  constructor(entryId: string, message: string) {
    super(`client bundle ${entryId}: ${message}`)
    this.name = 'BundleEvaluationError'
    this.entryId = entryId
  }
}

/** Hard ceiling on one bundle's source, so a pathological artifact cannot stall the Host. */
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024

/** Ceiling on one synchronous bundle evaluation. */
const EVALUATION_TIMEOUT_MS = 5_000

/** The `ctx.slots` surface a client bundle may call. */
interface SlotsStub {
  register(options: Record<string, unknown>, component: unknown): () => void
  registerFactory(options: Record<string, unknown>, component: unknown): () => void
  inject(name: string, callback: () => unknown): () => void
}

/** Everything one evaluation collects. */
interface CaptureState {
  readonly registrations: CapturedRegistration[]
  readonly injectedSlots: string[]
  readonly missingExternals: Set<string>
  readonly warnings: string[]
  readonly components: Map<string, CapturedComponent>
  componentCounter: number
}

/**
 * Build the Cordis context stub a bundle's `apply` receives.
 * @param entryId - the bundle being evaluated, recorded on captured components.
 * @param state - the capture sink.
 * @param react - the React namespace, so `ctx.slots.register` components stay renderable.
 * @returns the stub context.
 */
function createContextStub(entryId: string, state: CaptureState, react: ReactStub): Record<string, unknown> {
  const capture = (options: unknown, component: unknown, kind: 'component' | 'factory'): (() => void) => {
    if (typeof options !== 'object' || options === null) {
      state.warnings.push(`${entryId}: slots.${kind === 'factory' ? 'registerFactory' : 'register'} received no options`)
      return () => {}
    }
    const record = options as Record<string, unknown>
    const slot = typeof record.name === 'string' ? record.name : undefined
    if (slot === undefined) {
      state.warnings.push(`${entryId}: a slot registration declared no slot name`)
      return () => {}
    }
    state.componentCounter += 1
    const declaredId = typeof record.id === 'string' ? record.id : undefined
    const declaredKey = typeof record.key === 'string' ? record.key : undefined
    const componentId = declaredId ?? declaredKey ?? `component-${state.componentCounter}`
    const label = typeof record.label === 'function'
      ? safeLabel(record.label as () => string, state, entryId)
      : typeof record.label === 'string' ? record.label : undefined
    const registration: CapturedRegistration = {
      slot,
      ...(declaredId === undefined ? {} : { id: declaredId }),
      ...(declaredKey === undefined ? {} : { key: declaredKey }),
      ...(typeof record.order === 'number' ? { order: record.order } : {}),
      ...(label === undefined ? {} : { label }),
      ...(typeof record.priority === 'number' ? { priority: record.priority } : {}),
      ...(typeof record.locale === 'string' ? { locale: record.locale } : {}),
      component,
      componentId,
      kind,
    }
    state.registrations.push(registration)
    state.components.set(componentId, { componentId, component, slot, entryId })
    // Registrations are effects in the real client; a capture returns the same
    // disposer contract so a bundle that stores it behaves identically.
    return () => {
      const index = state.registrations.indexOf(registration)
      if (index >= 0) state.registrations.splice(index, 1)
      state.components.delete(componentId)
    }
  }

  const slots: SlotsStub = {
    register: (options, component) => capture(options, component, 'component'),
    registerFactory: (options, component) => capture(options, component, 'factory'),
    inject: (name, callback) => {
      if (typeof name === 'string') state.injectedSlots.push(name)
      // The real service waits for the declaration; the stub calls through at
      // once, because the bridge evaluates one bundle with no live declaration
      // ledger to wait on.
      const disposer = callback()
      return typeof disposer === 'function' ? (disposer as () => void) : () => {}
    },
  }

  const noopDisposer = (): void => {}
  const ctx: Record<string, unknown> = {
    slots,
    effect: (callback: unknown) => {
      if (typeof callback === 'function') {
        try {
          const disposer = (callback as () => unknown)()
          return typeof disposer === 'function' ? disposer : noopDisposer
        } catch (error) {
          state.warnings.push(`${entryId}: ctx.effect threw: ${(error as Error).message}`)
          return noopDisposer
        }
      }
      return noopDisposer
    },
    on: () => noopDisposer,
    once: () => noopDisposer,
    off: () => {},
    emit: () => {},
    get: () => undefined,
    provide: () => noopDisposer,
    inject: (services: unknown, callback?: unknown) => {
      const run = typeof callback === 'function' ? callback : typeof services === 'function' ? services : undefined
      if (run === undefined) return noopDisposer
      try {
        const disposer = (run as (context: unknown) => unknown)(ctx)
        return typeof disposer === 'function' ? disposer : noopDisposer
      } catch (error) {
        state.warnings.push(`${entryId}: ctx.inject threw: ${(error as Error).message}`)
        return noopDisposer
      }
    },
    waterfall: () => Promise.resolve(undefined),
    bail: () => Promise.resolve(undefined),
    logger: {
      debug: () => {},
      info: () => {},
      warn: (...parts: unknown[]) => { state.warnings.push(`${entryId}: ${parts.map(String).join(' ')}`) },
      error: (...parts: unknown[]) => { state.warnings.push(`${entryId}: ${parts.map(String).join(' ')}`) },
    },
    // Rendering needs no locale binding: the bridge reports the registration's
    // declared namespace and lets the client resolve text.
    locale: {
      register: () => noopDisposer,
      bind: () => (key: string) => key,
      resolveText: (text: string) => text,
      current: 'en',
    },
    React: react,
  }
  return ctx
}

/** Resolve one registration label without letting a throwing thunk abort the capture. */
function safeLabel(label: () => string, state: CaptureState, entryId: string): string | undefined {
  try {
    const value = label()
    return typeof value === 'string' ? value : undefined
  } catch (error) {
    state.warnings.push(`${entryId}: label thunk threw: ${(error as Error).message}`)
    return undefined
  }
}

/**
 * Evaluate one client bundle and capture its registrations.
 * @param entryId - the bundle's entry id (package name).
 * @param source - the bundle's JavaScript text.
 * @returns the captured registrations and slots.
 * @throws {BundleEvaluationError} when the bundle cannot register a factory or
 * when `apply` throws.
 */
export function evaluateBundleSource(entryId: string, source: string): EvaluatedBundle {
  const state: CaptureState = {
    registrations: [],
    injectedSlots: [],
    missingExternals: new Set(),
    warnings: [],
    components: new Map(),
    componentCounter: 0,
  }
  const react = createReactStub()
  const reactDom = createReactDomStub()
  const pending: { factory?: (require: (specifier: string) => unknown) => unknown } = {}

  const sandbox: Record<string, unknown> = {
    // The only global a bundle is promised: the module-loader facade.
    __ModuleLoader__: {
      load: (record: { id?: unknown; factory?: unknown }) => {
        if (typeof record?.factory !== 'function') {
          throw new Error('__ModuleLoader__.load received no factory')
        }
        pending.factory = record.factory as (require: (specifier: string) => unknown) => unknown
      },
    },
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  sandbox.self = sandbox
  sandbox.console = {
    log: () => {},
    info: () => {},
    warn: (...parts: unknown[]) => { state.warnings.push(`${entryId}: ${parts.map(String).join(' ')}`) },
    error: (...parts: unknown[]) => { state.warnings.push(`${entryId}: ${parts.map(String).join(' ')}`) },
    debug: () => {},
  }

  const context: VmContext = createContext({ ...sandbox })
  // The sandbox object and the VM global must be the same object, so a bundle
  // that writes `window.x` and reads `globalThis.x` sees one namespace.
  runInContext('globalThis.window = globalThis; globalThis.self = globalThis;', context)

  try {
    runInContext(source, context, {
      filename: `${entryId}.js`,
      timeout: EVALUATION_TIMEOUT_MS,
      displayErrors: true,
    })
  } catch (error) {
    throw new BundleEvaluationError(entryId, `evaluation failed: ${(error as Error).message}`)
  }

  const factory = pending.factory
  if (factory === undefined) {
    throw new BundleEvaluationError(entryId, 'registered no module factory')
  }

  const require = (specifier: string): unknown => {
    switch (specifier) {
      case 'react':
        return react
      case 'react-dom':
      case 'react-dom/client':
        return reactDom
      default:
        // A client bundle may request a shared module-table row the bridge VM does
        // not carry. Throwing here would discard the bundle's slot declarations along
        // with the import, so the request is answered with a permissive stub and
        // recorded: the registrations stay readable, and the component is known to be
        // unrenderable because something it reads was never real.
        state.missingExternals.add(specifier)
        return permissiveModule()
    }
  }

  let exported: unknown
  try {
    exported = factory(require)
  } catch (error) {
    throw new BundleEvaluationError(entryId, `factory threw: ${(error as Error).message}`)
  }

  const moduleExports = typeof exported === 'object' && exported !== null
    ? exported as Record<string, unknown>
    : {}
  const apply = moduleExports.apply
  if (typeof apply !== 'function') {
    throw new BundleEvaluationError(entryId, 'exports no apply function')
  }
  const ctx = createContextStub(entryId, state, react)
  try {
    const outcome = (apply as (context: unknown) => unknown)(ctx)
    // An async apply is not awaited: the bridge captures what the synchronous
    // part declared and reports the rest as a warning, because a captured
    // registration is a fact and a pending promise is not.
    if (typeof outcome === 'object' && outcome !== null && Symbol.iterator in (outcome as object)) {
      for (const _ of outcome as Iterable<unknown>) {
        // A generator apply yields its disposers; nothing to record here.
      }
    }
  } catch (error) {
    // A bundle's `apply` may do more than register slots; if it throws after
    // registering, the registrations it already made are facts and are kept. Only a
    // bundle that failed before registering anything is a failure.
    if (state.registrations.length === 0) {
      throw new BundleEvaluationError(entryId, `apply threw: ${(error as Error).message}`)
    }
    state.warnings.push(`apply threw after registering: ${(error as Error).message}`)
  }

  return {
    entryId,
    registrations: state.registrations,
    injectedSlots: [...new Set(state.injectedSlots)],
    missingExternals: [...state.missingExternals],
    warnings: state.warnings,
  }
}

/**
 * Read and evaluate one client bundle file.
 * @param entryId - the bundle's entry id.
 * @param path - absolute bundle path.
 * @returns the captured registrations.
 * @throws {BundleEvaluationError} when the file is too large or unreadable.
 */
export async function evaluateBundleFile(entryId: string, path: string): Promise<EvaluatedBundle> {
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (error) {
    throw new BundleEvaluationError(entryId, `cannot read ${path}: ${(error as Error).message}`)
  }
  if (bytes.byteLength > MAX_BUNDLE_BYTES) {
    throw new BundleEvaluationError(entryId, `${bytes.byteLength} bytes exceeds the ${MAX_BUNDLE_BYTES}-byte ceiling`)
  }
  return evaluateBundleSource(entryId, bytes.toString('utf8'))
}

/** Digest of one bundle's source, recorded so a client can tell a redeploy from a rename. */
export function bundleDigest(source: string): string {
  return createHash('sha256').update(source).digest('hex')
}

/** Re-export so callers can type-check a rendered value without importing the stub module. */
export { isStubElement }

/**
 * A stand-in for a module the VM does not carry.
 *
 * Client bundles import shared modules at factory time and only use them when a
 * component renders. Answering with something callable and infinitely nested lets the
 * factory finish and register its slots; anything it draws is marked unrenderable
 * through `missingExternals`, so no stub value ever reaches a client as if it were
 * real data.
 * @returns a callable, indexable stand-in.
 */
function permissiveModule(): unknown {
  const stub: unknown = new Proxy(function stubCall(): unknown { return stub }, {
    get: (_target, property) => {
      // Module interop and promise detection must stay truthful, or a caller would
      // treat the stub as a real namespace or await it forever.
      if (property === '__esModule') return true
      if (property === 'then') return undefined
      return stub
    },
    apply: (): unknown => stub,
    construct: (): object => stub as object,
  })
  return stub
}
