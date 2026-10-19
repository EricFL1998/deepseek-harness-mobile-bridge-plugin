/**
 * The React-shaped stub every evaluated client bundle runs against.
 *
 * The bridge does not want a DOM, a scheduler, or a live component tree: it
 * wants the element tree a component *produces*. This stub therefore provides
 * exactly the surface a client component may call, with hooks that resolve once
 * and no effects, refs to real nodes, or scheduling of any kind. Anything that
 * would reach outside the VM (timers, network, `document`) is absent, so a
 * bundle that needs it fails loudly instead of doing something invisible.
 */

/** One element the stub produced. */
export interface StubElement {
  readonly $$dshElement: true
  readonly type: unknown
  readonly key: string | null
  readonly ref: unknown
  readonly props: Record<string, unknown>
}

/** A fragment marker, so a tree can hold several sibling children. */
export interface StubFragment {
  readonly $$dshFragment: true
}

/** Whether a value is an element the stub produced. */
export function isStubElement(value: unknown): value is StubElement {
  return typeof value === 'object' && value !== null && (value as StubElement).$$dshElement === true
}

/** Whether a value is the stub's fragment marker. */
export function isStubFragment(value: unknown): value is StubFragment {
  return typeof value === 'object' && value !== null && (value as StubFragment).$$dshFragment === true
}

/** The stub's React namespace, as `require('react')` returns it. */
export interface ReactStub {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): StubElement
  cloneElement(element: StubElement, props?: Record<string, unknown> | null, ...children: unknown[]): StubElement
  isValidElement(value: unknown): boolean
  Fragment: StubFragment
  StrictMode: StubFragment
  useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void]
  useReducer<T>(reducer: (state: T, action: unknown) => T, initial: T): [T, (action: unknown) => void]
  useMemo<T>(factory: () => T): T
  useCallback<T>(callback: T): T
  useRef<T>(initial: T): { current: T }
  useId(): string
  useEffect(): void
  useLayoutEffect(): void
  useInsertionEffect(): void
  useContext(): undefined
  useSyncExternalStore<T>(_subscribe: unknown, getSnapshot: () => T): T
  useTransition(): [boolean, (callback: () => void) => void]
  useDeferredValue<T>(value: T): T
  memo<T>(component: T): T
  forwardRef<T>(render: T): T
  Children: {
    toArray(children: unknown): unknown[]
    map(children: unknown, fn: (child: unknown, index: number) => unknown): unknown[]
    count(children: unknown): number
    only(children: unknown): unknown
  }
}

/**
 * Build one stub namespace.
 *
 * `useId` counts per namespace so a single render pass numbers ids
 * deterministically; every hook resolves its value once, because the bridge
 * never re-renders.
 * @returns the React namespace to hand to evaluated bundles.
 */
export function createReactStub(): ReactStub {
  let idCounter = 0

  const flattenChildren = (children: unknown[]): unknown[] => {
    const out: unknown[] = []
    for (const child of children) {
      if (Array.isArray(child)) {
        out.push(...flattenChildren(child))
        continue
      }
      if (child === null || child === undefined || typeof child === 'boolean') continue
      out.push(child)
    }
    return out
  }

  const createElement = (
    type: unknown,
    props?: Record<string, unknown> | null,
    ...children: unknown[]
  ): StubElement => {
    const source = props ?? {}
    const { key, ref, ...rest } = source as { key?: unknown; ref?: unknown } & Record<string, unknown>
    const merged = flattenChildren(children)
    const resolvedProps: Record<string, unknown> = { ...rest }
    if (merged.length > 0) {
      resolvedProps.children = merged.length === 1 ? merged[0] : merged
    }
    return {
      $$dshElement: true,
      type,
      key: key === undefined || key === null ? null : String(key),
      ref: ref ?? null,
      props: resolvedProps,
    }
  }

  const fragment: StubFragment = { $$dshFragment: true }

  const stub: ReactStub = {
    createElement,
    cloneElement: (element, props, ...children) => createElement(
      element.type,
      { ...element.props, ...(props ?? {}) },
      ...(children.length > 0 ? children : [element.props.children]),
    ),
    isValidElement: isStubElement,
    Fragment: fragment,
    StrictMode: fragment,
    useState: <T,>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] => {
      const value = typeof initial === 'function' ? (initial as () => T)() : initial
      // A single render: the setter records nothing, because there is no second
      // pass for it to reach.
      return [value, () => {}]
    },
    useReducer: <T,>(reducer: (state: T, action: unknown) => T, initial: T): [T, (action: unknown) => void] => {
      void reducer
      return [initial, () => {}]
    },
    useMemo: <T,>(factory: () => T): T => factory(),
    useCallback: <T,>(callback: T): T => callback,
    useRef: <T,>(initial: T) => ({ current: initial }),
    useId: () => {
      idCounter += 1
      return `dsh-stub-${idCounter}`
    },
    useEffect: () => {},
    useLayoutEffect: () => {},
    useInsertionEffect: () => {},
    useContext: () => undefined,
    useSyncExternalStore: <T,>(_subscribe: unknown, getSnapshot: () => T): T => getSnapshot(),
    useTransition: () => [false, (callback: () => void) => { callback() }],
    useDeferredValue: <T,>(value: T): T => value,
    memo: <T,>(component: T): T => component,
    forwardRef: <T,>(render: T): T => render,
    Children: {
      toArray: children => flattenChildren([children]),
      map: (children, fn) => flattenChildren([children]).map((child, index) => fn(child, index)),
      count: children => flattenChildren([children]).length,
      only: children => {
        const items = flattenChildren([children])
        if (items.length !== 1) {
          throw new Error(`React.Children.only expected exactly one child, received ${items.length}`)
        }
        return items[0]
      },
    },
  }
  return stub
}

/**
 * The `react-dom` face: nothing renders, so nothing mounts.
 * @returns the namespace `require('react-dom')` receives.
 */
export function createReactDomStub(): Record<string, unknown> {
  return {
    createPortal: (children: unknown) => children,
    flushSync: (callback: () => void) => { callback() },
    findDOMNode: () => null,
    render: () => undefined,
    unmountComponentAtNode: () => false,
    version: '0.0.0-dsh-bridge-stub',
  }
}
