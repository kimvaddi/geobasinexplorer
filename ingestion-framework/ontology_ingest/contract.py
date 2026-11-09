"""Contract v1 producer API and loss-aware CSV/JSONL discovery and reading."""
from __future__ import annotations

import csv
import io
import json
import logging
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any

from .naming import validate_identifier
from .storage import Storage, relative_path
from .values import DATA_TYPES, as_string, compact_json, is_null

LOG = logging.getLogger(__name__)
ENTITY_COLUMNS = ("id", "label")
EDGE_COLUMNS = ("source_id", "source_type", "target_id", "target_type")


class ContractError(ValueError):
    """Invalid contract structure, rather than a recoverable bad row."""


def _json_object(text: str) -> dict[str, Any]:
    def reject_constant(value: str) -> None:
        raise ValueError(f"Non-JSON numeric constant {value}")
    value = json.loads(text, parse_constant=reject_constant)
    if not isinstance(value, dict):
        raise ValueError("Expected a JSON object")
    return value


def validate_metadata(metadata: dict[str, Any]) -> None:
    if metadata.get("contractVersion", "1") != "1":
        raise ContractError("Only contractVersion '1' is supported")
    for key in ("name", "title", "description", "producer", "producedAt"):
        if key in metadata and not isinstance(metadata[key], str):
            raise ContractError(f"dataset.json {key} must be a string")
    if "name" in metadata and not metadata["name"].strip():
        raise ContractError("Dataset name cannot be empty")
    priority = metadata.get("priority", 50)
    if isinstance(priority, bool) or not isinstance(priority, int):
        raise ContractError("Dataset priority must be an integer")
    if not isinstance(metadata.get("sources", []), list):
        raise ContractError("Dataset sources must be an array")
    for collection in ("entityTypes", "relationshipTypes"):
        types = metadata.get(collection, {})
        if not isinstance(types, dict):
            raise ContractError(f"{collection} must be an object")
        for name, details in types.items():
            if not isinstance(details, dict):
                raise ContractError(f"Metadata for {name} must be an object")
            if "description" in details and not isinstance(details["description"], str):
                raise ContractError(f"Description for {name} must be a string")
            synonyms = details.get("synonyms", [])
            if not isinstance(synonyms, list) or not all(isinstance(s, str) for s in synonyms):
                raise ContractError(f"Synonyms for {name} must be a string array")
            priority = details.get("priority", metadata.get("priority", 50))
            if isinstance(priority, bool) or not isinstance(priority, int):
                raise ContractError(f"Priority for {name} must be an integer")
            properties = details.get("properties", {})
            if not isinstance(properties, dict):
                raise ContractError(f"Properties for {name} must be an object")
            for key, prop in properties.items():
                if not isinstance(prop, dict):
                    raise ContractError(f"Property metadata for {name}.{key} must be an object")
                if "dataType" in prop and (not isinstance(prop["dataType"], str) or prop["dataType"] not in DATA_TYPES):
                    raise ContractError(f"Unsupported dataType for {name}.{key}: {prop['dataType']!r}")
                for field_name in ("description", "unit"):
                    if field_name in prop and prop[field_name] is not None and not isinstance(prop[field_name], str):
                        raise ContractError(f"{name}.{key}.{field_name} must be a string or null")


@dataclass
class Dataset:
    name: str
    path: str
    metadata: dict[str, Any]
    entities: dict[str, str] = field(default_factory=dict)
    relationships: dict[str, str] = field(default_factory=dict)

    def priority(self, entity: str | None = None) -> int:
        specific = self.metadata.get("entityTypes", {}).get(entity, {}) if entity else {}
        return specific.get("priority", self.metadata.get("priority", 50))


@dataclass
class InputRows:
    columns: list[str]
    rows: list[dict[str, Any]]
    row_numbers: list[int]
    valid: list[bool]
    errors: list[dict[str, Any]]


def discover(storage: Storage) -> list[Dataset]:
    entries = storage.list_paths()
    files = {entry.path for entry in entries if not entry.is_dir}
    roots: set[str] = set()
    for entry in entries:
        path = PurePosixPath(relative_path(entry.path))
        if (entry.is_dir and path.name in {"entities", "relationships"}) or (not entry.is_dir and path.name == "dataset.json"):
            roots.add("" if str(path.parent) == "." else str(path.parent))
        if not entry.is_dir and path.parent.name in {"entities", "relationships"}:
            roots.add("" if str(path.parent.parent) == "." else str(path.parent.parent))
    datasets: list[Dataset] = []
    names: set[str] = set()
    for root in sorted(roots):
        prefix = root + "/" if root else ""
        metadata_path = prefix + "dataset.json"
        try:
            metadata = _json_object(storage.read_bytes(metadata_path).decode("utf-8-sig")) if metadata_path in files else {}
            validate_metadata(metadata)
        except (ValueError, UnicodeError) as error:
            raise ContractError(f"{metadata_path}: {error}") from error
        name = metadata.get("name", PurePosixPath(root).name if root else storage.name)
        if name in names:
            raise ContractError(f"Dataset name {name!r} occurs in multiple folders; provenance would be ambiguous")
        names.add(name)
        dataset = Dataset(name, root, metadata)
        for folder, target in (("entities", dataset.entities), ("relationships", dataset.relationships)):
            for path_string in sorted(files):
                path = PurePosixPath(path_string)
                if str(path.parent) != prefix + folder or path.suffix.lower() not in {".csv", ".jsonl"}:
                    continue
                if path.stem in target:
                    raise ContractError(f"More than one file for {name}/{folder}/{path.stem}")
                target[path.stem] = path_string
        datasets.append(dataset)
    return sorted(datasets, key=lambda dataset: dataset.name)


