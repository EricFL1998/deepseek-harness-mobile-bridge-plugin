import json
p = "package.json"
d = json.load(open(p, encoding="utf-8"))
d["version"] = "1.3.0"
json.dump(d, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
open(p, "a", encoding="utf-8").write("\n")
print(d["version"])
