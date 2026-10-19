# dsh-mobile-bridge-plugin

A Host-side DSH plugin that exposes the **official web client's own runtime
data** to native clients (Android, desktop shells, test harnesses) as a stable,
versioned, capability-negotiated JSON protocol.

It is deliberately **not** a plugin-catalog endpoint. The plugin page is the
first consumer of a general mechanism that also serves settings forms, surfaces,
icons, locales, and remote RPCs.

## Principles

1. **No UI interpretation on the Host.** The bridge extracts data; clients render.
2. **Client assets are the source of truth.** Slot registrations, labels, icons,
   and package metadata come from the installed client packages and the boot
   manifest — never from a hand-written mobile table.
3. **Providers, not endpoints.** Every feature is a provider behind one generic
   query API. A new compatibility feature adds a provider; the wire format stays.
4. **Read-only by default.** Mutations go through explicit providers with a
   capability flag and the Host's own authorization; the bridge never bypasses
   DSH remote access.
5. **Versioned.** `bridge/v1` plus per-provider `version` and `capabilities`.
   Clients negotiate; unknown providers are ignored.

## Wire contract

Base: `http://127.0.0.1:<port>/dsh-mobile/bridge/v1`

### `GET /manifest`

```json
{
  "bridgeVersion": "1.0.0",
  "dshVersion": "0.2.1-rc.2",
  "providers": [
    { "id": "client-assets", "version": 1, "capabilities": ["boot-graph", "module-source", "locale"], "readOnly": true },
    { "id": "client-slots", "version": 1, "capabilities": ["list", "describe", "render-tree", "icon-svg"], "readOnly": true },
    { "id": "package-inventory", "version": 1, "capabilities": ["bundles", "rows", "meta-icon"], "readOnly": true },
    { "id": "rpc", "version": 1, "capabilities": ["invoke"], "authorization": "host-session" }
  ]
}
```

`dshVersion` is `null` when the Host publishes no release label. `warnings` lists
every service the composition could not bind, so a client can degrade knowingly
rather than discovering a hole at call time.

### `POST /query`

```json
{ "provider": "client-slots", "op": "list", "args": { "slot": "plugins.item" } }
```

```json
{ "ok": true, "provider": "client-slots", "version": 1, "data": [ ], "warnings": [] }
```

Errors never partially succeed:

```json
{ "ok": false, "error": { "code": "provider/unavailable", "message": "..." } }
```

Stable codes: `request/malformed`, `request/unsupported-method`,
`provider/unknown`, `provider/unavailable`, `provider/version-mismatch`,
`op/unknown`, `args/invalid`, `budget/exceeded`, `auth/required`,
`internal/error`. A client maps a code to its own copy; `message` is diagnostic.

`op/unknown` carries `details.capabilities`; an unknown component id carries
`details.known`. Both let a client correct itself without a second round trip.

## Providers

### `client-assets`

Reads the web boot manifest the Host injects into the served shell, then the
installed client entry URLs. It parses no React.

- `boot-graph` → `rev`, `release`, `entries`, `batches`.
- `module-source { id }` → the entry's bundle bytes, bounded by
  `maxModuleBytes`, with `complete` and `sha256` so a client can tell a head from
  the whole file.
- `locale { namespace, locale? }` → that package's dictionary, flattened to
  dotted keys, with the `available` tags it actually publishes.

### `client-slots`

The generic compatibility primitive. It evaluates official client bundles in an
isolated Node VM with a React-shaped stub (no DOM), captures
`ctx.slots.register` / `registerFactory` calls, and returns registrations as
data:

```json
{
  "slot": "plugins.item",
  "id": "agent-loop",
  "order": 30,
  "label": "Agent 循环",
  "package": "@deepseek-ai/dsh-client-ui-settings-agent-loop",
  "locale": "settings.agentLoop",
  "render": { "kind": "component", "componentId": "agent-loop" }
}
```

- `list { slot? }` → registrations sorted by slot, order, id; plus `emptySlots`,
  the slot names the evaluated bundles touched but contributed nothing to.
- `describe { slot, id }` → one contribution's complete metadata.
- `render-tree { componentId, props? }` → the element tree the component
  function produces under the stub. The client converts it to native widgets.
- `icon-svg { componentId, size? }` → that tree reduced to one standalone `<svg>`
  document, for image slots.

Execution is deterministic and side-effect free. The stub provides
`createElement`, `cloneElement`, `Fragment`, `useId`, `useMemo`, `useState`
(single render), `useRef`, `useCallback`, and the rest of the hook surface, each
resolving once. The VM rejects `document`, `window.fetch`, timers, `process`, and
any module request other than `react` / `react-dom`. A bundle that needs one
fails loudly and the failure is reported as a `warnings` entry, so the rest of
the catalog stays readable.

One evaluation is cached per entry revision, so a repeated query re-reads
nothing.

