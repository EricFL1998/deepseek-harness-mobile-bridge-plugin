/**
 * Package identity and published payload.
 *
 * This package is installed from a GitHub tarball, so its `exports` map is the
 * whole contract a Host resolves: a target that does not exist is an install
 * that loads nothing. `tsc` writes to `lib/` with no `types/` sublevel, which is
 * exactly the shape a hand-written exports map gets wrong, so it is checked
 * here rather than discovered on a device.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The parsed `package.json`. */
function manifest(): {
  name: string
  version: string
  main: string
  types: string
  exports: Record<string, string | Record<string, string>>
  files: string[]
  dsh: { bundle: { patch: string } }
} {
  return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as never
}

test('the package name is the one the Android client installs', () => {
  // The npm name `dsh-mobile-bridge` belongs to an unrelated published package,
  // so the name must stay distinct from it.
  assert.equal(manifest().name, 'dsh-mobile-bridge-plugin')
})

test('the version is a semver triple the client can compare', () => {
  assert.match(manifest().version, /^\d+\.\d+\.\d+$/)
})

test('every export target exists in the tree', () => {
  const pkg = manifest()
  const targets: string[] = [pkg.main, pkg.types]
  for (const value of Object.values(pkg.exports)) {
    if (typeof value === 'string') {
      targets.push(value)
      continue
    }
    for (const nested of Object.values(value)) targets.push(nested)
  }
  const missing = targets.filter(target => !existsSync(join(packageRoot, target)))
  assert.deepEqual(missing, [], `exports point at files that do not exist: ${missing.join(', ')}`)
})

test('the bundle patch the Loader reads exists and names this package', () => {
  const pkg = manifest()
  const patchPath = join(packageRoot, pkg.dsh.bundle.patch)
  assert.ok(existsSync(patchPath), `${pkg.dsh.bundle.patch} is missing`)
  const patch = readFileSync(patchPath, 'utf8')
  assert.match(patch, new RegExp(`name: ${pkg.name}\\b`))
})

test('the built entry is committed, because a tarball install runs no build', () => {
  const pkg = manifest()
  // `lib/` is deliberately tracked: this package is not published to npm, so the
  // tarball is the release artifact and nothing compiles it on install.
  assert.ok(existsSync(join(packageRoot, pkg.main)), 'the built entry is absent from the tree')
  assert.ok(existsSync(join(packageRoot, pkg.types)), 'the built types are absent from the tree')
})

test('the release flag is disarmed by default', () => {
  // Publishing is an explicit act: the workflow only creates a release when this
  // flag is true, and disarms it afterwards. A committed `true` means someone
  // armed a release and the workflow did not clear it (or the release was made
  // by hand), which would republish on the next push.
  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { release?: unknown }
  assert.equal(pkg.release, false, 'package.json "release" must be false outside a release commit')
})
