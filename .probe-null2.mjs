import { readFileSync } from 'node:fs'
import { buildComponentTree, DEFAULT_TRANSPILE_BUDGET } from './src/slots/transpile.ts'
const source = readFileSync(process.env.SUB_OAUTH_CLIENT, 'utf8')
const status = JSON.parse(readFileSync(process.env.STATUS_JSON, 'utf8'))
const built = buildComponentTree(source, 'SubscriptionsSection', { status }, DEFAULT_TRANSPILE_BUDGET, ['zh'])
const find = (n, path) => {
  if (n === null || n === undefined) { console.log('NULL', path); return }
  const kids = n.children
  if (!Array.isArray(kids)) return
  kids.forEach((k, i) => find(k, path + '[' + i + ']'))
}
find(built.tree, 'root')
