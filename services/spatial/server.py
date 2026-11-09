"""GeoBasin Explorer AI spatial service (deterministic GDAL/PROJ service behind Azure Maps).

Authoritative coordinate transforms and spatial checks for the cloud build, computed with GDAL/OGR/OSR (PROJ):
  POST /section    cross-section along a line: geodesic length, boreholes and named features in a corridor,
                   faults crossed, basins traversed and the GA depth-to-base profile
  POST /here       "What we know here": basin, depth, nearest boreholes, stress record, seismic line, features,
                   scanned-report wells, and the point in GDA2020 and MGA
  POST /transform  points between GDA94, GDA2020, WGS 84, Web Mercator and MGA zones 49 to 56
  GET  /health

It holds the same Geoscience Australia data as the app (basins-pack.json and app-pack.json, decoded the same way),
so results can be compared with the in-browser computations. Distances are geodesic on the GRS80 ellipsoid: points
are projected onto an azimuthal equidistant plane centred on the query point or the section's midpoint, where
distances from the centre are exact and geodesics through it are straight lines.

The service is reachable only inside the Container Apps environment (internal ingress); the web API validates every
request before forwarding it here.
"""
import base64
import json
import math
import os
import sys
import threading
import time
from array import array
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from osgeo import gdal, ogr, osr

gdal.UseExceptions()
ogr.UseExceptions()
osr.UseExceptions()

DATA = os.environ.get("GBX_DATA_DIR", "/app/data")
PORT = int(os.environ.get("PORT", "8080"))
NODATA = -32768
MAX_BODY = 256 * 1024
VERSIONS = {"gdal": gdal.__version__, "proj": f"{osr.GetPROJVersionMajor()}.{osr.GetPROJVersionMinor()}.{osr.GetPROJVersionMicro()}"}
METHOD = (f"GDAL {VERSIONS['gdal']} and PROJ {VERSIONS['proj']}: geodesic distances on the GRS80 ellipsoid (GDA94), "
          "measured on an azimuthal equidistant plane centred on the query; depth is a bilinear sample of the GA "
          "depth-to-base grid; basin membership uses the GA outlines (even-odd rule).")


def log(msg, **kw):
    print(json.dumps({"t": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "m": msg, **kw}), flush=True)


# ---------- reference systems (OSR objects aren't thread-safe, so each thread keeps its own) ----------
_local = threading.local()


def srs_epsg(code):
    cache = getattr(_local, "epsg", None)
    if cache is None:
        cache = _local.epsg = {}
    if code not in cache:
        s = osr.SpatialReference()
        s.ImportFromEPSG(code)
        s.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        cache[code] = s
    return cache[code]


def aeqd(lon, lat):
    s = osr.SpatialReference()
    s.ImportFromProj4(f"+proj=aeqd +lat_0={lat!r} +lon_0={lon!r} +ellps=GRS80 +units=m +no_defs")
    s.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    return s


def to_plane(lon, lat):
    """Transforms from GDA94 to the azimuthal equidistant plane centred on (lon, lat), and back."""
    plane = aeqd(lon, lat)
    return osr.CoordinateTransformation(srs_epsg(4283), plane), osr.CoordinateTransformation(plane, srs_epsg(4283))


def xy(ct, pts):
    return [(p[0], p[1]) for p in ct.TransformPoints([(float(lon), float(lat)) for lon, lat in pts])] if pts else []


# ---------- data, decoded exactly as the app decodes it (app/src/lib/basins.ts) ----------
if sys.byteorder != "little":
    raise SystemExit("The packed grids are little-endian; this service expects a little-endian host.")


