"""Deterministic names shared by preparation and definition generation."""
from __future__ import annotations

import hashlib
import re
import unicodedata
import uuid
from collections.abc import Iterable

LINEAGE_NAMESPACE = uuid.UUID("c57d82a8-9197-5c0e-bb3d-36b8db178d42")
RESERVED_PROPERTIES = frozenset({"id", "label", "source_datasets"})


def shorten(value: str, limit: int = 120) -> str:
    if len(value) <= limit:
        return value
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:8]
    return value[: limit - 9].rstrip("_") + "_" + digest


def snake(value: str) -> str:
    folded = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    folded = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", folded)
    folded = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", folded)
    folded = re.sub(r"[^a-z0-9]+", "_", folded.lower()).strip("_") or "col"
    if folded[0].isdigit():
        folded = "c_" + folded
    return shorten(folded)


def allocate_name(base: str, used: set[str]) -> str:
    candidate = shorten(base)
    index = 2
    while candidate.casefold() in used:
        suffix = f"_{index}"
        candidate = shorten(base, 120 - len(suffix)) + suffix
        index += 1
    used.add(candidate.casefold())
    return candidate


def column_names(keys: Iterable[str], reserved: Iterable[str] = RESERVED_PROPERTIES) -> dict[str, str]:
    reserved_set = {name.casefold() for name in reserved}
    used = set(reserved_set)
    result: dict[str, str] = {}
    for key in sorted(set(keys)):
        base = snake(key)
        if base.casefold() in reserved_set:
            base += "_prop"
        result[key] = allocate_name(base, used)
    return result


def lineage_tag(*parts: str) -> str:
    if any("\x1f" in part for part in parts):
        raise ValueError("Lineage identity parts must not contain the separator U+001F")
    return str(uuid.uuid5(LINEAGE_NAMESPACE, "\x1f".join(parts)))


def raw_table_name(folder: str, kind: str, stem: str) -> str:
    """The raw table that holds one landed file. A Fabric pipeline expression can only lowercase and replace text, so the
    ingest pipeline's Copy activity builds this same name from the dataset folder and the file name (see pipeline.py)."""
    if kind not in {"entity", "relationship"}:
        raise ValueError("kind must be entity or relationship")
    name = f"{folder.lower().replace('-', '_')}__{'e' if kind == 'entity' else 'r'}_{stem.lower()}"
    if not re.fullmatch(r"[a-z][a-z0-9_]*", name) or len(name) > 512:
        raise ValueError(f"Dataset folder {folder!r} and file {stem!r} must use only letters, digits, hyphens and underscores, "
                         f"starting with a letter, so that the pipeline and the framework name the raw table the same way")
    return name


def quote_name(value: str) -> str:
    if not value or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError("TMDL names must be nonempty and contain no control characters")
    if re.fullmatch(r"[A-Za-z0-9_]+", value):
        return value
    return "'" + value.replace("'", "''") + "'"


def validate_identifier(value: str, kind: str = "name") -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", value):
        raise ValueError(f"Invalid {kind}: {value!r}; expected [A-Za-z][A-Za-z0-9_]*")
    if len(value) > 512:
        raise ValueError(f"{kind} exceeds 512 characters")
    return value


def validate_table_name(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[a-z][a-z0-9_]*", value):
        raise ValueError(f"Invalid table or schema name: {value!r}")
    if len(value) > 512:
        raise ValueError("Table or schema name exceeds 512 characters")
    return value


def validate_run_id(run_id: str) -> str:
    if not isinstance(run_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,119}", run_id):
        raise ValueError("run_id must contain 1 to 120 letters, digits, dots, underscores or hyphens, starting with a letter or digit")
    return run_id


def staged_schema(base: str, run_id: str) -> str:
    validate_table_name(base)
    validate_run_id(run_id)
    digest = hashlib.sha256((base + "\x1f" + run_id).encode("utf-8")).hexdigest()[:12]
    return shorten(snake(base + "_" + run_id), 107) + "_" + digest


def validate_pipeline_run_id(run_id: str) -> str:
    """Pipeline run ids become part of schema names in pipeline expressions, which cannot rewrite them, so they are restricted."""
    if not isinstance(run_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_]{0,59}", run_id):
        raise ValueError("A pipeline run id must use 1 to 60 lowercase letters, digits and underscores, such as live6")
    return run_id


def pipeline_raw_schema(base: str, run_id: str) -> str:
    """The staged raw schema an ingest pipeline copies a run into. Pipeline expressions cannot hash, so the name carries no
    digest; the restricted pipeline run id keeps it unique and lets the pipeline build it as concat(base, '_', run_id)."""
    validate_table_name(base)
    return validate_table_name(base + "_" + validate_pipeline_run_id(run_id))
