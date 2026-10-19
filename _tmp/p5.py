p = "src/providers/package-inventory.ts"
c = open(p, encoding="utf-8").read()
import re
# add localizedString to the json.ts import list
m = re.search(r"import \{([^}]*)\} from '\.\./protocol/json\.ts'", c)
print("import:", m.group(1) if m else None)
if m and "localizedString" not in m.group(1):
    names = [n.strip() for n in m.group(1).split(",") if n.strip()]
    names.append("localizedString")
    c = c[:m.start()] + "import { " + ", ".join(sorted(set(names))) + " } from '../protocol/json.ts'" + c[m.end():]
    open(p, "w", encoding="utf-8").write(c)
    print("patched import")
