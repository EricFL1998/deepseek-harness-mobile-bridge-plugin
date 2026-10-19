/**
 * Real-composition check: load the plugin through Cordis itself.
 *
 * The other tests call `apply` with a hand-built stand-in, which proves the
 * plugin's own logic but not that Cordis accepts it. This one boots a real
 * Cordis root, provides the services the plugin reads, loads the plugin as a
 * fiber, and reads the routes it registered — so a wrong export form, a bad
 * inject list, or a misplaced effect fails here.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.ts'
import type { HostWebRoute } from '../src/host-services.ts'
import { BRIDGE_BASE_PATH, EVENTS_PATH, MANIFEST_PATH, QUERY_PATH } from '../src/protocol/types.ts'

/** A web-server service the plugin can inject. */
function webServerService(): { routes: HostWebRoute[]; register(route: HostWebRoute): () => void } {
  const routes: HostWebRoute[] = []
  return {
    routes,
    register: (route) => {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }
}

test('Cordis loads the plugin as a function plugin and it registers its routes', async () => {
  const ctx = new Context()
  const webServer = webServerService()
  // The Loader would provide these; here they are provided directly so the
  // plugin's declared injection is satisfied.
  ctx.provide('webServer', webServer)

  const fiber = ctx.plugin(plugin, new plugin.Config({}) as never)
  await fiber
  await new Promise<void>(resolve => { setImmediate(resolve) })

  assert.deepEqual(webServer.routes.map(route => `${route.kind} ${route.path}`), [
    `exact ${MANIFEST_PATH}`,
    `exact ${QUERY_PATH}`,
    `exact ${EVENTS_PATH}`,
    `prefix ${BRIDGE_BASE_PATH}`,
  ])

  await fiber.dispose()
  // Disposal removes every route: the registrations are effects, not state.
  assert.deepEqual(webServer.routes, [])
})

test('a disabled bridge registers nothing through Cordis either', async () => {
  const ctx = new Context()
  const webServer = webServerService()
  ctx.provide('webServer', webServer)
  const fiber = ctx.plugin(plugin, new plugin.Config({ enabled: false }) as never)
  await fiber
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.deepEqual(webServer.routes, [])
  await fiber.dispose()
})

test('the plugin waits for its injected carrier rather than failing to load', async () => {
  const ctx = new Context()
  const fiber = ctx.plugin(plugin, new plugin.Config({}) as never)
  await fiber
  await new Promise<void>(resolve => { setImmediate(resolve) })
  // No webServer yet: the fiber is pending, not failed.
  assert.notEqual(fiber.state, 3, 'the plugin must not fail when its carrier is absent')

  const webServer = webServerService()
  ctx.provide('webServer', webServer)
  await new Promise<void>(resolve => { setImmediate(resolve) })
  assert.equal(webServer.routes.length, 4)
  await fiber.dispose()
})
