"""Checks downloaded source files against data/sources/manifest.csv.

Usage: python3 pipeline/check_sources.py [source-data]
Writes <folder>/inventory.csv (path, bytes, sha256) and prints found and missing files per source.
Standard library only.
"""
import csv, fnmatch, hashlib, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
folder = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "source-data").resolve()
if not folder.is_dir():
    sys.exit(f"No folder at {folder}. Download the sources listed in data/sources/manifest.csv into it first.")

files = [p for p in folder.rglob("*") if p.is_file() and p.name != "inventory.csv"]
with (folder / "inventory.csv").open("w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["path", "bytes", "sha256"])
    for p in sorted(files):
        h = hashlib.sha256()
        with p.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        w.writerow([p.relative_to(folder).as_posix(), p.stat().st_size, h.hexdigest()])

names = [p.name.lower() for p in files]
pattern = re.compile(r"[\w*.-]+\.(?:pdf|tif|tiff|docx|las|csv|jpg|zip|xlsx|shp)", re.I)
total_missing = 0
with (ROOT / "data" / "sources" / "manifest.csv").open(encoding="utf-8") as f:
    for row in csv.DictReader(f):
        wanted = sorted(set(m.lower() for m in pattern.findall(row["files_used"])))
        if not wanted:
            print(f"- {row['id']}: nothing to download ({row['files_used']})")
            continue
        missing = [w for w in wanted if not any(fnmatch.fnmatch(n, w) for n in names)]
        total_missing += len(missing)
        state = "all present" if not missing else f"missing {len(missing)} of {len(wanted)}: {', '.join(missing)}"
        print(f"- {row['id']}: {state}")
print(f"\n{len(files)} files listed in {folder / 'inventory.csv'}. Missing file names: {total_missing}.")
