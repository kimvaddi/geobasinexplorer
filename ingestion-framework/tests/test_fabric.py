import json
from urllib.parse import parse_qs, quote, urlsplit

import pytest

from ontology_ingest.auth import StaticTokenProvider
from ontology_ingest.fabric import FabricClient, OntologyMCPClient
from ontology_ingest.http import ApiError, Response
from ontology_ingest.tmdl import build_definition, to_api_definition
from tests.fakes import FakeTransport, response


def client(fake, **kwargs):
    kwargs.setdefault("sleep", lambda _: None)
    return FabricClient("ws", StaticTokenProvider("test-token"), transport=fake, **kwargs)


def test_ontology_create_get_definition_lros_and_metadata_update(small_plan):
    parts = build_definition(small_plan, "Example", "desc", "host", "sql")
    definition = to_api_definition(parts)
    fake = FakeTransport(response({"value": []}), response({}, 202, Location="/v1/operations/create"),
                         response({"status": "Running"}), response({"status": "Succeeded"}), response({"id": "ont"}),
                         response({}, 202, Location="/v1/operations/get"), response({"status": "Succeeded"}),
                         response({"definition": definition}),
                         response({"value": [{"id": "ont", "type": "Ontology", "displayName": "Example"}]}),
                         response({}, 202, Location="/v1/operations/update"), response({"status": "Succeeded"}))
    api = client(fake)
    assert api.upsert_ontology("Example", parts, "desc")["id"] == "ont"
    assert api.get_ontology_definition("ont") == parts
    assert api.upsert_ontology("Example", parts, "desc")["id"] == "ont"
    assert fake.requests[1].json()["definition"] == definition
    assert fake.requests[1].json()["type"] == "Ontology"
    update = fake.requests[-2]
    assert update.url.endswith("/items/ont/updateDefinition?updateMetadata=true")
    assert update.json() == {"definition": definition}
    assert not fake.responses


def test_failed_and_timed_out_lros_are_not_successful():
    api = client(FakeTransport(response({"status": "Failed", "error": {"message": "bad test-token"}}, **{"request-id": "trace"})))
    with pytest.raises(ApiError) as error:
        api.poll_operation(response({}, 202, Location="/v1/operations/1"))
    assert "trace" in str(error.value) and "test-token" not in str(error.value)
    api = client(FakeTransport(response({"status": "Running"}), response({"status": "Running"})), max_polls=2)
    with pytest.raises(TimeoutError):
        api.poll_operation(response({}, 202, Location="/v1/operations/1"))
    with pytest.raises(ApiError, match="Location"):
        api.poll_operation(response({}, 202))


REGIONAL = "https://wabi-west-us3-a-primary-redirect.analysis.windows.net/v1/operations/0f0e0d0c-0b0a-4908-8706-050403020100"


@pytest.mark.parametrize("headers", [{"Location": REGIONAL, "x-ms-operation-id": "0f0e0d0c-0b0a-4908-8706-050403020100"},
                                     {"Location": REGIONAL}])
def test_regional_operation_location_is_polled_on_the_api_origin(headers):
    fake = FakeTransport(response({"status": "Running"}), response({"status": "Succeeded"}), response({"id": "nb"}))
    assert client(fake).poll_operation(response({}, 202, **headers)).json() == {"id": "nb"}
    assert [req.url for req in fake.requests] == [
        "https://api.fabric.microsoft.com/v1/operations/0f0e0d0c-0b0a-4908-8706-050403020100"] * 2 + [
        "https://api.fabric.microsoft.com/v1/operations/0f0e0d0c-0b0a-4908-8706-050403020100/result"]
    assert all(req.headers["Authorization"] == "Bearer test-token" for req in fake.requests)


@pytest.mark.parametrize("location", ["https://other.example/v1/workspaces/ws/items", "http://wabi.analysis.windows.net/v1/operations/1",
                                      "https://x.example/v1/operations/1?next=y", "https://x.example/v1/operations/1/../../items"])
def test_other_cross_origin_operation_urls_are_refused(location):
    fake = FakeTransport()
    with pytest.raises(ValueError, match="Refusing"):
        client(fake).poll_operation(response({}, 202, Location=location))
    assert not fake.requests


