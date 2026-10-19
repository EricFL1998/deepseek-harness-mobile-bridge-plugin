p = "src/protocol/json.ts"
c = open(p, encoding="utf-8").read()
addition = '''
/**
 * Read the first localized field of a record.
 *
 * The Host writes display text either as a plain string or as a locale map such as
 * `{ zh: "...", en: "..." }`. A native client shows one of those, so the map is
 * resolved to the first requested tag rather than dropped.
 * @param value - candidate record.
 * @param fields - field names in preference order.
 * @param tags - locale tags in preference order.
 * @returns the resolved text, or undefined.
 */
export function localizedString(
  value: unknown,
  fields: readonly string[],
  tags: readonly string[],
): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  for (const field of fields) {
    const entry = record[field]
    if (typeof entry === 'string' && entry !== '') return entry
    if (typeof entry === 'object' && entry !== null) {
      const map = entry as Record<string, unknown>
      for (const tag of tags) {
        const text = map[tag]
        if (typeof text === 'string' && text !== '') return text
      }
      for (const text of Object.values(map)) {
        if (typeof text === 'string' && text !== '') return text
      }
    }
  }
  return undefined
}
'''
open(p, "w", encoding="utf-8").write(c + addition)
print("ok")
