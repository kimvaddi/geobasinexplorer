import json
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import pyarrow as pa
import pytest

from ontology_ingest.auth import StaticTokenProvider
from ontology_ingest.delta import LocalDeltaWriter, OneLakeDeltaWriter, _write_delta
from ontology_ingest.onelake import CHUNK_BYTES, OneLakeClient, OneLakeFiles
from tests.fakes import FakeTransport, response


def test_upload_chunks_positions_and_flush_and_escaped_path():
    fake = FakeTransport(*(response({}, 201) for _ in range(5)), response({}, **{"Content-Length": str(2 * CHUNK_BYTES + 7)}))
    client = OneLakeClient("ws", "item", StaticTokenProvider("token"), transport=fake)
    content = b"x" * (2 * CHUNK_BYTES + 7)
    client.write_bytes("a b#.csv", content)
    assert [request.method for request in fake.requests] == ["PUT", "PATCH", "PATCH", "PATCH", "PATCH", "HEAD"]
    assert [len(request.body) for request in fake.requests[:-1]] == [0, CHUNK_BYTES, CHUNK_BYTES, 7, 0]
    assert [parse_qs(urlsplit(request.url).query).get("position") for request in fake.requests[1:-1]] == [["0"], [str(CHUNK_BYTES)], [str(CHUNK_BYTES * 2)], [str(len(content))]]
    assert all("/Files/a%20b%23.csv" in request.url for request in fake.requests)
    assert fake.requests[-2].url.endswith("action=flush&position=" + str(len(content)))
    assert all(request.headers["x-ms-version"] == "2023-11-03" for request in fake.requests)


def test_nested_empty_file_creates_parents_and_flushes_zero_bytes():
    fake = FakeTransport(response({}, 201), response({"error": {"code": "PathAlreadyExists"}}, 409), response({}, 201), response({}, 200), response({}, **{"Content-Length": "0"}))
    client = OneLakeClient("w", "i", StaticTokenProvider("t"), transport=fake)
    client.write_bytes("a/b/empty", b"")
    assert [request.url.split("?")[1] for request in fake.requests[:-1]] == ["resource=directory", "resource=directory", "resource=file", "action=flush&position=0"]
    with pytest.raises(ValueError):
        client.write_bytes("x", b"abc", chunk_size=CHUNK_BYTES + 1)


def test_listing_continuations_and_files_adapter_root():
    fake = FakeTransport(response({"paths": [{"name": "item/Files/landing/d", "isDirectory": "true"}]}, **{"x-ms-continuation": "+/="}),
                         response({"paths": [{"name": "item/Files/landing/d/dataset.json", "isDirectory": False}]}))
    adapter = OneLakeFiles(OneLakeClient("ws", "item", StaticTokenProvider("t"), transport=fake), "landing")
    assert [(entry.path, entry.is_dir) for entry in adapter.list_paths()] == [("d", True), ("d/dataset.json", False)]
    assert parse_qs(urlsplit(fake.requests[1].url).query)["continuation"] == ["+/="]
    assert parse_qs(urlsplit(fake.requests[0].url).query)["directory"] == ["item/Files/landing"]


def test_upload_folder_and_delete_are_confined_to_requested_prefix(tmp_path):
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub/x.txt").write_bytes(b"abc")
    fake = FakeTransport(*(response({}, 201) for _ in range(5)), response({}, **{"Content-Length": "3"}), response({}, 200))
    client = OneLakeClient("w", "i", StaticTokenProvider("t"), transport=fake)
    assert client.upload_folder(tmp_path, "landing") == 1
    client.delete_path("landing/sub/x.txt")
    assert all("/Files/landing" in request.url for request in fake.requests)
    assert fake.requests[-1].method == "DELETE"


