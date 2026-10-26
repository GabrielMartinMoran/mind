"""OmniMemEval client adapter for Mind's local Bun bridge.

A benchmark user maps to an isolated Mind space. Each ingestion add() creates
one session memory (the same granularity as Mind's prior retrieval benchmark).
"""
from __future__ import annotations

import os
import requests


class MindClient:
    def __init__(self):
        self._base = os.getenv("MIND_OMNI_URL", "http://127.0.0.1:40315")
        self._session = requests.Session()
        self._session.trust_env = False

    def _request(self, path: str, data: dict):
        response = self._session.post(self._base + path, json=data, timeout=180)
        response.raise_for_status()
        result = response.json()
        if "error" in result:
            raise RuntimeError(result["error"])
        return result

    def add(self, messages, user_id, **_kwargs):
        self._request("/add", {"user_id": user_id, "messages": messages})

    def search(self, query, user_id, top_k):
        return self._request("/search", {
            "user_id": user_id, "query": query, "top_k": top_k
        })["memories"]

    def delete(self, user_id):
        self._request("/delete", {"user_id": user_id})