def test_any_foreign_host_is_never_contacted():
    fake = FakeTransport(response({"status": "Succeeded"}), response({"id": "x"}))
    client(fake).poll_operation(response({}, 202, Location="https://evil.example/v1/operations/op-1"))
    assert {urlsplit(req.url).netloc for req in fake.requests} == {"api.fabric.microsoft.com"}


def test_invalid_operation_id_header_is_rejected():
    with pytest.raises(ApiError, match="x-ms-operation-id"):
        client(FakeTransport()).poll_operation(response({}, 202, **{"x-ms-operation-id": "../../items"}))


def test_job_uses_special_notebook_endpoint_for_exit_value():
    fake = FakeTransport(response({}, 202, Location="/v1/workspaces/ws/items/nb/jobs/instances/job-1"),
                         response({"status": "NotStarted"}), response({"status": "InProgress"}), response({"status": "Completed"}),
                         response({"properties": {"exitValue": '{"runId":"run"}'}}))
    result = client(fake).run_notebook_job("nb", {"run_id": "run", "landing_dir": "landing/run"})
    assert result == {"status": "Completed", "id": "job-1", "exitValue": '{"runId":"run"}'}
    assert fake.requests[0].json()["executionData"]["parameters"]["run_id"] == {"value": "run", "type": "string"}
    assert fake.requests[-1].url.endswith("/notebooks/nb/jobs/execute/instances/job-1?beta=true")
    assert all("?beta=true" not in req.url for req in fake.requests[1:-1])


@pytest.mark.parametrize("status", ["Failed", "Cancelled"])
def test_job_terminal_failure(status):
    fake = FakeTransport(response({}, 202, Location="/jobs/j"), response({"status": status}, **{"request-id": "jobtrace"}))
    with pytest.raises(ApiError, match="jobtrace"):
        client(fake).run_notebook_job("nb", {})


def test_graph_model_upsert_and_refresh_use_the_documented_definition_and_job_endpoints():
    parts = {".platform": "{}", "graphType.json": "{}"}
    fake = FakeTransport(response({"value": []}), response({"id": "g"}, 201),
                         response({}, 202, Location="/v1/workspaces/ws/items/g/jobs/instances/job-1"),
                         response({"status": "InProgress"}), response({"status": "Failed", "failureReason": {"message": "not initialized"}}))
    api = client(fake)
    assert api.upsert_graph_model("geobasin_graph", parts, "desc")["id"] == "g"
    created = fake.requests[1].json()
    assert created["type"] == "GraphModel" and created["definition"]["format"] == "json"
    assert sorted(part["path"] for part in created["definition"]["parts"]) == [".platform", "graphType.json"]
    assert api.run_graph_refresh("g") == {"status": "Failed", "id": "job-1", "failureReason": {"message": "not initialized"}}
    assert (fake.requests[2].method, fake.requests[2].url) == (
        "POST", "https://api.fabric.microsoft.com/v1/workspaces/ws/graphModels/g/jobs/refreshGraph/instances")


def test_a_deduped_graph_refresh_waits_for_the_refresh_already_running():
    jobs = {"value": [{"id": "old", "status": "Completed", "startTimeUtc": "2026-11-07T14:00:00"},
                      {"id": "auto", "status": "NotStarted", "startTimeUtc": "2026-11-07T14:35:45"},
                      {"id": "mine", "status": "Deduped", "startTimeUtc": "2026-11-07T14:35:48"}]}
    fake = FakeTransport(response({}, 202, Location="/v1/workspaces/ws/items/g/jobs/instances/mine"), response({"status": "Deduped"}),
                         response(jobs), response({"status": "InProgress"}), response({"status": "Completed"}))
    assert client(fake).run_graph_refresh("g") == {"status": "Completed", "id": "auto", "failureReason": None}
    assert fake.requests[2].url.endswith("/v1/workspaces/ws/items/g/jobs/instances")
    assert fake.requests[-1].url.endswith("/v1/workspaces/ws/items/g/jobs/instances/auto")


def test_list_pagination_and_duplicate_item_names():
    fake = FakeTransport(response({"value": [], "continuationToken": "+/="}),
                         response({"value": [{"id": "1", "type": "Ontology", "displayName": "X"}]}))
    assert client(fake).find_item("X", "Ontology")["id"] == "1"
    assert parse_qs(urlsplit(fake.requests[1].url).query)["continuationToken"] == ["+/="]
    fake = FakeTransport(response({"value": [{"id": str(i), "displayName": "X", "type": "Ontology"} for i in range(2)]}))
    with pytest.raises(ValueError, match="Multiple"):
        client(fake).find_item("X", "Ontology")


