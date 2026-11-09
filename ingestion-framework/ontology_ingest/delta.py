"""Explicit-schema table writers; the local fallback is deliberately not Delta."""
from __future__ import annotations

import importlib
import inspect
import json
import shutil
import uuid
from pathlib import Path
from typing import Any, Protocol

import pyarrow as pa
import pyarrow.parquet as pq

from .auth import TokenProvider
from .naming import validate_table_name
from .storage import LocalFolder
from .onelake import OneLakeClient


class TableWriter(Protocol):
    def write(self, schema_name: str, table_name: str, arrow_table: pa.Table) -> None: ...


class TableReader(Protocol):
    def count_rows(self, schema_name: str, table_name: str) -> int: ...


class RawTableReader(Protocol):
    def read_table(self, schema_name: str, table_name: str) -> pa.Table | None: ...


class SchemaManager(TableReader, Protocol):
    def schema_exists(self, schema_name: str) -> bool: ...
    def delete_schema(self, schema_name: str) -> None: ...


def _deltalake(required: bool = False) -> Any:
    try:
        return importlib.import_module("deltalake")
    except ModuleNotFoundError as error:
        if error.name != "deltalake":
            raise
        if required:
            raise RuntimeError("Delta writing requires deltalake; install ontology-ingest[delta]") from error
        return None


def _write_delta(module: Any, path: str, table: pa.Table, storage_options: dict[str, str] | None = None) -> None:
    options: dict[str, Any] = {"mode": "overwrite"}
    if storage_options is not None:
        options["storage_options"] = storage_options
    parameters = inspect.signature(module.write_deltalake).parameters
    if "schema_mode" in parameters:
        options["schema_mode"] = "overwrite"
    elif "overwrite_schema" in parameters:
        options["overwrite_schema"] = True
    else:
        raise RuntimeError("Unsupported deltalake writer: no schema overwrite parameter")
    module.write_deltalake(path, table, **options)


def _check(schema: str, table: str, data: pa.Table | None = None) -> None:
    validate_table_name(schema)
    validate_table_name(table)
    if data is not None and not isinstance(data, pa.Table):
        raise TypeError("TableWriter requires an explicitly typed pyarrow.Table")


class InMemoryWriter:
    def __init__(self) -> None:
        self.tables: dict[tuple[str, str], pa.Table] = {}

    def write(self, schema_name: str, table_name: str, arrow_table: pa.Table) -> None:
        _check(schema_name, table_name, arrow_table)
        self.tables[schema_name, table_name] = arrow_table

    def count_rows(self, schema_name: str, table_name: str) -> int:
        return self.tables[schema_name, table_name].num_rows

    def read_table(self, schema_name: str, table_name: str) -> pa.Table | None:
        _check(schema_name, table_name)
        return self.tables.get((schema_name, table_name))

    def schema_exists(self, schema_name: str) -> bool:
        validate_table_name(schema_name)
        return any(schema == schema_name for schema, _ in self.tables)

    def delete_schema(self, schema_name: str) -> None:
        validate_table_name(schema_name)
        for key in list(self.tables):
            if key[0] == schema_name:
                del self.tables[key]


