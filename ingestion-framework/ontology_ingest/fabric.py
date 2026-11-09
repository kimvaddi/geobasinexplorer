"""Fabric REST helpers and the synchronous ontology MCP protocol."""
from __future__ import annotations

import base64
import json
import logging
import re
from typing import Any
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit

from .auth import AzureCliTokenProvider, NotebookTokenProvider, StaticTokenProvider, TokenProvider
from .http import ApiError, HttpClient, Response, sse_messages
from .tmdl import to_api_definition

LOG = logging.getLogger(__name__)


class MCPIncompleteResponse(ApiError):
    """The endpoint answered without a message for our request id, for example an empty body after a long query."""


def _segment(value: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError("An API identifier is required")
    return quote(value, safe="")


def _query(url: str, **values: str) -> str:
    parsed = urlsplit(url)
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query.update(values)
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), ""))


def _result_url(location: str) -> str:
    parsed = urlsplit(location)
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/") + "/result", parsed.query, ""))


def _graph_diagnostic(status: dict[str, Any]) -> str:
    diagnostics = status.get("diagnostics", {})
    value = diagnostics.get("_graphaneGqlStatus", "") if isinstance(diagnostics, dict) else ""
    value = value or status.get("_graphaneGqlStatus", "")
    # The live service sends typed values such as {"gqlType": "STRING", "value": "42000"} rather than bare strings.
    if isinstance(value, dict):
        value = value.get("value", "")
    return str(value or "")


_OPERATION_PATH = re.compile(r"/v1/operations/([A-Za-z0-9-]{1,64})/?")


