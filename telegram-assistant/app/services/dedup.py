"""Защита от дублей и спама через Redis.

  * seen_update — один и тот же Telegram update не обрабатываем дважды;
  * allow — простой rate-limit на пользователя.
Если Redis недоступен — деградируем безопасно (не блокируем работу бота).
"""
from __future__ import annotations

import logging

import redis.asyncio as redis

from app.config import get_settings

log = logging.getLogger(__name__)

_client: redis.Redis | None = None


def _redis() -> redis.Redis | None:
    global _client
    if _client is None:
        try:
            _client = redis.from_url(get_settings().redis_url, decode_responses=True)
        except Exception as e:  # noqa: BLE001
            log.warning("Redis недоступен: %s", e)
            return None
    return _client


async def seen_update(update_id: int, ttl: int = 3600) -> bool:
    """True, если update уже видели (обрабатывать не нужно)."""
    r = _redis()
    if r is None:
        return False
    try:
        # SET NX вернёт None, если ключ уже был → значит, дубль.
        was_set = await r.set(f"upd:{update_id}", "1", ex=ttl, nx=True)
        return not bool(was_set)
    except Exception as e:  # noqa: BLE001
        log.warning("dedup seen_update error: %s", e)
        return False


async def allow(telegram_id: int, limit: int = 20, window: int = 60) -> bool:
    """Простой rate-limit: не более `limit` сообщений за `window` секунд."""
    r = _redis()
    if r is None:
        return True
    try:
        key = f"rate:{telegram_id}"
        cur = await r.incr(key)
        if cur == 1:
            await r.expire(key, window)
        return cur <= limit
    except Exception as e:  # noqa: BLE001
        log.warning("dedup allow error: %s", e)
        return True


async def once(key: str, ttl: int = 90000) -> bool:
    """True — если ключ поставлен впервые (действие ещё не выполнялось).

    Используется для «одна отправка check-in/отчёта в день». Без Redis всегда True
    (в этом случае дедуп обеспечивает БД-логика вызывающего кода)."""
    r = _redis()
    if r is None:
        return True
    try:
        return bool(await r.set(f"once:{key}", "1", ex=ttl, nx=True))
    except Exception as e:  # noqa: BLE001
        log.warning("dedup once error: %s", e)
        return True


async def reminder_lock(reminder_id: int, ttl: int = 300) -> bool:
    """Гарантия «одно напоминание — одна отправка» при гонке воркеров."""
    r = _redis()
    if r is None:
        return True
    try:
        was_set = await r.set(f"remlock:{reminder_id}", "1", ex=ttl, nx=True)
        return bool(was_set)
    except Exception as e:  # noqa: BLE001
        log.warning("dedup reminder_lock error: %s", e)
        return True
