/**
 * Tests for the static transpiler (`src/slots/transpile.ts`).
 *
 * Every fixture is the *compiled* shape a rolldown bundle ships: a
 * `window.__ModuleLoader__.load({ id, factory })` IIFE whose factory registers
 * slots and whose components return `_jsx(...)` / `React.createElement(...)`
 * calls. The transpiler must recover those trees without executing anything.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  analyzeBundle, buildComponentTree, tokenize, DEFAULT_TRANSPILE_BUDGET,
} from '../src/slots/transpile.ts'

/** Wrap a factory body in the rolldown IIFE shape. */
function bundle(body: string): string {
  return `(() => { window.__ModuleLoader__.load({ id: 'test-pkg#lib/client.js', factory: (require) => {
var jsx = require('react/jsx-runtime').jsx, jsxs = require('react/jsx-runtime').jsxs;
${body}
} }); })();`
}

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

describe('analyzeBundle', () => {
  it('recovers a register call with its static fields', () => {
    const analyzed = analyzeBundle('test-pkg', bundle(`
      return { apply(ctx) {
        ctx.effect(() => ctx.slots.register({ name: 'settings.section', id: 'subscription', order: 10 }, SubscriptionPage));
      } };
    `))
    assert.equal(analyzed.registrations.length, 1)
    assert.partialDeepStrictEqual(analyzed.registrations[0], {
      slot: 'settings.section', id: 'subscription', order: 10,
      componentName: 'SubscriptionPage', kind: 'component',
    })
  })

  it('finds register calls nested inside apply callbacks', () => {
    const analyzed = analyzeBundle('test-pkg', bundle(`
      return { apply(ctx) {
        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register({ name: 'conversation.input.right' }, MicButton));
      } };
    `))
    assert.equal(analyzed.registrations[0]?.slot, 'conversation.input.right')
    assert.equal(analyzed.registrations[0]?.componentName, 'MicButton')
  })

  it('collects function and arrow components', () => {
    const analyzed = analyzeBundle('test-pkg', bundle(`
      function Card() { return jsx('div', { children: 'hi' }); }
      const Chip = () => jsx('span', {});
      return { apply() {} };
    `))
    const names = analyzed.components.map(component => component.name)
    assert.ok(names.includes('Card'))
    assert.ok(names.includes('Chip'))
  })

  it('reports the bundler jsx aliases it detected', () => {
    const analyzed = analyzeBundle('test-pkg', bundle(`return { apply() {} };`))
    assert.ok(analyzed.jsxNames.includes('jsx'))
    assert.ok(analyzed.jsxNames.includes('jsxs'))
  })
})

