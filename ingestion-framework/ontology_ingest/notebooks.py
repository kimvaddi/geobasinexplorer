"""Deterministic framework archives and parameterized non-Spark notebooks."""
from __future__ import annotations

import copy
import hashlib
import io
import json
import re
import zipfile
from pathlib import Path
from typing import Any

from .tmdl import platform_metadata, to_api_definition

# Confirmed by the orchestrator against a Python 3.11.15 Fabric notebook session.
DEFAULT_KERNEL_METADATA = {
    "kernel_info": {"name": "jupyter", "jupyter_kernel_name": "python3.11"},
    "kernelspec": {"name": "jupyter", "display_name": "Jupyter"},
    "language_info": {"name": "python"},
    "microsoft": {"language": "python", "language_group": "jupyter_python"},
}
CODE_CELL_METADATA = {"microsoft": {"language": "python", "language_group": "jupyter_python"}}

BOOTSTRAP = '''import hashlib
import importlib
import re
import sys
import urllib.request
from pathlib import Path, PurePosixPath
from urllib.parse import quote
import notebookutils

if not re.fullmatch(r"[a-f0-9]{12,64}", framework_hash):
    raise ValueError("framework_hash must be the hash returned by the land command")
archive_path = PurePosixPath(framework_zip)
if archive_path.is_absolute() or ".." in archive_path.parts or "\\\\" in framework_zip:
    raise ValueError("framework_zip must be relative to OneLake Files")
url = "https://onelake.dfs.fabric.microsoft.com/" + "/".join(
    quote(part, safe="") for part in [workspace_id, lakehouse_id, "Files", *archive_path.parts]
)
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None
request = urllib.request.Request(url, headers={
    "Authorization": "Bearer " + notebookutils.credentials.getToken("storage"),
    "x-ms-version": "2023-11-03",
})
with urllib.request.build_opener(NoRedirect()).open(request, timeout=120) as response:
    archive = response.read(16 * 1024 * 1024 + 1)
if len(archive) > 16 * 1024 * 1024 or not hashlib.sha256(archive).hexdigest().startswith(framework_hash):
    raise ValueError("Framework archive is oversized or does not match framework_hash")
cache = Path(".ontology_ingest")
cache.mkdir(exist_ok=True)
archive_file = cache / (framework_hash + ".zip")
archive_file.write_bytes(archive)
for name in list(sys.modules):
    if name == "ontology_ingest" or name.startswith("ontology_ingest."):
        del sys.modules[name]
sys.path.insert(0, str(archive_file.resolve()))
importlib.invalidate_caches()
'''


