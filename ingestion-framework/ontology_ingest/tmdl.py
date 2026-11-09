"""Generate the documented TMDL ontology subset, with structural round-trip checks."""
from __future__ import annotations

import base64
import json
import re
from typing import Any

from .naming import lineage_tag, quote_name
from .plan import EntityPlan, OntologyPlan, PropertyPlan, _name, validate_plan
from .storage import relative_path
from .values import binding_type

PLATFORM_SCHEMA = "https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json"


ITEM_DESCRIPTION_LIMIT = 256


def platform_metadata(name: str, description: str, item_type: str = "Ontology") -> str:
    _name(name, "item")
    if not isinstance(description, str):
        raise ValueError("Item description must be a string")
    if len(description) > ITEM_DESCRIPTION_LIMIT:
        raise ValueError(f"Fabric item descriptions are limited to {ITEM_DESCRIPTION_LIMIT} characters; this one has {len(description)}")
    return json.dumps({"$schema": PLATFORM_SCHEMA,
                       "metadata": {"type": item_type, "displayName": name, "description": description},
                       "config": {"version": "2.0", "logicalId": "00000000-0000-0000-0000-000000000000"}},
                      ensure_ascii=False, indent=2) + "\n"


def _comments(text: str, level: int = 0) -> list[str]:
    return ["\t" * level + "/// " + "".join(char if ord(char) >= 32 else " " for char in line)
            for line in text[:4000].splitlines()]


def _finish(lines: list[str]) -> str:
    return "\n".join(lines).rstrip() + "\n\n" if lines else ""


def _properties(entity: EntityPlan) -> list[PropertyPlan]:
    return sorted(entity.properties, key=lambda prop: (0 if prop.name == "id" else 1 if prop.name == "label" else 2, prop.name))


def _table(name: str, columns: list[tuple[str, str]], schema: str, identity_schema: str | None = None) -> str:
    """Render a table. Lineage tags come from the logical identity (the binding schema base and the table name), so a
    staged run that moves the table to a new physical schema updates the existing table in place; the service rejects
    an update that keeps a table's name but changes its lineage tag ("No element with lineage tag ... in DataSources")."""
    identity = identity_schema or schema
    lines = [f"table {quote_name(name)}", f"\tlineageTag: {lineage_tag('table', identity, name)}"]
    for column, data_type in columns:
        lines += ["", f"\tcolumn {quote_name(column)}", f"\t\tdataType: {binding_type(data_type)}"]
        if data_type == "int64":
            lines.append("\t\tformatString: 0")
        elif data_type == "dateTime":
            lines.append("\t\tformatString: General Date")
        lines += [f"\t\tlineageTag: {lineage_tag('column', identity, name, column)}", f"\t\tsourceColumn: {quote_name(column)}"]
    lines += ["", f"\tpartition {quote_name(name)} = entity", "\t\tmode: directLake", "\t\tsource",
              f"\t\t\tentityName: {quote_name(name)}", f"\t\t\tschemaName: {quote_name(schema)}",
              "\t\t\texpressionSource: DatabaseQuery"]
    return _finish(lines)


def _entity(entity: EntityPlan) -> str:
    lines = _comments(entity.description) + [f"entity {quote_name(entity.name)}",
             f"\tlineageTag: {lineage_tag('entity', entity.name)}", f"\tbackingTable: {quote_name(entity.table)}",
             f"\tkeyProperty: {quote_name(entity.keyProperty)}"]
    for prop in _properties(entity):
        lines += [""] + _comments(prop.description, 1)
        lines += [f"\tproperty {quote_name(prop.name)}", f"\t\tdataType: {binding_type(prop.dataType)}",
                  f"\t\tlineageTag: {lineage_tag('property', entity.name, prop.name)}", "", "\t\tbackingConfiguration",
                  f"\t\t\tvalueColumn: {quote_name(entity.table)}.{quote_name(prop.column)}"]
    for synonym in sorted(set(entity.synonyms)):
        lines += ["", f"\tsynonym {quote_name(synonym)}"]
    return _finish(lines)


