"""Loads the data for the map's Planetary Computer overlays into the GeoBasin GeoCatalog (infra/bicep/geo.bicep).

    python3 infra/scripts/planetary_load.py            # collections, items, render options and mosaics, then a test tile of each
    python3 infra/scripts/planetary_load.py --select   # choose the items again from the open catalog first (needs shapely, Pillow)
    python3 infra/scripts/planetary_load.py --check    # only register the mosaics again (same IDs) and fetch the test tiles

What it does:
  1. Reads the catalog's address from the gbx-geo deployment.
  2. Creates the collections gbx-cop-dem-glo-30 and gbx-sentinel-2-l2a from the open Planetary Computer's own collection
     records, without collection-level assets and with the Cooper Basin extent (Microsoft Learn: create-stac-collection).
  3. Removes items the list no longer has, then copies the items listed in infra/scripts/planetary-items.json from the open
     Planetary Computer, keeping one asset each, the
     DEM's elevation and Sentinel-2's true-colour image, signed with a fresh short-lived token from the open catalog
     (Learn: add-stac-item-to-collection). Copies go in waves of eight, each with a new token, so no token expires while
     a copy waits. Every copy is an operation, polled until it ends; items already in the catalog are skipped.
  4. Adds render options, one per request, so the catalog's own Explorer can draw the collections (Learn:
     render-configuration). The app's relay sends its own options with each tile (services/api/src/planetary.ts).
  5. Registers one mosaic per collection and prints the PC_SEARCHES value, which infra/scripts/deploy.sh geo
     records as GBX_PC_SEARCHES for the site. A registration
     is identified by its search, so registering the same collection again returns the same ID.
  6. Fetches one tile of each collection over Innamincka and reports its size and time.
With --select it first rebuilds infra/scripts/planetary-items.json: every Copernicus DEM tile over the basin's extent, and for
each Sentinel-2 grid square there, between May and September 2025 with under 1% cloud, the scene with the fewest missing
pixels, the least cloud and the latest date, then more scenes until their footprints cover the square inside the extent,
leaving out any scene whose true-colour image lacks red or blue (one 2025 scene does, in the open catalog too).
Requires an Azure CLI sign-in as a GeoCatalog Administrator (the subscription Owner is one).
"""
import argparse, collections, json, os, pathlib, subprocess, sys, time, urllib.error, urllib.request
from datetime import datetime

ROOT = pathlib.Path(__file__).resolve().parents[2]
ITEMS = pathlib.Path(__file__).resolve().parent / "planetary-items.json"
SUB = os.environ["GBX_SUBSCRIPTION_ID"]  # exported by infra/scripts/lib.sh
API = "2026-04-15"
OPEN = "https://planetarycomputer.microsoft.com/api"
BBOX = [139.37, -29.419, 143.965, -24.523]  # the Cooper Basin outline's extent (app/src/data/basins-pack.json)
SOURCES = {  # collection here: (open collection, the one asset kept)
    "gbx-cop-dem-glo-30": ("cop-dem-glo-30", "data"),
    "gbx-sentinel-2-l2a": ("sentinel-2-l2a", "visual"),
}
LIMITS = "items_limit=100&time_limit=10"  # the catalog's default per-tile item limit leaves holes in these mosaics
HILLSHADE = "algorithm=hillshade&buffer=3&algorithm_params=%7B%22azimuth%22%3A%20315%2C%20%22angle_altitude%22%3A%2045%7D"
RENDER = {
    "gbx-cop-dem-glo-30": [
        {"id": "elevation", "name": "Elevation", "type": "raster-tile", "options": f"assets=data&colormap_name=schwarzwald&rescale=0,300&{LIMITS}", "minZoom": 6},
        {"id": "hillshade", "name": "Hillshade", "type": "raster-tile", "options": f"assets=data&colormap_name=gray&{HILLSHADE}&{LIMITS}", "minZoom": 6},
    ],
    "gbx-sentinel-2-l2a": [
        {"id": "natural-color", "name": "Natural colour", "type": "raster-tile", "options": f"assets=visual&asset_bidx=visual|1,2,3&nodata=0&pixel_selection=highest&{LIMITS}", "minZoom": 7},
    ],
}
TEST_TILE = (8, 228, 148)  # z/x/y over Innamincka (140.75 E, 27.8 S)
TEST_OPTIONS = {"gbx-cop-dem-glo-30": RENDER["gbx-cop-dem-glo-30"][1]["options"], "gbx-sentinel-2-l2a": RENDER["gbx-sentinel-2-l2a"][0]["options"]}

