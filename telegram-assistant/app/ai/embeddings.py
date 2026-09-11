"""Эмбеддинги для семантического поиска (pgvector). Провайдер — OpenAI-совместимый."""
from __future__ import annotations

import logging

import httpx

from app.config import get_settings

log = logging.getLogger(__name__)


async def embed(text: str) -> list[float] | None:
    s = get_settings()
    if not s.embeddings_enabled or not text.strip():
        return None
    url = f"{s.embeddings_base_url.rstrip('/')}/embeddings"
    headers = {"Authorization": f"Bearer {s.embeddings_api_key}", "Content-Type": "application/json"}
    payload = {"model": s.embeddings_model, "input": text[:8000]}
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(url, headers=headers, json=payload)
            r.raise_for_status()
            return r.json()["data"][0]["embedding"]
    except Exception as e:  # noqa: BLE001
        log.exception("Embeddings ошибка: %s", e)
        return None
