"""Versioned intermediate representation, independent of transport and storage."""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from typing import Any, TypeVar

from .naming import pipeline_raw_schema, quote_name, staged_schema, validate_table_name
from .values import DATA_TYPES, binding_type

T = TypeVar("T", bound="JsonRecord")


class JsonRecord:
    def to_dict(self) -> dict[str, Any]:
        return asdict(self)  # type: ignore[arg-type]

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), sort_keys=True, indent=2, ensure_ascii=False, allow_nan=False) + "\n"

    @classmethod
    def from_dict(cls: type[T], value: dict[str, Any]) -> T:
        return cls(**value)

    @classmethod
    def from_json(cls: type[T], value: str | bytes) -> T:
        data = json.loads(value)
        if not isinstance(data, dict):
            raise ValueError(f"{cls.__name__} must be a JSON object")
        try:
            return cls.from_dict(data)
        except (TypeError, KeyError) as error:
            raise ValueError(f"Invalid {cls.__name__}: {error}") from error


@dataclass
class PropertyPlan(JsonRecord):
    name: str
    column: str
    dataType: str
    description: str = ""
    unit: str | None = None
    derivedFrom: str | None = None

    def __post_init__(self) -> None:
        self.dataType = binding_type(self.dataType)


@dataclass
class EntityPlan(JsonRecord):
    name: str
    table: str
    keyProperty: str = "id"
    description: str = ""
    synonyms: list[str] = field(default_factory=list)
    rowCount: int = 0
    properties: list[PropertyPlan] = field(default_factory=list)

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> EntityPlan:
        fields = dict(value)
        fields["properties"] = [PropertyPlan.from_dict(prop) for prop in fields.get("properties", [])]
        return cls(**fields)


@dataclass
class RelationshipPlan(JsonRecord):
    name: str
    relation: str
    fromEntity: str
    toEntity: str
    table: str
    fromColumn: str = "source_id"
    toColumn: str = "target_id"
    description: str = ""
    synonyms: list[str] = field(default_factory=list)
    edgeCount: int = 0


@dataclass
class PublicationPlan(JsonRecord):
    mode: str
    rawSchemaBase: str
    bindingSchemaBase: str
    # "pipeline" when an ingest pipeline copied the raw tables into an unhashed per-run schema (naming.pipeline_raw_schema).
    rawSchemaNaming: str = "hashed"

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        if self.rawSchemaNaming == "hashed":
            del data["rawSchemaNaming"]  # records written before the field existed keep their exact form
        return data

    def schemas(self, run_id: str) -> tuple[str, str]:
        validate_table_name(self.rawSchemaBase)
        validate_table_name(self.bindingSchemaBase)
        if self.rawSchemaNaming not in {"hashed", "pipeline"}:
            raise ValueError("rawSchemaNaming must be hashed or pipeline")
        if self.mode == "staged":
            raw = pipeline_raw_schema(self.rawSchemaBase, run_id) if self.rawSchemaNaming == "pipeline" else staged_schema(self.rawSchemaBase, run_id)
            return raw, staged_schema(self.bindingSchemaBase, run_id)
        if self.mode == "in_place":
            return self.rawSchemaBase, self.bindingSchemaBase
        raise ValueError("publish_mode must be staged or in_place")


@dataclass
class OntologyPlan(JsonRecord):
    contractVersion: str = "1"
    runId: str = ""
    createdAt: str = ""
    bindingSchema: str = "dbo"
    rawSchema: str = "raw"
    entities: list[EntityPlan] = field(default_factory=list)
    relationships: list[RelationshipPlan] = field(default_factory=list)
    sqlEndpoint: dict[str, str] | None = None
    publication: PublicationPlan | None = None

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> OntologyPlan:
        fields = dict(value)
        fields["entities"] = [EntityPlan.from_dict(entity) for entity in fields.get("entities", [])]
        fields["relationships"] = [RelationshipPlan.from_dict(rel) for rel in fields.get("relationships", [])]
        if fields.get("publication") is not None:
            fields["publication"] = PublicationPlan.from_dict(fields["publication"])
        plan = cls(**fields)
        validate_plan(plan)
        return plan


def _name(value: str, kind: str) -> None:
    if not isinstance(value, str) or not value.strip() or len(value) > 512:
        raise ValueError(f"{kind} must be a nonempty name of at most 512 characters")
    if any(char in value for char in "/\\#"):
        raise ValueError(f"{kind} cannot contain a path separator or namespace marker: {value!r}")
    quote_name(value)


def _unique(values: list[str], kind: str) -> None:
    seen: set[str] = set()
    for value in values:
        _name(value, kind)
        if value.casefold() in seen:
            raise ValueError(f"Duplicate {kind} name (case-insensitive): {value}")
        seen.add(value.casefold())


