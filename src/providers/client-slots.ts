/**
 * `client-slots`: the generic compatibility primitive.
 *
 * It evaluates official client bundles in the isolated VM, captures their slot
 * registrations as data, and renders a captured component under the React stub
 * so a native client can obtain official artwork without a WebView.
 *
 * Execution is deterministic and side-effect free: the VM provides no DOM, no
 * timers, and no network, and one evaluation is cached per bundle revision so a
 * repeated query re-reads nothing.
 */

import {
  BridgeFailure, optionalObject, optionalPositiveInt, optionalString, requiredString,
  type Provider, type WarningSink,
} from '../protocol/provider.ts'
import type { IconSvgData, RenderTreeData, SlotListData, SlotRegistration } from '../protocol/types.ts'
import { projectJson } from '../protocol/json.ts'
import { evaluateBundleFile, type CapturedComponent, type EvaluatedBundle } from '../slots/evaluate.ts'
import { DEFAULT_RENDER_BUDGET, renderComponent, treeToSvg, type RenderBudget } from '../slots/render-tree.ts'
import type { ClientModulesFace } from './client-assets.ts'

/** `client-slots` configuration. */
export interface ClientSlotsOptions {
  /** Resolve the client-modules service, or undefined when absent. */
  readonly clientModules: () => ClientModulesFace | undefined
  /** Entry ids to evaluate, in order. Empty means every composed entry. */
  readonly entryIds: readonly string[]
  /** Ceilings applied to one `render-tree` call. */
  readonly renderBudget: RenderBudget
  /** Largest `size` an `icon-svg` call may request. */
  readonly maxIconSize: number
  /** Coordinate space the client's icons are authored in. */
  readonly iconViewBox: string
}

/** One cached evaluation, keyed by entry id and bundle revision. */
interface CachedEvaluation {
  readonly rev: string
  readonly bundle: EvaluatedBundle
  readonly components: Map<string, CapturedComponent>
}

/**
 * Build the `client-slots` provider.
 * @param options - service accessor, entry selection, and budgets.
 * @returns the provider to register.
 */
