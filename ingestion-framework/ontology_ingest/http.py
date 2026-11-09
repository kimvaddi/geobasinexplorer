"""Stdlib HTTP transport with injectable I/O, bounded retries and safe redirects."""
from __future__ import annotations

import json
import math
import re
import time
import threading
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import timezone
from email.utils import parsedate_to_datetime
from typing import Any, Callable, Protocol

from .auth import TokenProvider


@dataclass
class Response:
    status: int
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes = b""

    def header(self, name: str, default: str = "") -> str:
        return next((value for key, value in self.headers.items() if key.lower() == name.lower()), default)

    def json(self) -> Any:
        return json.loads(self.body) if self.body.strip() else {}


class Transport(Protocol):
    def request(self, method: str, url: str, headers: dict[str, str], body: bytes | None, timeout: float) -> Response: ...


class ApiError(RuntimeError):
    def __init__(self, status: int, request_id: str, body: str, context: str = "HTTP request failed"):
        self.status = status
        self.request_id = request_id
        self.body = body
        super().__init__(f"{context} (HTTP {status}, request id {request_id or 'unavailable'}): {body}")


def sse_messages(body: bytes) -> list[dict[str, Any]]:
    messages = []
    for event in re.split(r"\r?\n\r?\n", body.decode("utf-8-sig")):
        data = "\n".join(line[5:].lstrip(" ") for line in event.splitlines() if line.startswith("data:"))
        if not data or data.strip() == "[DONE]":
            continue
        try:
            value = json.loads(data)
        except ValueError:
            continue
        if isinstance(value, dict):
            messages.append(value)
    return messages


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        return None


class UrllibTransport:
    def __init__(self, *, max_response_bytes: int = 128 * 1024 * 1024):
        self.max_response_bytes = max_response_bytes
        self._local = threading.local()

    def _read(self, stream: Any, headers: dict[str, str], request_body: bytes | None, timeout: float) -> bytes:
        content_type = next((value for key, value in headers.items() if key.lower() == "content-type"), "")
        if "text/event-stream" not in content_type:
            body = stream.read(self.max_response_bytes + 1)
            if len(body) > self.max_response_bytes:
                raise RuntimeError("HTTP response exceeds the configured byte limit")
            return body
        request_id = json.loads(request_body or b"{}").get("id")
        chunks: list[bytes] = []
        event: list[bytes] = []
        size = 0
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            line = stream.readline(self.max_response_bytes - size + 1)
            if not line:
                break
            size += len(line)
            if size > self.max_response_bytes:
                raise RuntimeError("SSE response exceeds the configured byte limit")
            chunks.append(line)
            event.append(line)
            if not line.strip():
                if any(message.get("id") == request_id and ("result" in message or "error" in message)
                       for message in sse_messages(b"".join(event))):
                    break
                event = []
        else:
            raise TimeoutError("SSE response did not complete before the request deadline")
        return b"".join(chunks)

    def request(self, method: str, url: str, headers: dict[str, str], body: bytes | None, timeout: float) -> Response:
        request = urllib.request.Request(url, data=body, headers=headers, method=method)
        if not hasattr(self._local, "opener"):
            self._local.opener = urllib.request.build_opener(_NoRedirect())
        try:
            with self._local.opener.open(request, timeout=timeout) as stream:
                response_headers = dict(stream.headers.items())
                return Response(stream.status, response_headers, self._read(stream, response_headers, body, timeout))
        except urllib.error.HTTPError as error:
            with error:
                return Response(error.code, dict(error.headers.items()), error.read(self.max_response_bytes))
        except urllib.error.URLError:
            # Do not replay ambiguous transport failures: a POST may already have succeeded.
            raise RuntimeError("HTTP transport failed; inspect connectivity before retrying the operation") from None


