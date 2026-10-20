# Protocol reference

The complete wire surface of `bridge/v1`. This file is the authority a native
client's decoder is written against; `README.md` explains why each field exists.

## Conventions

- Base path: `/dsh-mobile/bridge/v1`.
- Every response is `application/json; charset=utf-8` with `cache-control: no-store`.
- A response is either `ok: true` with `data`, or `ok: false` with `error`. Never both.
- Absent optional fields are omitted, never `null`, except where a field is
  explicitly nullable.
- An unknown provider id, capability, or response field is ignored by a client;
  that is what makes `v1` additive.

## `GET /manifest`

| Field | Type | Meaning |
| --- | --- | --- |
| `bridgeVersion` | string | Protocol version, currently `1.0.0`. A client refuses an unknown major. |
| `pluginVersion` | string | The plugin package's own version, moving independently of the protocol. A client compares it against the version it expects to decide whether an update is worth offering. |
| `dshVersion` | string \| null | The Host release label, or null when it publishes none. |
| `providers[].id` | string | Stable provider id. |
| `providers[].version` | number | Provider schema version. Bump means a returned field changed meaning. |
| `providers[].capabilities` | string[] | Operation names, in declaration order. |
| `providers[].readOnly` | `true`? | Present when no operation mutates Host state. |
| `providers[].authorization` | `"host-session"`? | Present when the caller's Host session is the authority. |
| `warnings` | string[]? | Services the composition could not bind. |

## `POST /query`

Request:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `provider` | string | yes | Provider id from the manifest. |
| `op` | string | yes | Capability name from that provider's `capabilities`. |
| `args` | object | no | Operation arguments; defaults to `{}`. |

`content-type` must be `application/json`. The body is capped at 256 KiB.

Success: `{ ok: true, provider, version, data, warnings }`.
Failure: `{ ok: false, error: { code, message, details? } }`.

### Failure codes

| Code | Meaning | `details` |
| --- | --- | --- |
| `request/malformed` | The envelope or body was not a valid query. | — |
| `request/unsupported-method` | The route exists but not for this method. | — |
| `provider/unknown` | No provider with that id. | — |
| `provider/unavailable` | The provider exists but its Host service is absent, or its budget refuses. | — |
| `provider/version-mismatch` | The client asked for a version this bridge does not serve. | — |
| `op/unknown` | The provider has no such operation. | `{ capabilities: string[] }` |
| `args/invalid` | A required argument was missing, or named something that does not exist. | `{ known?: string[], allowlist?: string[] }` |
| `budget/exceeded` | The result would exceed a configured ceiling. | `{ dropped: string[] }` |
| `auth/required` | The Host's connection fence refused the caller. | — |
| `internal/error` | A handler threw, or a remote call failed or timed out. | — |

## `client-assets` (version 1)

### `boot-graph`

```json
{
  "rev": "9f2c…",
  "release": { "version": "0.2.1-rc.2", "commit": "…" },
  "entries": [
    { "id": "@deepseek-ai/dsh-client-ui-plugin-manager", "url": "plugins/??…", "rev": "…",
      "inject": ["…"], "immediately": true, "external": ["…"] }
  ],
  "batches": [
    { "phase": "bootstrap", "url": "plugins/??…", "rev": "…", "entries": ["…"] }
  ]
}
```

`release` is `null` when the Host publishes none. `inject`, `immediately`, and
`external` are omitted when the Host omits them.

### `module-source { id }`

```json
{ "id": "…", "path": "/…/lib/client.js", "bytes": 524288, "complete": false, "sha256": "…", "source": "…" }
```

`complete` is false when the byte ceiling cut the file; `sha256` always covers
the returned bytes, so a client can cache a head and a whole file apart.

### `locale { namespace, locale? }`

```json
{ "namespace": "…", "locale": "zh", "available": ["zh", "en"], "dictionary": { "meta.title": "…" } }
```

Nested groups are flattened to dotted keys. An unavailable `locale` falls back to
`en`, then to the first available tag; the response names the tag it answered with.

## `client-slots` (version 1)

### `list { slot?, locale? }`

```json
{
  "slot": "plugins.item",
  "registrations": [
    { "slot": "plugins.item", "id": "agent-loop", "order": 30, "label": "Agent 循环",
      "package": "…", "locale": "settings.agentLoop",
      "render": { "kind": "component", "componentId": "agent-loop" } }
  ],
  "emptySlots": []
}
```

`slot` is `null` when the request did not narrow. Registrations sort by slot,
then `order`, then id. `key` replaces `id` for keyed slots. `package` is the
entry id whose bundle registered it. `render.kind` is `component` or `factory`.
`origin` is `static` when the registration was read from the bundle's text
without running it, or `evaluated` when the VM captured the call; older
bridges omit it, and a client treats that as unknown.

