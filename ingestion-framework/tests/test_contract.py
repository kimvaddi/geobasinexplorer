import csv
import io
import json

import pytest

from ontology_ingest.contract import ContractError, DatasetWriter, discover, read_rows, rows_from_records
from ontology_ingest.storage import LocalFolder, MemoryStorage


def test_writer_deterministic_merge_and_csv_contract(tmp_path, caplog):
    writer = DatasetWriter(tmp_path / "dataset", name="producer", priority=60)
    writer.entity_type("Well", description="A well", synonyms=["Borehole"], properties={"depth_m": {"dataType": "double"}})
    writer.add_entity("Well", id="b", label="Beta", properties={"z": "é", "a": None, "depth_m": 3851.8123456789}, publisher="Agency")
    writer.add_entity("Well", id="a", label="", properties={"x": None}, source_title='A, "quoted"\ntitle')
    writer.add_entity("Well", id="a", label="Alpha", properties={"x": 1, "z": False}, publisher="First")
    writer.add_entity("Well", id="a", label="Wrong", properties={"x": 99}, publisher="Second")
    writer.add_relationship("isPartOf", "b", "Well", "a", "Well")
    writer.add_relationship("isPartOf", " b ", "Well", "a", "Well")
    summary = writer.close()
    snapshot = {p.relative_to(tmp_path).as_posix(): p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()}
    assert writer.close() == summary
    assert snapshot == {p.relative_to(tmp_path).as_posix(): p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()}
    assert summary["entities"] == {"Well": 2} and summary["relationshipCount"] == 1 and summary["duplicateEntities"] == 2
    assert "Merging duplicate" in caplog.text
    content = (tmp_path / "dataset/entities/Well.csv").read_text()
    assert content.splitlines()[0] == "id,label,publisher,source_title,properties_json"
    rows = list(csv.DictReader(io.StringIO(content)))
    assert rows[0]["id"] == "a" and rows[0]["publisher"] == "First" and rows[0]["label"] == "Alpha"
    assert json.loads(rows[0]["properties_json"]) == {"x": 1, "z": False}
    assert json.loads(rows[1]["properties_json"]) == {"depth_m": 3851.8123456789, "z": "é"}
    assert rows[0]["source_title"] == 'A, "quoted"\ntitle'
    assert discover(LocalFolder(tmp_path))[0].name == "producer"
    with pytest.raises(ValueError, match="already closed"):
        writer.add_entity("Well", id="c", label="C")


def test_writer_is_independent_of_row_insertion_order(tmp_path):
    outputs = []
    for number, order in enumerate(([2, 1], [1, 2])):
        writer = DatasetWriter(tmp_path / str(number), name="same")
        for value in order:
            writer.add_entity("Thing", id=str(value), label="é", properties={"b": value, "a": 2}, **{f"flat_{value}": 1.234567890123})
        writer.close()
        outputs.append({p.relative_to(tmp_path / str(number)).as_posix(): p.read_bytes() for p in (tmp_path / str(number)).rglob("*") if p.is_file()})
    assert outputs[0] == outputs[1]


@pytest.mark.parametrize("name", ["bad name", "123", "bad/name", "x\n", "é", ""])
def test_writer_rejects_invalid_type_names(tmp_path, name):
    writer = DatasetWriter(tmp_path, name="valid")
    with pytest.raises(ValueError):
        writer.entity_type(name)
    with pytest.raises(ValueError):
        writer.relationship_type(name)


def test_reader_bom_nulls_and_typed_jsonl():
    store = MemoryStorage({"d/entities/T.csv": '\ufeffid,label,text\nx,,"line one\nline two"\n'.encode(),
                           "d/relationships/r.jsonl": b'{"source_id":"x","source_type":"T","target_id":"y","target_type":"T","properties_json":{"n":2}}\n[]\n{bad}\n'})
    csv_rows = read_rows(store, "d/entities/T.csv", "entity")
    assert csv_rows.rows == [{"id": "x", "label": None, "text": "line one\nline two"}]
    data = read_rows(store, "d/relationships/r.jsonl", "relationship")
    assert data.rows[0]["properties_json"] == {"n": 2}
    assert data.valid == [True, False, False] and data.row_numbers == [1, 2, 3]
    assert len(data.errors) == 2 and data.rows[2]["_unparsed_json"] == "{bad}"