def read_rows(storage: Storage, path: str, kind: str) -> InputRows:
    required = ENTITY_COLUMNS if kind == "entity" else EDGE_COLUMNS
    text = storage.read_bytes(path).decode("utf-8-sig")
    rows: list[dict[str, Any]] = []
    row_numbers: list[int] = []
    valid: list[bool] = []
    errors: list[dict[str, Any]] = []
    columns: set[str] = set(required)

    def record(row: dict[str, Any], number: int, error: str | None = None) -> None:
        rows.append(row)
        row_numbers.append(number)
        valid.append(error is None)
        columns.update(row)
        if error:
            errors.append({"file": path, "row": number, "error": error})

    if PurePosixPath(path).suffix.lower() == ".csv":
        reader = csv.reader(io.StringIO(text, newline=""), strict=True)
        try:
            header = next(reader)
        except (StopIteration, csv.Error) as error:
            raise ContractError(f"{path}: a CSV header is required") from error
        if len(set(header)) != len(header) or any(not name for name in header):
            raise ContractError(f"{path}: duplicate or empty CSV header names")
        missing = set(required) - set(header)
        if missing:
            raise ContractError(f"{path}: missing required columns: {', '.join(sorted(missing))}")
        columns.update(header)
        try:
            for row_number, values in enumerate(reader, 1):
                if not values:
                    continue
                row = {key: value if value != "" else None for key, value in zip(header, values)}
                error = None
                if len(values) != len(header):
                    row["_unparsed_values"] = compact_json(values)
                    error = "CSV row has the wrong number of fields"
                record(row, row_number, error)
        except csv.Error as error:
            raise ContractError(f"{path}, physical line {reader.line_num}: {error}") from error
    else:
        for number, line in enumerate(text.splitlines(), 1):
            if not line.strip():
                continue
            try:
                row = _json_object(line)
            except (ValueError, TypeError) as error:
                record({"_unparsed_json": line}, number, str(error))
                continue
            missing = set(required) - set(row)
            record(row, number, f"Missing required fields: {', '.join(sorted(missing))}" if missing else None)
    return InputRows(list(required) + sorted(columns - set(required)), rows, row_numbers, valid, errors)


def rows_from_records(columns: list[str], records: list[dict[str, Any]], path: str, kind: str) -> InputRows:
    """The same InputRows that read_rows gives for a CSV file, built from the raw table a pipeline Copy activity loaded it
    into. Every column is text, empty cells are null, and row numbers follow the table's order."""
    required = ENTITY_COLUMNS if kind == "entity" else EDGE_COLUMNS
    if len(set(columns)) != len(columns) or any(not name for name in columns):
        raise ContractError(f"{path}: duplicate or empty column names in its copied table")
    missing = set(required) - set(columns)
    if missing:
        raise ContractError(f"{path}: missing required columns: {', '.join(sorted(missing))}")
    rows = [{key: None if value is None or value == "" else value for key, value in record.items() if key in columns}
            for record in records]
    return InputRows(list(required) + sorted(set(columns) - set(required)), rows, list(range(1, len(rows) + 1)),
                     [True] * len(rows), [])