_token: tuple[str, float] = ("", 0.0)
def token() -> str:
    global _token
    if _token[1] < time.time() + 300:
        r = json.loads(subprocess.check_output(["az", "account", "get-access-token", "--scope", "https://geocatalog.spatio.azure.com/.default", "-o", "json"]))
        _token = (r["accessToken"], time.time() + 40 * 60)
    return _token[0]

def call(method: str, url: str, body=None, auth=True, timeout=120):
    """Returns (status, headers, parsed JSON or raw bytes); never raises for an HTTP status."""
    h = {"Accept": "application/json", **({"Content-Type": "application/json"} if body is not None else {}), **({"Authorization": f"Bearer {token()}"} if auth else {})}
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            status, headers, raw = r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()
    except urllib.error.HTTPError as e:
        status, headers, raw = e.code, {k.lower(): v for k, v in e.headers.items()}, e.read()
    if raw and "json" in headers.get("content-type", ""):
        try: return status, headers, json.loads(raw)
        except ValueError: pass
    return status, headers, raw

def open_get(path: str):
    s, _, b = call("GET", f"{OPEN}{path}", auth=False)
    if s != 200: sys.exit(f"Open Planetary Computer answered {s} for {path}")
    return b

def open_search(body: dict) -> list[dict]:
    out, url = [], f"{OPEN}/stac/v1/search"
    while url:
        s, _, page = call("POST", url, body, auth=False)
        if s != 200: sys.exit(f"Open Planetary Computer search answered {s}: {str(page)[:300]}")
        out += page["features"]
        nxt = next((l for l in page.get("links", []) if l.get("rel") == "next"), None)
        url, body = (nxt["href"], nxt.get("body", body)) if nxt else (None, None)
    return out

def looks_right(item_id: str) -> bool:
    """A true-colour scene must carry red and blue. One 2025 scene (S2C, 5 May, square 54JWS) has almost none, in the
    open catalog too, and would draw as a bright green block."""
    import io
    from PIL import Image, ImageStat
    s, _, b = call("GET", f"{OPEN}/data/v1/item/preview.png?collection=sentinel-2-l2a&item={item_id}&assets=visual&asset_bidx=visual|1,2,3&nodata=0&max_size=128", auth=False)
    if s != 200: return False
    im = Image.open(io.BytesIO(b)).convert("RGBA")
    r, g, bl = ImageStat.Stat(im.convert("RGB"), mask=im.getchannel("A")).mean
    return min(r, bl) >= 30 and g <= 1.3 * r

def select() -> None:
    from shapely.geometry import box, shape
    from shapely.ops import unary_union
    aoi = box(*BBOX)
    checked: dict[str, bool] = {}
    ok = lambda f: checked.setdefault(f["id"], looks_right(f["id"]))
    dem = open_search({"collections": ["cop-dem-glo-30"], "bbox": BBOX, "limit": 100})
    s2 = open_search({"collections": ["sentinel-2-l2a"], "bbox": BBOX, "datetime": "2025-05-01T00:00:00Z/2025-09-30T23:59:59Z", "query": {"eo:cloud_cover": {"lt": 1}}, "limit": 1000})
    by = collections.defaultdict(list)
    for f in s2: by[f["properties"]["s2:mgrs_tile"]].append(f)
    picked = []
    for tile, fs in sorted(by.items()):
        geo = {f["id"]: shape(f["geometry"]) for f in fs}
        full = unary_union(list(geo.values())).intersection(aoi)
        if full.area == 0: continue
        fs.sort(key=lambda f: (f["properties"].get("s2:nodata_pixel_percentage", 100), f["properties"]["eo:cloud_cover"], -datetime.fromisoformat(f["properties"]["datetime"].replace("Z", "+00:00")).timestamp(), f["id"]))
        first = next((f for f in fs if ok(f)), None)
        if first is None: continue
        chosen, cov = [first], geo[first["id"]].intersection(full)
        while cov.area / full.area < 0.999 and len(chosen) < 4:
            gain = lambda f: geo[f["id"]].intersection(full).difference(cov).area
            ranked = sorted((f for f in fs if f not in chosen), key=lambda f: (gain(f), -f["properties"]["eo:cloud_cover"]), reverse=True)
            best = next((f for f in ranked if gain(f) / full.area >= 0.0005 and ok(f)), None)
            if best is None: break
            chosen.append(best); cov = cov.union(geo[best["id"]].intersection(full))
        picked += chosen
    ITEMS.write_text(json.dumps({
        "selected": time.strftime("%Y-%m-%d"), "bbox": BBOX,
        "rule": "Every Copernicus DEM GLO-30 tile over the bbox. For each Sentinel-2 grid square over it, 1 May to 30 Sep 2025, cloud under 1%: the scene with the fewest missing pixels, then the least cloud, then the latest, then more scenes until their footprints cover 99.9% of the square inside the bbox. Scenes whose true-colour image lacks red or blue are left out.",
        "collections": {
            "gbx-cop-dem-glo-30": sorted(f["id"] for f in dem),
            "gbx-sentinel-2-l2a": sorted(f["id"] for f in picked),
        },
    }, indent=1) + "\n")
    print(f"Selected {len(dem)} DEM tiles and {len(picked)} Sentinel-2 scenes for {len(by)} grid squares; left out {sum(not v for v in checked.values())} faulty scene(s); wrote {ITEMS.relative_to(ROOT)}")