def test_create_schema_enabled_lakehouse_and_refresh_failure():
    fake = FakeTransport(response({"id": "lh"}, 201), response({"value": [{"tableName": "dbo.t", "status": "Failed"}]}))
    api = client(fake)
    assert api.create_lakehouse("L")["id"] == "lh"
    assert fake.requests[0].json()["creationPayload"] == {"enableSchemas": True}
    with pytest.raises(ApiError, match="refresh"):
        api.refresh_sql_endpoint_metadata("sql")
    assert fake.requests[-1].json() == {}


def test_refresh_accepts_not_run_for_synced_tables_and_requires_binding_tables():
    synced = {"tableName": "dbo.basin", "status": "NotRun", "lastSuccessfulSyncDateTime": "2026-11-06T12:17:51Z"}
    fresh = {"tableName": "dbo.rel_x", "status": "Success", "lastSuccessfulSyncDateTime": "2026-11-06T12:21:33Z"}
    api = client(FakeTransport(response({"value": [synced, fresh]})))
    assert len(api.refresh_sql_endpoint_metadata("sql", ["dbo.basin", "DBO.REL_X"])["value"]) == 2
    never = {"tableName": "dbo.basin", "status": "NotRun", "lastSuccessfulSyncDateTime": None}
    with pytest.raises(ApiError, match="dbo.basin"):
        client(FakeTransport(response({"value": [never]}))).refresh_sql_endpoint_metadata("sql")
    with pytest.raises(ValueError, match="1 binding tables yet: dbo.wellbore"):
        client(FakeTransport(response({"value": [synced]}))).refresh_sql_endpoint_metadata("sql", ["dbo.basin", "dbo.wellbore"])


def test_refresh_ignores_unsynced_tables_the_ontology_does_not_bind():
    synced = {"tableName": "dbo.basin", "status": "Success", "lastSuccessfulSyncDateTime": "2026-11-07T17:13:37Z"}
    other = {"tableName": "raw_live6.t_backup_5b253441", "status": "Failure", "lastSuccessfulSyncDateTime": None}
    assert client(FakeTransport(response({"value": [synced, other]}))).refresh_sql_endpoint_metadata("sql", ["dbo.basin"])
    failed = dict(synced, status="Failure")
    with pytest.raises(ApiError, match="dbo.basin"):
        client(FakeTransport(response({"value": [failed, other]}))).refresh_sql_endpoint_metadata("sql", ["dbo.basin"])


def test_pipeline_run_passes_parameters_and_reports_its_activity_runs():
    fake = FakeTransport(response({}, 202, Location="/v1/workspaces/ws/items/p/jobs/instances/job-1"),
                         response({"status": "InProgress"}), response({"status": "Failed", "failureReason": {"message": "copy failed"}}),
                         response({"value": [{"activityName": "Copy entity file", "status": "Failed"}, "not a run"]}))
    api = client(fake)
    result = api.run_pipeline("p", {"run_id": "live6"})
    assert (result["status"], result["id"], result["failureReason"]) == ("Failed", "job-1", {"message": "copy failed"})
    assert fake.requests[0].url.endswith("/v1/workspaces/ws/items/p/jobs/instances?jobType=Pipeline")
    assert fake.requests[0].json() == {"executionData": {"parameters": {"run_id": "live6"}}}
    assert api.pipeline_activity_runs("job-1", after="a", before="b") == [{"activityName": "Copy entity file", "status": "Failed"}]
    assert fake.requests[-1].url.endswith("/v1/workspaces/ws/datapipelines/pipelineruns/job-1/queryactivityruns")
    assert (fake.requests[-1].json()["lastUpdatedAfter"], fake.requests[-1].json()["lastUpdatedBefore"]) == ("a", "b")
    with pytest.raises(ValueError, match="strings"):
        api.run_pipeline("p", {"retain_runs": 2})


