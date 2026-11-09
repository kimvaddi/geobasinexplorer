"""Small file-store interface; all adapter paths are relative to their root."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path, PurePosixPath
import uuid
from typing import Protocol


@dataclass(frozen=True, order=True)
class Entry:
    path: str
    is_dir: bool = False


def relative_path(value: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or "\\" in value or any(ord(char) < 32 for char in value):
        raise ValueError(f"Invalid relative path: {value!r}")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or (not path.parts and not allow_empty):
        raise ValueError(f"Expected a non-traversing relative path: {value!r}")
    return "" if not path.parts else path.as_posix()


class Storage(Protocol):
    @property
    def name(self) -> str: ...
    def list_paths(self, prefix: str = "") -> list[Entry]: ...
    def read_bytes(self, path: str) -> bytes: ...
    def write_bytes(self, path: str, data: bytes) -> None: ...


class LocalFolder:
    def __init__(self, root: str | Path):
        self.root = Path(root).resolve()

    @property
    def name(self) -> str:
        return self.root.name

    def _path(self, relative: str) -> Path:
        result = (self.root / relative_path(relative)).resolve()
        if not result.is_relative_to(self.root):
            raise ValueError("File path escapes storage root")
        return result

    def list_paths(self, prefix: str = "") -> list[Entry]:
        prefix = relative_path(prefix, allow_empty=True)
        directory = self._path(prefix) if prefix else self.root
        if prefix and not directory.exists():
            return []
        if not directory.is_dir():
            raise ValueError(f"Landing directory does not exist: {self.root}")
        result: list[Entry] = []
        for path in sorted(directory.rglob("*")):
            if path.is_symlink():
                raise ValueError(f"Symlinks are not allowed in landing folders: {path}")
            result.append(Entry(path.relative_to(self.root).as_posix(), path.is_dir()))
        return result

    def read_bytes(self, path: str) -> bytes:
        return self._path(path).read_bytes()

    def write_bytes(self, path: str, data: bytes) -> None:
        target = self._path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        # A same-directory replacement never exposes a partially written report.
        pending = target.with_name(f".{target.name}.{uuid.uuid4().hex}.pending")
        try:
            with pending.open("xb") as stream:
                stream.write(data)
            pending.replace(target)
        finally:
            pending.unlink(missing_ok=True)


class MemoryStorage:
    def __init__(self, files: dict[str, bytes] | None = None, name: str = "landing"):
        self.files = dict(files or {})
        self.name = name

    def list_paths(self, prefix: str = "") -> list[Entry]:
        prefix = relative_path(prefix, allow_empty=True)
        directories: set[str] = set()
        for name in self.files:
            directories.update(str(parent) for parent in PurePosixPath(name).parents if str(parent) != ".")
        entries = [Entry(name) for name in self.files] + [Entry(name, True) for name in directories]
        return sorted(entry for entry in entries if not prefix or entry.path == prefix or entry.path.startswith(prefix + "/"))

    def read_bytes(self, path: str) -> bytes:
        return self.files[relative_path(path)]

    def write_bytes(self, path: str, data: bytes) -> None:
        self.files[relative_path(path)] = data
