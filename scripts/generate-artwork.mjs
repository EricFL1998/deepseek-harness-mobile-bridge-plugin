#!/usr/bin/env node
/**
 * Generate the official plugin artwork from the shipped source.
 *
 * The artwork lives in `ui-primitives`, which is a static library bundled into the
 * web shell: there is no `client.js` for the bridge to evaluate, so a native client
 * cannot obtain these drawings at runtime. Rather than keep a hand-copied table that
 * drifts from the real thing, this script turns the authoritative JSX into SVG once,
 * and the generated file is committed. Re-run it when upstream artwork changes.
 *
 * Usage:
 *   node scripts/generate-artwork.mjs <path to plugin-artwork.tsx> <output .ts>
 */

import { readFileSync, writeFileSync } from 'node:fs'

/**
 * The web-search drawing paints its ring with a CSS conic gradient inside a
 * `foreignObject`, which SVG cannot express and a native canvas cannot evaluate.
 * This static stand-in keeps the handle and draws the ring as a stroke at the same
 * centre and radius, so the icon reads correctly instead of losing its body.
 */
const SEARCH_FALLBACK = `<path d="M26.5362 26.9865L22.3813 22.8317" stroke="#658EFF" stroke-width="3" />
  <circle cx="15.7661" cy="16.2159" r="4.5" stroke="#658EFF" stroke-width="2.5" />`

/** JSX attribute names that differ from their SVG spelling. */
const ATTRIBUTE_NAMES = {
  strokeWidth: 'stroke-width',
  strokeLinecap: 'stroke-linecap',
  strokeLinejoin: 'stroke-linejoin',
  strokeDasharray: 'stroke-dasharray',
  fillOpacity: 'fill-opacity',
  strokeOpacity: 'stroke-opacity',
  stopColor: 'stop-color',
  stopOpacity: 'stop-opacity',
  clipPath: 'clip-path',
  clipRule: 'clip-rule',
  fillRule: 'fill-rule',
}

/**
 * Convert one JSX svg element body to SVG text.
 * @param jsx - the element body between `<svg …>` and `</svg>`.
 * @returns SVG-ready markup, with per-instance id prefixes normalised away.
 */
function toSvg(jsx) {
  let out = jsx
  // Per-instance ids exist only to keep `url(#…)` unique in a live DOM; a single
  // rendered icon needs none, so the prefix is dropped and the suffix kept.
  out = out.replaceAll('${uid}', '')
  // `foreignObject` carries an HTML div (the conic-gradient ring); SVG has no such
  // construct, so the browser-specific part is dropped and replaced with the closest
  // static equivalent: a stroked ring at the same centre and radius.
  const hadForeignObject = out.includes('<foreignObject')
  out = out.replace(/<foreignObject[\s\S]*?<\/foreignObject>/g, '')
  if (hadForeignObject) out = SEARCH_FALLBACK
  // Expressions for size/class belong to the React component, not the drawing.
  out = out.replace(/\s*width=\{size\}/g, ' width="36"')
  out = out.replace(/\s*height=\{size\}/g, ' height="36"')
  out = out.replace(/\s*className=\{className\}/g, '')
  // Remaining `{...}` expressions: template literals with the prefix gone are plain
  // strings; anything else is not a static value and is reported by the caller.
  out = out.replace(/\{`([^`$]*)`\}/g, '"$1"')
  for (const [from, to] of Object.entries(ATTRIBUTE_NAMES)) {
    out = out.replace(new RegExp(`\\b${from}=`, 'g'), `${to}=`)
  }
  // Numeric JSX values become attributes.
  out = out.replace(/=(\d+(?:\.\d+)?)(?=[\s/>])/g, '="$1"')
  return out.trim()
}

/**
 * Pull the exported artwork components out of the source file.
 * @param source - contents of plugin-artwork.tsx.
 * @returns component name to SVG markup.
 */
function extractArtwork(source) {
  const found = new Map()
  const component = /export const (\w+) = [\s\S]*?<svg([\s\S]*?)<\/svg>/g
  for (const match of source.matchAll(component)) {
    const [, name, header] = match
    const body = header.slice(header.indexOf('>') + 1)
    const openTag = header.slice(0, header.indexOf('>'))
    const viewBox = /viewBox="([^"]+)"/.exec(openTag)?.[1] ?? '0 0 36 36'
    const svg = toSvg(body)
    if (svg.includes('{')) {
      // An unevaluated expression would produce invalid SVG; failing here is better
      // than shipping a broken icon.
      throw new Error(`${name} still contains a JSX expression after conversion`)
    }
    found.set(name, `<svg viewBox="${viewBox}" fill="none" xmlns="http://www.w3.org/2000/svg">${svg}</svg>`)
  }
  return found
}

const [, , sourcePath, outputPath] = process.argv
if (sourcePath === undefined || outputPath === undefined) {
  console.error('usage: node scripts/generate-artwork.mjs <plugin-artwork.tsx> <output.ts>')
  process.exit(2)
}

const artwork = extractArtwork(readFileSync(sourcePath, 'utf8'))
if (artwork.size === 0) {
  console.error(`no exported artwork found in ${sourcePath}`)
  process.exit(1)
}

/** Which drawing belongs to which plugin row; ids are the Host's own slot ids. */
const ITEM_ARTWORK = {
  shell: 'PluginArtworkTerminal',
  'agent-loop': 'PluginArtworkLoop',
  subagent: 'PluginArtworkSubagent',
  'web-search': 'PluginArtworkSearch',
}

const entries = Object.entries(ITEM_ARTWORK).map(([id, component]) => {
  const svg = artwork.get(component)
  if (svg === undefined) throw new Error(`${component} is missing from ${sourcePath}`)
  return `  ${JSON.stringify(id)}: ${JSON.stringify(svg)},`
})

const file = `/**
 * Official plugin artwork, generated from \`ui-primitives\`'s \`plugin-artwork.tsx\`.
 *
 * Do not edit by hand: run \`node scripts/generate-artwork.mjs\` against the shipped
 * source instead. The drawing has to come from the real component because the web
 * shell bundles \`ui-primitives\` statically, so a native client cannot evaluate it.
 */

export const OFFICIAL_ARTWORK: Readonly<Record<string, string>> = {
${entries.join('\n')}
}
`

writeFileSync(outputPath, file, 'utf8')
console.log(`wrote ${Object.keys(ITEM_ARTWORK).length} artwork entries to ${outputPath}`)
