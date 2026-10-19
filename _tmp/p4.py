p = "src/index.ts"
c = open(p, encoding="utf-8").read()
c = c.replace("""  registry.add(createPackageInventoryProvider({
    pluginManager: () => ctx.get('pluginManager') as PluginManagerFace | undefined,
    pluginInventory: () => ctx.get('pluginInventory') as PluginInventoryFace | undefined,
  }))""",
"""  registry.add(createPackageInventoryProvider({
    pluginManager: () => ctx.get('pluginManager') as PluginManagerFace | undefined,
    pluginInventory: () => ctx.get('pluginInventory') as PluginInventoryFace | undefined,
    localeTags: config.localeTags,
  }))""")
open(p, "w", encoding="utf-8").write(c)
print("ok")