def graph_page(code="00000", *, rows=None, columns=None, token=None):
    result = {"kind": "TABLE", "columns": columns or [], "data": rows or []}
    if token is not None:
        result["nextPage"] = token
    return {"status": {"code": code, "description": "Query status."}, "result": result}


def test_graph_retains_generic_lro_compatibility_with_table_results():
    columns = [{"name": "label", "type": "STRING"}]
    fake = FakeTransport(response({}, 202, Location="/operations/q"), response({"status": "Succeeded"}),
                         response(graph_page(rows=[["A"]], columns=columns)))
    result = client(fake).graph_execute_query("graph", "MATCH (n) RETURN n.label")
    assert result["columns"] == columns and result["rows"] == [["A"]]
    assert result["status"]["code"] == "00000" and not result["warnings"] and not result["truncated"]


def test_mcp_handshake_session_headers_and_json_tool_results():
    fake = FakeTransport(response({"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": "2025-06-18", "serverInfo": {"name": "Ontology"}}}, **{"Mcp-Session-Id": "session"}),
                         response({}, 202), response({"jsonrpc": "2.0", "id": 2, "result": {"tools": [{"name": "ask_ontology"}]}}),
                         response({"jsonrpc": "2.0", "id": 3, "result": {"content": [{"type": "text", "text": "Answer"}], "isError": False}}))
    api = OntologyMCPClient("ws", "ont", StaticTokenProvider("pbi-token"), transport=fake)
    assert api.list_tools()["tools"][0]["name"] == "ask_ontology"
    assert api.call_tool("ask_ontology", {"request": "Describe entities"})["content"][0]["text"] == "Answer"
    assert fake.requests[0].json()["params"]["protocolVersion"] == "2025-06-18"
    assert "id" not in fake.requests[1].json()
    assert fake.requests[1].json()["method"] == "notifications/initialized"
    assert fake.requests[2].headers["Mcp-Session-Id"] == "session"
    assert fake.requests[2].headers["MCP-Protocol-Version"] == "2025-06-18"


def test_mcp_sse_ignores_notifications_and_matches_request_id():
    sse = (b'event: message\ndata: {"jsonrpc":"2.0","method":"progress"}\n\n'
           b'data: {"jsonrpc":"2.0","id":99,"result":{"wrong":true}}\n\n'
           b'data: {"jsonrpc":"2.0","id":1,\ndata: "result":{"tools":[]}}\n\n')
    fake = FakeTransport(Response(200, {"Content-Type": "text/event-stream"}, sse))
    api = OntologyMCPClient("w", "o", StaticTokenProvider("secret"), transport=fake)
    assert api.call("tools/list") == {"tools": []}


@pytest.mark.parametrize("payload", [{"jsonrpc": "2.0", "id": 1, "error": {"message": "bad"}},
                                      {"jsonrpc": "2.0", "id": 1, "result": {"isError": True}},
                                      {"jsonrpc": "2.0", "id": 42, "result": {}}])
def test_mcp_errors_are_not_silent_success(payload):
    api = OntologyMCPClient("w", "o", StaticTokenProvider("secret"), transport=FakeTransport(response(payload)))
    with pytest.raises(ApiError, match="MCP"):
        api.call("tools/call")


def test_graph_polls_repeated_in_progress_tokens_then_aggregates_rows_with_rfc3986_encoding():
    token = "opaque+/=%2F space?&é"
    columns = [{"name": "label", "type": "STRING"}]
    fake = FakeTransport(response(graph_page("02000", token=token)),
                         response(graph_page("02000", token=token)),
                         response(graph_page(rows=[["A"]], columns=columns, token="page/2")),
                         response(graph_page(rows=[["B"]], columns=columns)))
    delays = []
    result = client(fake, sleep=delays.append).graph_execute_query("graph", "MATCH (n) RETURN n.label")
    endpoint = "https://api.fabric.microsoft.com/v1/workspaces/ws/graphModels/graph/executeQuery?beta=true"
    assert fake.requests[0].url == endpoint
    assert fake.requests[1].url == fake.requests[2].url == endpoint + "&continuationToken=" + quote(token, safe="")
    assert parse_qs(urlsplit(fake.requests[1].url).query)["continuationToken"] == [token]
    assert fake.requests[3].url == endpoint + "&continuationToken=page%2F2"
    assert all(request.method == "POST" and request.json() == {"query": "MATCH (n) RETURN n.label"} for request in fake.requests)
    assert result == {"columns": columns, "rows": [["A"], ["B"]],
                      "status": {"code": "00000", "description": "Query status."}, "warnings": [], "truncated": False}
    assert delays == [2, 2]