def _m_string(value: str) -> str:
    if not isinstance(value, str) or not value.strip() or any(ord(char) < 32 for char in value):
        raise ValueError("SQL endpoint host and id must be nonempty strings without control characters")
    return '"' + value.replace("#", "#(#)").replace('"', '""') + '"'


def build_definition(plan: OntologyPlan, ontology_name: str, description: str,
                     sql_endpoint_host: str, sql_endpoint_id: str) -> dict[str, str]:
    validate_plan(plan)
    host, endpoint = _m_string(sql_endpoint_host), _m_string(sql_endpoint_id)
    parts = {".platform": platform_metadata(ontology_name, description),
             "database.tmdl": "database\n\tcompatibilityLevel: 1000000\n\n",
             "namespaces/default.tmdl": "namespace default\n\tlineageTag: default\n\n",
             "expressions.tmdl": _finish(["expression DatabaseQuery =", "\t\tlet",
                 f"\t\t    database = Sql.Database({host}, {endpoint})", "\t\tin", "\t\t    database",
                 f"\tlineageTag: {lineage_tag('expression', 'DatabaseQuery')}"])}
    entities = {entity.name: entity for entity in plan.entities}
    identity = plan.publication.bindingSchemaBase if plan.publication is not None else plan.bindingSchema
    for entity in sorted(plan.entities, key=lambda entity: entity.name):
        parts[f"tables/{entity.table}.tmdl"] = _table(entity.table, [(prop.column, prop.dataType) for prop in _properties(entity)],
                                                      plan.bindingSchema, identity)
        parts[f"entities/{entity.name}.tmdl"] = _entity(entity)
    tom_lines: list[str] = []
    relationship_lines: list[str] = []
    for rel in sorted(plan.relationships, key=lambda rel: rel.name):
        source, target = entities[rel.fromEntity], entities[rel.toEntity]
        key_types = {entity.name: next(prop.dataType for prop in entity.properties if prop.name == entity.keyProperty)
                     for entity in (source, target)}
        parts[f"tables/{rel.table}.tmdl"] = _table(rel.table, [(rel.fromColumn, key_types[source.name]),
                                                                           (rel.toColumn, key_types[target.name])], plan.bindingSchema, identity)
        for suffix, column, entity in (("__from", rel.fromColumn, source), ("__to", rel.toColumn, target)):
            name = rel.table + suffix
            tom_lines.append(f"relationship {quote_name(name)}")
            if suffix == "__to" and source.name == target.name:
                tom_lines.append("\tisActive: false")
            tom_lines += [f"\tfromColumn: {quote_name(rel.table)}.{quote_name(column)}",
                          f"\ttoColumn: {quote_name(entity.table)}.{quote_name(entity.keyProperty)}", ""]
        relationship_lines += _comments(rel.description)
        relationship_lines += [f"entityRelationship {quote_name(rel.name)}",
              f"\tlineageTag: {lineage_tag('entityRelationship', rel.relation, rel.fromEntity, rel.toEntity)}",
              f"\tfromEntity: {quote_name(rel.fromEntity)}", f"\ttoEntity: {quote_name(rel.toEntity)}",
              "", "\tbackingConfiguration", "\t\ttype: table", f"\t\ttable: {quote_name(rel.table)}",
              f"\t\tfromRelationship: {quote_name(rel.table + '__from')}", f"\t\ttoRelationship: {quote_name(rel.table + '__to')}"]
        for synonym in sorted(set(rel.synonyms)):
            relationship_lines += ["", f"\tsynonym {quote_name(synonym)}"]
        relationship_lines.append("")
    parts["relationships.tmdl"] = _finish(tom_lines)
    parts["entityRelationships.tmdl"] = _finish(relationship_lines)
    tables = sorted([entity.table for entity in plan.entities] + [rel.table for rel in plan.relationships])
    model_lines = ["model Model", ""] + [f"ref table {quote_name(table)}" for table in tables]
    model_lines += [""] + [f"ref entity {quote_name(name)}" for name in sorted(entities)]
    model_lines += ["", "ref namespace default"]
    parts["model.tmdl"] = _finish(model_lines)
    verify_definition(plan, parts)
    return dict(sorted(parts.items()))