### `package-inventory`

Reuses Host services, never filesystem guesses:

- `bundles { name? }` → `pluginManager.listBundles()` projected: name, official,
  optional, removable, enabled, installed, availability, version, rows, and
  `meta.title/description/icon`.
- `rows` → `pluginInventory.list()`: every running Loader entry with its fiber
  phase and `meta`.
- `meta-icon { name }` → one bundle's or row's `meta.icon` data URL, passed
  through untouched.

Third-party plugin icons therefore remain fully backend-driven.

### `rpc`

A single generic proxy for whitelisted Host remotes:

```json
{ "provider": "rpc", "op": "invoke",
  "args": { "namespace": "settings", "method": "describe", "args": {} } }
```

Authorization is the caller's existing Host session cookie: the carrier admits
the request through the Host's own connection fence before any provider runs, so
the bridge never mints credentials. `rpcAllowlist` names the reachable methods;
an empty list refuses every call. `maxRpcResultBytes` and `rpcTimeoutMs` cap one
invocation.

## Installation

The package is a DSH bundle: `dsh.bundle.patch` names `cordis.patch.yml`, which
inserts the one row this plugin is.

This package is **not published to npm**. `lib/` is committed, so a GitHub
source tarball is directly installable — no build step runs on install.

```sh
# inside the Host, in the profile directory
dsh plugin --profile web add https://github.com/EricFL1998/deepseek-harness-mobile-bridge-plugin
```

Or point at a specific tag for a reproducible install:

```sh
dsh plugin --profile web add https://github.com/EricFL1998/deepseek-harness-mobile-bridge-plugin#v1.1.0
```

Then add `dsh-mobile-bridge-plugin` to the profile's `dsh.profile.bundles`. The
bridge registers on the Host's existing `webServer`, so it needs no port of its
own.

The Android client performs exactly that install from its settings page: the
APK ships a small manifest naming this repository and the plugin version it
expects, and the update button runs the command inside the rootfs. So a bridge
release reaches existing users without re-downloading a rootfs image.

### Releases are version markers

A GitHub release here carries **no assets**: the plugin is installed from the
source tarball, so the tag is the whole artifact.

Publishing is deliberate, never a side effect of pushing. Ordinary commits —
including work in progress and a half-finished version bump — create nothing.
To release:

1. bump `version` in `package.json`;
2. set `"release": true`;
3. commit and push.

`.github/workflows/release.yml` then creates `v<version>`, and flips the flag
back to `false` in the same run, so it cannot republish on the next push. A test
asserts the committed flag is `false`, which catches a hand-made release whose
flag was left armed.

Two consumers read the tag and nothing else:

- **The Android client** compares it against the plugin version installed inside
  the rootfs. A difference is offered as an update in Settings → Updates.
- **The rootfs build** bundles that version and stamps it into its
  `runtimeVersion` as `-bridge<version>`, e.g.
  `1.1.0-dsh0.2.1-rc.2-bridge1.1.0`.

So a plugin release needs no APK rebuild and no rootfs rebuild.

Configuration is per deployment; see `Config` in `src/index.ts` and the defaults
in `cordis.patch.yml`. The two worth reading before shipping a client:

- `slotEntries` — empty evaluates every composed entry. Naming entries bounds the
  work to the bundles a client actually reads.
- `rpcAllowlist` — empty means the `rpc` provider refuses everything.

## Standalone carrier

`startStandalone` serves the same handler from a plain Node process with no Host,
so a native client can be developed and contract-tested against the exact
handler the Host composes. It binds loopback only.

```sh
node --experimental-strip-types bin/serve.ts
```

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test        # 64 tests: wire contract, providers, VM isolation, assembly, fixture, e2e, Cordis
pnpm run build   # emits lib/
```

Tests exercise the handler directly rather than over a socket, so the wire
contract is checked without a carrier; the standalone carrier has its own
socket-level test, and a real Cordis composition loads the plugin as a fiber to
prove the export form, inject list, and effect disposal are all correct.

## Known limitations

- The VM carries `react` and `react-dom` only. A client bundle that requests a
  shared module-table row (for example `@deepseek-ai/dsh-client-ui-primitives`)
  registers its slots but its components are not renderable; the bridge reports
  the specifier as a warning instead of returning a fabricated tree. Extending the
  VM means implementing that module, not mocking it.
- `icon-svg` converts shapes, not text: a slot icon that draws letters would need
  font metrics the bridge does not have, so text nodes are reported and dropped.
- `render-tree` renders once. A component whose output depends on a second render
  (an effect, a subscription, a transition) reports its first-pass tree.
- `client-assets/locale` reads the package's `locale/<tag>.json` files beside its
  manifest. A package that ships dictionaries only inside its bundle reports
  `provider/unavailable` rather than a guessed dictionary.