class FabricClient:
    def __init__(self, workspace_id: str, token_provider: TokenProvider, *, base_url: str = "https://api.fabric.microsoft.com",
                 operation_timeout: float = 3600, poll_interval: float = 2, max_polls: int = 1800, **http_options: Any):
        if operation_timeout <= 0 or poll_interval < 0 or max_polls < 1:
            raise ValueError("Invalid operation polling settings")
        self.workspace_id = workspace_id
        self.workspace_path = "/v1/workspaces/" + _segment(workspace_id)
        self.http = HttpClient(base_url, token_provider, **http_options)
        self.operation_timeout, self.poll_interval, self.max_polls = operation_timeout, poll_interval, max_polls

    def _operation_location(self, response: Response) -> str:
        """Where to poll a long-running operation without sending the token to another host.

        Fabric adds x-ms-operation-id to every long-running response and documents Get Operation State and Get
        Operation Result under /v1/operations/{id} on the API origin. The Location header may instead name a regional
        cluster host, so a cross-origin Location is accepted only in that documented form and mapped to the API origin.
        """
        operation_id = response.header("x-ms-operation-id")
        if operation_id:
            if not re.fullmatch(r"[A-Za-z0-9-]{1,64}", operation_id):
                raise self.http.error(response, "Long-running response has an invalid x-ms-operation-id header")
            return self.http.url("/v1/operations/" + operation_id)
        location = response.header("Location")
        if not location:
            raise self.http.error(response, "Long-running response has no Location header")
        if self.http.is_same_origin(location):
            return self.http.url(location)
        parsed = urlsplit(location)
        match = _OPERATION_PATH.fullmatch(parsed.path)
        if parsed.scheme != "https" or not match or parsed.query or parsed.fragment or parsed.username or parsed.password:
            raise ValueError("Refusing a cross-origin long-running operation URL that is not a Fabric operation")
        return self.http.url("/v1/operations/" + match.group(1))

    def poll_operation(self, response: Response, *, fetch_result: bool = True) -> Response:
        if response.status != 202:
            return response
        location = self._operation_location(response)
        deadline = self.http.monotonic() + self.operation_timeout
        for _ in range(self.max_polls):
            delay = self.http.retry_delay(response, self.poll_interval)
            if self.http.monotonic() + delay >= deadline:
                raise TimeoutError("Fabric operation exceeded its polling deadline")
            self.http.sleep(delay)
            response = self.http.request("GET", location)
            status = response.json().get("status", "").casefold()
            if status == "succeeded":
                return self.http.request("GET", _result_url(location)) if fetch_result else response
            if status in {"failed", "cancelled", "canceled"}:
                raise self.http.error(response, "Fabric operation " + status)
            if status not in {"notstarted", "running", "inprogress", "undefined", ""}:
                raise self.http.error(response, "Unrecognized operation status " + status)
        raise TimeoutError(f"Fabric operation exceeded {self.max_polls} polls")

    def list_items(self) -> list[dict[str, Any]]:
        path = self.workspace_path + "/items"
        items: list[dict[str, Any]] = []
        visited: set[str] = set()
        for _ in range(1000):
            if path in visited:
                raise ValueError("Fabric item pagination repeated a continuation")
            visited.add(path)
            body = self.http.request("GET", path).json()
            if not isinstance(body.get("value"), list):
                raise ValueError("Fabric list items response has no value array")
            items.extend(body["value"])
            if body.get("continuationUri"):
                path = body["continuationUri"]
            elif body.get("continuationToken"):
                path = _query(self.workspace_path + "/items", continuationToken=body["continuationToken"])
            else:
                return items
        raise ValueError("Fabric item pagination exceeded 1000 pages")

    def find_item(self, display_name: str, item_type: str) -> dict[str, Any] | None:
        matches = [item for item in self.list_items() if item.get("displayName") == display_name and item.get("type") == item_type]
        if len(matches) > 1:
            raise ValueError(f"Multiple {item_type} items named {display_name!r}; use an unambiguous name")
        return matches[0] if matches else None

    def create_lakehouse(self, display_name: str) -> dict[str, Any]:
        response = self.http.request("POST", self.workspace_path + "/lakehouses",
                                     json_body={"displayName": display_name, "creationPayload": {"enableSchemas": True}})
        item = self.poll_operation(response).json()
        if not item.get("id"):
            item = self.find_item(display_name, "Lakehouse")
        if not item or not item.get("id"):
            raise ValueError("Lakehouse creation completed without a discoverable item id")
        return item

    def get_lakehouse(self, lakehouse_id: str) -> dict[str, Any]:
        return self.http.request("GET", self.workspace_path + "/lakehouses/" + _segment(lakehouse_id)).json()

    def refresh_sql_endpoint_metadata(self, endpoint_id: str, required_tables: list[str] | None = None) -> dict[str, Any]:
        """Sync the SQL analytics endpoint and check that every required schema.table is visible and in sync.

        NotRun means the endpoint had nothing to sync because nothing changed since its last sync (Learn: Refresh SQL
        analytics endpoint activity), so it counts as in sync when the table has a last successful sync time. When
        required tables are named, only they must sync: the lakehouse is shared, and a table the ontology does not bind
        (another team's, or one a pipeline is rewriting) must not block a publish. Without names, every table must sync.
        """
        response = self.http.request("POST", self.workspace_path + f"/sqlEndpoints/{_segment(endpoint_id)}/refreshMetadata?preview=true", json_body={})
        response = self.poll_operation(response)
        body = response.json()
        synced: set[str] = set()
        unsynced: list[dict[str, Any]] = []
        for table in body.get("value", []):
            status = table.get("status", "").casefold()
            if status == "notrun" and table.get("lastSuccessfulSyncDateTime"):
                synced.add(table.get("tableName", "").casefold())
            elif status == "success":
                synced.add(table.get("tableName", "").casefold())
            else:
                unsynced.append(table)
        required = None if required_tables is None else {name.casefold() for name in required_tables}
        for table in unsynced:
            if required is None or table.get("tableName", "").casefold() in required:
                raise self.http.error(response, f"SQL endpoint table refresh did not succeed for {table.get('tableName')!r} (status {table.get('status')!r})")
        if unsynced:
            LOG.warning("The SQL endpoint did not sync %d tables the ontology does not bind, such as %r (status %r)",
                        len(unsynced), unsynced[0].get("tableName"), unsynced[0].get("status"))
        missing = sorted(name for name in (required_tables or []) if name.casefold() not in synced)
        if missing:
            raise ValueError(f"The SQL endpoint does not list {len(missing)} binding tables yet: {', '.join(missing[:10])}")
        return body

    def _upsert(self, display_name: str, item_type: str, definition: dict[str, Any], description: str) -> dict[str, Any]:
        if not any(part.get("path") == ".platform" for part in definition.get("parts", [])):
            raise ValueError("Create/update definitions must include .platform metadata")
        existing = self.find_item(display_name, item_type)
        if existing:
            path = self.workspace_path + f"/items/{_segment(existing['id'])}/updateDefinition?updateMetadata=true"
            self.poll_operation(self.http.request("POST", path, json_body={"definition": definition}), fetch_result=False)
            return existing
        payload = {"displayName": display_name, "description": description, "type": item_type, "definition": definition}
        item = self.poll_operation(self.http.request("POST", self.workspace_path + "/items", json_body=payload)).json()
        if not item.get("id"):
            item = self.find_item(display_name, item_type)
        if not item or not item.get("id"):
            raise ValueError(f"{item_type} creation completed without a discoverable item id")
        return item

    def upsert_ontology(self, display_name: str, parts: dict[str, str], description: str = "") -> dict[str, Any]:
        return self._upsert(display_name, "Ontology", to_api_definition(parts), description)

    def upsert_graph_model(self, display_name: str, parts: dict[str, str], description: str = "") -> dict[str, Any]:
        return self._upsert(display_name, "GraphModel", {"format": "json", **to_api_definition(parts)}, description)

    def upsert_pipeline(self, display_name: str, content: dict[str, Any], description: str = "") -> dict[str, Any]:
        from .pipeline import pipeline_definition
        return self._upsert(display_name, "DataPipeline", pipeline_definition(content, display_name, description), description)

    def run_pipeline(self, pipeline_id: str, parameters: dict[str, str]) -> dict[str, Any]:
        """Run a pipeline on demand (Job Scheduler, jobType=Pipeline) and wait for it; a failed run is returned, not raised."""
        if not all(isinstance(value, str) for value in parameters.values()):
            raise ValueError("Pipeline parameters must be strings")
        path = self.workspace_path + f"/items/{_segment(pipeline_id)}/jobs/instances?jobType=Pipeline"
        response = self.http.request("POST", path, json_body={"executionData": {"parameters": parameters}})
        location = response.header("Location")
        if not location:
            raise self.http.error(response, "Pipeline run response has no Location header")
        location = self._job_location(location, pipeline_id)
        _, result = self._wait_for_job(response, location, "Pipeline run")
        return {"status": result.get("status", ""), "id": urlsplit(location).path.rstrip("/").rsplit("/", 1)[-1],
                "failureReason": result.get("failureReason"), "startTimeUtc": result.get("startTimeUtc"),
                "endTimeUtc": result.get("endTimeUtc")}

    def pipeline_activity_runs(self, job_id: str, *, after: str, before: str) -> list[dict[str, Any]]:
        """The activity runs of one pipeline run (Query activity runs), oldest first."""
        body = {"filters": [], "orderBy": [{"orderBy": "ActivityRunStart", "order": "ASC"}],
                "lastUpdatedAfter": after, "lastUpdatedBefore": before}
        result = self.http.request("POST", self.workspace_path + f"/datapipelines/pipelineruns/{_segment(job_id)}/queryactivityruns",
                                   json_body=body).json()
        runs = result if isinstance(result, list) else result.get("value", []) if isinstance(result, dict) else []
        return [run for run in runs if isinstance(run, dict)]

    def upsert_notebook(self, display_name: str, notebook: dict[str, Any], description: str = "") -> dict[str, Any]:
        from .notebooks import notebook_definition
        return self._upsert(display_name, "Notebook", notebook_definition(notebook, display_name, description), description)

    def get_ontology_definition(self, ontology_id: str) -> dict[str, str]:
        path = self.workspace_path + f"/items/{_segment(ontology_id)}/getDefinition"
        body = self.poll_operation(self.http.request("POST", path)).json()
        definition = body.get("definition", body)
        if not isinstance(definition.get("parts"), list):
            raise ValueError("getDefinition response has no parts array")
        parts: dict[str, str] = {}
        for part in definition["parts"]:
            if part.get("payloadType") != "InlineBase64" or part["path"] in parts:
                raise ValueError("Definition has a duplicate path or unsupported payloadType")
            parts[part["path"]] = base64.b64decode(part["payload"], validate=True).decode("utf-8-sig")
        return parts

    def _job_location(self, location: str, item_id: str) -> str:
        if self.http.is_same_origin(location):
            return self.http.url(location)
        parsed = urlsplit(location)
        prefix = self.workspace_path + f"/items/{_segment(item_id)}/jobs/instances/"
        match = re.fullmatch(re.escape(prefix) + r"([A-Za-z0-9-]{1,64})/?", parsed.path)
        if parsed.scheme != "https" or not match or parsed.query or parsed.fragment or parsed.username or parsed.password:
            raise ValueError("Refusing a cross-origin job URL that is not this item's documented job-instance path")
        return self.http.url(prefix + match.group(1))

    def _wait_for_job(self, response: Response, location: str, kind: str) -> tuple[Response, dict[str, Any]]:
        """Poll a job instance until it reaches a terminal status, which the caller interprets."""
        deadline = self.http.monotonic() + self.operation_timeout
        for _ in range(self.max_polls):
            delay = self.http.retry_delay(response, self.poll_interval)
            if self.http.monotonic() + delay >= deadline:
                raise TimeoutError(f"{kind} exceeded its polling deadline; the job may still be running")
            self.http.sleep(delay)
            response = self.http.request("GET", location)
            result = response.json()
            status = result.get("status", "")
            if status.casefold() in {"completed", "failed", "cancelled", "canceled", "deduped"}:
                return response, result
            if status.casefold() not in {"notstarted", "inprogress", "running", ""}:
                raise self.http.error(response, f"Unrecognized {kind.lower()} status " + status)
        raise TimeoutError(f"{kind} exceeded {self.max_polls} polls; the job may still be running")

    def run_notebook_job(self, notebook_id: str, parameters: dict[str, str]) -> dict[str, Any]:
        if not all(isinstance(value, str) for value in parameters.values()):
            raise ValueError("Notebook parameters must be strings")
        body = {"executionData": {"parameters": {key: {"value": value, "type": "string"} for key, value in parameters.items()}}}
        path = self.workspace_path + f"/items/{_segment(notebook_id)}/jobs/instances?jobType=RunNotebook"
        response = self.http.request("POST", path, json_body=body)
        location = response.header("Location")
        if not location:
            job_id = response.json().get("id")
            if not job_id:
                raise self.http.error(response, "Notebook job response has neither Location nor id")
            location = self.workspace_path + f"/items/{_segment(notebook_id)}/jobs/instances/{_segment(job_id)}"
        location = self._job_location(location, notebook_id)
        job_id = urlsplit(location).path.rstrip("/").rsplit("/", 1)[-1]
        response, result = self._wait_for_job(response, location, "Notebook job")
        status = result.get("status", "")
        if status.casefold() != "completed":
            raise self.http.error(response, "Notebook job " + status)
        details_path = self.workspace_path + f"/notebooks/{_segment(notebook_id)}/jobs/execute/instances/{_segment(job_id)}?beta=true"
        details = self.http.request("GET", details_path).json()
        return {"status": status, "id": job_id, "exitValue": details.get("properties", {}).get("exitValue")}

    def run_graph_refresh(self, graph_model_id: str) -> dict[str, Any]:
        """Run the documented on-demand RefreshGraph job and wait for it; a failed job is returned so callers can explain it.

        Creating a graph model with a definition starts a refresh by itself, so a request made meanwhile ends as Deduped.
        In that case the refresh already running, which loads the new definition, is the one to wait for.
        """
        response = self.http.request("POST", self.workspace_path + f"/graphModels/{_segment(graph_model_id)}/jobs/refreshGraph/instances")
        location = response.header("Location")
        if not location:
            if response.status == 200:
                return {"status": "Completed", "id": "", "failureReason": None}
            raise self.http.error(response, "Graph refresh response has no Location header")
        location = self._job_location(location, graph_model_id)
        response, result = self._wait_for_job(response, location, "Graph refresh job")
        if result.get("status", "").casefold() == "deduped":
            other = self._latest_job_id(graph_model_id)
            if other:
                location = self.http.url(self.workspace_path + f"/items/{_segment(graph_model_id)}/jobs/instances/{_segment(other)}")
                response, result = self._wait_for_job(response, location, "Graph refresh job")
        return {"status": result.get("status", ""), "id": urlsplit(location).path.rstrip("/").rsplit("/", 1)[-1],
                "failureReason": result.get("failureReason")}

    def _latest_job_id(self, item_id: str) -> str | None:
        """The most recently started job instance that was not skipped as a duplicate (List Item Job Instances).

        That is the job that caused the duplicate, even if it has finished by the time the list is read.
        """
        path, jobs = self.workspace_path + f"/items/{_segment(item_id)}/jobs/instances", []
        for _ in range(10):
            body = self.http.request("GET", path).json()
            jobs.extend(job for job in body.get("value", []) if isinstance(job, dict))
            if not body.get("continuationUri"):
                break
            path = body["continuationUri"]
        candidates = [job for job in jobs if job.get("id") and str(job.get("status", "")).casefold() != "deduped"]
        candidates.sort(key=lambda job: str(job.get("startTimeUtc") or ""), reverse=True)
        return str(candidates[0]["id"]) if candidates else None

    def graph_execute_query(self, graph_model_id: str, query: str, *, max_pages: int = 1000) -> dict[str, Any]:
        if not isinstance(query, str) or not query.strip():
            raise ValueError("A graph query is required")
        if not isinstance(max_pages, int) or isinstance(max_pages, bool) or max_pages < 1:
            raise ValueError("max_pages must be a positive integer")
        endpoint = self.workspace_path + f"/graphModels/{_segment(graph_model_id)}/executeQuery?beta=true"
        path = endpoint
        columns: list[Any] = []
        rows: list[Any] = []
        warnings: list[dict[str, Any]] = []
        warning_keys: set[str] = set()
        truncated = False
        deadline = self.http.monotonic() + self.operation_timeout
        for _ in range(max_pages):
            if self.http.monotonic() >= deadline:
                raise TimeoutError("Graph query exceeded its execution deadline; results are incomplete")
            response = self.poll_operation(self.http.request("POST", path, json_body={"query": query}))
            page = response.json()
            status = page.get("status") if isinstance(page, dict) else None
            if not isinstance(status, dict) or not isinstance(status.get("code"), str) or status["code"] not in {"00000", "00001", "01000", "02000", "42000", "50000"}:
                raise self.http.error(response, "Graph query returned an unrecognized status")
            code = status["code"]
            if code in {"42000", "50000"}:
                diagnostic = _graph_diagnostic(status) or _graph_diagnostic(page)
                context = f"Graph query failed ({code}, GQL {diagnostic or 'unreported'}): {status.get('description', '')}"
                raise self.http.error(response, self.http.redact(context))
            statuses = [status]
            for container in (status, page):
                additional = container.get("additionalStatuses")
                if additional is None:
                    continue
                if not isinstance(additional, list) or not all(isinstance(item, dict) for item in additional):
                    raise self.http.error(response, "Graph query returned invalid additionalStatuses")
                statuses.extend(additional)
            for warning in statuses:
                is_truncation = _graph_diagnostic(warning) == "01M11"
                if warning.get("code") == "01000" or is_truncation:
                    key = json.dumps(warning, sort_keys=True, ensure_ascii=False)
                    if key not in warning_keys:
                        warnings.append(warning)
                        warning_keys.add(key)
                    truncated = truncated or is_truncation
            result = page.get("result")
            if result is None:
                result = {}
            if not isinstance(result, dict) or (result and result.get("kind") != "TABLE"):
                raise self.http.error(response, "Graph query returned an unsupported result kind")
            page_columns, page_rows = result.get("columns", []), result.get("data", [])
            if not isinstance(page_columns, list) or not isinstance(page_rows, list):
                raise self.http.error(response, "Graph query returned invalid table columns or data")
            if page_columns:
                if columns and columns != page_columns:
                    raise self.http.error(response, "Graph query column schema changed between pages")
                columns = page_columns
            rows.extend(page_rows)
            token = result.get("nextPage")
            if token is None or token == "":
                return {"columns": columns, "rows": rows, "status": status, "warnings": warnings, "truncated": truncated}
            if not isinstance(token, str):
                raise self.http.error(response, "Graph query nextPage must be an opaque string")
            # Never decode the opaque token or feed an already encoded value through another encoder.
            path = endpoint + "&continuationToken=" + quote(token, safe="")
            delay = self.http.retry_delay(response, self.poll_interval if code == "02000" else 0)
            if self.http.monotonic() + delay >= deadline:
                raise TimeoutError("Graph query exceeded its execution deadline; results are incomplete")
            if delay:
                self.http.sleep(delay)
        raise ValueError("Graph query exceeded the page limit; results are incomplete")


