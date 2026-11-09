import json
from dataclasses import dataclass
from typing import Any

from ontology_ingest.http import Response


def response(body: Any = None, status: int = 200, **headers: str) -> Response:
    return Response(status, headers, json.dumps(body if body is not None else {}).encode())


@dataclass
class Request:
    method: str
    url: str
    headers: dict[str, str]
    body: bytes | None
    timeout: float

    def json(self) -> Any:
        return json.loads(self.body) if self.body else None


class FakeTransport:
    def __init__(self, *responses: Response):
        self.responses = list(responses)
        self.requests: list[Request] = []

    def request(self, method, url, headers, body, timeout):
        self.requests.append(Request(method, url, headers, body, timeout))
        assert self.responses, f"Unexpected request: {method} {url}"
        return self.responses.pop(0)