describe('buildComponentTree', () => {
  it('turns a jsx call tree into element and text nodes', () => {
    const source = bundle(`
      function Hello() {
        return jsxs('div', { className: 'card', children: [
          jsx('h2', { children: 'Title' }),
          jsx('p', { children: 'Body text' }),
        ] });
      }
      return { apply() {} };
    `)
    const built = buildComponentTree(source, 'Hello', {})
    assert.deepEqual(built.tree, {
      kind: 'element', type: 'div', key: null,
      props: { className: 'card' },
      children: [
        { kind: 'element', type: 'h2', key: null, props: {}, children: [{ kind: 'text', value: 'Title' }] },
        { kind: 'element', type: 'p', key: null, props: {}, children: [{ kind: 'text', value: 'Body text' }] },
      ],
    })
    assert.equal(built.truncated, false)
  })

  it('keeps static style objects as JSON props', () => {
    const source = bundle(`
      const Styled = () => jsx('div', { style: { color: 'red', fontSize: 14 } });
      return { apply() {} };
    `)
    const built = buildComponentTree(source, 'Styled', {})
    assert.partialDeepStrictEqual(built.tree, {
      kind: 'element', type: 'div',
      props: { style: { color: 'red', fontSize: 14 } },
    })
  })

  it('resolves destructured and member-read props from the request', () => {
    const source = bundle(`
      function Greeting({ name }) { return jsx('span', { children: name }); }
      const Count = (props) => jsx('span', { children: props.count });
      return { apply() {} };
    `)
    assert.partialDeepStrictEqual(
      buildComponentTree(source, 'Greeting', { name: 'Ada' }).tree as Record<string, unknown>,
      { children: [{ kind: 'text', value: 'Ada' }] },
    )
    assert.partialDeepStrictEqual(
      buildComponentTree(source, 'Count', { count: 3 }).tree as Record<string, unknown>,
      { children: [{ kind: 'text', value: '3' }] },
    )
  })

  it('marks dynamic children as opaque instead of guessing', () => {
    const source = bundle(`
      function Dynamic({ name }) { return jsx('div', { children: name.toUpperCase() }); }
      return { apply() {} };
    `)
    const built = buildComponentTree(source, 'Dynamic', { name: 'x' })
    assert.partialDeepStrictEqual(built.tree as Record<string, unknown>, {
      kind: 'element', type: 'div',
      children: [{ kind: 'opaque' }],
    })
  })

  it('supports React.createElement with variadic children', () => {
    const source = bundle(`
      var React = require('react');
      function Pair() { return React.createElement('div', null, React.createElement('b', null, 'one'), 'two'); }
      return { apply() {} };
    `)
    const built = buildComponentTree(source, 'Pair', {})
    assert.partialDeepStrictEqual(built.tree as Record<string, unknown>, {
      kind: 'element', type: 'div',
      children: [
        { kind: 'element', type: 'b', children: [{ kind: 'text', value: 'one' }] },
        { kind: 'text', value: 'two' },
      ],
    })
  })

  it('handles arrow components whose body is the expression', () => {
    const source = bundle(`
      const Chip = () => jsx('span', { children: 'chip' });
      return { apply() {} };
    `)
    assert.partialDeepStrictEqual(
      buildComponentTree(source, 'Chip', {}).tree as Record<string, unknown>,
      { kind: 'element', type: 'span' },
    )
  })

  it('resolves the statically-known branch of a conditional', () => {
    const source = bundle(`
      function Maybe() { return true ? jsx('div', {}) : jsx('span', {}); }
      return { apply() {} };
    `)
    assert.partialDeepStrictEqual(
      buildComponentTree(source, 'Maybe', {}).tree as Record<string, unknown>,
      { kind: 'element', type: 'div' },
    )
  })

  it('reports truncation when a component composition is too deep', () => {
    // Self-referencing composition: each level inlines another component.
    const source = bundle(`
      function Loop() { return jsx(Loop2, {}); }
      function Loop2() { return jsx(Loop, {}); }
      return { apply() {} };
    `)
    const built = buildComponentTree(source, 'Loop', {}, {
      ...DEFAULT_TRANSPILE_BUDGET, maxDepth: 4, maxNodes: 6,
    })
    assert.equal(built.truncated, true)
  })

  it('handles the minified (0, n.jsx)(…) call shape', () => {
    const source = `(()=>{var e={271:(e,t,r)=>{r.d(t,{apply:()=>a});var n=r(609);function s({title:e}){return(0,n.jsxs)("div",{children:[(0,n.jsx)("h3",{children:e}),(0,n.jsx)("button",{children:"登录"})]})}function a(e){e.slots.inject("settings.section",()=>e.slots.register({name:"settings.section",id:"subscription",order:92},s))}},609:e=>{e.exports={}}};window.__ModuleLoader__.load({id:"x",factory:e=>(0,e(271).apply)({})})})();`
    const analyzed = analyzeBundle('x', source)
    assert.equal(analyzed.registrations[0]?.componentName, 's')
    // Minified destructuring `{title:e}` renames the binding but never the
    // object key: the positional fallback maps the renamed binding back to its
    // prop, so the request's `title` still reaches the tree.
    const built = buildComponentTree(source, 's', { title: '订阅' })
    assert.partialDeepStrictEqual(built.tree as Record<string, unknown>, {
      kind: 'element', type: 'div',
      children: [
        { kind: 'element', type: 'h3', children: [{ kind: 'text', value: '订阅' }] },
        { kind: 'element', type: 'button', children: [{ kind: 'text', value: '登录' }] },
      ],
    })
  })

  it('resolves t(key) through the dictionary the bundle carries', () => {
    const source = bundle(`
      var en = { nav: 'Subscriptions', intro: 'Sign in with a subscription.', connect: 'Connect',
                 edit: 'Edit', cancel: 'Cancel', close: 'Close', logout: 'Sign out' };
      function Section() {
        return jsxs('section', { children: [
          jsx('h2', { children: t('nav') }),
          jsx('p', { children: t('intro') }),
          jsx('button', { children: t('connect') }),
        ] });
      }
      return { apply() {} };
    `)
    const built = buildComponentTree(source, 'Section', {}, DEFAULT_TRANSPILE_BUDGET, ['en'])
    assert.partialDeepStrictEqual(built.tree as Record<string, unknown>, {
      kind: 'element', type: 'section',
      children: [
        { kind: 'element', type: 'h2', children: [{ kind: 'text', value: 'Subscriptions' }] },
        { kind: 'element', type: 'p', children: [{ kind: 'text', value: 'Sign in with a subscription.' }] },
        { kind: 'element', type: 'button', children: [{ kind: 'text', value: 'Connect' }] },
      ],
    })
  })

  it('fills {placeholders} from static params and keeps dynamic ones', () => {
    const source = bundle(`
      var en = { a: 'Connected · {count} account(s)', b: 'expires {time}', c: 'x',
                 d: 'x', e: 'x', f: 'x' };
      function Status() {
        return jsx('span', { children: t('a', { count: 3 }) });
      }
      return { apply() {} };
    `)
    const built = buildComponentTree(source, 'Status', {}, DEFAULT_TRANSPILE_BUDGET, ['en'])
    assert.partialDeepStrictEqual(built.tree as Record<string, unknown>, {
      kind: 'element', type: 'span',
      children: [{ kind: 'text', value: 'Connected · 3 account(s)' }],
    })
  })

  it('prefers the locale tag the client asked for', () => {
    const source = bundle(`
      var en = { nav: 'Subscriptions', a: 'x', b: 'x', c: 'x', d: 'x', e: 'x' };
      var zh = { nav: '订阅', a: 'x', b: 'x', c: 'x', d: 'x', e: 'x' };
      function Section() { return jsx('h2', { children: t('nav') }); }
      return { apply() {} };
    `)
    const zhTree = buildComponentTree(source, 'Section', {}, DEFAULT_TRANSPILE_BUDGET, ['zh'])
    assert.partialDeepStrictEqual(zhTree.tree as Record<string, unknown>, {
      kind: 'element', type: 'h2', children: [{ kind: 'text', value: '订阅' }],
    })
    const enTree = buildComponentTree(source, 'Section', {}, DEFAULT_TRANSPILE_BUDGET, ['en'])
    assert.partialDeepStrictEqual(enTree.tree as Record<string, unknown>, {
      kind: 'element', type: 'h2', children: [{ kind: 'text', value: 'Subscriptions' }],
    })
  })

  it('reports a key the dictionary does not carry', () => {
    const source = bundle(`
      var en = { nav: 'Subscriptions', a: 'x', b: 'x', c: 'x', d: 'x', e: 'x' };
      function Missing() { return jsx('span', { children: t('absentKey') }); }
      return { apply() {} };
    `)
    const built = buildComponentTree(source, 'Missing', {}, DEFAULT_TRANSPILE_BUDGET, ['en'])
    assert.partialDeepStrictEqual(built.tree as Record<string, unknown>, {
      kind: 'element', type: 'span',
      children: [{ kind: 'opaque', reason: 'untranslated:absentKey' }],
    })
  })

  it('returns null with a warning for an unknown component', () => {
    const source = bundle(`return { apply() {} };`)
    const built = buildComponentTree(source, 'Missing', {})
    assert.equal(built.tree, null)
    assert.ok(built.warnings.some(note => note.includes('Missing')))
  })
})