class OntologyMCPClient:
    def __init__(self, workspace_id: str, ontology_id: str, token_provider: TokenProvider, *,
                 protocol_version: str = "2025-06-18", base_url: str = "https://api.fabric.microsoft.com", **http_options: Any):
        self.http = HttpClient(base_url, token_provider, **http_options)
        self.path = f"/v1/mcp/dataPlane/workspaces/{_segment(workspace_id)}/items/{_segment(ontology_id)}/ontologyEndpoint"
        self.protocol_version = protocol_version
        self._next_id = 0
        self._session_id = ""
        self._initialized = False

    def _headers(self) -> dict[str, str]:
        headers = {"Accept": "application/json, text/event-stream"}
        if self._initialized:
            headers["MCP-Protocol-Version"] = self.protocol_version
        if self._session_id:
            headers["Mcp-Session-Id"] = self._session_id
        return headers

    def call(self, method: str, parameters: dict[str, Any] | None = None) -> dict[str, Any]:
        self._next_id += 1
        request_id = self._next_id
        payload = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": parameters or {}}
        response = self.http.request("POST", self.path, json_body=payload, headers=self._headers())
        self._session_id = response.header("Mcp-Session-Id") or self._session_id
        if "text/event-stream" in response.header("Content-Type"):
            messages = sse_messages(response.body)
        elif not response.body.strip():
            messages = []
        else:
            value = response.json()
            messages = value if isinstance(value, list) else [value]
        matches = [message for message in messages if isinstance(message, dict) and message.get("id") == request_id]
        if not matches:
            error = self.http.error(response, "MCP response has no matching JSON-RPC id")
            raise MCPIncompleteResponse(error.status, error.request_id, error.body, "MCP response has no matching JSON-RPC id")
        message = matches[-1]
        if message.get("jsonrpc") != "2.0" or "error" in message or "result" not in message:
            raise self.http.error(response, "MCP JSON-RPC error")
        result = message["result"]
        if not isinstance(result, dict) or result.get("isError"):
            raise self.http.error(response, "MCP tool returned an error")
        return result

    def initialize(self) -> dict[str, Any]:
        result = self.call("initialize", {"protocolVersion": self.protocol_version, "capabilities": {},
                                         "clientInfo": {"name": "ontology-ingest", "version": "0.1.0"}})
        self.protocol_version = result.get("protocolVersion", self.protocol_version)
        self._initialized = True
        self.http.request("POST", self.path, json_body={"jsonrpc": "2.0", "method": "notifications/initialized"}, headers=self._headers())
        return result

    def list_tools(self) -> dict[str, Any]:
        if not self._initialized:
            self.initialize()
        tools: list[dict[str, Any]] = []
        parameters: dict[str, Any] = {}
        seen: set[str] = set()
        for _ in range(1000):
            result = self.call("tools/list", parameters)
            tools.extend(result.get("tools", []))
            cursor = result.get("nextCursor")
            if not cursor:
                return {"tools": tools}
            if cursor in seen:
                raise ValueError("MCP tools/list repeated a continuation cursor")
            seen.add(cursor)
            parameters = {"cursor": cursor}
        raise ValueError("MCP tools/list exceeded the page limit")

    def call_tool(self, name: str, arguments: dict[str, Any] | None = None, *, incomplete_retries: int = 1) -> dict[str, Any]:
        """Call a tool. The ontology endpoint's tools are read-only, so a call whose response arrives without our
        request id (a long query can outlast an intermediary's connection) is safely repeated with a fresh id. Learn's
        MCP tasks guidance is the fuller answer for long questions; the Foundry agent uses it through background mode."""
        if not self._initialized:
            self.initialize()
        for attempt in range(incomplete_retries + 1):
            try:
                return self.call("tools/call", {"name": name, "arguments": arguments or {}})
            except MCPIncompleteResponse:
                if attempt == incomplete_retries:
                    raise
        raise AssertionError("unreachable")