class DatasetWriter:
    """Build one deterministic dataset folder. ``out_dir`` is that folder itself."""

    def __init__(self, out_dir: str | Path, *, name: str, title: str = "", description: str = "",
                 priority: int = 50, producer: str = "", sources: list[dict[str, Any]] | None = None,
                 produced_at: str | None = None):
        self.out_dir = Path(out_dir)
        self.metadata: dict[str, Any] = {
            "contractVersion": "1", "name": name, "title": title, "description": description,
            "priority": priority, "producer": producer, "sources": sources or [],
            "entityTypes": {}, "relationshipTypes": {},
        }
        if produced_at is not None:
            self.metadata["producedAt"] = produced_at
        validate_metadata(self.metadata)
        self._entities: dict[str, dict[str, dict[str, Any]]] = {}
        self._relationships: dict[str, set[tuple[str, str, str, str]]] = {}
        self._duplicates = 0
        self._summary: dict[str, Any] | None = None

    def _open(self) -> None:
        if self._summary is not None:
            raise ValueError("DatasetWriter is already closed")

    def entity_type(self, name: str, *, description: str = "", synonyms: list[str] | None = None,
                    priority: int | None = None, properties: dict[str, Any] | None = None) -> None:
        self._open()
        validate_identifier(name, "entity type")
        details: dict[str, Any] = {"description": description, "synonyms": synonyms or [], "properties": properties or {}}
        if priority is not None:
            details["priority"] = priority
        self.metadata["entityTypes"][name] = details
        validate_metadata(self.metadata)
        self._entities.setdefault(name, {})

    def relationship_type(self, name: str, *, description: str = "", synonyms: list[str] | None = None) -> None:
        self._open()
        validate_identifier(name, "relationship name")
        self.metadata["relationshipTypes"][name] = {"description": description, "synonyms": synonyms or []}
        validate_metadata(self.metadata)
        self._relationships.setdefault(name, set())

    def add_entity(self, entity_type: str, *, id: str, label: str, properties: dict[str, Any] | None = None,
                   **flat_columns: Any) -> None:
        self._open()
        validate_identifier(entity_type, "entity type")
        if not isinstance(id, str) or not id.strip():
            raise ValueError("Entity id must be a nonempty string")
        if not isinstance(label, str):
            raise ValueError("Entity label must be a string (it may be empty)")
        if "properties_json" in flat_columns:
            raise ValueError("Use properties= instead of the reserved flat column properties_json")
        if any(not isinstance(key, str) or not key for key in flat_columns):
            raise ValueError("Flat column names must be nonempty strings")
        if properties is not None and (not isinstance(properties, dict) or not all(isinstance(k, str) for k in properties)):
            raise ValueError("properties must be a dictionary with string keys")
        props = {key: value for key, value in (properties or {}).items() if value is not None}
        compact_json(props)
        compact_json(flat_columns)
        if entity_type not in self._entities:
            self.entity_type(entity_type)
        rows = self._entities[entity_type]
        key = id.strip()
        incoming = {"id": key, "label": label, "properties": props, "flat": dict(flat_columns)}
        if key not in rows:
            rows[key] = incoming
            return
        self._duplicates += 1
        LOG.warning("Merging duplicate entity id %r in %s", key, entity_type)
        existing = rows[key]
        if is_null(existing["label"]) and not is_null(label):
            existing["label"] = label
        for section in ("properties", "flat"):
            for prop, value in incoming[section].items():
                if prop not in existing[section] or (is_null(existing[section][prop]) and not is_null(value)):
                    existing[section][prop] = value

    def add_relationship(self, relation: str, source_id: str, source_type: str,
                         target_id: str, target_type: str) -> None:
        self._open()
        for value, kind in ((relation, "relationship name"), (source_type, "source type"), (target_type, "target type")):
            validate_identifier(value, kind)
        if not all(isinstance(value, str) and value.strip() for value in (source_id, target_id)):
            raise ValueError("Relationship ids must be nonempty strings")
        if relation not in self._relationships:
            self.relationship_type(relation)
        self._relationships[relation].add((source_type, source_id.strip(), target_type, target_id.strip()))

    @staticmethod
    def _write_csv(path: Path, header: list[str], rows: list[list[Any]]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8", newline="") as stream:
            writer = csv.writer(stream, lineterminator="\n")
            writer.writerow(header)
            for row in rows:
                writer.writerow(["" if value is None else as_string(value) for value in row])

    def close(self) -> dict[str, Any]:
        if self._summary is not None:
            return dict(self._summary)
        validate_metadata(self.metadata)
        for folder, names in (("entities", self._entities), ("relationships", self._relationships)):
            for old in (self.out_dir / folder).glob("*"):
                if old.suffix.lower() in {".csv", ".jsonl"} and (old.stem not in names or old.suffix != ".csv"):
                    raise ContractError(f"Stale source file {old}; use a fresh output folder or remove it explicitly")
        self.out_dir.mkdir(parents=True, exist_ok=True)
        for name, entities in sorted(self._entities.items()):
            flat_names = sorted({key for row in entities.values() for key in row["flat"]})
            rows = [[row["id"], row["label"], *(row["flat"].get(key) for key in flat_names),
                     compact_json({k: v for k, v in row["properties"].items() if v is not None})]
                    for _, row in sorted(entities.items())]
            self._write_csv(self.out_dir / "entities" / f"{name}.csv", ["id", "label", *flat_names, "properties_json"], rows)
        for name, edges in sorted(self._relationships.items()):
            rows = [[source_id, source_type, target_id, target_type]
                    for source_type, source_id, target_type, target_id in sorted(edges)]
            self._write_csv(self.out_dir / "relationships" / f"{name}.csv", list(EDGE_COLUMNS), rows)
        (self.out_dir / "dataset.json").write_text(json.dumps(self.metadata, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
        self._summary = {"name": self.metadata["name"],
                         "entities": {name: len(rows) for name, rows in sorted(self._entities.items())},
                         "relationships": {name: len(rows) for name, rows in sorted(self._relationships.items())},
                         "entityCount": sum(map(len, self._entities.values())),
                         "relationshipCount": sum(map(len, self._relationships.values())),
                         "duplicateEntities": self._duplicates}
        return dict(self._summary)