class HttpClient:
    def __init__(self, base_url: str, token_provider: TokenProvider, *, transport: Transport | None = None,
                 max_retries: int = 4, max_retry_after: float = 60, timeout: float = 120,
                 sleep: Callable[[float], None] = time.sleep, clock: Callable[[], float] = time.time,
                 monotonic: Callable[[], float] = time.monotonic):
        if max_retries < 0 or max_retry_after < 0 or timeout <= 0:
            raise ValueError("Invalid HTTP retry or timeout settings")
        self.base_url = base_url.rstrip("/")
        parsed = urllib.parse.urlsplit(self.base_url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("HTTP base URL must be an HTTPS origin without credentials")
        self._origin = parsed.scheme, parsed.netloc
        self.token_provider = token_provider
        self.transport = transport if transport is not None else UrllibTransport()
        self.max_retries = max_retries
        self.max_retry_after = max_retry_after
        self.timeout = timeout
        self.sleep, self.clock, self.monotonic = sleep, clock, monotonic
        self._last_token = ""
        self._issued_tokens: set[str] = set()
        self._token_lock = threading.Lock()

    def url(self, path: str) -> str:
        result = urllib.parse.urljoin(self.base_url + "/", path)
        parsed = urllib.parse.urlsplit(result)
        if (parsed.scheme, parsed.netloc) != self._origin or parsed.username or parsed.password or parsed.fragment:
            raise ValueError("Refusing a cross-origin, credential-bearing or fragment-bearing API URL")
        return result

    def is_same_origin(self, url: str) -> bool:
        parsed = urllib.parse.urlsplit(urllib.parse.urljoin(self.base_url + "/", url))
        return (parsed.scheme, parsed.netloc) == self._origin

    def redact(self, text: str) -> str:
        with self._token_lock:
            tokens = sorted(self._issued_tokens, key=len, reverse=True)
        for token in tokens:
            if token:
                text = text.replace(token, "[REDACTED]")
        return re.sub(r"(?i)bearer\s+[^\s\"'<>]+", "Bearer [REDACTED]", text)

    def error(self, response: Response, context: str = "HTTP request failed") -> ApiError:
        request_id = response.header("request-id") or response.header("x-ms-request-id") or response.header("x-ms-correlation-request-id")
        return ApiError(response.status, self.redact(request_id), self.redact(response.body.decode("utf-8", errors="replace")), context)

    def retry_delay(self, response: Response, default: float = 1) -> float:
        value = response.header("Retry-After")
        delay = default
        if value:
            try:
                delay = float(value)
            except ValueError:
                try:
                    date = parsedate_to_datetime(value)
                    if date.tzinfo is None:
                        date = date.replace(tzinfo=timezone.utc)
                    delay = date.timestamp() - self.clock()
                except (ValueError, TypeError, OverflowError):
                    pass
        if not math.isfinite(delay):
            delay = default
        return max(0, min(delay, self.max_retry_after))

    def request(self, method: str, path: str, *, json_body: Any = None, data: bytes | None = None,
                headers: dict[str, str] | None = None, allow_status: tuple[int, ...] = (), retry: bool | None = None) -> Response:
        url = self.url(path)
        if json_body is not None and data is not None:
            raise ValueError("Supply either json_body or data, not both")
        outgoing = {"Accept": "application/json", **(headers or {})}
        if json_body is not None:
            data = json.dumps(json_body, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
            outgoing["Content-Type"] = "application/json"
        retries = self.max_retries if (retry if retry is not None else method.upper() != "PATCH") else 0
        for attempt in range(retries + 1):
            token = self.token_provider.get_token()
            with self._token_lock:
                self._last_token = token
                self._issued_tokens.add(token)
            outgoing["Authorization"] = "Bearer " + token
            response = self.transport.request(method, url, dict(outgoing), data, self.timeout)
            if (response.status == 429 or 500 <= response.status <= 599) and attempt < retries:
                self.sleep(self.retry_delay(response, min(2**attempt, self.max_retry_after)))
                continue
            if 200 <= response.status < 300 or response.status in allow_status:
                return response
            raise self.error(response)
        raise AssertionError("Unreachable retry state")
