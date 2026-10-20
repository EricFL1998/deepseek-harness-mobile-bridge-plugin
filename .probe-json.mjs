import { readFileSync } from 'node:fs'
import { buildComponentTree, DEFAULT_TRANSPILE_BUDGET } from './src/slots/transpile.ts'
const source = readFileSync(process.env.SUB_OAUTH_CLIENT, 'utf8')
const status = JSON.parse(readFileSync(process.env.STATUS_JSON, 'utf8'))
const built = buildComponentTree(source, 'SubscriptionsSection', { status }, DEFAULT_TRANSPILE_BUDGET, ['zh'])
const json = JSON.stringify(built.tree)
console.log('len', json.length, 'has null in children:', /"children":\[[^\]]*null/.test(json))
console.log(json.slice(3300, 3500))