def test_delta_writer_supports_old_and_current_schema_overwrite_signatures():
    calls = []
    table = pa.Table.from_pylist([{"id": "a"}], schema=pa.schema([("id", pa.string())]))

    def old(path, data, mode=None, overwrite_schema=False):
        calls.append((path, data, mode, overwrite_schema))

    def current(path, data, mode=None, schema_mode=None, storage_options=None):
        calls.append((path, data, mode, schema_mode, storage_options))
    _write_delta(SimpleNamespace(write_deltalake=old), "path", table)
    _write_delta(SimpleNamespace(write_deltalake=current), "path", table, {"use_fabric_endpoint": "true"})
    assert calls[0][2:] == ("overwrite", True)
    assert calls[1][2:] == ("overwrite", "overwrite", {"use_fabric_endpoint": "true"})


def test_one_lake_delta_uri_and_token_storage_options(monkeypatch):
    calls = []

    def write(path, data, mode=None, schema_mode=None, storage_options=None):
        calls.append((path, mode, schema_mode, storage_options))
    monkeypatch.setattr("ontology_ingest.delta._deltalake", lambda **kwargs: SimpleNamespace(write_deltalake=write))
    writer = OneLakeDeltaWriter("11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", StaticTokenProvider("fresh-token"))
    writer.write("raw", "a", pa.Table.from_pylist([], schema=pa.schema([("id", pa.string())])))
    assert calls[0][0] == "abfss://11111111-1111-1111-1111-111111111111@onelake.dfs.fabric.microsoft.com/22222222-2222-2222-2222-222222222222/Tables/raw/a"
    assert calls[0][1:3] == ("overwrite", "overwrite")
    assert calls[0][3] == {"bearer_token": "fresh-token", "use_fabric_endpoint": "true"}


def test_local_parquet_overwrite_and_guard_against_fallback_over_delta(tmp_path):
    writer = LocalDeltaWriter(tmp_path, use_delta=False)
    writer.write("dbo", "t", pa.Table.from_pylist([{"id": "a"}, {"id": "b"}], schema=pa.schema([("id", pa.string())])))
    writer.write("dbo", "t", pa.Table.from_pylist([{"value": 3}], schema=pa.schema([("value", pa.int64())])))
    assert writer.count_rows("dbo", "t") == 1
    assert json.loads((writer.path("dbo", "t") / "_format.json").read_text())["columns"] == [{"name": "value", "type": "int64"}]
    (writer.path("dbo", "t") / "_delta_log").mkdir()
    with pytest.raises(RuntimeError, match="fallback"):
        writer.write("dbo", "t", pa.table({"id": ["x"]}))


def test_real_local_delta_overwrite_preserves_utc_and_changes_schema(tmp_path):
    delta = pytest.importorskip("deltalake")
    from datetime import datetime, timezone
    writer = LocalDeltaWriter(tmp_path, use_delta=True)
    schema = pa.schema([("id", pa.string()), ("at", pa.timestamp("us", tz="UTC"))])
    writer.write("dbo", "t", pa.Table.from_pylist([{"id": "a", "at": datetime(2026, 1, 1, tzinfo=timezone.utc)}], schema=schema))
    assert writer.count_rows("dbo", "t") == 1
    restored = delta.DeltaTable(str(writer.path("dbo", "t"))).to_pyarrow_table()
    assert restored.schema.field("at").type.tz == "UTC"
    writer.write("dbo", "t", pa.Table.from_pylist([{"value": 2}], schema=pa.schema([("value", pa.int64())])))
    assert delta.DeltaTable(str(writer.path("dbo", "t"))).to_pyarrow_table().column_names == ["value"]


def test_delta_library_errors_do_not_leak_storage_tokens(monkeypatch):
    def write(path, data, mode=None, schema_mode=None, storage_options=None):
        raise ValueError("library detail bearer_token=" + storage_options["bearer_token"])
    monkeypatch.setattr("ontology_ingest.delta._deltalake", lambda **kwargs: SimpleNamespace(write_deltalake=write))
    writer = OneLakeDeltaWriter("11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", StaticTokenProvider("never-log-this-token"))
    with pytest.raises(RuntimeError) as error:
        writer.write("dbo", "t", pa.Table.from_pylist([], schema=pa.schema([("id", pa.string())])))
    assert "never-log-this-token" not in str(error.value) and "[REDACTED]" in str(error.value)


