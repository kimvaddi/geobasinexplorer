"""Conservative scalar inference and loss-aware display-quantity derivation."""
from __future__ import annotations

import json
import math
import re
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any, Sequence

import pyarrow as pa

from .naming import snake, shorten

DATA_TYPES = frozenset({"string", "int64", "double", "boolean", "dateTime", "decimal"})
INTEGER = re.compile(r"-?(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)$")
NUMBER_TEXT = r"[+-]?(?:(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?"
NUMBER = re.compile(NUMBER_TEXT + r"$")
ISO_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[Tt ][0-9].*)?$")
QUANTITY = re.compile(
    rf"^(?P<low>{NUMBER_TEXT})(?:\s*(?:to|[–—−-])\s*(?P<high>{NUMBER_TEXT}))?"
    r"\s*(?P<unit>[^\d\s,().+\-–—−][^()]*)$"
)
QUANTITY_NULLS = frozenset({"", "not recorded", "none", "n/a", "unknown", "-"})
INT64_MIN, INT64_MAX = -(2**63), 2**63 - 1


def compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def is_null(value: Any) -> bool:
    return value is None or (isinstance(value, str) and value.strip().casefold() in QUANTITY_NULLS)


def as_string(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, (dict, list, bool)):
        return compact_json(value)
    if isinstance(value, datetime):
        return as_datetime(value).isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return repr(value) if isinstance(value, float) else str(value)


def as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.strip().lower() in {"true", "false", "yes", "no"}:
        return value.strip().lower() in {"true", "yes"}
    raise ValueError("Not a boolean")


def as_int(value: Any) -> int:
    if isinstance(value, bool):
        raise ValueError("A boolean is not an integer property")
    if isinstance(value, int):
        number = value
    elif isinstance(value, str) and INTEGER.fullmatch(value.strip()):
        number = int(value.strip().replace(",", ""))
    elif isinstance(value, (float, Decimal)) and math.isfinite(value) and value == int(value):
        number = int(value)
    else:
        raise ValueError("Not an integer")
    if not INT64_MIN <= number <= INT64_MAX:
        raise ValueError("Integer outside int64")
    return number


def as_double(value: Any) -> float:
    if isinstance(value, bool):
        raise ValueError("A boolean is not a numeric property")
    if isinstance(value, str):
        if not NUMBER.fullmatch(value.strip()):
            raise ValueError("Not a numeric string")
        value = value.strip().replace(",", "")
    elif not isinstance(value, (int, float, Decimal)):
        raise ValueError("Not a number")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Non-finite number")
    return number


def as_datetime(value: Any) -> datetime:
    if isinstance(value, datetime):
        result = value
    elif isinstance(value, date):
        result = datetime.combine(value, datetime.min.time())
    elif isinstance(value, str) and ISO_DATE.fullmatch(value.strip()):
        result = datetime.fromisoformat(value.strip().replace("Z", "+00:00").replace("z", "+00:00"))
    else:
        raise ValueError("Not an ISO-8601 date or datetime")
    if result.tzinfo is None:
        result = result.replace(tzinfo=timezone.utc)
    return result.astimezone(timezone.utc)


def _family(value: Any) -> str:
    if isinstance(value, (dict, list)):
        return "string"
    try:
        as_bool(value)
        return "boolean"
    except ValueError:
        pass
    if isinstance(value, int) or (isinstance(value, str) and INTEGER.fullmatch(value.strip())):
        try:
            as_int(value)
            return "int64"
        except ValueError:
            return "string"
    try:
        as_double(value)
        return "double"
    except (ValueError, OverflowError):
        pass
    try:
        as_datetime(value)
        return "dateTime"
    except (ValueError, OverflowError):
        return "string"


def infer_type(values: Sequence[Any]) -> str:
    families = {_family(value) for value in values if not is_null(value)}
    if not families:
        return "string"
    if families <= {"int64", "double"}:
        return "double" if "double" in families else "int64"
    return next(iter(families)) if len(families) == 1 else "string"


def binding_type(data_type: str) -> str:
    return "double" if data_type == "decimal" else data_type