def to_api_definition(parts: dict[str, str]) -> dict[str, Any]:
    payload = []
    for path, text in sorted(parts.items()):
        relative_path(path)
        if not isinstance(text, str):
            raise ValueError(f"Definition part {path} must be UTF-8 text")
        payload.append({"path": path, "payload": base64.b64encode(text.encode("utf-8")).decode("ascii"), "payloadType": "InlineBase64"})
    return {"parts": payload}


def _unquote(value: str) -> str:
    value = value.strip()
    return value[1:-1].replace("''", "'") if value.startswith("'") and value.endswith("'") else value


def _canonical(value: str) -> str:
    value = _unquote(value)
    return value[len("default#"):] if value.startswith("default#") else value


def _reference(value: str) -> tuple[str, str]:
    match = re.fullmatch(r"('(?:[^']|'')*'|[^.]+)\.('(?:[^']|'')*'|[^.]+)", value)
    if not match:
        raise ValueError(f"Invalid column reference in returned definition: {value!r}")
    return _unquote(match[1]), _unquote(match[2])


def _objects(parts: dict[str, str]) -> dict[str, dict[str, dict[str, Any]]]:
    objects: dict[str, dict[str, dict[str, Any]]] = {kind: {} for kind in ("entity", "table", "entityRelationship", "relationship", "expression")}
    for path, text in parts.items():
        if not path.endswith(".tmdl"):
            continue
        current: dict[str, Any] | None = None
        child: dict[str, str] | None = None
        for raw in text.splitlines():
            stripped = raw.strip()
            if not stripped or stripped.startswith("///"):
                continue
            indent = len(raw.expandtabs(4)) - len(raw.expandtabs(4).lstrip())
            if indent == 0:
                header = re.fullmatch(r"(entityRelationship|entity|table|relationship|expression)\s+(.+)", stripped)
                current, child = None, None
                if header:
                    kind, name = header[1], header[2]
                    name = name.removesuffix(" =") if kind == "expression" else name
                    name = _canonical(name) if kind in {"entity", "entityRelationship"} else _unquote(name)
                    if name in objects[kind]:
                        raise ValueError(f"Duplicate {kind} in returned definition: {name}")
                    current = {"fields": {}, "properties": {}, "columns": {}}
                    objects[kind][name] = current
            elif current is not None:
                if indent == 4:
                    child = None
                    for keyword, group in (("property ", "properties"), ("column ", "columns")):
                        if stripped.startswith(keyword):
                            name = _unquote(stripped[len(keyword):])
                            if name in current[group]:
                                raise ValueError(f"Duplicate {group} member: {name}")
                            child = {}
                            current[group][name] = child
                if ":" in stripped and not stripped.startswith(("synonym ", "annotation ")):
                    key, value = stripped.split(":", 1)
                    target = child if child is not None and indent > 4 else current["fields"]
                    target[key.strip()] = value.strip()
    return objects


