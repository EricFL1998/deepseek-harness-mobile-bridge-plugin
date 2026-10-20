import { readFileSync } from 'node:fs'
import { buildComponentTree, DEFAULT_TRANSPILE_BUDGET } from './src/slots/transpile.ts'
const source = readFileSync(process.env.SUB_OAUTH_CLIENT, 'utf8')
const status = JSON.parse(readFileSync(process.env.STATUS_JSON, 'utf8'))
const built = buildComponentTree(source, 'SubscriptionsSection', { status }, DEFAULT_TRANSPILE_BUDGET, ['zh'])
const json = JSON.stringify(built.tree)
const i = json.indexOf('[null,null]')
console.log('has [null,null]:', i >= 0, 'len', json.length)
if (i >= 0) console.log(json.slice(Math.max(0, i - 200), i + 40))
