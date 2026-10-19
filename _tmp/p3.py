p = "src/providers/package-inventory.ts"
c = open(p, encoding="utf-8").read()
c = c.replace("""function displayText(meta: unknown): { title?: string; description?: string; icon?: string } {
  const title = firstString(meta, ['title'])
  const description = firstString(meta, ['description'])
  const icon = firstString(meta, ['icon'])""",
"""function displayText(
  meta: unknown,
  localeTags: readonly string[] = [],
): { title?: string; description?: string; icon?: string } {
  const title = localizedString(meta, ['title'], localeTags)
  const description = localizedString(meta, ['description'], localeTags)
  const icon = localizedString(meta, ['icon'], localeTags)""")
c = c.replace("""  readonly pluginInventory: () => PluginInventoryFace | undefined
}""",
"""  readonly pluginInventory: () => PluginInventoryFace | undefined
  /** Locale tags used to resolve locale-mapped titles and descriptions. */
  readonly localeTags?: readonly string[]
}""")
c = c.replace("function projectBundle(bundle: HostBundleInfo): InventoryBundle {",
              "function projectBundle(bundle: HostBundleInfo, localeTags: readonly string[]): InventoryBundle {")
c = c.replace("  const text = displayText(bundle.meta)", "  const text = displayText(bundle.meta, localeTags)")
c = c.replace("    ...displayText(row.meta),", "    ...displayText(row.meta, localeTags),")
# call sites of projectBundle inside bundles op: pass options.localeTags
c = c.replace("projectBundle(entry)", "projectBundle(entry, localeTags)")
# define localeTags inside the bundles op
c = c.replace("""      bundles: async (args, warnings): Promise<{ bundles: InventoryBundle[]; managementAvailable: boolean }> => {""",
"""      bundles: async (_args, warnings): Promise<{ bundles: InventoryBundle[]; managementAvailable: boolean }> => {
        const localeTags = options.localeTags ?? []""")
c = c.replace("   ...projectBundle(entry, localeTags),", "   ...projectBundle(entry, localeTags),")
if "import { localizedString" not in c:
    c = c.replace("import { projectJson", "import { localizedString, projectJson", 1)
open(p, "w", encoding="utf-8").write(c)
print("ok")