export function createClientSlotsProvider(options: ClientSlotsOptions): Provider {
  const cache = new Map<string, CachedEvaluation>()

  /** The bundle paths this provider may evaluate, in declared order. */
  const selectedEntries = (): { id: string; path: string; rev: string }[] => {
    const face = options.clientModules()
    if (face === undefined) {
      throw new BridgeFailure('provider/unavailable', 'this Host composition has no client module registry')
    }
    const graph = face.graph()
    if (graph === undefined) {
      throw new BridgeFailure('provider/unavailable', 'the Host composes no web boot graph')
    }
    const wanted = options.entryIds.length === 0
      ? graph.entries
      : graph.entries.filter(entry => options.entryIds.includes(entry.id))
    const rows: { id: string; path: string; rev: string }[] = []
    for (const entry of wanted) {
      const path = face.clientPath(entry.id)
      // An entry the Host composes but cannot locate on disk is skipped rather
      // than reported as a broken registration source: the client sees only
      // what could actually be evaluated.
      if (path === undefined) continue
      rows.push({ id: entry.id, path, rev: entry.rev })
    }
    return rows
  }

  /** Evaluate one entry, reusing a cached result for the same revision. */
  const evaluationOf = async (id: string, path: string, rev: string): Promise<CachedEvaluation> => {
    const cached = cache.get(id)
    if (cached !== undefined && cached.rev === rev) return cached
    const bundle = await evaluateBundleFile(id, path)
    const components = new Map<string, CapturedComponent>()
    for (const registration of bundle.registrations) {
      components.set(registration.componentId, {
        componentId: registration.componentId,
        component: registration.component,
        slot: registration.slot,
        entryId: id,
      })
    }
    const entry: CachedEvaluation = { rev, bundle, components }
    cache.set(id, entry)
    return entry
  }

  /** Evaluate every selected entry, reporting per-bundle failures as warnings. */
  const evaluateAll = async (warnings: WarningSink): Promise<CachedEvaluation[]> => {
    const entries: CachedEvaluation[] = []
    for (const row of selectedEntries()) {
      try {
        const evaluation = await evaluationOf(row.id, row.path, row.rev)
        entries.push(evaluation)
        for (const note of evaluation.bundle.warnings) warnings.warn(note)
        for (const specifier of evaluation.bundle.missingExternals) {
          warnings.warn(`${row.id} requested ${specifier}, which the bridge VM does not provide`)
        }
      } catch (error) {
        warnings.warn((error as Error).message)
      }
    }
    return entries
  }

  const findComponent = (
    entries: readonly CachedEvaluation[],
    componentId: string,
  ): CapturedComponent | undefined => {
    for (const entry of entries) {
      const found = entry.components.get(componentId)
      if (found !== undefined) return found
    }
    return undefined
  }

  return {
    id: 'client-slots',
    version: 1,
    readOnly: true,
    ops: {
      /** Every captured registration, optionally narrowed to one slot. */
      list: async (args, warnings): Promise<SlotListData> => {
        const slot = optionalString(args, 'slot')
        const entries = await evaluateAll(warnings)
        const registrations: SlotRegistration[] = []
        const touched = new Set<string>()
        for (const entry of entries) {
          for (const injected of entry.bundle.injectedSlots) touched.add(injected)
          for (const registration of entry.bundle.registrations) {
            touched.add(registration.slot)
            if (slot !== undefined && registration.slot !== slot) continue
            registrations.push({
              slot: registration.slot,
              ...(registration.id === undefined ? {} : { id: registration.id }),
              ...(registration.key === undefined ? {} : { key: registration.key }),
              ...(registration.order === undefined ? {} : { order: registration.order }),
              ...(registration.label === undefined ? {} : { label: registration.label }),
              ...(registration.priority === undefined ? {} : { priority: registration.priority }),
              package: entry.bundle.entryId,
              ...(registration.locale === undefined ? {} : { locale: registration.locale }),
              render: { kind: registration.kind, componentId: registration.componentId },
            })
          }
        }
        const occupied = new Set(registrations.map(registration => registration.slot))
        return {
          slot: slot ?? null,
          registrations: registrations.sort(compareRegistrations),
          emptySlots: [...touched].filter(name => !occupied.has(name)).sort(),
        }
      },

      /** One registration's complete contribution metadata. */
      describe: async (args, warnings): Promise<SlotRegistration> => {
        const slot = requiredString(args, 'slot')
        const id = requiredString(args, 'id')
        const entries = await evaluateAll(warnings)
        for (const entry of entries) {
          const match = entry.bundle.registrations.find(
            registration => registration.slot === slot
              && (registration.id === id || registration.key === id || registration.componentId === id),
          )
          if (match === undefined) continue
          return {
            slot: match.slot,
            ...(match.id === undefined ? {} : { id: match.id }),
            ...(match.key === undefined ? {} : { key: match.key }),
            ...(match.order === undefined ? {} : { order: match.order }),
            ...(match.label === undefined ? {} : { label: match.label }),
            ...(match.priority === undefined ? {} : { priority: match.priority }),
            package: entry.bundle.entryId,
            ...(match.locale === undefined ? {} : { locale: match.locale }),
            render: { kind: match.kind, componentId: match.componentId },
          }
        }
        throw new BridgeFailure('args/invalid', `no registration ${slot}/${id}`)
      },

      /** Serialize one captured component's element tree. */
      'render-tree': async (args, warnings): Promise<RenderTreeData> => {
        const componentId = requiredString(args, 'componentId')
        const props = optionalObject(args, 'props') ?? {}
        const entries = await evaluateAll(warnings)
        const found = findComponent(entries, componentId)
        if (found === undefined) {
          throw new BridgeFailure('args/invalid', `no captured component ${componentId}`, 200, {
            known: entries.flatMap(entry => [...entry.components.keys()]),
          })
        }
        const projected = projectJson(props, 'props')
        for (const path of projected.dropped) warnings.warn(`dropped prop ${path}`)
        const rendered = renderComponent(
          found.component,
          (projected.value ?? {}) as Readonly<Record<string, unknown>>,
          options.renderBudget,
        )
        for (const note of rendered.warnings) warnings.warn(note)
        return { componentId, tree: rendered.tree }
      },

      /** Convert one captured component's artwork into a standalone SVG document. */
      'icon-svg': async (args, warnings): Promise<IconSvgData> => {
        const componentId = requiredString(args, 'componentId')
        const size = optionalPositiveInt(args, 'size', 24, options.maxIconSize)
        const entries = await evaluateAll(warnings)
        const found = findComponent(entries, componentId)
        if (found === undefined) {
          throw new BridgeFailure('args/invalid', `no captured component ${componentId}`, 200, {
            known: entries.flatMap(entry => [...entry.components.keys()]),
          })
        }
        const rendered = renderComponent(found.component, { size }, options.renderBudget)
        const converted = treeToSvg(rendered.tree, size, options.iconViewBox)
        for (const note of [...rendered.warnings, ...converted.warnings]) warnings.warn(note)
        return { componentId, size, svg: converted.svg }
      },
    },
  }
}

/**
 * Order registrations the way the client dispatches them: slot, then declared
 * order, then id, so two calls return the same sequence.
 * @param left - first registration.
 * @param right - second registration.
 * @returns the comparison result.
 */
function compareRegistrations(left: SlotRegistration, right: SlotRegistration): number {
  if (left.slot !== right.slot) return left.slot < right.slot ? -1 : 1
  const leftOrder = left.order ?? 0
  const rightOrder = right.order ?? 0
  if (leftOrder !== rightOrder) return leftOrder - rightOrder
  const leftId = left.id ?? left.key ?? ''
  const rightId = right.id ?? right.key ?? ''
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
}

/** Re-exported so the plugin assembly can share one budget default. */
export { DEFAULT_RENDER_BUDGET }
