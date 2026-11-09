"""Prepare raw audit tables, merged typed entities, junctions and a versioned plan."""
from __future__ import annotations

import hashlib
import logging
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import PurePosixPath
from typing import Any

import pyarrow as pa

from .contract import Dataset, InputRows, _json_object, discover, read_rows, rows_from_records
from .delta import RawTableReader, TableWriter
from .naming import RESERVED_PROPERTIES, column_names, raw_table_name, snake, validate_run_id, validate_table_name
from .plan import EntityPlan, OntologyPlan, PropertyPlan, PublicationPlan, RelationshipPlan, validate_plan
from .lifecycle import SnapshotReader, optional_json
from .storage import Storage, relative_path
from .values import arrow_type, as_string, binding_type, cast_column, compact_json, derive_quantities, infer_type, is_null, unit_words

LOG = logging.getLogger(__name__)
AUDIT_COLUMNS = ("_dataset", "_source_file", "_row_number", "_run_id", "_ingested_at")


@dataclass
class EntityBatch:
    dataset: Dataset
    name: str
    rows: list[dict[str, Any]]


def _error(report: dict[str, Any], dataset: Dataset, file: str, row: int, code: str, error: str) -> None:
    report["parseErrors"].append({"dataset": dataset.name, "file": file, "row": row, "code": code, "error": error})


def _raw_table(data: InputRows, dataset: Dataset, path: str, run_id: str, now: datetime) -> tuple[pa.Table, dict[str, str]]:
    mapping = column_names(data.columns, reserved=AUDIT_COLUMNS)
    columns = [mapping[column] for column in data.columns]
    fields = [pa.field(name, pa.string()) for name in columns]
    fields += [pa.field("_dataset", pa.string()), pa.field("_source_file", pa.string()),
               pa.field("_row_number", pa.int64()), pa.field("_run_id", pa.string()),
               pa.field("_ingested_at", pa.timestamp("us", tz="UTC"))]
    rows = []
    for number, row in zip(data.row_numbers, data.rows):
        record = {mapping[key]: None if value is None else as_string(value) for key, value in row.items()}
        record.update(_dataset=dataset.name, _source_file=path, _row_number=number, _run_id=run_id, _ingested_at=now)
        rows.append(record)
    return pa.Table.from_pylist(rows, schema=pa.schema(fields)), mapping


