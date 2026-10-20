/**
 * Tests for the inline-locale reader (`src/slots/bundle-locale.ts`).
 *
 * The reader recovers the copy tables a compiled bundle carries inline
 * (`const en = { nav: 'Subscriptions' }`) and resolves `t(key)` the way the
 * bundle's own translate helper would — without executing anything. These tests
 * survive the retirement of the component-tree transpiler: labelling a
 * registration (`label: () => t('nav')`) still needs the dictionaries.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  bundleDictionaries, chooseBundleDictionary, resolveDictionaryKey, tokenize,
} from '../src/slots/bundle-locale.ts'

describe('tokenize', () => {
  it('splits identifiers, strings, numbers and punctuation', () => {
    const tokens = tokenize(`const a = 'x'; b(1.5, "y")`)
    assert.deepEqual(tokens.map(token => token.value), ['const', 'a', '=', 'x', ';', 'b', '(', '1.5', ',', 'y', ')'])
  })

  it('skips comments and keeps template literals atomic', () => {
    const tokens = tokenize('a /* { ; } */ b // c\n`hi ${x} there`')
    assert.deepEqual(tokens.map(token => [token.kind, token.value]), [
      ['ident', 'a'], ['ident', 'b'], ['template', 'hi ${x} there'],
    ])
  })

  it('distinguishes a regex literal from division', () => {
    assert.deepEqual(tokenize('a = /x+/g').map(t => t.kind), ['ident', 'punct', 'regex'])
    assert.deepEqual(tokenize('a = b / c').map(t => t.kind), ['ident', 'punct', 'ident', 'punct', 'ident'])
  })
})

describe('bundleDictionaries', () => {
  // The reader only needs the top-level string-object bindings; no IIFE wrapper
  // is required for dictionary recovery.
  const source = `
    var en = { nav: 'Subscriptions', a: 'x', b: 'x', c: 'x', d: 'x', e: 'x' };
    var zh = { nav: '订阅', a: 'x', b: 'x', c: 'x', d: 'x', e: 'x' };
  `

  it('exports the inline copy tables by binding name', () => {
    const dictionaries = bundleDictionaries(source)
    assert.deepEqual([...dictionaries.keys()], ['en', 'zh'])
    assert.equal(dictionaries.get('zh')?.get('nav'), '订阅')
  })

  it('resolves a key the way the client language would', () => {
    const dictionaries = bundleDictionaries(source)
    assert.equal(resolveDictionaryKey(dictionaries, ['zh-Hans-CN', 'zh', 'en'], 'nav'), '订阅')
    assert.equal(resolveDictionaryKey(dictionaries, ['en-US', 'en'], 'nav'), 'Subscriptions')
    // No tag names a table: the bundle's `en` table is the documented fallback.
    assert.equal(resolveDictionaryKey(dictionaries, [], 'nav'), 'Subscriptions')
    assert.equal(resolveDictionaryKey(dictionaries, ['en'], 'absent'), undefined)
  })

  it('reports the tag and binding a preference answered with', () => {
    const chosen = chooseBundleDictionary(bundleDictionaries(source), ['zh-CN', 'en'])
    assert.equal(chosen?.name, 'zh-CN')
    assert.equal(chosen?.table.get('nav'), '订阅')
    assert.equal(chooseBundleDictionary(new Map(), ['en']), undefined)
  })
})
