"""Короткоживущее состояние диалога (например, «ждём ввод времени/даты»).

Хранится в Redis с TTL. Если Redis нет — используем локальный dict (на один процесс).
"""
from __future__ import annotations

import json
import logging
import time

import redis.asyncio as redis

from app.config import get_settings

log = logging.getLogger(__name__)

_client: redis.Redis | None = None
_fallback: dict[str, tuple[float, dict]] = {}


def _redis() -> redis.Redis | None:
    global _client
    if _client is None:
        try:
            _client = redis.from_url(get_settings().redis_url, decode_responses=True)
        except Exception:  # noqa: BLE001
            return None
    return _client


async def set_await(tg_id: int, payload: dict, ttl: int = 900) -> None:
    r = _redis()
    if r is not None:
        try:
            await r.set(f"await:{tg_id}", json.dumps(payload), ex=ttl)
            return
        except Exception as e:  # noqa: BLE001
            log.warning("state set error: %s", e)
    _fallback[str(tg_id)] = (time.time() + ttl, payload)


async def pop_await(tg_id: int) -> dict | None:
    r = _redis()
    if r is not None:
        try:
            key = f"await:{tg_id}"
            val = await r.get(key)
            if val:
                await r.delete(key)
                return json.loads(val)
            return None
        except Exception as e:  # noqa: BLE001
            log.warning("state pop error: %s", e)
    item = _fallback.pop(str(tg_id), None)
    if item and item[0] > time.time():
        return item[1]
    return None
