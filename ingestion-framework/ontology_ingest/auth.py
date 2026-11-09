"""Lazy token providers. Tokens are never serialized to configuration or logs."""
from __future__ import annotations

import base64
import importlib
import json
import math
import subprocess
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol

FABRIC_RESOURCE = "https://api.fabric.microsoft.com"
STORAGE_RESOURCE = "https://storage.azure.com/"
POWER_BI_RESOURCE = "https://analysis.windows.net/powerbi/api"


class TokenProvider(Protocol):
    def get_token(self) -> str: ...


@dataclass
class StaticTokenProvider:
    token: str = field(repr=False)

    def get_token(self) -> str:
        if not self.token:
            raise ValueError("An access token is required")
        return self.token


def _expiry(token: str) -> float:
    try:
        payload = token.split(".")[1]
        value = float(json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))["exp"])
        return value if math.isfinite(value) else 0
    except (ValueError, KeyError, IndexError, TypeError):
        return 0


class AzureCliTokenProvider:
    def __init__(self, resource: str, *, runner: Callable[..., Any] = subprocess.run,
                 clock: Callable[[], float] = time.time):
        self.resource = resource
        self._runner = runner
        self._clock = clock
        self._token = ""
        self._expires = 0.0
        self._lock = threading.Lock()

    def get_token(self) -> str:
        with self._lock:
            if self._token and self._clock() < self._expires - 300:
                return self._token
            try:
                result = self._runner(["az", "account", "get-access-token", "--resource", self.resource,
                                       "--query", "accessToken", "-o", "tsv"],
                                      check=True, capture_output=True, text=True, timeout=60)
            except (OSError, subprocess.SubprocessError) as error:
                raise RuntimeError("Azure CLI token acquisition failed; check az login and the requested resource") from None
            token = result.stdout.strip()
            if not token:
                raise RuntimeError("Azure CLI returned an empty access token")
            self._token, self._expires = token, _expiry(token)
            return token


class NotebookTokenProvider:
    def __init__(self, audience_key: str):
        self.audience_key = audience_key

    def get_token(self) -> str:
        try:
            notebookutils = importlib.import_module("notebookutils")
        except ImportError as error:
            raise RuntimeError("NotebookTokenProvider must run inside a Fabric notebook") from error
        token = notebookutils.credentials.getToken(self.audience_key)
        if not isinstance(token, str) or not token:
            raise RuntimeError("Notebook token provider returned an empty access token")
        return token