describe('data binding', () => {
  it('reads a prop object destructured inside the body', () => {
    // The shape most real components use: take `props`, destructure in the body.
    const source = bundle(`
      function Card(props) {
        const { status, t } = props;
        return jsx('span', { children: status.displayName });
      }
      return { apply() {} };
    `)
    const built = buildComponentTree(source, 'Card', { status: { displayName: 'Kimi Code' } })
    assert.partialDeepStrictEqual(built.tree as Record<string, unknown>, {
      kind: 'element', type: 'span', children: [{ kind: 'text', value: 'Kimi Code' }],
    })
  })

  it('reads a local derived from props and renders one child per row', () => {
    const source = bundle(`
      function List(props) {
        const rows = props.rows;
        return jsx('div', { children: rows.map(row => jsx('span', { children: row.name })) });
      }
      return { apply() {} };
    `)
    const built = buildComponentTree(source, 'List', {
      rows: [{ name: 'first' }, { name: 'second' }],
    })
    assert.partialDeepStrictEqual(built.tree as Record<string, unknown>, {
      kind: 'element',
      type: 'div',
      children: [
        { kind: 'element', type: 'span', children: [{ kind: 'text', value: 'first' }] },
        { kind: 'element', type: 'span', children: [{ kind: 'text', value: 'second' }] },
      ],
    })
  })

  it('filters before mapping, using the element index', () => {
    const source = bundle(`
      function List(props) {
        return jsx('ul', { children: props.rows.filter((row, index) => index > 0).map(row => jsx('li', { children: row.name })) });
      }
      return { apply() {} };
    `)
    const built = buildComponentTree(source, 'List', { rows: [{ name: 'a' }, { name: 'b' }] })
    assert.partialDeepStrictEqual(built.tree as Record<string, unknown>, {
      kind: 'element', type: 'ul',
      children: [{ kind: 'element', type: 'li', children: [{ kind: 'text', value: 'b' }] }],
    })
  })

  it('selects the branch a data test picks and interpolates a template', () => {
    const source = bundle(`
      function Badge(props) {
        const { status } = props;
        return jsx('i', {
          children: status.loggedIn ? \`已连接 \${status.accounts.length} 个账号\` : '未登录',
        });
      }
      return { apply() {} };
    `)
    const connected = buildComponentTree(source, 'Badge', {
      status: { loggedIn: true, accounts: [{}, {}] },
    })
    assert.partialDeepStrictEqual(connected.tree as Record<string, unknown>, {
      kind: 'element', type: 'i', children: [{ kind: 'text', value: '已连接 2 个账号' }],
    })
    const signedOut = buildComponentTree(source, 'Badge', { status: { loggedIn: false, accounts: [] } })
    assert.partialDeepStrictEqual(signedOut.tree as Record<string, unknown>, {
      kind: 'element', type: 'i', children: [{ kind: 'text', value: '未登录' }],
    })
  })

  it('reads a module-level constant object', () => {
    const source = bundle(`
      const styles = { name: { fontWeight: 600 } };
      function Label() { return jsx('span', { style: styles.name, children: 'x' }); }
      return { apply() {} };
    `)
    const built = buildComponentTree(source, 'Label', {})
    assert.partialDeepStrictEqual(built.tree as Record<string, unknown>, {
      kind: 'element', type: 'span', props: { style: { fontWeight: 600 } },
    })
  })

  it('treats the third jsx argument as the key, not a child', () => {
    // Production jsx emits `jsx(type, props, key)`; reading the key as a child
    // put a list key where the card should be.
    const source = bundle(`
      function Card(props) { return jsx('span', { children: props.label }); }
      function List(props) {
        return jsx('div', { children: props.rows.map(row => jsx(Card, { label: row.name }, row.id)) });
      }
      return { apply() {} };
    `)
    const built = buildComponentTree(source, 'List', { rows: [{ id: 'a', name: 'first' }] })
    assert.partialDeepStrictEqual(built.tree as Record<string, unknown>, {
      kind: 'element', type: 'div',
      children: [{ kind: 'element', type: 'span', children: [{ kind: 'text', value: 'first' }] }],
    })
  })

  it('inlines a component that sits inside another component children', () => {
    const source = bundle(`
      function Badge(props) { return jsx('b', { children: props.text }); }
      function Card(props) { return jsx('div', { children: jsx(Badge, { text: props.title }) }); }
      return { apply() {} };
    `)
    const built = buildComponentTree(source, 'Card', { title: 'hello' })
    assert.partialDeepStrictEqual(built.tree as Record<string, unknown>, {
      kind: 'element', type: 'div',
      children: [{ kind: 'element', type: 'b', children: [{ kind: 'text', value: 'hello' }] }],
    })
  })
})