def catalog_uri() -> str:
    out = subprocess.check_output(["az", "deployment", "sub", "show", "--subscription", SUB, "-n", "gbx-geo", "--query", "properties.outputs.catalogUri.value", "-o", "tsv"], text=True).strip()
    if not out.startswith("https://"): sys.exit("No catalog address in the gbx-geo deployment; deploy infra/bicep/geo.bicep first.")
    return out.rstrip("/")

def wait(cat: str, location: str, what: str, limit_s=3600) -> bool:
    start = time.time()
    while time.time() - start < limit_s:
        s, _, op = call("GET", location)
        st = op.get("status") if isinstance(op, dict) else None
        if s == 200 and st not in ("Pending", "Running"):
            if st == "Succeeded": return True
            print(f"  {what}: {st} {json.dumps(op.get('error') or op)[:400]}")
            return False
        time.sleep(10)
    print(f"  {what}: still running after {limit_s} s")
    return False

def ensure_collection(cat: str, cid: str, items: list[dict]) -> None:
    s, _, _ = call("GET", f"{cat}/stac/collections/{cid}?api-version={API}")
    if s == 200:
        print(f"Collection {cid} exists"); return
    src, asset = SOURCES[cid]
    c = open_get(f"/stac/v1/collections/{src}")
    c.pop("assets", None)
    for k in [k for k in c if k.startswith("msft:")]: c.pop(k)
    c["id"] = cid
    c["title"] = f"{c.get('title', src)}, Cooper Basin"
    c["description"] = f"The part over the Cooper Basin of the open Microsoft Planetary Computer collection {src}, copied for the GeoBasin Explorer AI map overlays.\n\n{c.get('description', '')}"
    xs = [i["bbox"] for i in items]
    times = sorted(i["properties"]["datetime"] for i in items)
    c["extent"] = {"spatial": {"bbox": [[min(b[0] for b in xs), min(b[1] for b in xs), max(b[2] for b in xs), max(b[3] for b in xs)]]}, "temporal": {"interval": [[times[0], times[-1]]]}}
    if asset in c.get("item_assets", {}): c["item_assets"] = {asset: c["item_assets"][asset]}
    c["links"] = [l for l in c.get("links", []) if l.get("rel") in ("license", "describedby", "cite-as", "about")]
    s, h, b = call("POST", f"{cat}/stac/collections?api-version={API}", c)
    if s == 202 and h.get("location"):
        if not wait(cat, h["location"], f"collection {cid}"): sys.exit(f"Collection {cid} wasn't created")
    elif s not in (200, 201, 409):
        sys.exit(f"Creating {cid} answered {s}: {str(b)[:400]}")
    print(f"Collection {cid} created")

def existing_ids(cat: str, cid: str) -> set[str]:
    ids, url = set(), f"{cat}/stac/collections/{cid}/items?api-version={API}&limit=500"
    while url:
        s, _, page = call("GET", url)
        if s != 200: return ids
        ids |= {f["id"] for f in page.get("features", [])}
        url = next((l["href"] for l in page.get("links", []) if l.get("rel") == "next"), None)
    return ids