def _metadata(description: str, synonyms: list[str]) -> None:
    if not isinstance(description, str):
        raise ValueError("Descriptions must be strings")
    if not isinstance(synonyms, list) or len(synonyms) > 100:
        raise ValueError("An object can have at most 100 synonyms")
    for synonym in synonyms:
        if not isinstance(synonym, str) or not synonym or len(synonym) > 100:
            raise ValueError("Each synonym must contain 1 to 100 characters")
        quote_name(synonym)


def validate_plan(plan: OntologyPlan) -> None:
    if plan.contractVersion != "1":
        raise ValueError("Only ontology plan contractVersion '1' is supported")
    validate_table_name(plan.bindingSchema)
    validate_table_name(plan.rawSchema)
    if plan.bindingSchema == plan.rawSchema:
        raise ValueError("Raw and binding schemas must be different")
    if plan.publication is not None and plan.publication.schemas(plan.runId) != (plan.rawSchema, plan.bindingSchema):
        raise ValueError("Plan schemas do not match their publication ownership metadata")
    _unique([entity.name for entity in plan.entities], "entity")
    _unique([rel.name for rel in plan.relationships], "entity relationship")
    entity_tables = [entity.table for entity in plan.entities]
    junction_tables = [rel.table for rel in plan.relationships]
    if set(entity_tables) & set(junction_tables):
        raise ValueError("A junction table must not also be an entity backing table")
    all_tables = entity_tables + junction_tables
    _unique(all_tables, "table")
    for table in all_tables:
        validate_table_name(table)
    entities = {entity.name: entity for entity in plan.entities}
    for entity in plan.entities:
        _metadata(entity.description, entity.synonyms)
        if not isinstance(entity.rowCount, int) or isinstance(entity.rowCount, bool) or entity.rowCount < 0:
            raise ValueError("Entity rowCount must be a nonnegative integer")
        if len(entity.properties) > 1000:
            raise ValueError(f"Entity {entity.name} exceeds 1000 properties")
        _unique([prop.name for prop in entity.properties], f"property of {entity.name}")
        _unique([prop.column for prop in entity.properties], f"column of {entity.table}")
        props = {prop.name: prop for prop in entity.properties}
        if entity.keyProperty != "id" or "id" not in props or props["id"].dataType not in {"string", "int64"}:
            raise ValueError(f"Entity {entity.name} requires an id key property of type string or int64")
        for prop in entity.properties:
            validate_table_name(prop.column)
            if prop.name != prop.column:
                raise ValueError("Contract v1 property names must match their binding column")
            if not isinstance(prop.dataType, str) or prop.dataType not in DATA_TYPES:
                raise ValueError(f"Unsupported property dataType: {prop.dataType!r}")
            _metadata(prop.description, [])
            if prop.unit is not None and not isinstance(prop.unit, str):
                raise ValueError("Property unit must be a string or null")
            if prop.derivedFrom is not None and prop.derivedFrom not in props:
                raise ValueError(f"Derived property {prop.name} refers to missing property {prop.derivedFrom}")
    for rel in plan.relationships:
        _metadata(rel.description, rel.synonyms)
        if rel.fromEntity not in entities or rel.toEntity not in entities:
            raise ValueError(f"Relationship {rel.name} refers to an unknown entity")
        if rel.fromColumn != "source_id" or rel.toColumn != "target_id":
            raise ValueError("Contract v1 junction columns must be source_id and target_id")
        if not isinstance(rel.edgeCount, int) or isinstance(rel.edgeCount, bool) or rel.edgeCount < 0:
            raise ValueError("Relationship edgeCount must be a nonnegative integer")
    tom_names = [rel.table + suffix for rel in plan.relationships for suffix in ("__from", "__to")]
    _unique(tom_names, "TOM relationship")
    if len(plan.entities) > 10000 or len(plan.relationships) > 10000 or len(tom_names) > 10000:
        raise ValueError("An ontology collection exceeds its 10000-object limit")
    columns = sum(len(entity.properties) for entity in plan.entities) + 2 * len(plan.relationships)
    if 2 + len(all_tables) + columns > 16000:
        raise ValueError("Ontology exceeds the 16000 tables-plus-columns-plus-two budget")
    if plan.sqlEndpoint is not None:
        if not isinstance(plan.sqlEndpoint, dict) or set(plan.sqlEndpoint) != {"host", "id"}:
            raise ValueError("sqlEndpoint must contain exactly host and id")
        if not all(isinstance(value, str) and value for value in plan.sqlEndpoint.values()):
            raise ValueError("sqlEndpoint host and id must be nonempty strings")