def test_graph_throttling_honors_retry_after():
    fake = FakeTransport(response({}, 429, **{"Retry-After": "3"}), response(graph_page(rows=[[1]], columns=["count"])))
    delays = []
    result = client(fake, sleep=delays.append).graph_execute_query("g", "query")
    assert delays == [3] and result["rows"] == [[1]]
    assert fake.requests[0].body == fake.requests[1].body


@pytest.mark.parametrize("code,diagnostic", [("42000", "42N01"), ("50000", "50N00")])
def test_graph_application_errors_on_http_200_include_description_and_diagnostics(code, diagnostic):
    body = {"status": {"code": code, "description": "Query problem involving test-token",
                       "diagnostics": {"_graphaneGqlStatus": diagnostic}}}
    fake = FakeTransport(response(body, **{"request-id": "graph-trace"}))
    with pytest.raises(ApiError) as error:
        client(fake).graph_execute_query("g", "query")
    message = str(error.value)
    assert error.value.status == 200 and "Query problem" in message and diagnostic in message and code in message
    assert "graph-trace" in message and "test-token" not in message
    assert len(fake.requests) == 1


@pytest.mark.parametrize("location", ["status", "response"])
@pytest.mark.parametrize("diagnostic", ["01M11", {"gqlType": "STRING", "value": "01M11"}])
def test_graph_truncation_additional_status_is_exposed_as_a_warning(location, diagnostic):
    warning = {"code": "01000", "description": "Result truncated above 64 MB.",
               "diagnostics": {"_graphaneGqlStatus": diagnostic}}
    page = graph_page(rows=[[1]], columns=["n"])
    parent = page["status"] if location == "status" else page
    parent["additionalStatuses"] = [warning]
    fake = FakeTransport(response(page))
    result = client(fake).graph_execute_query("g", "query")
    assert result["rows"] == [[1]] and result["warnings"] == [warning] and result["truncated"]
    assert len(fake.requests) == 1


def test_graph_top_level_warning_is_not_automatically_truncation():
    page = graph_page("01000", rows=[[1]], columns=["n"])
    page["status"]["description"] = "A non-truncation warning."
    result = client(FakeTransport(response(page))).graph_execute_query("g", "query")
    assert result["warnings"] == [page["status"]] and not result["truncated"]


@pytest.mark.parametrize("code", ["00001", "02000"])
def test_graph_omitted_and_empty_results_terminate_without_a_next_page(code):
    page = graph_page(code)
    if code == "00001":
        page["result"] = None
    result = client(FakeTransport(response(page))).graph_execute_query("g", "query")
    assert result["columns"] == [] and result["rows"] == [] and result["status"]["code"] == code


def test_graph_server_query_timeout_is_not_retried_or_returned_as_success():
    fake = FakeTransport(response(graph_page("02000", token="pending")),
                         response({"error": {"code": "QueryTimeout", "message": "Exceeded 20 minutes"}}, 408))
    with pytest.raises(ApiError, match="QueryTimeout") as error:
        client(fake).graph_execute_query("g", "query")
    assert error.value.status == 408 and len(fake.requests) == 2


def test_graph_page_and_execution_budgets_are_bounded():
    fake = FakeTransport(response(graph_page("02000", token="pending")), response(graph_page("02000", token="pending")))
    with pytest.raises(ValueError, match="page limit"):
        client(fake).graph_execute_query("g", "query", max_pages=2)
    now = [0.0]
    def sleep(delay):
        now[0] += delay
    fake = FakeTransport(response(graph_page("02000", token="pending")), response(graph_page("02000", token="pending")))
    with pytest.raises(TimeoutError):
        client(fake, operation_timeout=3, monotonic=lambda: now[0], sleep=sleep).graph_execute_query("g", "query")
    assert len(fake.requests) == 2