def build_framework_zip(package_dir: str | Path | None = None) -> tuple[bytes, str]:
    root = Path(package_dir) if package_dir is not None else Path(__file__).parent
    stream = io.BytesIO()
    paths = sorted(path for path in root.rglob("*.py") if "__pycache__" not in path.relative_to(root).parts)
    if not (root / "__init__.py").is_file():
        raise ValueError("Framework package directory must contain __init__.py")
    # Cloud-sync conflict copies such as "fabric 2.py" are not importable modules and must never ship in the archive.
    stray = [path.relative_to(root).as_posix() for path in paths
             if not all(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", part) for part in path.relative_to(root).with_suffix("").parts)]
    if stray:
        raise ValueError(f"Framework package contains files that are not importable modules: {', '.join(stray[:5])}")
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in paths:
            if path.is_symlink():
                raise ValueError("Framework archive must not contain symlinked sources")
            info = zipfile.ZipInfo("ontology_ingest/" + path.relative_to(root).as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes(), compresslevel=9)
    data = stream.getvalue()
    return data, hashlib.sha256(data).hexdigest()[:12]


def _code(source: str, *, parameters: bool = False) -> dict[str, Any]:
    metadata = copy.deepcopy(CODE_CELL_METADATA)
    if parameters:
        metadata["tags"] = ["parameters"]
    return {"id": "code-" + hashlib.sha256(source.encode("utf-8")).hexdigest()[:16],
            "cell_type": "code", "execution_count": None, "metadata": metadata,
            "outputs": [], "source": source.splitlines(keepends=True)}


def build_notebook(step: str, *, workspace_id: str, lakehouse_id: str, lakehouse_name: str,
                   parameters: dict[str, str] | None = None,
                   kernel_metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    if step not in {"prepare", "generate", "graph"}:
        raise ValueError("Notebook step must be prepare, generate or graph")
    defaults = {"landing_dir": "", "run_id": "", "workspace_id": workspace_id, "lakehouse_id": lakehouse_id,
                "framework_zip": "", "framework_hash": "", "ontology_name": "", "ontology_description": "",
                "raw_schema": "raw", "binding_schema": "dbo", "plan_path": "", "publish_mode": "staged", "retain_runs": "2",
                "raw_tables_schema": "", "graph_model_name": "", "graph_model_description": "", "raise_errors": "false"}
    if parameters:
        unknown = set(parameters) - set(defaults)
        if unknown or not all(isinstance(value, str) for value in parameters.values()):
            raise ValueError(f"Invalid notebook parameter names or values: {sorted(unknown)}")
        defaults.update(parameters)
    parameter_source = "\n".join(f"{key} = {json.dumps(value, ensure_ascii=False)}" for key, value in defaults.items()) + "\n"
    if step == "prepare":
        markdown = ("# Prepare ontology data\n\nRead the landing datasets, or the raw tables an ingest pipeline copied them into, "
                    "expand the JSON properties into columns, merge entities, derive numeric quantities, and write managed Delta "
                    "binding tables, edge quarantine, an ontology plan and a quality report.\n")
        call = '''from ontology_ingest.workflow import prepare_remote
    summary = prepare_remote(
        workspace_id, lakehouse_id, landing_dir, run_id,
        storage_token=NotebookTokenProvider("storage"),
        raw_schema=raw_schema, binding_schema=binding_schema, publish_mode=publish_mode,
        raw_tables_schema=raw_tables_schema,
    )'''
    elif step == "generate":
        markdown = ("# Generate the ontology\n\nRead the prepared plan, refresh the SQL endpoint metadata, generate the TMDL definition, "
                    "publish the ontology with its data bindings, and verify its returned structure.\n")
        call = '''from ontology_ingest.workflow import generate_remote
    summary = generate_remote(
        workspace_id, lakehouse_id, plan_path, ontology_name, ontology_description,
        fabric_token=NotebookTokenProvider("pbi"), storage_token=NotebookTokenProvider("storage"), retain_runs=int(retain_runs),
    )'''
    else:
        markdown = ("# Build the graph model\n\nPublish the graph model over the run's binding tables, reload it and check every node "
                    "and edge count against the plan. The ontology's own graph can't be materialized for an ontology published "
                    "through the public API, so this graph model is the workaround (docs/FABRIC_KNOWLEDGE.md).\n")
        call = '''from ontology_ingest.workflow import graph_remote
    summary = graph_remote(
        workspace_id, lakehouse_id, run_id, graph_model_name, graph_model_description,
        fabric_token=NotebookTokenProvider("pbi"), storage_token=NotebookTokenProvider("storage"),
    )'''
    # The exit calls sit outside the try block so the error handler cannot swallow them. A pipeline sets raise_errors so
    # that a failure fails its notebook activity instead of returning an error summary as a successful exit value.
    run_source = f'''import json
import traceback
from ontology_ingest.auth import NotebookTokenProvider
try:
    {call}
except Exception as error:
    if raise_errors.strip().lower() == "true":
        raise
    failure = {{"runId": run_id, "error": {{"type": type(error).__name__, "message": str(error)[:4000],
                                          "traceback": traceback.format_exc()[-3000:]}}}}
else:
    failure = None
notebookutils.notebook.exit(json.dumps(failure if failure else summary, ensure_ascii=False))
'''
    metadata = copy.deepcopy(DEFAULT_KERNEL_METADATA if kernel_metadata is None else kernel_metadata)
    metadata["dependencies"] = {"lakehouse": {"default_lakehouse": lakehouse_id, "default_lakehouse_name": lakehouse_name,
                                               "default_lakehouse_workspace_id": workspace_id}}
    return {"nbformat": 4, "nbformat_minor": 5, "metadata": metadata,
            "cells": [{"id": "description", "cell_type": "markdown", "metadata": {}, "source": markdown.splitlines(keepends=True)},
                      _code(parameter_source, parameters=True), _code(BOOTSTRAP), _code(run_source)]}


def build_prepare_notebook(**options: Any) -> dict[str, Any]:
    return build_notebook("prepare", **options)


def build_generate_notebook(**options: Any) -> dict[str, Any]:
    return build_notebook("generate", **options)


def build_graph_notebook(**options: Any) -> dict[str, Any]:
    return build_notebook("graph", **options)


def notebook_definition(notebook: dict[str, Any], name: str, description: str = "") -> dict[str, Any]:
    parts = {"artifact.content.ipynb": json.dumps(notebook, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
             ".platform": platform_metadata(name, description, "Notebook")}
    return {"format": "ipynb", **to_api_definition(parts)}
