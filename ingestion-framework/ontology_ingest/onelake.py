"""OneLake Files adapter using the documented ADLS Gen2 file operations."""
from __future__ import annotations

from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import quote, urlencode

from .auth import TokenProvider
from .http import ApiError, HttpClient
from .storage import Entry, relative_path
from .naming import validate_table_name

CHUNK_BYTES = 4 * 1024 * 1024
API_VERSION = "2023-11-03"


class OneLakeClient:
    def __init__(self, workspace_id: str, item_id: str, token_provider: TokenProvider, *,
                 base_url: str = "https://onelake.dfs.fabric.microsoft.com", **http_options: Any):
        self.workspace_id, self.item_id = workspace_id, item_id
        for value in (workspace_id, item_id):
            if not value or "/" in value or "\\" in value:
                raise ValueError("Workspace and item ids must be nonempty path segments")
        self.http = HttpClient(base_url, token_provider, **http_options)
        self.headers = {"x-ms-version": API_VERSION}

    def _area_url(self, area: str, path: str) -> str:
        safe = relative_path(path)
        return "/" + "/".join(quote(part, safe="") for part in [self.workspace_id, self.item_id, area, *PurePosixPath(safe).parts])

    def _url(self, path: str) -> str:
        return self._area_url("Files", path)

    def list(self, directory: str = "", *, recursive: bool = True) -> list[Entry]:
        directory = relative_path(directory, allow_empty=True)
        prefix = f"{self.item_id}/Files/"
        query = {"resource": "filesystem", "recursive": str(recursive).lower(), "directory": prefix + directory}
        entries: list[Entry] = []
        seen: set[str] = set()
        for _ in range(10000):
            response = self.http.request("GET", f"/{quote(self.workspace_id, safe='')}?{urlencode(query)}", headers=self.headers)
            for path in response.json().get("paths", []):
                name = path["name"]
                if not name.startswith(prefix):
                    raise ValueError("OneLake listing returned a path outside the selected item's Files directory")
                relative = relative_path(name[len(prefix):], allow_empty=True)
                if relative:
                    entries.append(Entry(relative, str(path.get("isDirectory", False)).lower() == "true"))
            continuation = response.header("x-ms-continuation")
            if not continuation:
                return sorted(entries)
            if continuation in seen:
                raise ValueError("OneLake listing repeated a continuation")
            seen.add(continuation)
            query["continuation"] = continuation
        raise ValueError("OneLake listing exceeded its page limit")

    def read_bytes(self, path: str) -> bytes:
        return self.http.request("GET", self._url(path), headers=self.headers).body

    def mkdir(self, path: str) -> None:
        path = relative_path(path)
        response = self.http.request("PUT", self._url(path) + "?resource=directory", data=b"", headers=self.headers, allow_status=(409,))
        if response.status == 409:
            body = response.json()
            code = body.get("error", {}).get("code", "")
            if code not in {"PathAlreadyExists", "ResourceAlreadyExists"}:
                raise self.http.error(response, "Cannot create OneLake directory")

    def write_bytes(self, path: str, data: bytes, *, chunk_size: int = CHUNK_BYTES) -> None:
        if not isinstance(data, bytes):
            raise TypeError("OneLake writes require bytes")
        if not 1 <= chunk_size <= CHUNK_BYTES:
            raise ValueError("Upload chunks must be between 1 byte and 4 MiB")
        path = relative_path(path)
        for parent in reversed(PurePosixPath(path).parents):
            if str(parent) != ".":
                self.mkdir(str(parent))
        url = self._url(path)
        headers = {**self.headers, "Content-Type": "application/octet-stream"}
        for attempt in range(2):
            # Create File overwrites by default; deliberately do not send If-None-Match.
            self.http.request("PUT", url + "?resource=file", data=b"", headers=headers)
            try:
                for offset in range(0, len(data), chunk_size):
                    self.http.request("PATCH", url + f"?action=append&position={offset}",
                                      data=data[offset:offset + chunk_size], headers=headers, retry=False)
                self.http.request("PATCH", url + f"?action=flush&position={len(data)}", data=b"", headers=headers, retry=False)
                head = self.http.request("HEAD", url, headers=self.headers)
                try:
                    length = int(head.header("Content-Length"))
                except ValueError:
                    raise self.http.error(head, "Upload verification requires a valid Content-Length") from None
                if length != len(data):
                    raise self.http.error(head, f"Upload length mismatch: expected {len(data)}, found {length}")
                return
            except Exception:
                self.delete_path(path, missing_ok=True)
                if attempt:
                    raise

    def delete_path(self, path: str, *, recursive: bool = False, missing_ok: bool = False) -> None:
        self.http.request("DELETE", self._url(path) + "?" + urlencode({"recursive": str(recursive).lower()}),
                          headers=self.headers, allow_status=(404,) if missing_ok else ())

    def table_schema_exists(self, schema: str) -> bool:
        validate_table_name(schema)
        return self.http.request("HEAD", self._area_url("Tables", schema), headers=self.headers, allow_status=(404,)).status != 404

    def delete_table_schema(self, schema: str) -> None:
        validate_table_name(schema)
        self.http.request("DELETE", self._area_url("Tables", schema) + "?recursive=true", headers=self.headers, allow_status=(404,))
        if self.table_schema_exists(schema):
            raise RuntimeError(f"Schema {schema} is still visible after deletion; cleanup must be retried")

    def upload_folder(self, local_root: str | Path, destination: str) -> int:
        root = Path(local_root)
        if not root.is_dir():
            raise ValueError(f"Local upload folder does not exist: {root}")
        destination = relative_path(destination, allow_empty=True)
        count = 0
        for path in sorted(root.rglob("*")):
            if path.is_symlink():
                raise ValueError(f"Refusing to upload symlink {path}")
            if path.is_file():
                target = "/".join(filter(None, [destination, path.relative_to(root).as_posix()]))
                self.write_bytes(target, path.read_bytes())
                count += 1
        return count


class OneLakeFiles:
    def __init__(self, client: OneLakeClient, root: str = ""):
        self.client = client
        self.root = relative_path(root, allow_empty=True)

    @property
    def name(self) -> str:
        return PurePosixPath(self.root).name or "landing"

    def _path(self, relative: str) -> str:
        return "/".join(filter(None, [self.root, relative_path(relative)]))

    def list_paths(self, prefix: str = "") -> list[Entry]:
        directory = self._path(prefix) if prefix else self.root
        root_prefix = self.root + "/" if self.root else ""
        result = []
        try:
            entries = self.client.list(directory)
        except ApiError as error:
            if prefix and error.status == 404:
                return []
            raise
        for entry in entries:
            if entry.path == self.root:
                continue
            if not entry.path.startswith(root_prefix):
                raise ValueError("OneLake returned a path outside this adapter's root")
            result.append(Entry(entry.path[len(root_prefix):], entry.is_dir))
        return result

    def read_bytes(self, path: str) -> bytes:
        return self.client.read_bytes(self._path(path))

    def write_bytes(self, path: str, data: bytes) -> None:
        self.client.write_bytes(self._path(path), data)
