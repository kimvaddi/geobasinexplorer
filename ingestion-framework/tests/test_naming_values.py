from datetime import datetime, timezone

import pytest

from ontology_ingest.naming import (column_names, lineage_tag, pipeline_raw_schema, quote_name, raw_table_name, snake,
                                    validate_pipeline_run_id)
from ontology_ingest.values import as_datetime, cast_column, derive_quantities, infer_type, unit_slug


@pytest.mark.parametrize("value,expected", [
    ("totalDepthM", "total_depth_m"), ("XMLParser", "xml_parser"), ("Étage (km²)", "etage_km2"),
    ("19 wells", "c_19_wells"), ("___", "col"), ("a,,;{}()=\n\tb", "a_b"), ("already_snake", "already_snake"),
])
def test_snake(value, expected):
    assert snake(value) == expected


def test_naming_collisions_reserved_and_long_names_are_order_independent():
    keys = ["id", "label", "source_datasets", "x y", "x-y", "x_y", "x_y_2", "A" * 180, "A" * 179 + "B"]
    forward, backward = column_names(keys), column_names(reversed(keys))
    assert forward == backward
    assert forward["id"] == "id_prop"
    assert forward["label"] == "label_prop"
    assert forward["source_datasets"] == "source_datasets_prop"
    assert len(set(forward.values())) == len(keys)
    assert max(map(len, forward.values())) <= 120
    assert snake("A" * 180) != snake("A" * 179 + "B")


def test_tmdl_quote_and_lineage_are_stable():
    assert quote_name("O'Brien Node") == "'O''Brien Node'"
    assert quote_name("node_id") == "node_id"
    assert lineage_tag("a", "b") == lineage_tag("a", "b")
    assert lineage_tag("a", "b") != lineage_tag("ab")
    with pytest.raises(ValueError):
        lineage_tag("a\x1fb")
    with pytest.raises(ValueError):
        quote_name("node\nproperty Evil")


@pytest.mark.parametrize("values,expected", [
    ([True, False, "yes", "NO"], "boolean"), (["True", "false"], "boolean"), (["yes", "maybe"], "string"),
    ([True, 1], "string"), ([0, 1], "int64"), (["1959", "-12", "6,692"], "int64"),
    (["12,34", "23"], "string"), ([2**63 - 1, -(2**63)], "int64"), ([2**63], "string"),
    ([str(2**63), "1"], "string"), (["3851.8", "2,616.6", "1e-3"], "double"),
    ([1, 2.0], "double"), (["1", "3.4"], "double"), (["1e9999"], "string"),
    (["NaN", "Infinity"], "string"), (["2025-03-01", "2025-03-01T01:00:00+01:00"], "dateTime"),
    (["2025-02-29"], "string"), (["20250301"], "int64"), (["2025-03-01", "never"], "string"),
    ([{}, []], "string"), ([None, ""], "string"), ([None, "yes"], "boolean"),
])
def test_inference(values, expected):
    assert infer_type(values) == expected


def test_declared_casts_count_bad_values_and_do_not_truncate_integers():
    kind, values, failures = cast_column(["2", "oops", 3.2, 4.0, True, 2**64, None], "int64")
    assert kind == "int64"
    assert values == [2, None, None, 4, None, None, None]
    assert failures == 4
    assert cast_column(["6,692", "1e-3"], "double")[1] == [6692.0, 0.001]
    assert cast_column(["yes", "0", "false"], "boolean") == ("boolean", [True, None, False], 1)
    assert cast_column([True, {"b": [1], "a": 2}], "string")[1] == ["true", '{"a":2,"b":[1]}']


def test_dates_become_utc_and_decimal_binds_as_double():
    assert as_datetime("2025-03-01T01:00:00+01:00") == datetime(2025, 3, 1, tzinfo=timezone.utc)
    assert as_datetime("2025-03-01").tzinfo == timezone.utc
    kind, values, failures = cast_column(["1.2300", "1.23456", "1000000000000000", None], "decimal")
    assert kind == "double" and values == [1.23, 1.23456, 1e15, None] and failures == 0


@pytest.mark.parametrize("text,names,values,unit", [
    ("3,852 m", ["depth_m"], [3852.0], "m"),
    ("130,196 km²", ["depth_km2"], [130196.0], "km2"),
    ("25 km", ["depth_km"], [25.0], "km"),
    ("66.7 °C", ["depth_c"], [66.7], "°C"),
    ("866 to 4,781 m", ["depth_min_m", "depth_max_m"], [866.0, 4781.0], "m"),
    ("2,616.6–3,942.6 m", ["depth_min_m", "depth_max_m"], [2616.6, 3942.6], "m"),
    ("1,338-2,149 m", ["depth_min_m", "depth_max_m"], [1338.0, 2149.0], "m"),
    ("12 to 10 m", ["depth_min_m", "depth_max_m"], [10.0, 12.0], "m"),
    ("Pliocene (2.6–5.3 Ma)", ["depth_min_ma", "depth_max_ma"], [2.6, 5.3], "Ma"),
    ("Episode (4 Ma)", ["depth_ma"], [4.0], "Ma"),
    ("-10--2 °C", ["depth_min_c", "depth_max_c"], [-10.0, -2.0], "°C"),
    ("1e-3 ms", ["depth_ms"], [0.001], "ms"),
    ("2.5 %", ["depth_pct"], [2.5], "%"),
    ("10 m/s", ["depth_m_s"], [10.0], "m/s"),
])
def test_quantity_derivation(text, names, values, unit):
    columns = derive_quantities("depth", [text, "not recorded", "none", "n/a", "unknown", "-", "", None])
    assert [column.name for column in columns] == names
    assert [column.values[0] for column in columns] == values
    for column in columns:
        assert column.unit == unit and column.derivedFrom == "depth"
        assert column.values[1:] == [None] * 7