@pytest.mark.parametrize("data", [b"", b"label\na\n", b"id,label,id\nx,a,x\n", b"id,label,\nx,a,\n"])
def test_reader_rejects_bad_headers(data):
    with pytest.raises(ContractError):
        read_rows(MemoryStorage({"x.csv": data}), "x.csv", "entity")


def test_reader_reports_wrong_width_and_missing_json_fields():
    store = MemoryStorage({"x.csv": b"id,label\nx,one,extra\ny\n", "x.jsonl": b'{"id":"x"}\n'})
    data = read_rows(store, "x.csv", "entity")
    assert data.valid == [False, False] and len(data.errors) == 2
    assert read_rows(store, "x.jsonl", "entity").valid == [False]


def test_discovery_fails_on_duplicate_files_and_metadata_names():
    with pytest.raises(ContractError, match="More than one file"):
        discover(MemoryStorage({"d/entities/T.csv": b"id,label\n", "d/entities/T.jsonl": b""}))
    with pytest.raises(ContractError, match="multiple folders"):
        discover(MemoryStorage({"a/dataset.json": b'{"name":"same"}', "b/dataset.json": b'{"name":"same"}'}))
    with pytest.raises(ContractError, match="contractVersion"):
        discover(MemoryStorage({"d/dataset.json": b'{"contractVersion":"2"}'}))


def test_writer_refuses_stale_snapshot_files(tmp_path):
    path = tmp_path / "entities"
    path.mkdir()
    (path / "Old.csv").write_text("id,label\n")
    with pytest.raises(ContractError, match="Stale"):
        DatasetWriter(tmp_path, name="d").close()


def test_local_storage_blocks_path_traversal_and_external_symlinks(tmp_path):
    store = LocalFolder(tmp_path / "root")
    with pytest.raises(ValueError):
        store.write_bytes("../bad", b"bad")
    store.write_bytes("safe/a", b"hello")
    outside = tmp_path / "outside"
    outside.write_bytes(b"outside")
    (tmp_path / "root/escape").symlink_to(outside)
    with pytest.raises(ValueError, match="escapes"):
        store.read_bytes("escape")
    with pytest.raises(ValueError, match="Symlinks"):
        store.list_paths()


def test_invalid_datatype_metadata_raises_a_contract_error_not_type_error():
    store = MemoryStorage({"d/dataset.json": b'{"entityTypes":{"T":{"properties":{"x":{"dataType":[]}}}}}'})
    with pytest.raises(ContractError, match="dataType"):
        discover(store)


def test_stale_pending_file_cannot_redirect_a_report_write(tmp_path):
    outside = tmp_path / "outside"
    outside.write_bytes(b"unchanged")
    store = LocalFolder(tmp_path / "reports")
    store.root.mkdir()
    (store.root / "quality.json.pending").symlink_to(outside)
    store.write_bytes("quality.json", b"new report")
    assert outside.read_bytes() == b"unchanged"
    assert store.read_bytes("quality.json") == b"new report"


def test_writer_duplicate_placeholders_do_not_block_real_properties(tmp_path):
    writer = DatasetWriter(tmp_path, name="d")
    writer.add_entity("T", id="a", label="not recorded", properties={"depth": "unknown", "operator": ""}, year="n/a")
    writer.add_entity("T", id="a", label="A", properties={"depth": "100 m", "operator": "Santos"}, year=1965)
    writer.close()
    row = read_rows(LocalFolder(tmp_path), "entities/T.csv", "entity").rows[0]
    assert row["label"] == "A" and row["year"] == "1965"
    assert json.loads(row["properties_json"]) == {"depth": "100 m", "operator": "Santos"}


def test_rows_from_a_copied_table_match_the_csv_reader_and_require_the_contract_columns():
    rows = rows_from_records(["label", "id", "depth"], [{"id": "a", "label": "", "depth": "12"}], "d/entities/T.csv", "entity")
    assert rows.columns == ["id", "label", "depth"] and rows.rows == [{"id": "a", "label": None, "depth": "12"}]
    assert rows.row_numbers == [1] and rows.valid == [True]
    with pytest.raises(ContractError, match="missing required columns: target_type"):
        rows_from_records(["source_id", "source_type", "target_id"], [], "d/relationships/r.csv", "relationship")