A contribution appears once. A phone Host locates its `node_modules` through
several path spellings (a `require.resolve` answer, the running entry point, and
a profile's own symlink), so the same bundle can be discovered through more than
one root; the rows are deduplicated by
`<slot>|<id-or-key>|<package>` and the first (install-first) copy wins. Without
this, one plugin's `settings.section` entry would be listed once per root.

`locale` is an optional BCP-47 tag (`zh-Hans-CN`, `en-US`, …) naming the
language the client renders in. Tags are tried in this order: the requested
tag, its base language (`zh-Hans-CN` → `zh`), then the Host's configured
`localeTags`. The Host caches labels per bundle revision and tag preference, so
one client asking for Chinese and another for English both get their own text
from the same request path. Omitting `locale` uses the Host's tags; a value that
is not a language tag (or is not a string) is `args/invalid`.

A registration's label comes from, in order: the literal the bundle wrote
(`label: "Subscriptions"`); the copy table the bundle ships inline, resolved
through the key its thunk names (`label: () => t("nav")`); then the package's
own `locale/<tag>.json`. When a bundle localizes its label this way the response
also carries `labelKey` (`"nav"`), so a client can tell a resolved translation
from a literal. A registration none of those sources names keeps no `label`, and
the client shows its id instead of inventing a name.

### `describe { slot, id, locale? }`

One `registrations[]` entry, or `args/invalid`. `locale` resolves the label the
same way `list` does.

### `render-tree { componentId, props? }`

```json
{
  "componentId": "…",
  "tree": {
    "kind": "element", "type": "component:AgentLoopCard", "key": null,
    "props": { "view": "summary" },
    "children": [
      { "kind": "element", "type": "div", "key": null, "props": { "className": "card" }, "children": [] },
      { "kind": "text", "value": "…" },
      { "kind": "opaque", "reason": "depth-budget" }
    ]
  }
}
```

- `type` is a host tag (`div`, `span`, `svg`, `path`, …), `component:<Name>`,
  `fragment`, or `unknown:<tag>` for a tag outside the known set.
- `props` holds JSON-safe members only. A function prop becomes
  `<function:name>`; a nested element prop becomes `<element:type>`; children
  live in `children`, never in `props`.
- `opaque.reason` is `depth-budget`, `node-budget`, `component-threw`, or
  `object-child`. A client renders an opaque node as nothing.
- `tree` is `null` when the component produced no node.

### `icon-svg { componentId, size? }`

```json
{ "componentId": "…", "size": 24, "svg": "<svg …>…</svg>" }
```

`size` defaults to 24 and is clamped to the configured `maxIconSize`. `svg` is
`null` when the component drew no shape; `warnings` then says why.

### `dispatch { componentId, event, payload? }`

```json
{ "ok": true }
```

Delivers one native UI event to the plugin: `event` is `press`, `input`,
`toggle`, or `submit`; `payload` is a JSON-safe object (unknown members are
dropped with a warning). The bridge re-broadcasts it on the Host event bus as
`ui/<componentId>/<event>` and queues a `client/refresh` transient message
(`events/pending`), so the client re-pulls the component tree once the plugin
has reacted. A composition without an event bus still answers `ok` and warns.

## `native-plugins` (version 1)

The catalogue of native companion plugins. A JS plugin whose author also ships
a Kotlin/Compose APK (rendered through the native SDK) declares that half in its
`package.json` under `dsh.native`. The bridge surfaces those declarations so the
Android client can mark a plugin as "native enhanced" and gate on compatibility
before any download. The APK itself ships through the store / package manager,
never through the bridge.

### `list`

```json
{ "companions": [
  { "pluginId": "changfenhuang.kimi-oauth", "name": "Kimi 登录",
    "apiVersion": 1, "minAppVersion": 12,
    "capabilities": ["openUrl", "storage"], "storeUrl": "https://…" }
] }
```

### `for { pluginId }`

One plugin's declaration, or `{ "companion": null }` when it ships no native
half. Omitting `pluginId` also answers `null`.

- `pluginId` pairs the companion APK with this JS plugin — it equals the APK's
  `dsh.plugin.id` and the componentId prefix the JS half registers under.
- `apiVersion` / `minAppVersion` let the App refuse an incompatible companion
  before loading it (the ABI gate); absent means "any".
- `capabilities` are the strings the companion's `PluginDescriptor` declares;
  the App shows them on the store/detail page.

## `package-inventory` (version 1)

### `bundles { name? }`

```json
{
  "managementAvailable": true,
  "bundles": [
    { "name": "…", "official": false, "optional": false, "removable": true,
      "enabled": true, "installed": true, "availability": "profile",
      "version": "1.2.3", "title": "…", "description": "…",
      "icon": "data:image/png;base64,…",
      "rows": [{ "rowId": "…", "moduleName": "…", "entryId": "include:…", "enabled": false, "title": "…" }],
      "errorCode": "not-bundle" }
  ]
}
```

`icon` is the package's own `meta.icon` data URL, passed through untouched. A
bundle with a management error carries `errorCode` and no `version`.

A row's `entryId` is the Loader entry the Host resolved that row to: present means
the row is addressable (even while disabled), absent means it is not live — which
is why a client cannot toggle it. `enabled` is joined from the Loader inventory
(same rule as the browser page: an entry reports its own state, a row without one
is `false`); it is absent only when the composition has no inventory service.

### `rows`

```json
{
  "managementAvailable": true,
  "rows": [
    { "entryId": "…", "moduleName": "…", "enabled": true, "fiberPhase": "active", "title": "…" }
  ]
}
```

`fiberPhase` is `pending`, `loading`, `active`, `failed`, `unloading`, or `null`.

### `meta-icon { name }`

```json
{ "name": "…", "icon": "data:image/png;base64,…" }
```

`icon` is `null` when the bundle or row publishes none. The name resolves as a
bundle first, then as a row `entryId` or `moduleName`.

## `rpc` (version 1)

### `invoke { namespace, method, args? }`

```json
{ "namespace": "settings", "method": "describe", "result": { } }
```

`result` is the remote method's own return value, projected to JSON. A method
outside `rpcAllowlist` fails with `args/invalid` and `details.allowlist`; an empty
allowlist fails with `provider/unavailable` before the gateway is touched.

## Adding a provider

A new provider needs an id, a version, and one handler per capability. Nothing
else changes: the manifest picks it up from the registry, `/query` dispatches to
it, and an existing client ignores the unknown id. Bump `version` when a field
changes meaning or disappears — that is the only breaking change this protocol
allows.
