"""Well sites that have scanned reports (wells.json and lowcarbon-sites.json), and the ids of their documents.

Shared by the application-pack and well-report producers so that passages, figures and extracted values point at
the same document ids that the well-report producer mints.
"""
from __future__ import annotations

import json

from .common import Bundle, slug

FALLBACK = {"innamincka-1": "doc:inn-wcr", "marabooka-1": "doc:mar-wcr"}


LIST_KEYS = {"documents": "docId", "fields": "fieldId", "findings": "findingId", "curves": "curveId", "pages": "pageId"}


def _merge_site(into: dict, other: dict) -> None:
    """Fill gaps in one site record from another: scalars only when missing, lists item by item on their id."""
    for key, value in other.items():
        if key in LIST_KEYS and isinstance(value, list):
            ident = LIST_KEYS[key]
            have = {item.get(ident) for item in into.get(key, [])}
            into.setdefault(key, []).extend(item for item in value if item.get(ident) not in have)
        elif into.get(key) in (None, "", [], {}):
            into[key] = value


def load_sites(bundle: Bundle) -> dict[str, dict]:
    sites: dict[str, dict] = {}
    for rel in ("wells/lowcarbon-sites.json", "wells/wells.json"):
        for s in json.loads(bundle.processed(rel).read_text(encoding="utf-8")):
            _merge_site(sites.setdefault(s["siteId"], {}), s)
    return sites


def load_velocity(bundle: Bundle) -> dict:
    return json.loads(bundle.processed("wells/velocity.json").read_text(encoding="utf-8"))


def site_doc_id(site_id: str, doc_id: str) -> str:
    return f"doc:{site_id}:{doc_id}"


def velocity_doc_id(velocity: dict, item_id: str) -> str:
    return f"doc:{velocity['well']}:{item_id}"


def match_doc(label: str, sites: dict[str, dict], velocity: dict) -> str | None:
    """Map a passage or figure document label such as 'Innamincka 1 · Appendix 4 - Core analysis (...)' to a document id."""
    name, _, rest = label.partition(" · ")
    site_id = slug(name)
    site = sites.get(site_id)
    if not site:
        for sid, s in sites.items():
            if label.lower().startswith(s["name"].lower()):
                site_id, site, rest = sid, s, label[len(s["name"]):].strip(" ·")
                break
    if not site:
        return None
    rest_l = rest.lower()
    if velocity.get("well") == site_id:
        for it in velocity["items"]:
            if ("checkshot" in rest_l and "checkshot" in it["itemId"]) or ("velocity chart" in rest_l and "checkshot" not in it["itemId"]):
                return velocity_doc_id(velocity, it["itemId"])
    for d in site.get("documents", []):
        title = d["title"].lower()
        if rest_l and (title.startswith(rest_l) or rest_l.startswith(title) or rest_l in title):
            return site_doc_id(site_id, d["docId"])
    if "ocr" in rest_l:
        ocr = next((d for d in site.get("documents", []) if "ocr" in d["docId"].lower()), None)
        if ocr:
            return site_doc_id(site_id, ocr["docId"])
    body = next((d for d in site.get("documents", []) if d["docId"] in ("body", "wcr", "report")), None)
    return site_doc_id(site_id, body["docId"]) if body else FALLBACK.get(site_id)