def _expand(data: InputRows, dataset: Dataset, name: str, path: str, report: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    stats = report["datasets"][dataset.name]["files"][path]
    for row, number, valid in zip(data.rows, data.row_numbers, data.valid):
        if not valid:
            continue
        entity_id = row.get("id")
        if not isinstance(entity_id, str) or is_null(entity_id):
            stats["invalidIds"] += 1
            _error(report, dataset, path, number, "invalid_id", "Entity id must be a nonempty string")
            continue
        entity_id = entity_id.strip()
        if entity_id in seen:
            stats["duplicateIds"] += 1
            LOG.warning("Keeping first duplicate id %r in %s", entity_id, path)
            continue
        seen.add(entity_id)
        label = row.get("label")
        if label is not None and not isinstance(label, str):
            _error(report, dataset, path, number, "invalid_label", "Label must be a string; replaced with null")
            label = None
        properties: dict[str, Any] = {}
        blob = row.get("properties_json")
        if not is_null(blob):
            try:
                properties = dict(blob) if isinstance(blob, dict) else _json_object(blob)
            except (TypeError, ValueError) as error:
                _error(report, dataset, path, number, "properties_json", str(error))
        for key, value in row.items():
            if key not in {"id", "label", "properties_json"} and not is_null(value):
                if key in properties and not is_null(properties[key]) and properties[key] != value:
                    _error(report, dataset, path, number, "flat_property_collision", f"Flat column {key!r} wins over properties_json")
                properties[key] = value
            elif key not in {"id", "label", "properties_json"}:
                properties.setdefault(key, None)
        properties = {key: None if is_null(value) else compact_json(value) if isinstance(value, (dict, list)) else value
                      for key, value in properties.items()}
        rows.append({"id": entity_id, "label": None if is_null(label) else label, "properties": properties})
    stats["acceptedRows"] = len(rows)
    return rows


def _entity_metadata(batches: list[EntityBatch], name: str, field: str, default: Any) -> Any:
    for batch in batches:
        value = batch.dataset.metadata.get("entityTypes", {}).get(name, {}).get(field)
        if value is not None and value != "":
            return value
    return default


def _synonyms(details: list[dict[str, Any]]) -> list[str]:
    return sorted({synonym for meta in details for synonym in meta.get("synonyms", [])})


@dataclass
class PropertyOrigin:
    dataset: Dataset
    raw_key: str
    has_values: bool
    derived_from: str | None = None
    unit: str | None = None
    example: str | None = None


def _canonicalize_properties(batches: list[EntityBatch]) -> tuple[dict[str, dict[str, str]], dict[str, list[PropertyOrigin]]]:
    mappings: dict[str, dict[str, str]] = {}
    origins: dict[str, list[PropertyOrigin]] = defaultdict(list)
    for batch in batches:
        raw_keys = {key for row in batch.rows for key in row["properties"]}
        mapping = column_names(raw_keys)
        mappings[batch.dataset.name] = mapping
        for key, column in mapping.items():
            origins[column].append(PropertyOrigin(batch.dataset, key,
                any(not is_null(row["properties"].get(key)) for row in batch.rows)))
        batch.rows = [{"id": row["id"], "label": row["label"],
                       **{mapping[key]: value for key, value in row["properties"].items()}}
                      for row in batch.rows]
    return mappings, origins


@dataclass
class QuantityCandidate:
    values: list[Any]
    origin: PropertyOrigin


def _column_metadata(name: str, column: str, batches: list[EntityBatch],
                     mappings: dict[str, dict[str, str]]) -> tuple[dict[str, Any], dict[str, str]]:
    meta: dict[str, Any] = {}
    declarations: dict[str, str] = {}
    if column in RESERVED_PROPERTIES:
        return meta, declarations
    for batch in batches:
        declared = batch.dataset.metadata.get("entityTypes", {}).get(name, {}).get("properties", {})
        raw_key = next((key for key, target in mappings[batch.dataset.name].items() if target == column), None)
        candidate = declared.get(column, declared.get(raw_key, {}))
        for field_name, value in candidate.items():
            if field_name not in meta and value is not None:
                meta[field_name] = value
        if "dataType" in candidate:
            declarations[batch.dataset.name] = candidate["dataType"]
    return meta, declarations


def _add_quantities(name: str, batches: list[EntityBatch], mappings: dict[str, dict[str, str]],
                    origins: dict[str, list[PropertyOrigin]], report: dict[str, Any]) -> dict[tuple[str, str], list[QuantityCandidate]]:
    extras: dict[tuple[str, str], list[QuantityCandidate]] = defaultdict(list)
    metadata = {column: _column_metadata(name, column, batches, mappings)[0] for column in origins}
    for batch in batches:
        raw_keys = {column: key for key, column in mappings[batch.dataset.name].items()}
        for source_column in sorted(raw_keys):
            # An explicit numeric/date/boolean contract is not a request for a shadow display-quantity column.
            if metadata[source_column].get("dataType", "string") != "string":
                continue
            for derived in derive_quantities(source_column, [row.get(source_column) for row in batch.rows]):
                example = next(as_string(row[source_column]) for row, value in zip(batch.rows, derived.values) if value is not None)
                origin = PropertyOrigin(batch.dataset, raw_keys[source_column], False, source_column, derived.unit, example)
                origins[derived.name].append(origin)
                extras[batch.dataset.name, derived.name].append(QuantityCandidate(derived.values, origin))
                report["derivedColumns"].append({"dataset": batch.dataset.name, "entity": name, "column": derived.name,
                                                 "derivedFrom": source_column, "unit": derived.unit})
    return extras


def _single_line(text: str) -> str:
    return " ".join("".join(char if ord(char) >= 32 else " " for char in text).split())[:3999]


def _distinct_labels(labels: list[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for label in labels:
        label = _single_line(label)
        if label and label.casefold() not in seen:
            seen.add(label.casefold())
            result.append(label)
    return result


def _join_labels(labels: list[str]) -> str:
    return ", ".join(labels[:-1]) + " and " + labels[-1] if len(labels) > 1 else "".join(labels)


def _native_description(column: str, origins: list[PropertyOrigin]) -> str:
    native = [origin for origin in origins if origin.derived_from is None]
    keys = sorted({origin.raw_key for origin in native or origins}, key=lambda key: (key.casefold(), key))
    labels = _distinct_labels(keys) or [column.replace("_", " ")]
    label = min(labels, key=lambda key: (not (" " in key or any(char.isupper() for char in key)),
                                        key == column, " " not in key, key.casefold(), key))
    titles = _distinct_labels([origin.dataset.metadata.get("title", "").strip() or origin.dataset.name for origin in origins])
    recorded_in = _join_labels(titles) if len(titles) <= 3 else ", ".join(titles[:3]) + f" and {len(titles) - 3} more"
    return f"{label}, as recorded in {recorded_in}."


def _derivation(origins: list[PropertyOrigin]) -> tuple[str | None, str | None]:
    derived = [origin for origin in origins if origin.derived_from is not None and origin.has_values]
    unit = next((origin.unit for origin in derived if origin.unit), None)
    sources = {origin.derived_from for origin in derived}
    has_native = any(origin.derived_from is None and origin.has_values for origin in origins)
    derived_from = next(iter(sources)) if len(sources) == 1 and not has_native else None
    return derived_from, unit


def _prepare_entity(name: str, batches: list[EntityBatch], report: dict[str, Any]) -> tuple[EntityPlan | None, pa.Table | None, set[str]]:
    batches = sorted(batches, key=lambda batch: (-batch.dataset.priority(name), batch.dataset.name))
    mappings, origins = _canonicalize_properties(batches)
    report["columnMaps"][name] = mappings
    extras = _add_quantities(name, batches, mappings, origins, report)
    conflicts: Counter[str] = Counter()
    provenance: dict[str, set[str]] = defaultdict(set)
    for batch in batches:
        for row in batch.rows:
            provenance[row["id"]].add(batch.dataset.name)
    merged = {key: {"id": key, "source_datasets": ",".join(sorted(provenance[key]))} for key in sorted(provenance)}
    report["entities"][name] = {"inputRows": sum(len(batch.rows) for batch in batches), "rowCount": len(merged),
                                "datasets": sorted({batch.dataset.name for batch in batches})}
    report["conflicts"][name] = {}
    if not merged:
        report["skippedEntities"].append(name)
        return None, None, set()
    columns = ["id", "label"] + sorted(set(origins) | {"source_datasets"})
    properties: list[PropertyPlan] = []
    arrays: list[pa.Array] = []
    fields: list[pa.Field] = []
    for column in columns:
        meta, declarations = _column_metadata(name, column, batches, mappings)
        if len({binding_type(value) for value in declarations.values()}) > 1:
            report["declarationConflicts"].append({"entity": name, "column": column, "declarations": declarations, "chosen": binding_type(meta["dataType"])})
        contributors = origins.get(column, [])
        all_values = [row.get(column) for batch in batches for row in batch.rows]
        all_values.extend(value for batch in batches for candidate in extras.get((batch.dataset.name, column), []) for value in candidate.values)
        data_type = "string" if column in RESERVED_PROPERTIES else binding_type(meta.get("dataType") or infer_type(all_values))
        failures = 0
        for batch in batches:
            _, native, count = cast_column([row.get(column) for row in batch.rows], data_type)
            failures += count
            for origin in contributors:
                if origin.dataset.name == batch.dataset.name and origin.derived_from is None:
                    origin.has_values = any(value is not None for value in native)
            candidates = [native]
            for candidate in extras.get((batch.dataset.name, column), []):
                _, typed, count = cast_column(candidate.values, data_type)
                failures += count
                candidate.origin.has_values = any(value is not None for value in typed)
                candidates.append(typed)
            for index, row in enumerate(batch.rows):
                target = merged[row["id"]]
                for candidate in candidates:
                    value = candidate[index]
                    if value is None:
                        continue
                    if target.get(column) is None:
                        target[column] = value
                    elif target[column] != value:
                        conflicts[column] += 1
        if failures:
            report["castErrors"].append({"entity": name, "column": column, "dataType": data_type, "count": failures})
        values = [row.get(column) for row in merged.values()]
        if data_type == "string" and any(value is not None and len(value.encode("utf-8")) > 65535 for value in values):
            raise ValueError(f"{name}.{column} exceeds the graph's 65535-byte string limit; shorten it upstream")
        derived_from, derived_unit = _derivation(contributors)
        unit = meta.get("unit", derived_unit)
        if column == "id":
            description = "The unique key for this entity."
        elif column == "label":
            description = "The display name of this entity."
        elif column == "source_datasets":
            description = "The sorted, comma-separated names of datasets contributing this entity."
        elif derived_from is not None:
            source = next(origin for origin in contributors if origin.derived_from == derived_from and origin.has_values)
            description = f"Numeric value in {unit_words(unit or '')} parsed from {source.raw_key} (for example {source.example})."
        else:
            description = _native_description(column, contributors)
        description = _single_line(meta.get("description") or "") or _single_line(description)
        properties.append(PropertyPlan(column, column, data_type, description, unit, derived_from))
        fields.append(pa.field(column, arrow_type(data_type), nullable=column != "id"))
        arrays.append(pa.array(values, type=arrow_type(data_type)))
    report["conflicts"][name] = dict(sorted(conflicts.items()))
    dataset_names = sorted({batch.dataset.name for batch in batches})
    default_description = f"{snake(name).replace('_', ' ').capitalize()} records merged from datasets {', '.join(dataset_names)}."
    details = [batch.dataset.metadata.get("entityTypes", {}).get(name, {}) for batch in batches]
    entity = EntityPlan(name, snake(name), description=_entity_metadata(batches, name, "description", default_description),
                        synonyms=_synonyms(details), rowCount=len(merged), properties=properties)
    return entity, pa.Table.from_arrays(arrays, schema=pa.schema(fields)), set(merged)


def _edge_reason(source: str, source_type: str, target: str, target_type: str, ids: dict[str, set[str]]) -> str | None:
    if not source or not target:
        return "empty_id"
    if source_type not in ids:
        return "unknown_source_type"
    if target_type not in ids:
        return "unknown_target_type"
    if source not in ids[source_type]:
        return "missing_source"
    if target not in ids[target_type]:
        return "missing_target"
    return None


def _prepare_edges(edges: list[dict[str, Any]], relation_names: set[str], datasets: list[Dataset],
                   ids: dict[str, set[str]], report: dict[str, Any]) -> tuple[list[RelationshipPlan], dict[str, pa.Table], pa.Table]:
    pairs: dict[str, set[tuple[str, str]]] = defaultdict(set)
    grouped: dict[tuple[str, str, str], set[tuple[str, str]]] = defaultdict(set)
    quarantine: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str, str, str]] = set()
    for edge in edges:
        relation = edge["relation"]
        source, source_type, target, target_type = (edge[key] for key in ("source_id", "source_type", "target_id", "target_type"))
        key = (relation, source_type, source, target_type, target)
        if key in seen:
            report["duplicateEdges"] += 1
            continue
        seen.add(key)
        reason = _edge_reason(source, source_type, target, target_type, ids)
        if reason:
            quarantine.append(dict(edge, reason=reason))
        else:
            pairs[relation].add((source_type, target_type))
            grouped[relation, source_type, target_type].add((source, target))
    relationships: list[RelationshipPlan] = []
    tables: dict[str, pa.Table] = {}
    edge_schema = pa.schema([pa.field("source_id", pa.string(), nullable=False), pa.field("target_id", pa.string(), nullable=False)])
    for relation in sorted(relation_names):
        if not pairs[relation]:
            report["skippedRelationships"].append(relation)
        for source_type, target_type in sorted(pairs[relation]):
            name = relation if len(pairs[relation]) == 1 else f"{relation}_{source_type}_{target_type}"
            values = sorted(grouped.get((relation, source_type, target_type), set()))
            report["relationships"][name] = {"relation": relation, "fromEntity": source_type, "toEntity": target_type, "edgeCount": len(values)}
            if not values:
                report["skippedRelationships"].append(name)
                continue
            details = [dataset.metadata.get("relationshipTypes", {}).get(relation, {})
                       for dataset in sorted(datasets, key=lambda dataset: (-dataset.priority(), dataset.name))]
            default = f"Relationship {relation} from {source_type} to {target_type}."
            description = next((meta["description"] for meta in details if meta.get("description")), default)
            table = "rel_" + snake(name)
            if table in tables:
                raise ValueError(f"Relationship table name collision: {table}")
            relationships.append(RelationshipPlan(name, relation, source_type, target_type, table,
                                                  description=description, synonyms=_synonyms(details), edgeCount=len(values)))
            tables[table] = pa.Table.from_pylist([{"source_id": source, "target_id": target} for source, target in values], schema=edge_schema)
    quarantine_fields = [pa.field(key, pa.string()) for key in ("relation", "source_id", "source_type", "target_id", "target_type", "reason", "_dataset", "_source_file", "_run_id")]
    quarantine_fields.append(pa.field("_row_number", pa.int64()))
    report["quarantinedEdges"] = {"count": len(quarantine), "byReason": dict(sorted(Counter(edge["reason"] for edge in quarantine).items()))}
    return relationships, tables, pa.Table.from_pylist(quarantine, schema=pa.schema(quarantine_fields))


def run(landing: Storage, table_writer: TableWriter, run_id: str, *, raw_schema: str = "raw",
        binding_schema: str = "dbo", output: Storage | None = None, output_dir: str | None = None,
        now: datetime | None = None, publish_mode: str = "staged",
        copied_raw: tuple[RawTableReader, str] | None = None) -> dict[str, Any]:
    """Prepare one run. ``copied_raw`` names a reader and the schema where an ingest pipeline has already copied each
    landed file into its raw table; those tables are read instead of the files, and only files without one are parsed."""
    validate_run_id(run_id)
    validate_table_name(raw_schema)
    validate_table_name(binding_schema)
    if raw_schema == binding_schema:
        raise ValueError("Raw and binding schemas must be different")
    publication = PublicationPlan(publish_mode, raw_schema, binding_schema,
                                  rawSchemaNaming="pipeline" if copied_raw is not None else "hashed")
    raw_schema, binding_schema = publication.schemas(run_id)
    copied_reader, copied_schema = copied_raw if copied_raw is not None else (None, "")
    if copied_raw is not None and copied_schema != raw_schema:
        raise ValueError(f"The pipeline copied this run's raw tables into {copied_schema!r}, but its raw schema is {raw_schema!r}")
    snapshot = SnapshotReader(landing)
    timestamp = now or datetime.now(timezone.utc)
    if timestamp.tzinfo is None:
        raise ValueError("The ingestion clock must be timezone-aware")
    timestamp = timestamp.astimezone(timezone.utc)
    datasets = discover(snapshot)
    if not datasets:
        raise ValueError("No dataset folders found; expected entities/, relationships/ or dataset.json")
    report: dict[str, Any] = {"runId": run_id, "createdAt": timestamp.isoformat(), "datasets": {}, "entities": {},
                              "relationships": {}, "columnMaps": {}, "conflicts": {}, "parseErrors": [], "castErrors": [],
                              "declarationConflicts": [], "derivedColumns": [], "duplicateEdges": 0,
                              "skippedEntities": [], "skippedRelationships": []}
    batches: dict[str, list[EntityBatch]] = defaultdict(list)
    edges: list[dict[str, Any]] = []
    relation_names: set[str] = set()
    writes: dict[tuple[str, str], pa.Table] = {}
    raw_names: set[str] = set()
    for dataset in datasets:
        report["datasets"][dataset.name] = {"files": {}}
        for name in dataset.metadata.get("entityTypes", {}):
            if name not in dataset.entities:
                batches[name].append(EntityBatch(dataset, name, []))
        relation_names.update(dataset.metadata.get("relationshipTypes", {}))
        folder = PurePosixPath(dataset.path).name or dataset.name
        for kind, sources in (("entity", dataset.entities), ("relationship", dataset.relationships)):
            for name, path in sorted(sources.items()):
                raw_table = raw_table_name(folder, kind, name)
                if raw_table in raw_names:
                    raise ValueError(f"Raw table name collision: {raw_schema}.{raw_table}")
                raw_names.add(raw_table)
                copied = copied_reader.read_table(raw_schema, raw_table) if copied_reader is not None else None
                if copied is not None:
                    snapshot.read_bytes(path)  # the run's fingerprint still covers the landed file
                    data = rows_from_records(copied.column_names, copied.to_pylist(), path, kind)
                    raw_mapping = {column: column for column in copied.column_names}
                else:
                    data = read_rows(snapshot, path, kind)
                    raw_data, raw_mapping = _raw_table(data, dataset, path, run_id, timestamp)
                    writes[raw_schema, raw_table] = raw_data
                for error in data.errors:
                    _error(report, dataset, path, error["row"], "row_parse", error["error"])
                report["datasets"][dataset.name]["files"][path] = {"rows": len(data.rows), "rawTable": raw_table,
                    "rawSource": "pipeline copy" if copied is not None else "file", "rawColumnMap": raw_mapping,
                    "duplicateIds": 0, "invalidIds": 0, "acceptedRows": sum(data.valid)}
                LOG.info("Discovered %s: %d rows (%s %s)", path, len(data.rows), kind, name)
                if kind == "entity":
                    batches[name].append(EntityBatch(dataset, name, _expand(data, dataset, name, path, report)))
                else:
                    relation_names.add(name)
                    for row, number, valid in zip(data.rows, data.row_numbers, data.valid):
                        edge = {key: row.get(key, "").strip() if isinstance(row.get(key), str) else ""
                                for key in ("source_id", "source_type", "target_id", "target_type")}
                        for identifier in ("source_id", "target_id"):
                            if is_null(edge[identifier]):
                                edge[identifier] = ""
                        if not valid:
                            edge["source_id"] = ""
                        edge.update(relation=name, _dataset=dataset.name, _source_file=path, _row_number=number, _run_id=run_id)
                        edges.append(edge)
    entities: list[EntityPlan] = []
    ids: dict[str, set[str]] = {}
    for name in sorted(batches):
        entity, table, ids[name] = _prepare_entity(name, batches[name], report)
        if entity is not None and table is not None:
            if (binding_schema, entity.table) in writes:
                raise ValueError(f"Entity table name collision: {entity.table}")
            entities.append(entity)
            writes[binding_schema, entity.table] = table
    relationships, edge_tables, quarantine = _prepare_edges(edges, relation_names, datasets, ids, report)
    plan = OntologyPlan(runId=run_id, createdAt=timestamp.isoformat(), bindingSchema=binding_schema,
                        rawSchema=raw_schema, entities=entities, relationships=relationships, publication=publication)
    validate_plan(plan)
    for name, table in edge_tables.items():
        writes[binding_schema, name] = table
    writes[raw_schema, "quarantine_edges"] = quarantine
    destination = output or landing
    directory = relative_path(output_dir if output_dir is not None else f"_prepared/{run_id}", allow_empty=True)
    prefix = directory + "/" if directory else ""
    plan_path, quality_path = prefix + "ontology-plan.json", prefix + "quality-report.json"
    status_path = prefix + "prepare-status.json"
    summary = {"runId": run_id, "planPath": plan_path, "qualityPath": quality_path, "statusPath": status_path,
               "entities": len(entities), "relationships": len(relationships), "bindingSchema": binding_schema, "rawSchema": raw_schema,
               "entityRows": sum(entity.rowCount for entity in entities), "edges": sum(rel.edgeCount for rel in relationships),
               "quarantinedEdges": report["quarantinedEdges"]["count"], "parseErrors": len(report["parseErrors"]),
               "castErrors": sum(error["count"] for error in report["castErrors"])}
    fingerprint = snapshot.fingerprint([{"name": dataset.name, "path": dataset.path} for dataset in datasets], publication)
    previous = optional_json(destination, status_path)
    if publish_mode == "staged":
        schema_exists = getattr(table_writer, "schema_exists", None)
        if not callable(schema_exists):
            raise ValueError("Staged preparation requires a table writer with schema_exists")
        expected_schemas = {schema for schema, _ in writes}
        if previous is not None:
            if previous.get("inputFingerprint") != fingerprint or previous.get("bindingSchema") != binding_schema or previous.get("rawSchema") != raw_schema:
                raise ValueError("A staged run is an immutable snapshot; use a new run_id for changed input or settings")
            if previous.get("state") == "writing":
                raise ValueError("This staged run may still be writing; use a new run_id instead of overlapping its upload")
            if previous.get("state") == "complete":
                existing_plan = destination.read_bytes(plan_path)
                if previous.get("planSha256") != hashlib.sha256(existing_plan).hexdigest():
                    raise ValueError("Existing staged snapshot plan does not match its completion marker")
                if any(not schema_exists(schema) for schema in expected_schemas):
                    raise ValueError("The staged snapshot is no longer available, possibly due to retention; use a new run_id")
                return previous["summary"]
            if previous.get("state") != "failed":
                raise ValueError("Existing staged snapshot has an unknown state")
        elif any(schema_exists(schema) for schema in expected_schemas - {copied_schema}):
            raise ValueError("Refusing to overwrite an existing staged schema without matching snapshot ownership")
    status = {"runId": run_id, "createdAt": timestamp.isoformat(), "state": "writing", "inputFingerprint": fingerprint,
              "bindingSchema": binding_schema, "rawSchema": raw_schema, "publication": publication.to_dict()}
    destination.write_bytes(status_path, (compact_json(status) + "\n").encode("utf-8"))
    try:
        for (schema_name, table_name), table in sorted(writes.items(), key=lambda entry: (entry[0][0] != raw_schema, entry[0][1])):
            table_writer.write(schema_name, table_name, table)
        destination.write_bytes(quality_path, (compact_json(report) + "\n").encode("utf-8"))
        plan_bytes = plan.to_json().encode("utf-8")
        destination.write_bytes(plan_path, plan_bytes)
        status.update(state="complete", planSha256=hashlib.sha256(plan_bytes).hexdigest(), summary=summary)
        destination.write_bytes(status_path, (compact_json(status) + "\n").encode("utf-8"))
    except Exception as error:
        status.update(state="failed", errorType=type(error).__name__)
        try:
            destination.write_bytes(status_path, (compact_json(status) + "\n").encode("utf-8"))
        except Exception:
            LOG.warning("Could not persist failed preparation status for run %s", run_id)
        raise
    return summary