def verify_definition(plan: OntologyPlan, parts: dict[str, str]) -> dict[str, int]:
    """Check our binding subset, not byte equality or service-added metadata."""
    validate_plan(plan)
    required = {".platform", "database.tmdl", "model.tmdl", "namespaces/default.tmdl"}
    if not required <= parts.keys():
        raise ValueError(f"Definition is missing required parts: {sorted(required - parts.keys())}")
    if json.loads(parts[".platform"]).get("metadata", {}).get("type") != "Ontology":
        raise ValueError("Returned item definition is not an Ontology")
    if not re.search(r"^\s*compatibilityLevel:\s*1000000\s*$", parts["database.tmdl"], re.MULTILINE):
        raise ValueError("Missing ontology compatibility level 1000000")
    if not re.search(r"^ref namespace (?:default|'default')\s*$", parts["model.tmdl"], re.MULTILINE):
        raise ValueError("Model must reference the default namespace")
    objects = _objects(parts)

    def get(kind: str, name: str) -> dict[str, Any]:
        if name not in objects[kind]:
            raise ValueError(f"Definition is missing {kind} {name}")
        return objects[kind][name]

    def expect(fields: dict[str, str], key: str, value: str, owner: str, *, canonical: bool = False) -> None:
        actual = (_canonical if canonical else _unquote)(fields.get(key, ""))
        if actual != value:
            raise ValueError(f"Definition mismatch for {owner}.{key}: expected {value!r}, got {actual!r}")

    def table(name: str, columns: list[tuple[str, str]]) -> None:
        data = get("table", name)
        for key, value in (("mode", "directLake"), ("entityName", name), ("schemaName", plan.bindingSchema), ("expressionSource", "DatabaseQuery")):
            expect(data["fields"], key, value, name)
        for column, data_type in columns:
            if column not in data["columns"]:
                raise ValueError(f"Definition is missing column {name}.{column}")
            expect(data["columns"][column], "dataType", binding_type(data_type), f"{name}.{column}")
            expect(data["columns"][column], "sourceColumn", column, f"{name}.{column}")

    entities = {entity.name: entity for entity in plan.entities}
    if entities or plan.relationships:
        get("expression", "DatabaseQuery")
    for entity in plan.entities:
        actual = get("entity", entity.name)
        expect(actual["fields"], "backingTable", entity.table, entity.name)
        expect(actual["fields"], "keyProperty", entity.keyProperty, entity.name)
        table(entity.table, [(prop.column, prop.dataType) for prop in entity.properties])
        for prop in entity.properties:
            if prop.name not in actual["properties"]:
                raise ValueError(f"Definition is missing property {entity.name}.{prop.name}")
            fields = actual["properties"][prop.name]
            expect(fields, "dataType", binding_type(prop.dataType), prop.name)
            if _reference(fields.get("valueColumn", "")) != (entity.table, prop.column):
                raise ValueError(f"Definition mismatch for binding {entity.name}.{prop.name}")
    for rel in plan.relationships:
        actual = get("entityRelationship", rel.name)["fields"]
        expect(actual, "fromEntity", rel.fromEntity, rel.name, canonical=True)
        expect(actual, "toEntity", rel.toEntity, rel.name, canonical=True)
        for key, value in (("table", rel.table), ("fromRelationship", rel.table + "__from"), ("toRelationship", rel.table + "__to")):
            expect(actual, key, value, rel.name)
        if actual.get("type", "table") != "table":
            raise ValueError(f"Relationship {rel.name} must be junction-table-backed")
        columns: list[tuple[str, str]] = []
        for suffix, column, entity_name in (("__from", rel.fromColumn, rel.fromEntity), ("__to", rel.toColumn, rel.toEntity)):
            entity = entities[entity_name]
            data_type = next(prop.dataType for prop in entity.properties if prop.name == entity.keyProperty)
            columns.append((column, data_type))
            fields = get("relationship", rel.table + suffix)["fields"]
            if _reference(fields.get("fromColumn", "")) != (rel.table, column) or _reference(fields.get("toColumn", "")) != (entity.table, entity.keyProperty):
                raise ValueError(f"Definition mismatch for TOM relationship {rel.table + suffix}")
            if suffix == "__to" and rel.fromEntity == rel.toEntity and fields.get("isActive", "true").lower() != "false":
                raise ValueError(f"Self-relationship {rel.name} requires its target TOM relationship to be inactive")
        table(rel.table, columns)
    return {"entities": len(plan.entities), "relationships": len(plan.relationships), "tables": len(plan.entities) + len(plan.relationships)}
