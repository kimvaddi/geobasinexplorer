import base64
import io
import json
from email.utils import formatdate
from types import SimpleNamespace

import pytest

from ontology_ingest.auth import AzureCliTokenProvider, StaticTokenProvider
from ontology_ingest.http import ApiError, HttpClient, Response, UrllibTransport
from tests.fakes import FakeTransport, response


def test_azure_cli_cache_refreshes_five_minutes_before_jwt_expiry():
    now = [0]
    calls = []
    payload = base64.urlsafe_b64encode(json.dumps({"exp": 1000}).encode()).decode().rstrip("=")
    token = "header." + payload + ".signature"

    def runner(args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(stdout=token + "\n")
    provider = AzureCliTokenProvider("https://resource.invalid", runner=runner, clock=lambda: now[0])
    assert provider.get_token() == token and provider.get_token() == token
    assert len(calls) == 1
    now[0] = 701
    assert provider.get_token() == token and len(calls) == 2
    assert calls[0][0] == ["az", "account", "get-access-token", "--resource", "https://resource.invalid", "--query", "accessToken", "-o", "tsv"]
    assert calls[0][1]["check"] and calls[0][1]["capture_output"]


def test_opaque_tokens_are_not_assumed_to_have_a_long_expiry():
    calls = []
    provider = AzureCliTokenProvider("r", runner=lambda *a, **k: (calls.append(1) or SimpleNamespace(stdout="opaque")))
    provider.get_token()
    provider.get_token()
    assert len(calls) == 2
    assert "secret" not in repr(StaticTokenProvider("secret"))


def test_http_retries_throttling_and_server_errors_with_bounded_delays():
    fake = FakeTransport(response({"error": "slow"}, 429, **{"Retry-After": "999"}),
                         response({}, 503, **{"Retry-After": formatdate(1020, usegmt=True)}), response({"ok": True}))
    delays = []
    client = HttpClient("https://service.invalid", StaticTokenProvider("secret"), transport=fake,
                        max_retry_after=7, sleep=delays.append, clock=lambda: 1000)
    assert client.request("POST", "/v1/resource", json_body={"x": "é"}).json() == {"ok": True}
    assert delays == [7, 7] and len(fake.requests) == 3
    assert all(request.json() == {"x": "é"} for request in fake.requests)
    assert fake.requests[0].headers["Authorization"] == "Bearer secret"


def test_retries_stop_and_errors_include_request_id_without_tokens():
    fake = FakeTransport(*(response({"error": "secret-token", "detail": "Bearer another-token"}, 503,
                                    **{"x-ms-request-id": "trace-123"}) for _ in range(3)))
    client = HttpClient("https://service.invalid", StaticTokenProvider("secret-token"), transport=fake, max_retries=2, sleep=lambda _: None)
    with pytest.raises(ApiError) as error:
        client.request("GET", "/resource")
    assert error.value.request_id == "trace-123" and error.value.status == 503
    assert "secret-token" not in str(error.value) and "another-token" not in str(error.value)
    assert "trace-123" in str(error.value) and len(fake.requests) == 3


@pytest.mark.parametrize("url", ["https://evil.invalid/path", "http://service.invalid/path", "//evil.invalid/path", "https://user:pass@service.invalid/path"])
def test_cross_origin_continuations_are_rejected_before_authentication(url):
    class ForbiddenToken:
        def get_token(self):
            raise AssertionError("Should validate the URL before requesting a token")
    client = HttpClient("https://service.invalid", ForbiddenToken(), transport=FakeTransport())
    with pytest.raises(ValueError, match="Refusing"):
        client.request("GET", url)


def test_unauthorized_requests_are_not_retried():
    fake = FakeTransport(response({"error": "denied"}, 401))
    client = HttpClient("https://service.invalid", StaticTokenProvider("secret"), transport=fake)
    with pytest.raises(ApiError):
        client.request("GET", "/x")
    assert len(fake.requests) == 1


def test_sse_transport_stops_at_matching_response_without_waiting_for_disconnect():
    body = (b'data: {"jsonrpc":"2.0","method":"progress"}\n\n'
            b'event: message\ndata: {"jsonrpc":"2.0","id":2,\ndata: "result":{"ok":true}}\n\n'
            b'data: never read this trailing event\n\n')
    stream = io.BytesIO(body)
    transport = UrllibTransport()
    result = transport._read(stream, {"Content-Type": "text/event-stream"}, b'{"id":2}', 10)
    assert b"never read" not in result
    assert stream.read() == b'data: never read this trailing event\n\n'


def test_http_response_size_limit_is_enforced():
    with pytest.raises(RuntimeError, match="byte limit"):
        UrllibTransport(max_response_bytes=3)._read(io.BytesIO(b"1234"), {}, None, 1)


def test_errors_redact_a_token_from_an_earlier_retry_attempt():
    tokens = iter(["old-secret", "new-secret"])
    provider = SimpleNamespace(get_token=lambda: next(tokens))
    fake = FakeTransport(response({}, 503), response({"message": "old-secret and new-secret"}, 403))
    client = HttpClient("https://service.invalid", provider, transport=fake, sleep=lambda _: None)
    with pytest.raises(ApiError) as error:
        client.request("GET", "/x")
    assert "old-secret" not in str(error.value) and "new-secret" not in str(error.value)
