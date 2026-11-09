"""Immutable preparation snapshots and verified-publication retention."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any

from .delta import SchemaManager, TableReader
from .http import ApiError
from .plan import OntologyPlan, PublicationPlan
from .storage import Entry, Storage
from .values import compact_json

CATALOG_DIRECTORY = "_ontology_ingest/_publications"


def optional_json(files: Storage, path: str) -> dict[str, Any] | None:
    try:
        data = files.read_bytes(path)
    except (FileNotFoundError, KeyError):
        return None
    except ApiError as error:
        if error.status == 404:
            return None
        raise
    value = json.loads(data)
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object at {path}")
    return value


class SnapshotReader:
    def __init__(self, source: Storage):
        self.source = source
        self.digests: dict[str, str] = {}

    @property
    def name(self) -> str:
        return self.source.name

    def list_paths(self, prefix: str = "") -> list[Entry]:
        return self.source.list_paths(prefix) if prefix else self.source.list_paths()

    def read_bytes(self, path: str) -> bytes:
        data = self.source.read_bytes(path)
        self.digests[path] = hashlib.sha256(data).hexdigest()
        return data

    def write_bytes(self, path: str, data: bytes) -> None:
        raise RuntimeError("An input snapshot is read-only")

    def fingerprint(self, datasets: list[dict[str, str]], publication: PublicationPlan) -> str:
        data = {"files": self.digests, "datasets": datasets, "publication": publication.to_dict()}
        return hashlib.sha256(compact_json(data).encode("utf-8")).hexdigest()


def verify_row_counts(tables: TableReader, plan: OntologyPlan) -> dict[str, int]:
    counts: dict[str, int] = {}
    mismatches: list[str] = []
    expected = [(entity.table, entity.rowCount) for entity in plan.entities] + [(rel.table, rel.edgeCount) for rel in plan.relationships]
    for table, count in expected:
        actual = tables.count_rows(plan.bindingSchema, table)
        counts[table] = actual
        if actual != count:
            mismatches.append(f"{plan.bindingSchema}.{table}: expected {count}, found {actual}")
    if mismatches:
        raise ValueError("Binding row-count verification failed: " + "; ".join(mismatches))
    return counts


def validate_retention(retain_runs: int) -> int:
    if not isinstance(retain_runs, int) or isinstance(retain_runs, bool) or retain_runs < 1:
        raise ValueError("retain_runs must be a positive integer; the current run must be retained")
    return retain_runs


def _catalog_path(ontology_id: str) -> str:
    digest = hashlib.sha256(ontology_id.encode("utf-8")).hexdigest()
    return CATALOG_DIRECTORY + "/" + digest + ".json"


def _snapshot_key(record: dict[str, Any]) -> tuple[str, str, str]:
    return record["runId"], record["bindingSchema"], record["rawSchema"]


def _owned_schemas(record: dict[str, Any]) -> list[str]:
    publication = record.get("publication")
    if not publication or publication.get("mode") != "staged":
        return []
    metadata = PublicationPlan.from_dict(publication)
    raw, binding = metadata.schemas(record["runId"])
    if (raw, binding) != (record["rawSchema"], record["bindingSchema"]):
        raise ValueError("Refusing retention cleanup of schemas that do not match their recorded ownership")
    return [binding, raw]


def record_publication(files: Storage, tables: SchemaManager, plan: OntologyPlan, ontology_id: str,
                       ontology_name: str, retain_runs: int = 2) -> dict[str, Any]:
    """Called only after both publication and verification have succeeded."""
    validate_retention(retain_runs)
    path = _catalog_path(ontology_id)
    previous = optional_json(files, path) or {"runs": [], "pendingCleanup": []}
    record = {"runId": plan.runId, "bindingSchema": plan.bindingSchema, "rawSchema": plan.rawSchema,
              "publication": plan.publication.to_dict() if plan.publication else None,
              "publishedAt": datetime.now(timezone.utc).isoformat()}
    key = _snapshot_key(record)
    history = [record] + [item for item in previous["runs"] if _snapshot_key(item) != key]
    retained = history[:retain_runs]
    pending: dict[tuple[str, str, str], dict[str, Any]] = {}
    for item in previous["pendingCleanup"] + history[retain_runs:]:
        if _snapshot_key(item) not in {_snapshot_key(entry) for entry in retained}:
            pending[_snapshot_key(item)] = item
    catalog = {"contractVersion": "1", "ontologyId": ontology_id, "ontologyName": ontology_name,
               "runs": retained, "pendingCleanup": list(pending.values())}
    # Persist the new references and pending cleanup before deleting any old storage.
    files.write_bytes(path, (compact_json(catalog) + "\n").encode("utf-8"))
    protected = {schema for item in retained for schema in (item["bindingSchema"], item["rawSchema"])}
    for entry in files.list_paths(CATALOG_DIRECTORY):
        if not entry.is_dir and entry.path.endswith(".json"):
            other = optional_json(files, entry.path)
            if other is None or other.get("contractVersion") != "1" or not isinstance(other.get("runs"), list):
                raise ValueError("Publication catalog is invalid; retention cleanup is refused")
            for item in other["runs"]:
                protected.update((item["bindingSchema"], item["rawSchema"]))
    deleted: list[str] = []
    errors: list[dict[str, str]] = []
    remaining: list[dict[str, Any]] = []
    for item in pending.values():
        try:
            schemas = _owned_schemas(item)
            if any(schema in protected for schema in schemas):
                remaining.append(item)
                continue
            for schema in schemas:
                tables.delete_schema(schema)
                deleted.append(schema)
        except Exception as error:
            remaining.append(item)
            errors.append({"runId": item.get("runId", ""), "error": str(error)})
    catalog["pendingCleanup"] = remaining
    files.write_bytes(path, (compact_json(catalog) + "\n").encode("utf-8"))
    return {"retainedRuns": [item["runId"] for item in retained], "deletedSchemas": deleted,
            "pendingRuns": [item["runId"] for item in remaining], "errors": errors}
