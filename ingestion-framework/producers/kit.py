"""Producer: the curated GeoBasin knowledge-graph kit (processed/geology/fabric-iq-kit).

The kit already follows the contract shape, so this producer passes its rows through, keeping the human-readable
property strings such as "3,852 m" exactly as the upstream process wrote them; expanding and typing them is the
framework's job. It adds descriptions, turns the class and property labels of the exported OWL ontology into synonyms,
and leaves out the few well locatedIn edges that the Geoscience Australia borehole layer places outside the basin outline.
"""
from __future__ import annotations

import csv
import json
import logging
import re

from . import vocabulary as v
from .common import Bundle, clean, num
from .ga_basins import wells_inside

NAME = "geobasin-kit"
FLAT = ("basin_id", "crs", "source_title", "source_id", "publisher", "licence")
# The kit's basin_id names the basin package a record was mapped in, not the outline that contains it.
RENAME = {"basin_id": "package_id"}
LOG = logging.getLogger(__name__)


def _outside_outline(row: dict, inside: dict[str, set[str]], covered: set[str]) -> bool:
    """A kit edge that puts a well in a basin whose outline does not contain it, by the Geoscience Australia layer.

    The kit links each well to the basin package it was mapped in, while locatedIn means inside the basin outline, so
    such an edge would contradict the well's own inside_basin_outline; package_id still records the package. Only wells
    in the layer and basins the layer covers can be checked, so links to anything else are kept."""
    if row["source_type"] != "Wellbore" or row["target_type"] != "Basin":
        return False
    basin, basins = row["target_id"].removeprefix("basin:"), inside.get(row["source_id"])
    return basins is not None and basin in covered and basin not in basins


def _owl_labels(bundle: Bundle) -> dict[str, str]:
    labels: dict[str, str] = {}
    for ttl in sorted(bundle.processed("geology/ontology").glob("*.ttl")):
        for name, label in re.findall(r'^gb:(\w+) a owl:\w+ ; rdfs:label "([^"]+)"', ttl.read_text(encoding="utf-8"), flags=re.M):
            labels.setdefault(name, label)
    return labels


def produce(bundle: Bundle, writer_cls, out_root) -> dict:
    kit = bundle.processed("geology/fabric-iq-kit")
    labels = _owl_labels(bundle)
    w = writer_cls(out_root, name=NAME, title="GeoBasin curated knowledge-graph kit", priority=100, producer="producers/kit.py",
                   description="The curated knowledge graph that GeoBasin Explorer AI builds from the Geoscience Australia packages, the scanned well reports and the World Stress Map: entities with display properties and the relationships between them.",
                   sources=[{"id": "geobasin-kit", "title": "GeoBasin Explorer AI knowledge-graph export", "publisher": "GeoBasin Explorer AI", "licence": "CC BY 4.0 (derived from CC BY 4.0 sources)"}])
    for f in sorted((kit / "entities").glob("*.csv")):
        etype = f.stem
        desc, syn = v.ENTITIES[etype]
        extra = [labels[etype]] if etype in labels and labels[etype].lower() not in {s.lower() for s in syn} else []
        w.entity_type(etype, description=desc, synonyms=syn + extra, properties={**v.COMMON, **v.PROPERTIES.get(etype, {})})
        with f.open(encoding="utf-8-sig", newline="") as fh:
            for row in csv.DictReader(fh):
                props = json.loads(row.get("properties_json") or "{}")
                repeated = {k.casefold(): str(val) for k, val in props.items()}
                # A flat column that repeats a JSON property of the same name and value adds nothing; keep one copy.
                flat = clean({RENAME.get(k, k): row.get(k) for k in FLAT if repeated.get(k.casefold()) != row.get(k)})
                flat.update(clean({"lon": num(row.get("lon")), "lat": num(row.get("lat"))}))
                w.add_entity(etype, id=row["id"], label=row["label"], properties=props, **flat)
    inside, covered = wells_inside(bundle), {b.id for b in bundle.basins}
    outside = []
    for f in sorted((kit / "relationships").glob("*.csv")):
        rel = f.stem
        desc, syn = v.RELATIONS[rel]
        extra = [labels[rel]] if rel in labels and labels[rel].lower() not in {s.lower() for s in syn} else []
        w.relationship_type(rel, description=desc, synonyms=syn + extra)
        with f.open(encoding="utf-8-sig", newline="") as fh:
            for row in csv.DictReader(fh):
                if rel == "locatedIn" and _outside_outline(row, inside, covered):
                    outside.append(f"{row['source_id']} {row['target_id']}")
                    continue
                w.add_relationship(rel, row["source_id"], row["source_type"], row["target_id"], row["target_type"])
    if outside:
        LOG.info("left out %d kit locatedIn edges for wells outside the basin outline: %s", len(outside), ", ".join(outside))
    return w.close()
