/**
 * `settings`: the Host's live plugin configuration documents.
 *
 * A plugin's Settings page is a generated form: the Host projects the plugin's
 * `Config` schema into a field tree and stores the user's overrides. This provider
 * exposes exactly that pair — the form and its values — plus the write the page
 * needs, so a native client renders the *same* form the browser does instead of
 * guessing at fields.
 */

import { BridgeFailure, requiredString, type Provider } from '../protocol/provider.ts'

/** One field in a projected settings form. */
export interface SettingsFieldNode {
  /** Field kind: `string`, `number`, `boolean`, `object`, `array`, `union`, … */
  readonly type?: string
  /** Human label, when the schema sets one. */
  readonly description?: string
  /** Declared default. */
  readonly default?: unknown
  /** Enum members, when constrained. */
  readonly options?: readonly unknown[]
  /** Child fields for object/record nodes. */
  readonly dict?: Readonly<Record<string, SettingsFieldNode>>
  /** Element field for arrays. */
  readonly inner?: SettingsFieldNode
  /** Whether the field may be edited. */
  readonly meta?: unknown
}

/** One redacted secret position reported by the Host settings service. */
export interface SettingsSecretSlot {
  /** Path of the secret field inside the document value. */
  readonly path: readonly string[]
  /** Whether the user section currently stores a value for this slot. */
  readonly set: boolean
}

/** One settings document, structurally the Host's descriptor. */
export interface SettingsDocument {
  readonly ns: string
  readonly revision: number
  readonly applies?: string
  readonly schema?: SettingsFieldNode
  readonly value?: unknown
  readonly user?: unknown
  readonly base?: unknown
  /** Secret positions (values are already stripped from `value`). */
  readonly secrets?: readonly SettingsSecretSlot[]
}

/** The slice of the Host `settings` service this provider reads and writes. */
export interface SettingsServiceFace {
  describe(options?: { redactSecrets?: boolean }): readonly SettingsDocument[]
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
}

/** `settings` configuration. */
export interface SettingsOptions {
  /** Resolve the settings service, or undefined when this composition has none. */
  readonly settings: () => SettingsServiceFace | undefined
}

/**
 * Build the `settings` provider.
 * @param options - service accessor.
 * @returns the provider to register.
 */
export function createSettingsProvider(options: SettingsOptions): Provider {
  const service = (): SettingsServiceFace => {
    const face = options.settings()
    if (face === undefined) {
      throw new BridgeFailure('provider/unavailable', 'this Host composition has no settings service')
    }
    return face
  }
  return {
    id: 'settings',
    version: 1,
    ops: {
      /** The form and live values of one settings document. */
      describe: (args: Record<string, unknown>) => {
        const ns = requiredString(args, 'ns')
        const document = service().describe({ redactSecrets: true }).find(row => row.ns === ns)
        // A namespace that vanished between listing and opening is a real state, not
        // a bug: report it so the page can explain instead of showing blank fields.
        if (document === undefined) {
          throw new BridgeFailure('args/invalid', `no configurable settings document "${ns}"`)
        }
        return {
          ns: document.ns,
          revision: document.revision,
          applies: document.applies,
          schema: document.schema ?? {},
          value: document.value ?? {},
          // Secret values never ride the response; the client only needs the
          // path plus whether a value is stored, so the field can show a mask.
          secrets: document.secrets ?? [],
        }
      },
      /** Merge edited fields into the document, rejecting a stale revision. */
      update: async (args: Record<string, unknown>) => {
        const ns = requiredString(args, 'ns')
        const patch = args.patch
        if (patch === undefined || patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
          throw new BridgeFailure('args/invalid', 'patch must be an object of edited fields')
        }
        const expected = args.expectedRevision
        if (expected !== undefined && typeof expected !== 'number') {
          throw new BridgeFailure('args/invalid', 'expectedRevision must be a number')
        }
        await service().update(ns, patch as object, expected as number | undefined)
        return { ns, updated: true }
      },
    },
  }
}