def cast_column(values: Sequence[Any], declared_type: str | None = None) -> tuple[str, list[Any], int]:
    data_type = binding_type(declared_type or infer_type(values))
    if data_type not in DATA_TYPES:
        raise ValueError(f"Unsupported dataType {data_type!r}")
    caster = {"string": as_string, "boolean": as_bool, "int64": as_int,
              "double": as_double, "dateTime": as_datetime}[data_type]
    result: list[Any] = []
    failures = 0
    for value in values:
        if is_null(value):
            result.append(None)
            continue
        try:
            result.append(caster(value))
        except (ValueError, TypeError, OverflowError):
            result.append(None)
            failures += 1
    return data_type, result, failures


def arrow_type(data_type: str) -> pa.DataType:
    return {"string": pa.string(), "int64": pa.int64(), "double": pa.float64(),
            "boolean": pa.bool_(), "dateTime": pa.timestamp("us", tz="UTC"),
            "decimal": pa.float64()}[data_type]


def unit_slug(unit: str) -> str:
    normalized = unicodedata.normalize("NFKC", unit.strip())
    return {"m": "m", "km": "km", "km2": "km2", "Ma": "ma", "ma": "ma",
            "°C": "c", "°c": "c", "C": "c", "ft": "ft", "s": "s", "ms": "ms",
            "%": "pct"}.get(normalized, snake(normalized))


def unit_words(unit: str) -> str:
    slug = unit_slug(unit)
    return {"m": "metres", "km": "kilometres", "km2": "square kilometres", "ma": "millions of years",
            "c": "degrees Celsius", "ft": "feet", "s": "seconds", "ms": "milliseconds", "pct": "percent"}.get(slug, slug)


@dataclass(frozen=True)
class DerivedColumn:
    name: str
    values: list[float | None]
    derivedFrom: str
    unit: str


def _quantity(value: str) -> tuple[str, str, float, float | None] | None:
    value = value.strip().replace("−", "-")
    family_prefix = ""
    trailing = re.fullmatch(r".+\(([^()]*)\)\s*", value)
    if trailing:
        value = trailing.group(1).strip()
        family_prefix = "parenthesized_"
    if re.fullmatch(rf"{NUMBER_TEXT}(?:\s*(?:to|[–—−-])\s*{NUMBER_TEXT})?", value):
        return None
    match = QUANTITY.fullmatch(value)
    if not match:
        return None
    unit = unicodedata.normalize("NFKC", match["unit"].strip())
    if not unit or not any(char.isalpha() or char in "%°" for char in unit):
        return None
    # Dimensional units are legitimate; arbitrary digits here usually mean an unparsed range.
    if any(char.isdigit() for char in unit) and unit not in {"m2", "km2", "m3", "km3"}:
        return None
    try:
        low = as_double(match["low"])
        high = as_double(match["high"]) if match["high"] is not None else None
    except (ValueError, OverflowError):
        return None
    if high is not None:
        low, high = min(low, high), max(low, high)
    return family_prefix + ("range" if high is not None else "number"), unit, low, high


def derive_quantities(column: str, values: Sequence[Any]) -> list[DerivedColumn]:
    tokens = snake(column).split("_")
    while tokens and (tokens[-1].isdigit() or tokens[-1] == "prop"):
        tokens.pop()
    if set(tokens) & {"id", "ids", "identifier", "identifiers", "code", "codes", "uuid", "guid", "url", "uri"} or tokens[-1:] in (["ref"], ["reference"]):
        return []
    parsed: list[tuple[str, str, float, float | None] | None] = []
    for value in values:
        if is_null(value):
            parsed.append(None)
        elif not isinstance(value, str):
            return []
        elif value.strip().lower() in QUANTITY_NULLS:
            parsed.append(None)
        else:
            quantity = _quantity(value)
            if quantity is None:
                return []
            parsed.append(quantity)
    present = [value for value in parsed if value is not None]
    if not present or len({value[:2] for value in present}) != 1:
        return []
    _, unit, _, high = present[0]
    slug = unit_slug(unit)
    low_values = [value[2] if value else None for value in parsed]
    if high is None:
        return [DerivedColumn(shorten(f"{column}_{slug}"), low_values, column, unit)]
    return [DerivedColumn(shorten(f"{column}_min_{slug}"), low_values, column, unit),
            DerivedColumn(shorten(f"{column}_max_{slug}"), [value[3] if value else None for value in parsed], column, unit)]