class LocalDeltaWriter:
    def __init__(self, root: str | Path, *, use_delta: bool | None = None):
        self.root = Path(root)
        self.use_delta = use_delta

    def path(self, schema_name: str, table_name: str) -> Path:
        _check(schema_name, table_name)
        return self.root / "Tables" / schema_name / table_name

    def write(self, schema_name: str, table_name: str, arrow_table: pa.Table) -> None:
        _check(schema_name, table_name, arrow_table)
        path = self.path(schema_name, table_name)
        module = _deltalake(required=self.use_delta is True) if self.use_delta is not False else None
        if module is not None:
            _write_delta(module, str(path), arrow_table)
            return
        if (path / "_delta_log").exists():
            raise RuntimeError("Refusing Parquet fallback over an existing Delta table")
        path.mkdir(parents=True, exist_ok=True)
        pending = path / f".data.{uuid.uuid4().hex}.pending"
        try:
            with pending.open("xb") as stream:
                pq.write_table(arrow_table, stream)
            pending.replace(path / "data.parquet")
        finally:
            pending.unlink(missing_ok=True)
        sidecar = {"format": "parquet-fallback", "rowCount": arrow_table.num_rows,
                   "columns": [{"name": field.name, "type": str(field.type)} for field in arrow_table.schema]}
        LocalFolder(path).write_bytes("_format.json", (json.dumps(sidecar, sort_keys=True, indent=2) + "\n").encode("utf-8"))

    def count_rows(self, schema_name: str, table_name: str) -> int:
        path = self.path(schema_name, table_name)
        if (path / "_delta_log").exists():
            return _deltalake(required=True).DeltaTable(str(path)).to_pyarrow_dataset().count_rows()
        return pq.read_metadata(path / "data.parquet").num_rows

    def schema_exists(self, schema_name: str) -> bool:
        validate_table_name(schema_name)
        return (self.root / "Tables" / schema_name).exists()

    def delete_schema(self, schema_name: str) -> None:
        validate_table_name(schema_name)
        tables = self.root / "Tables"
        path = tables / schema_name
        if tables.is_symlink() or path.is_symlink() or not path.resolve().is_relative_to(tables.resolve()):
            raise ValueError("Refusing schema cleanup through a symlink or outside the Tables root")
        if path.exists():
            shutil.rmtree(path)


class OneLakeDeltaWriter:
    def __init__(self, workspace_id: str, lakehouse_id: str, token_provider: TokenProvider, *, client: OneLakeClient | None = None):
        self.client = client
        self.workspace_id = workspace_id
        self.lakehouse_id = lakehouse_id
        self.token_provider = token_provider

    def uri(self, schema_name: str, table_name: str) -> str:
        _check(schema_name, table_name)
        for value in (self.workspace_id, self.lakehouse_id):
            try:
                uuid.UUID(value)
            except (ValueError, TypeError, AttributeError) as error:
                raise ValueError("OneLake Delta URIs require workspace and lakehouse GUIDs") from error
        return (f"abfss://{self.workspace_id}@onelake.dfs.fabric.microsoft.com/"
                f"{self.lakehouse_id}/Tables/{schema_name}/{table_name}")

    def _options(self) -> dict[str, str]:
        return {"bearer_token": self.token_provider.get_token(), "use_fabric_endpoint": "true"}

    def write(self, schema_name: str, table_name: str, arrow_table: pa.Table) -> None:
        _check(schema_name, table_name, arrow_table)
        options = self._options()
        try:
            _write_delta(_deltalake(required=True), self.uri(schema_name, table_name), arrow_table, options)
        except Exception as error:
            raise RuntimeError("OneLake Delta write failed: " + str(error).replace(options["bearer_token"], "[REDACTED]")) from None

    def count_rows(self, schema_name: str, table_name: str) -> int:
        options = self._options()
        try:
            table = _deltalake(required=True).DeltaTable(self.uri(schema_name, table_name), storage_options=options)
            return table.to_pyarrow_dataset().count_rows()
        except Exception as error:
            raise RuntimeError("OneLake Delta read failed: " + str(error).replace(options["bearer_token"], "[REDACTED]")) from None

    def read_table(self, schema_name: str, table_name: str) -> pa.Table | None:
        """The whole table, or None when no Delta table exists at that path."""
        options = self._options()
        module = _deltalake(required=True)
        try:
            return module.DeltaTable(self.uri(schema_name, table_name), storage_options=options).to_pyarrow_table()
        except Exception as error:
            if type(error).__name__ == "TableNotFoundError":
                return None
            raise RuntimeError("OneLake Delta read failed: " + str(error).replace(options["bearer_token"], "[REDACTED]")) from None

    def _schema_client(self) -> OneLakeClient:
        if self.client is None:
            self.client = OneLakeClient(self.workspace_id, self.lakehouse_id, self.token_provider)
        return self.client

    def schema_exists(self, schema_name: str) -> bool:
        return self._schema_client().table_schema_exists(schema_name)

    def delete_schema(self, schema_name: str) -> None:
        self._schema_client().delete_table_schema(schema_name)
