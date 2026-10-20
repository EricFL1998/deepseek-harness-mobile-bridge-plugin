/**
 * Cross-repository contract fixture.
 *
 * The Android client's `fixtures/bridge-contract-fixture.json` is the shared
 * sample of this wire. When the Host plugin is checked out beside that project,
 * these tests decode the same file, so a field rename on either side fails here
 * instead of on a device.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BRIDGE_VERSION } from '../src/protocol/types.ts'

/** Candidate locations of the Android project's fixture, nearest first. */
const FIXTURE_CANDIDATES = [
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'bridge-contract-fixture.json'),
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'deepseek mobile', 'fixtures', 'bridge-contract-fixture.json'),
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'deepseek mobile', 'fixtures', 'bridge-contract-fixture.json'),
]

/** The fixture, or undefined when the sibling checkout is absent. */
function fixture(): Record<string, unknown> | undefined {
  const path = FIXTURE_CANDIDATES.find(candidate => existsSync(candidate))
  if (path === undefined) return undefined
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

test('the shared fixture declares this bridge version', () => {
  const shared = fixture()
  if (shared === undefined) return
  assert.equal(shared.bridgeVersion, BRIDGE_VERSION)
})

test('the fixture manifest names exactly the providers this package registers', () => {
  const shared = fixture()
  if (shared === undefined) return
  const manifest = shared.manifest as { providers: { id: string; version: number; capabilities: string[] }[] }
  // The ids and their capability names are the contract; the order is the
  // registration order the plugin documents. The transpile provider was retired:
  // the component-tree it served moved to the plugin's full Web UI.
  assert.deepEqual(manifest.providers.map(provider => provider.id), [
    'client-assets', 'client-slots', 'package-inventory', 'rpc',
  ])
  assert.deepEqual(manifest.providers[0]!.capabilities, ['boot-graph', 'module-source', 'locale'])
  assert.deepEqual(manifest.providers[1]!.capabilities, ['list', 'describe', 'render-tree', 'icon-svg', 'dispatch'])
  assert.deepEqual(manifest.providers[2]!.capabilities, ['bundles', 'rows', 'meta-icon'])
  assert.deepEqual(manifest.providers[3]!.capabilities, ['invoke'])
  for (const provider of manifest.providers) assert.equal(provider.version, 1)
})

test('the fixture failure codes are the ones this bridge emits', () => {
  const shared = fixture()
  if (shared === undefined) return
  const failures = shared.failures as { code: string }[]
  const known = new Set([
    'request/malformed', 'request/unsupported-method', 'provider/unknown',
    'provider/unavailable', 'provider/version-mismatch', 'op/unknown',
    'args/invalid', 'budget/exceeded', 'auth/required', 'internal/error',
  ])
  for (const failure of failures) {
    assert.ok(known.has(failure.code), `fixture uses an undocumented code: ${failure.code}`)
  }
  assert.deepEqual(failures.map(failure => failure.code), [
    'provider/unavailable', 'op/unknown', 'args/invalid', 'budget/exceeded', 'auth/required',
  ])
})

test('the fixture icon document parses as the SVG this provider emits', () => {
  const shared = fixture()
  if (shared === undefined) return
  const icon = shared.iconSvg as { svg: string; size: number }
  assert.match(icon.svg, /^<svg /)
  assert.match(icon.svg, /viewBox="0 0 24 24"/)
  assert.match(icon.svg, /fill-rule="evenodd"/)
  assert.equal(icon.size, 40)
})

test('the fixture slot registrations keep their official order and identity', () => {
  const shared = fixture()
  if (shared === undefined) return
  const list = shared.slotList as {
    registrations: { slot: string; id: string; order: number; label: string; render: { componentId: string } }[]
  }
  assert.deepEqual(list.registrations.map(registration => registration.id), ['agent-loop', 'shell'])
  // Ascending order is what `client-slots/list` sorts by.
  const orders = list.registrations.map(registration => registration.order)
  assert.deepEqual([...orders].sort((left, right) => left - right), orders)
  for (const registration of list.registrations) {
    assert.equal(registration.slot, 'plugins.item')
    assert.equal(registration.render.componentId, registration.id)
  }
})