@pytest.mark.parametrize("values", [
    ["10 m", "11 km"], ["10 m", "11 to 12 m"], ["10 m", 11], ["not recorded"],
    ["1", "2"], ["1e-3"], ["1e-3", "2e-3"], ["1,23 m"],
    ["Pliocene (2.6–5.3 Ma)", "2.6–5.3 Ma"], ["12 m", "approximately 20 m"],
])
def test_ambiguous_quantities_do_not_generate_columns(values):
    assert derive_quantities("value", values) == []


@pytest.mark.parametrize("unit,slug", [("km²", "km2"), ("°C", "c"), ("%", "pct"), ("Ma", "ma"), ("ft", "ft"), ("kg/m³", "kg_m3")])
def test_units(unit, slug):
    assert unit_slug(unit) == slug


@pytest.mark.parametrize("value", ["1 to 3", "1e-3 to 2e-3", "Phase (1 to 3)"])
def test_unitless_ranges_never_treat_to_or_exponents_as_units(value):
    assert derive_quantities("reading", [value]) == []


def test_iso_offsets_and_submicrosecond_input_normalize_to_required_utc_microseconds():
    value = as_datetime("2025-03-01T01:00:00.123456789+0100")
    assert value == datetime(2025, 3, 1, 0, 0, 0, 123456, tzinfo=timezone.utc)
    assert infer_type(["2025-03-01T01:00:00.123456789+0100"]) == "dateTime"


def test_empty_json_strings_are_null_for_typing_and_derivation():
    assert infer_type(["", "2"]) == "int64"
    assert cast_column(["", "2"]) == ("int64", [None, 2], 0)
    assert cast_column([""], "int64") == ("int64", [None], 0)
    assert derive_quantities("depth", ["", "2 m"])[0].values == [None, 2.0]


@pytest.mark.parametrize("column,values", [
    ("catalogue_id", ["TEGI-66233-1", "TEGI-66234-1"]),
    ("reference", ["GSQ CR0407", "GSQ CR0408"]),
    ("sourceId", ["25 m", "26 m"]),
    ("document_code", ["25 m", "26 m"]),
    ("id_prop", ["25 m", "26 m"]),
    ("Identifier", ["25 m", "26 m"]),
])
def test_identifier_columns_never_create_quantity_properties(column, values):
    assert derive_quantities(column, values) == []


def test_reference_measurements_are_not_mistaken_for_identifier_columns():
    columns = derive_quantities("reference_depth", ["25 m", "30 m"])
    assert columns[0].name == "reference_depth_m" and columns[0].values == [25.0, 30.0]


@pytest.mark.parametrize("value,expected", [
    ("2,616.6—3,942.6 m", [2616.6, 3942.6]),
    ("10 − 20 m", [10.0, 20.0]),
    ("−10 to −2 m", [-10.0, -2.0]),
])
def test_em_dash_and_unicode_minus_are_numeric_ranges(value, expected):
    result = derive_quantities("depth", [value])
    assert [column.name for column in result] == ["depth_min_m", "depth_max_m"]
    assert [column.values[0] for column in result] == expected


@pytest.mark.parametrize("value", ["10 to 20 to 30 m", "10 unit123", "10 — nonsense 20 m"])
def test_units_cannot_contain_leftover_range_digits(value):
    assert derive_quantities("depth", [value]) == []


def test_raw_table_and_pipeline_schema_names_follow_the_rule_the_pipeline_builds():
    assert raw_table_name("ga-basin-packages", "entity", "StratigraphicUnit") == "ga_basin_packages__e_stratigraphicunit"
    assert raw_table_name("wsm-2025-australia", "relationship", "locatedIn") == "wsm_2025_australia__r_locatedin"
    with pytest.raises(ValueError):
        raw_table_name("a b", "entity", "T")  # a pipeline expression cannot rewrite a space, so it is refused
    assert pipeline_raw_schema("raw", "live6") == "raw_live6"
    for run_id in ("Live6", "live-6", "live.6", "_live6", "", "x" * 61):
        with pytest.raises(ValueError, match="lowercase"):
            validate_pipeline_run_id(run_id)