def test_create_file_overwrites_without_if_none_match():
    fake = FakeTransport(*[item for _ in range(2) for item in (
        response({}, 201), response({}, 202), response({}, 200), response({}, **{"Content-Length": "3"}))])
    client = OneLakeClient("ws", "item", StaticTokenProvider("token"), transport=fake)
    client.write_bytes("archive.zip", b"abc")
    client.write_bytes("archive.zip", b"abc")
    creates = [request for request in fake.requests if request.method == "PUT"]
    assert len(creates) == 2
    assert all(not any(key.lower() == "if-none-match" for key in request.headers) for request in fake.requests)
    assert sum(request.method == "HEAD" for request in fake.requests) == 2


@pytest.mark.parametrize("failure", ["append", "flush", "length", "missing_length"])
def test_failed_upload_restarts_the_whole_file_once(failure):
    initial = [response({}, 201)]
    if failure == "append":
        initial += [response({"error": "ambiguous append"}, 500)]
    else:
        initial += [response({}, 202)]
        if failure == "flush":
            initial += [response({"error": "ambiguous flush"}, 503)]
        else:
            initial += [response({}, 200), response({}, **({"Content-Length": "6"} if failure == "length" else {}))]
    fake = FakeTransport(*initial, response({}, 404), response({}, 201), response({}, 202), response({}, 200), response({}, **{"Content-Length": "3"}))
    client = OneLakeClient("ws", "item", StaticTokenProvider("t"), transport=fake, max_retries=1, sleep=lambda _: None)
    client.write_bytes("f", b"abc")
    methods = [request.method for request in fake.requests]
    cut = methods.index("DELETE")
    assert methods[cut + 1:] == ["PUT", "PATCH", "PATCH", "HEAD"]
    assert fake.requests[cut + 2].body == b"abc" and fake.requests[cut + 2].url.endswith("action=append&position=0")
    assert not fake.responses


def test_upload_retry_is_bounded_and_cleans_the_last_partial_file():
    from ontology_ingest.http import ApiError
    fake = FakeTransport(response({}, 201), response({}, 500), response({}, 200),
                         response({}, 201), response({}, 500), response({}, 200))
    client = OneLakeClient("w", "i", StaticTokenProvider("t"), transport=fake, max_retries=1, sleep=lambda _: None)
    with pytest.raises(ApiError):
        client.write_bytes("f", b"abc")
    assert [request.method for request in fake.requests] == ["PUT", "PATCH", "DELETE", "PUT", "PATCH", "DELETE"]


def test_schema_lifecycle_is_confined_to_tables_and_confirms_deletion():
    fake = FakeTransport(response({}, 200), response({}, 200), response({}, 404))
    client = OneLakeClient("ws", "item", StaticTokenProvider("token"), transport=fake)
    assert client.table_schema_exists("dbo_run_hash")
    client.delete_table_schema("dbo_run_hash")
    assert [request.method for request in fake.requests] == ["HEAD", "DELETE", "HEAD"]
    assert all("/item/Tables/dbo_run_hash" in request.url for request in fake.requests)
    assert "recursive=true" in fake.requests[1].url
    with pytest.raises(ValueError):
        client.delete_table_schema("../Files")


def test_append_transport_failure_restarts_instead_of_replaying_the_patch():
    from http.client import IncompleteRead
    class BrokenAppend(FakeTransport):
        broken = False
        def request(self, method, *args):
            result = super().request(method, *args)
            if method == "PATCH" and not self.broken:
                self.broken = True
                raise IncompleteRead(b"partial", 10)
            return result
    fake = BrokenAppend(response({}, 201), response({}, 200), response({}, 200), response({}, 201),
                        response({}, 200), response({}, 200), response({}, **{"Content-Length": "3"}))
    OneLakeClient("w", "i", StaticTokenProvider("t"), transport=fake).write_bytes("f", b"abc")
    assert [request.method for request in fake.requests] == ["PUT", "PATCH", "DELETE", "PUT", "PATCH", "PATCH", "HEAD"]
