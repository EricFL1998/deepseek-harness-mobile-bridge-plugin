import { readFileSync } from 'node:fs'
import { buildComponentTree, DEFAULT_TRANSPILE_BUDGET } from './src/slots/transpile.ts'
const source = readFileSync(process.env.SUB_OAUTH_CLIENT, 'utf8')
const status = JSON.parse(readFileSync(process.env.STATUS_JSON, 'utf8'))
const built = buildComponentTree(source, 'SubscriptionsSection', { status }, DEFAULT_TRANSPILE_BUDGET, ['zh'])
let nulls = 0
const walk = (n, path) => { if (!n) { nulls += 1; console.log('NULL at', path); return } for (let i = 0; i < (n.children ?? []).length; i += 1) walk(n.children[i], path + '/' + i) }
walk(built.tree, '')
console.log('nulls:', nulls)