def test_graph_rejects_schema_drift_and_non_string_continuation_tokens():
    fake = FakeTransport(response(graph_page(rows=[[1]], columns=["a"], token="next")),
                         response(graph_page(rows=[[2]], columns=["b"])))
    with pytest.raises(ApiError, match="schema"):
        client(fake).graph_execute_query("g", "query")
    fake = FakeTransport(response(graph_page("02000", token={"not": "a token"})))
    with pytest.raises(ApiError, match="nextPage"):
        client(fake).graph_execute_query("g", "query")


def test_graph_optional_null_status_details_and_invalid_public_status():
    page = graph_page("02000")
    page["status"]["additionalStatuses"] = None
    page["status"]["diagnostics"] = None
    assert client(FakeTransport(response(page))).graph_execute_query("g", "query")["rows"] == []
    with pytest.raises(ApiError, match="status"):
        client(FakeTransport(response({"status": {"code": []}}))).graph_execute_query("g", "query")


def test_regional_notebook_job_uses_documented_api_origin_path_not_operation_id():
    location = "https://wabi-west-us3-a-primary-redirect.analysis.windows.net/v1/workspaces/ws/items/nb/jobs/instances/job1"
    fake = FakeTransport(response({}, 202, Location=location, **{"x-ms-operation-id": "different-operation"}),
                         response({"status": "Completed"}), response({"properties": {"exitValue": "{}"}}))
    result = client(fake).run_notebook_job("nb", {})
    assert result["id"] == "job1"
    assert fake.requests[1].url == "https://api.fabric.microsoft.com/v1/workspaces/ws/items/nb/jobs/instances/job1"
    assert fake.requests[2].url.endswith("/notebooks/nb/jobs/execute/instances/job1?beta=true")
    assert {urlsplit(request.url).netloc for request in fake.requests} == {"api.fabric.microsoft.com"}


@pytest.mark.parametrize("location", [
    "https://evil.example/v1/workspaces/other/items/nb/jobs/instances/j",
    "https://evil.example/v1/workspaces/ws/items/other/jobs/instances/j",
    "https://evil.example/v1/workspaces/ws/items/nb/jobs/instances/j?secret=x",
    "https://evil.example/v1/workspaces/ws/items/nb/jobs/instances/j#fragment",
    "http://evil.example/v1/workspaces/ws/items/nb/jobs/instances/j",
    "https://user:pass@evil.example/v1/workspaces/ws/items/nb/jobs/instances/j",
])
def test_regional_notebook_job_rejects_undocumented_locations(location):
    fake = FakeTransport(response({}, 202, Location=location))
    with pytest.raises(ValueError, match="Refusing"):
        client(fake).run_notebook_job("nb", {})
    assert len(fake.requests) == 1


@pytest.mark.parametrize("status", ["Skipped", "Completed", "Succeeded", "Failure"])
def test_sql_refresh_only_accepts_documented_success_states(status):
    fake = FakeTransport(response({"value": [{"tableName": "dbo.t", "status": status, "lastSuccessfulSyncDateTime": "2026-11-06T00:00:00Z"}]}))
    with pytest.raises(ApiError, match="refresh"):
        client(fake).refresh_sql_endpoint_metadata("sql", ["dbo.t"])


def test_mcp_tool_call_repeats_once_after_an_empty_response_then_fails_clearly():
    from ontology_ingest.fabric import MCPIncompleteResponse
    from ontology_ingest.http import Response
    empty = Response(200, {"Content-Type": "application/json; charset=utf-8"}, b"")
    init = response({"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": "2025-06-18"}})
    answer = response({"jsonrpc": "2.0", "id": 3, "result": {"content": [{"type": "text", "text": "Answer"}], "isError": False}})
    fake = FakeTransport(init, response({}, 202), empty, answer)
    api = OntologyMCPClient("ws", "ont", StaticTokenProvider("pbi-token"), transport=fake)
    assert api.call_tool("ask_ontology", {"request": "Which core images?"})["content"][0]["text"] == "Answer"
    assert [req.json()["id"] for req in fake.requests[2:]] == [2, 3]
    assert fake.requests[2].json()["params"] == fake.requests[3].json()["params"]
    fake = FakeTransport(init, response({}, 202), empty, empty)
    with pytest.raises(MCPIncompleteResponse, match="no matching JSON-RPC id"):
        OntologyMCPClient("ws", "ont", StaticTokenProvider("pbi-token"), transport=fake).call_tool("ask_ontology", {"request": "x y z"})
