"""Shared helpers for the GeoBasin producers.

The id rules (slug, well-name normalisation, title case) are ported from app/src/lib/kg.ts so that every producer
mints the same ids as the curated knowledge-graph kit, which lets the framework merge records by id.
"""
from __future__ import annotations

import base64
import json
import math
import re
import unicodedata
from array import array
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

ABBR = {"GSQ", "DST", "SA", "QLD", "NSW", "NT", "CSG", "DIO", "AAO", "BMR", "PPC", "AOE", "GA"}
PACKAGE_BASIN = {"cooper-basin": "cooper", "adavale-basin": "adavale", "galilee-basin": "galilee", "north-bowen-basin": "northbowen"}


def slug(s: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", "-", unicodedata.normalize("NFKD", (s or "").lower())).strip("-")


def norm_well(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"^GSQ\s+", "", s.upper())).strip()


def well_id(name: str) -> str:
    return f"bh:{slug(norm_well(name))}"


def title_case(s: str) -> str:
    def word(w: str) -> str:
        keep = bool(re.search(r"\d", w)) or (re.sub(r"[^A-Za-z]", "", w).upper() in ABBR and w == w.upper())
        return w if keep else w[:1].upper() + w[1:].lower()
    return " ".join(word(w) for w in re.split(r"\s+", s.strip()) if w)


def snake_header(s: str) -> str:
    """'SHOT NUMBER' to 'shot_number', 'Z(KB)' to 'z_kb'; used for table headers read from scanned documents."""
    out = re.sub(r"[^a-z0-9]+", "_", unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()).strip("_")
    return out if out and not out[0].isdigit() else f"c_{out}"


def unique(names: list[str]) -> list[str]:
    seen: dict[str, int] = {}
    out = []
    for n in names:
        seen[n] = seen.get(n, 0) + 1
        out.append(n if seen[n] == 1 else f"{n}_{seen[n]}")
    return out


def haversine_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    rad = math.pi / 180
    a = math.sin((lat2 - lat1) * rad / 2) ** 2 + math.cos(lat1 * rad) * math.cos(lat2 * rad) * math.sin((lon2 - lon1) * rad / 2) ** 2
    return 2 * 6371.0088 * math.asin(min(1.0, math.sqrt(a)))


def in_rings(lon: float, lat: float, rings: list) -> bool:
    inside = False
    for ring in rings:
        j = len(ring) - 1
        for i in range(len(ring)):
            xi, yi = ring[i]
            xj, yj = ring[j]
            if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
                inside = not inside
            j = i
    return inside


def num(v) -> float | None:
    """Parse '3,197.66' or 3197.66 to a float; None for blanks and non-numbers."""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v) if math.isfinite(v) else None
    s = str(v).strip().replace(",", "")
    try:
        f = float(s)
    except ValueError:
        return None
    return f if math.isfinite(f) else None


def clean(d: dict) -> dict:
    """Drop None and empty-string values so they do not shadow other datasets during the merge."""
    return {k: v for k, v in d.items() if v is not None and v != "" and v != []}


@dataclass
class Basin:
    id: str
    name: str
    bbox: tuple
    outline: list

    def contains(self, lon: float, lat: float) -> bool:
        x0, y0, x1, y1 = self.bbox
        return x0 <= lon <= x1 and y0 <= lat <= y1 and in_rings(lon, lat, self.outline)


@dataclass
class Borehole:
    basin: str
    index: int
    lon: float
    lat: float
    td: int | None
    type: str
    year: int | None
    inside: bool
    major: bool
    name: str | None
    operator: str
    result: str


@dataclass
class Bundle:
    """Paths into the data bundle plus the decoded packs, loaded once and shared by every producer."""
    root: Path
    workspace: Path
    basins_pack: dict = field(default_factory=dict)
    app_pack: dict = field(default_factory=dict)
    lowcarbon_pack: dict = field(default_factory=dict)
    basins: list[Basin] = field(default_factory=list)
    boreholes: list[Borehole] = field(default_factory=list)
    cache: dict = field(default_factory=dict)

    @classmethod
    def load(cls, root: Path, workspace: Path) -> "Bundle":
        b = cls(root=root, workspace=workspace)
        p = root / "processed"
        b.basins_pack = json.loads((p / "geospatial/basins-pack.json").read_text(encoding="utf-8"))
        b.app_pack = json.loads((p / "application/app-pack.json").read_text(encoding="utf-8"))
        b.lowcarbon_pack = json.loads((p / "application/lowcarbon-pack.json").read_text(encoding="utf-8"))
        b.basins = [Basin(r["id"], r["name"], tuple(r["bbox"]), r["outline"]) for r in b.basins_pack["basins"]]
        b.boreholes = list(decode_boreholes(b.basins_pack))
        return b

    def processed(self, rel: str) -> Path:
        return self.root / "processed" / rel

    def basins_at(self, lon: float, lat: float) -> list[str]:
        return [x.id for x in self.basins if x.contains(lon, lat)]


def decode_boreholes(pack: dict) -> Iterable[Borehole]:
    """Decode the packed borehole layer exactly as app/src/lib/basins.ts does (little-endian uint16 quads)."""
    types = pack["types"]
    for r in pack["basins"]:
        raw = base64.b64decode(r["bh"]["b64"])
        u = array("H")
        u.frombytes(raw[: len(raw) // 2 * 2])
        if u.itemsize != 2:
            raise RuntimeError("unexpected uint16 size")
        bx0, by0, bx1, by1 = r["bh"]["bb"]
        sx, sy = (bx1 - bx0) / 65535, (by1 - by0) / 65535
        named = {n[0]: n for n in r["bh"]["names"]}
        for i in range(r["bh"]["n"]):
            f = u[i * 4 + 3]
            yr = f >> 8
            nm = named.get(i)
            yield Borehole(basin=r["id"], index=i, lon=bx0 + u[i * 4] * sx, lat=by0 + u[i * 4 + 1] * sy,
                           td=u[i * 4 + 2] or None, type=types[f & 63] if (f & 63) < len(types) else "UNKNOWN",
                           year=1850 + yr if yr > 0 else None, inside=bool(f & 64), major=bool(f & 128),
                           name=nm[1] if nm else None, operator=nm[2] if nm else "", result=nm[3] if nm else "")