def copy_items(cat: str, cid: str, items: list[dict]) -> None:
    src, asset = SOURCES[cid]
    have = existing_ids(cat, cid)
    for gone in sorted(have - {i["id"] for i in items}):
        s, h, b = call("DELETE", f"{cat}/stac/collections/{cid}/items/{gone}?api-version={API}")
        ok = (s == 202 and h.get("location") and wait(cat, h["location"], f"removing {gone}")) or s in (200, 204)
        print(f"  removed {gone}, no longer listed" if ok else f"  couldn't remove {gone}: {s} {str(b)[:200]}")
    todo = [i for i in items if i["id"] not in have]
    print(f"{cid}: {len(items)} listed, {len(have)} already in the catalog, {len(todo)} to copy")
    failed = []
    for n in range(0, len(todo), 8):
        sas = open_get(f"/sas/v1/token/{src}")["token"]
        ops = []
        for it in todo[n:n + 8]:
            a = dict(it["assets"][asset]); a["href"] = f"{a['href']}?{sas}"
            # STAC requires a collection link when an item names its collection; it points at this catalog's copy.
            body = {**it, "assets": {asset: a}, "collection": cid, "links": [{"rel": "collection", "href": f"{cat}/stac/collections/{cid}", "type": "application/json"}]}
            s, h, b = call("POST", f"{cat}/stac/collections/{cid}/items?api-version={API}", body)
            if s == 202 and h.get("location"): ops.append((it["id"], h["location"]))
            else: failed.append(it["id"]); print(f"  {it['id']}: {s} {str(b)[:300]}")
        for iid, loc in ops:
            if not wait(cat, loc, iid): failed.append(iid)
        print(f"  {min(n + 8, len(todo))} of {len(todo)} copied for {cid}, {len(failed)} failed so far")
    if failed: sys.exit(f"{len(failed)} items failed in {cid}; run again to retry them")

def render_options(cat: str) -> None:
    for cid, opts in RENDER.items():
        for o in opts:
            s, _, b = call("POST", f"{cat}/stac/collections/{cid}/configurations/render-options?api-version={API}", o)
            if s == 409:
                s, _, b = call("PUT", f"{cat}/stac/collections/{cid}/configurations/render-options/{o['id']}?api-version={API}", o)
            print(f"Render option {cid}/{o['id']}: {s}{'' if s in (200, 201) else ' ' + str(b)[:200]}")

def mosaics(cat: str) -> dict[str, str]:
    out = {}
    for cid in SOURCES:
        s, _, b = call("POST", f"{cat}/data/mosaic/register?api-version={API}", {"collections": [cid]})
        if s != 200 or not isinstance(b, dict) or not b.get("searchid"): sys.exit(f"Registering the {cid} mosaic answered {s}: {str(b)[:300]}")
        out[cid] = b["searchid"]
    print("PC_SEARCHES value for the site (GBX_PC_SEARCHES): " + ",".join(f"{k}={v}" for k, v in out.items()))
    return out

def test_tiles(cat: str, searches: dict[str, str]) -> None:
    z, x, y = TEST_TILE
    for cid, sid in searches.items():
        t = time.time()
        s, h, b = call("GET", f"{cat}/data/mosaic/searches/{sid}/tiles/WebMercatorQuad/{z}/{x}/{y}@2x.jpeg?api-version={API}&{TEST_OPTIONS[cid]}", timeout=60)
        kind = h.get("content-type", "?")
        print(f"Test tile {cid} {z}/{x}/{y}@2x.jpeg: {s} {kind} {len(b) if isinstance(b, bytes) else '-'} bytes in {time.time() - t:.1f} s")

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--select", action="store_true", help="choose the items again from the open catalog first")
    ap.add_argument("--check", action="store_true", help="only register the mosaics and fetch the test tiles")
    args = ap.parse_args()
    if args.select: select()
    cat = catalog_uri()
    print(f"Catalog {cat}")
    if not args.check:
        listed = json.loads(ITEMS.read_text())["collections"]
        for cid, ids in listed.items():
            src, _ = SOURCES[cid]
            items = open_search({"collections": [src], "ids": ids, "limit": 1000})
            missing = set(ids) - {i["id"] for i in items}
            if missing: sys.exit(f"The open catalog no longer has {len(missing)} listed {src} items, for example {sorted(missing)[0]}")
            ensure_collection(cat, cid, items)
            copy_items(cat, cid, items)
        render_options(cat)
    test_tiles(cat, mosaics(cat))

if __name__ == "__main__":
    main()