def load():
    t0 = time.perf_counter()
    with open(os.path.join(DATA, "basins-pack.json"), encoding="utf-8") as f:
        bp = json.load(f)
    with open(os.path.join(DATA, "app-pack.json"), encoding="utf-8") as f:
        ap = json.load(f)
    basins = []
    for r in bp["basins"]:
        db = base64.b64decode(r["depth"]["b64"])
        grid = array("h")
        grid.frombytes(db[: len(db) // 2 * 2])
        hb = base64.b64decode(r["bh"]["b64"])
        u = array("H")
        u.frombytes(hb[: len(hb) // 2 * 2])
        bx0, by0, bx1, by1 = r["bh"]["bb"]
        sx, sy = (bx1 - bx0) / 65535, (by1 - by0) / 65535
        named = {n[0]: n for n in r["bh"]["names"]}
        holes = []
        for i in range(r["bh"]["n"]):
            f = u[i * 4 + 3]
            yr = f >> 8
            nm = named.get(i)
            holes.append({"key": f"{r['id']}:{i}", "lon": bx0 + u[i * 4] * sx, "lat": by0 + u[i * 4 + 1] * sy,
                          "td": u[i * 4 + 2] if u[i * 4 + 2] > 0 else None, "year": 1850 + yr if yr > 0 else None,
                          "inside": bool(f & 64), "major": bool(f & 128), "name": nm[1] if nm else None})
        rings = []
        for ring in r["outline"]:
            lr = ogr.Geometry(ogr.wkbLinearRing)
            for lon, lat in ring:
                lr.AddPoint_2D(lon, lat)
            lr.CloseRings()
            poly = ogr.Geometry(ogr.wkbPolygon)
            poly.AddGeometry(lr)
            rings.append(poly)
        d = r["depth"]
        basins.append({"id": r["id"], "name": r["name"], "bbox": r["bbox"], "rings": rings, "boreholes": holes,
                       "faults": r["faults"], "features": r["features"], "stress": r["stress"],
                       "depth": {"w": d["w"], "h": d["h"], "x0": d["x0"], "y0": d["y0"], "dx": d["dx"], "dy": d["dy"], "grid": grid}})
    seismic = [ln for lines in ap.get("seismic2d", {}).values() for ln in lines]
    wells = [{"id": w["siteId"], "name": w["name"], "lon": w["lon"], "lat": w["lat"]} for w in ap.get("wells", [])]
    log("data loaded", basins=len(basins), boreholes=sum(len(b["boreholes"]) for b in basins), seismicLines=len(seismic), ms=round((time.perf_counter() - t0) * 1000))
    return basins, seismic, wells


BASINS, SEISMIC, WELLS = load()


_rings_lock = threading.Lock()  # the outline geometries are shared, and OGR objects aren't guaranteed thread-safe


def basin_at(lon, lat):
    """GA outline membership with the even-odd rule over all rings (the app's inRings)."""
    pt = ogr.Geometry(ogr.wkbPoint)
    pt.AddPoint_2D(lon, lat)
    for b in BASINS:
        x0, y0, x1, y1 = b["bbox"]
        if lon < x0 or lon > x1 or lat < y0 or lat > y1:
            continue
        with _rings_lock:
            inside = sum(1 for ring in b["rings"] if ring.Contains(pt)) % 2 == 1
        if inside:
            return b
    return None


def depth_at(b, lon, lat):
    """Bilinear sample of the GA depth-to-base grid (the same rule as the app's depthAt); None outside the data."""
    g = b["depth"]
    fx = (lon - g["x0"]) / g["dx"] - 0.5
    fy = (lat - g["y0"]) / g["dy"] - 0.5
    c0, r0 = math.floor(fx), math.floor(fy)
    s = ws = 0.0
    for k in range(4):
        c, r = c0 + (k & 1), r0 + (k >> 1)
        if c < 0 or r < 0 or c >= g["w"] or r >= g["h"]:
            continue
        v = g["grid"][r * g["w"] + c]
        if v == NODATA:
            continue
        w = (1 - abs(fx - c)) * (1 - abs(fy - r))
        s += w * v
        ws += w
    return s / ws if ws > 0.25 else None


# ---------- cross-section ----------
def reference_corridor(a, b, width_km=10.0):
    """The prototype's flat approximation (app/src/lib/section.ts, computeSection), reproduced exactly so the
    locked fixture (1.3.1 and UC5: 260 km west-east Cooper section, 464 boreholes within 10 km) can be rerun here:
    spherical length (R = 6371 km), a straight line in longitude and latitude, and offsets on one flat scale."""
    p = math.pi / 180
    h = math.sin((b[1] - a[1]) * p / 2) ** 2 + math.cos(a[1] * p) * math.cos(b[1] * p) * math.sin((b[0] - a[0]) * p / 2) ** 2
    length = 2 * 6371 * math.asin(math.sqrt(h))
    kx = 111.32 * math.cos((a[1] + b[1]) / 2 * p)
    ux, uy = (b[0] - a[0]) * kx, (b[1] - a[1]) * 110.57
    ul = math.hypot(ux, uy) or 1
    bb = (min(a[0], b[0]) - 0.2, min(a[1], b[1]) - 0.2, max(a[0], b[0]) + 0.2, max(a[1], b[1]) + 0.2)
    n = 0
    for bs in BASINS:
        for w in bs["boreholes"]:
            if not (bb[0] <= w["lon"] <= bb[2] and bb[1] <= w["lat"] <= bb[3]):
                continue
            x, y = (w["lon"] - a[0]) * kx, (w["lat"] - a[1]) * 110.57
            along, off = (x * ux + y * uy) / ul, abs(x * uy - y * ux) / ul
            if off <= width_km and 0 <= along <= length:
                n += 1
    return {"lengthKm": length, "boreholes": n, "method": "Prototype reference: spherical length, straight line in longitude and latitude, flat offsets"}


def section(a, b, width_km=10.0, feature_km=15.0, n=260):
    t0 = time.perf_counter()
    # The geodesic from A to B is straight on a plane centred at A, and distances from A are exact there: B's
    # distance is the geodesic length, and halfway along that line is the geodesic midpoint.
    ct_a, back_a = to_plane(a[0], a[1])
    (xb, yb), = xy(ct_a, [b])
    mid = back_a.TransformPoint(xb / 2, yb / 2)[:2]
    ct, back = to_plane(mid[0], mid[1])
    (ax, ay), (bx, by) = xy(ct, [a, b])
    length = math.hypot(xb, yb)
    ux, uy = (bx - ax) / (math.hypot(bx - ax, by - ay) or 1), (by - ay) / (math.hypot(bx - ax, by - ay) or 1)

    def place(px, py):
        dx, dy = px - ax, py - ay
        return dx * ux + dy * uy, abs(dx * uy - dy * ux)

    bb = (min(a[0], b[0]) - 0.3, min(a[1], b[1]) - 0.3, max(a[0], b[0]) + 0.3, max(a[1], b[1]) + 0.3)
    inbox = lambda lon, lat: bb[0] <= lon <= bb[2] and bb[1] <= lat <= bb[3]

    cand = [w for bs in BASINS for w in bs["boreholes"] if inbox(w["lon"], w["lat"])]
    boreholes = []
    for w, (px, py) in zip(cand, xy(ct, [(w["lon"], w["lat"]) for w in cand])):
        along, off = place(px, py)
        if 0 <= along <= length and off <= width_km * 1000:
            boreholes.append({"name": w["name"] or "Unnamed", "d": along / 1000, "off": off / 1000, "td": w["td"], "year": w["year"], "key": w["key"]})
    boreholes.sort(key=lambda x: x["d"])

    # The profile follows the geodesic: equal steps on the plane, transformed back to GDA94.
    pts = []
    for i in range(n + 1):
        t = i / n
        lon, lat = back.TransformPoint(ax + (bx - ax) * t, ay + (by - ay) * t)[:2]
        bs = basin_at(lon, lat)
        pts.append({"d": length * t / 1000, "lon": lon, "lat": lat, "depth": depth_at(bs, lon, lat) if bs else None, "basin": bs["id"] if bs else None})
    valid = [p["depth"] for p in pts if p["depth"] is not None]

    line = ogr.Geometry(ogr.wkbLineString)
    line.AddPoint_2D(ax, ay)
    line.AddPoint_2D(bx, by)
    faults = []
    for bs in BASINS:
        for f in bs["faults"]:
            # Kept when any segment's extent overlaps the corridor's (a long segment can cross with no vertex inside).
            if not any(max(p[0], q[0]) >= bb[0] and min(p[0], q[0]) <= bb[2] and max(p[1], q[1]) >= bb[1] and min(p[1], q[1]) <= bb[3] for p, q in zip(f, f[1:])):
                continue
            fl = ogr.Geometry(ogr.wkbLineString)
            for px, py in xy(ct, f):
                fl.AddPoint_2D(px, py)
            hit = line.Intersection(fl)
            if hit is None or hit.IsEmpty():
                continue
            parts = [hit] if hit.GetGeometryType() in (ogr.wkbPoint, ogr.wkbPoint25D) else [hit.GetGeometryRef(i) for i in range(hit.GetGeometryCount())]
            for g in parts:
                if g.GetGeometryType() in (ogr.wkbPoint, ogr.wkbPoint25D):
                    faults.append({"d": place(g.GetX(), g.GetY())[0] / 1000})
    faults.sort(key=lambda x: x["d"])

    basins = []
    step = length / 1000 / n
    for p in pts:
        last = basins[-1] if basins else None
        if p["basin"] and last and last["id"] == p["basin"] and p["d"] - last["d1"] < step * 1.5:
            last["d1"] = p["d"]
        elif p["basin"]:
            basins.append({"id": p["basin"], "name": next(x["name"] for x in BASINS if x["id"] == p["basin"]), "d0": p["d"], "d1": p["d"]})

    feats = [f for bs in BASINS for f in bs["features"]]
    features = []
    for f, (px, py) in zip(feats, xy(ct, [(f["lon"], f["lat"]) for f in feats])):
        along, off = place(px, py)
        if off <= feature_km * 1000 and 0 <= along <= length:
            features.append({"name": f["n"], "d": along / 1000, "off": off / 1000})
    features.sort(key=lambda x: x["d"])
    return {"a": list(a), "b": list(b), "lengthKm": length / 1000, "pts": pts, "maxDepth": max(valid) if valid else None,
            "boreholes": boreholes, "faults": faults, "basins": basins, "features": features, "widthKm": width_km,
            "reference": reference_corridor(a, b, width_km),
            "ms": round((time.perf_counter() - t0) * 1000), "engine": "gdal", "method": METHOD, "versions": VERSIONS}


# ---------- what we know here ----------
def mga(lon, lat, lon20, lat20):
    """Map Grid of Australia coordinates for the point: GDA94 / MGA from the GDA94 position, GDA2020 / MGA from the GDA2020 one."""
    zone = int((lon + 180) // 6) + 1
    out = {"zone": zone}
    for name, src, dst, p in (("gda94", 4283, 28300 + zone, (lon, lat)), ("gda2020", 7844, 7800 + zone, (lon20, lat20))):
        e, nn = osr.CoordinateTransformation(srs_epsg(src), srs_epsg(dst)).TransformPoint(p[0], p[1])[:2]
        out[name] = {"epsg": dst, "easting": round(e, 2), "northing": round(nn, 2)}
    return out


def here(lon, lat):
    t0 = time.perf_counter()
    ct, _ = to_plane(lon, lat)
    dist = lambda pts: [math.hypot(x, y) / 1000 for x, y in xy(ct, pts)]

    cand = [w for bs in BASINS for w in bs["boreholes"] if abs(w["lat"] - lat) <= 1 and abs(w["lon"] - lon) <= 1.2]
    near = sorted(({"name": w["name"] or "Unnamed borehole", "km": d, "td": w["td"], "year": w["year"], "key": w["key"], "lon": w["lon"], "lat": w["lat"]}
                   for w, d in zip(cand, dist([(w["lon"], w["lat"]) for w in cand]))), key=lambda x: x["km"])

    recs = [s for bs in BASINS for s in bs["stress"]]
    stress = None
    for s, d in zip(recs, dist([(s[0], s[1]) for s in recs])):
        if d < 150 and (stress is None or d < stress["km"]):
            stress = {"km": d, "azi": s[2], "quality": s[3], "regime": s[4]}

    seismic_km = None
    origin = ogr.Geometry(ogr.wkbPoint)
    origin.AddPoint_2D(0, 0)
    for ln in SEISMIC:
        if not any(abs(p[1] - lat) <= 1.5 and abs(p[0] - lon) <= 1.5 for p in ln):
            continue
        g = ogr.Geometry(ogr.wkbLineString)
        for x, y in xy(ct, ln):
            g.AddPoint_2D(x, y)
        d = g.Distance(origin) / 1000
        if seismic_km is None or d < seismic_km:
            seismic_km = d

    feats = [(f, bs) for bs in BASINS for f in bs["features"]]
    features = sorted(({"name": f["n"], "km": d, "kind": f["t"]} for (f, _), d in zip(feats, dist([(f["lon"], f["lat"]) for f, _ in feats])) if d < 60), key=lambda x: x["km"])[:4]
    wells = sorted(({"id": w["id"], "name": w["name"], "km": d} for w, d in zip(WELLS, dist([(w["lon"], w["lat"]) for w in WELLS])) if d < 80), key=lambda x: x["km"])

    bs = basin_at(lon, lat)
    lon20, lat20 = osr.CoordinateTransformation(srs_epsg(4283), srs_epsg(7844)).TransformPoint(lon, lat)[:2]
    (sx, sy), = xy(ct, [(lon20, lat20)])
    return {"lon": lon, "lat": lat, "basin": bs["id"] if bs else None, "basinName": bs["name"] if bs else None,
            "depth": depth_at(bs, lon, lat) if bs else None, "boreholes": near[:5], "within10": sum(1 for w in near if w["km"] <= 10),
            "stress": stress, "seismicKm": seismic_km, "features": features, "wells": wells,
            "gda2020": {"lon": lon20, "lat": lat20, "shiftM": math.hypot(sx, sy)}, "mga": mga(lon, lat, lon20, lat20),
            "ms": round((time.perf_counter() - t0) * 1000), "engine": "gdal", "method": METHOD, "versions": VERSIONS}


# ---------- transforms ----------
ALLOWED_EPSG = {4283, 7844, 4326, 3857} | {28300 + z for z in range(49, 57)} | {7800 + z for z in range(49, 57)}


def transform(src, dst, points):
    ct = osr.CoordinateTransformation(srs_epsg(src), srs_epsg(dst))
    return {"from": f"EPSG:{src}", "to": f"EPSG:{dst}", "points": [[p[0], p[1]] for p in ct.TransformPoints([(float(x), float(y)) for x, y in points])] if points else [], "versions": VERSIONS}


# ---------- HTTP ----------
class BadRequest(Exception):
    pass


def num(v, lo, hi, what):
    if not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v) or not lo <= v <= hi:
        raise BadRequest(f"{what} must be a number between {lo} and {hi}")
    return float(v)


def lonlat(v, what):
    if not isinstance(v, (list, tuple)) or len(v) != 2:
        raise BadRequest(f"{what} must be [longitude, latitude]")
    return (num(v[0], 100, 170, f"{what} longitude"), num(v[1], -50, 0, f"{what} latitude"))


def route(path, body):
    if path == "/section":
        a, b = lonlat(body.get("a"), "a"), lonlat(body.get("b"), "b")
        if a == b:
            raise BadRequest("a and b must differ")
        return section(a, b, width_km=num(body.get("widthKm", 10), 0.1, 50, "widthKm"))
    if path == "/here":
        lon, lat = lonlat([body.get("lon"), body.get("lat")], "point")
        return here(lon, lat)
    if path == "/transform":
        src, dst = int(num(body.get("from"), 0, 100000, "from")), int(num(body.get("to"), 0, 100000, "to"))
        if src not in ALLOWED_EPSG or dst not in ALLOWED_EPSG:
            raise BadRequest(f"from and to must be one of {sorted(ALLOWED_EPSG)}")
        pts = body.get("points")
        if not isinstance(pts, list) or len(pts) > 5000:
            raise BadRequest("points must be a list of at most 5000 [x, y] pairs")
        return transform(src, dst, [(num(p[0], -2e7, 2e7, "x"), num(p[1], -2e7, 2e7, "y")) for p in pts if isinstance(p, (list, tuple)) and len(p) == 2])
    return None


class Handler(BaseHTTPRequestHandler):
    server_version = "gbx-spatial"
    sys_version = ""

    def send(self, code, obj):
        data = json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self.send(200, {"ok": True, **VERSIONS, "boreholes": sum(len(b["boreholes"]) for b in BASINS)})
        else:
            self.send(404, {"error": "Not found."})

    def do_POST(self):
        t0 = time.perf_counter()
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > MAX_BODY:
                raise BadRequest("send a JSON body of at most 256 KB")
            body = json.loads(self.rfile.read(n))
            if not isinstance(body, dict):
                raise BadRequest("the body must be a JSON object")
            out = route(self.path, body)
            if out is None:
                self.send(404, {"error": "Not found."})
                return
            self.send(200, out)
            log("ok", path=self.path, ms=round((time.perf_counter() - t0) * 1000))
        except (BadRequest, ValueError) as e:
            self.send(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001 - report, don't crash the server
            log("error", path=self.path, error=repr(e))
            self.send(500, {"error": "The spatial service could not complete that request."})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    log("listening", port=PORT, **VERSIONS)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
