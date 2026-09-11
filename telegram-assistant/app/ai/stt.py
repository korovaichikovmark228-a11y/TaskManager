"""Speech-to-text. Провайдер заменяемый (STT_PROVIDER). По умолчанию — Whisper.

Возвращаем оригинальный текст транскрипции (требование ТЗ).
"""
from __future__ import annotations

import logging

import httpx

from app.config import get_settings

log = logging.getLogger(__name__)


async def transcribe(audio_bytes: bytes, filename: str = "voice.ogg") -> str | None:
    s = get_settings()
    if not s.stt_enabled:
        return None
    if s.stt_provider != "openai":
        log.warning("Неизвестный STT_PROVIDER=%s", s.stt_provider)
        return None

    url = f"{s.stt_base_url.rstrip('/')}/audio/transcriptions"
    headers = {"Authorization": f"Bearer {s.stt_api_key}"}
    files = {"file": (filename, audio_bytes, "audio/ogg")}
    data = {"model": s.stt_model, "language": "ru"}
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            r = await client.post(url, headers=headers, files=files, data=data)
            r.raise_for_status()
            return (r.json().get("text") or "").strip()
    except Exception as e:  # noqa: BLE001
        log.exception("STT ошибка: %s", e)
        return None
