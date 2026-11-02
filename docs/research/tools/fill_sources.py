"""Replace <!-- SOURCES:PREFIX[,PREFIX] --> markers in docs/research/*.md with a table built from sources.csv.

Usage: python3 docs/research/tools/fill_sources.py
Re-run after editing sources.csv; content between the marker and <!-- /SOURCES --> is regenerated.
"""
import csv, pathlib, re

ROOT = pathlib.Path(__file__).resolve().parents[1]
rows = list(csv.DictReader(open(ROOT / "sources.csv", newline="")))
pattern = re.compile(r"<!-- SOURCES:([A-Z,]+) -->.*?(?:<!-- /SOURCES -->\n*|\Z)", re.S)


def table(prefixes):
    picked = [r for r in rows if r["ID"].split("-")[0] in prefixes]
    out = ["## Sources", "", "| ID | Source | Org | Date | Priority |", "|----|--------|-----|------|----------|"]
    for r in picked:
        title = r["Title"].replace("|", "/")
        out.append(f"| {r['ID']} | [{title}]({r['URL']}) | {r['Org / Authors']} | {r['Date']} | {r['Priority']} |")
    return "\n".join(out)


for md in sorted(ROOT.glob("*.md")):
    text = md.read_text()
    new = pattern.sub(lambda m: f"<!-- SOURCES:{m.group(1)} -->\n{table(m.group(1).split(','))}\n<!-- /SOURCES -->\n", text)
    if new != text:
        md.write_text(new)
        print("updated", md.name)
