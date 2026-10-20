import { readFileSync } from 'node:fs'
import { buildComponentTree, DEFAULT_TRANSPILE_BUDGET } from './src/slots/transpile.ts'
const source = readFileSync(process.env.SUB_OAUTH_CLIENT, 'utf8')
const status = JSON.parse(readFileSync(process.env.STATUS_JSON, 'utf8'))
const built = buildComponentTree(source, 'SubscriptionsSection', { status }, DEFAULT_TRANSPILE_BUDGET, ['zh'])
const types = new Map()
const walk = n => { if (!n) return; if (n.kind === 'element') types.set(n.type, (types.get(n.type) ?? 0) + 1); for (const c of n.children ?? []) walk(c) }
walk(built.tree)
console.log([...types.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 14).map(([t,c]) => t + ':' + c).join(' '))
