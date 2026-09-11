"""Абстракция над LLM. Провайдера легко заменить через .env (LLM_PROVIDER).

Поддержаны:
  * openai    — любой OpenAI-совместимый endpoint (OpenAI, OpenRouter, локальный vLLM);
  * anthropic — Anthropic Messages API.
"""
from __future__ import annotations

import json
import logging
from abc import ABC, abstractmethod

import httpx

from app.config import Settings, get_settings

log = logging.getLogger(__name__)


class LLMProvider(ABC):
    @abstractmethod
    async def chat(self, system: str, user: str, *, json_mode: bool = False) -> str: ...


class OpenAIProvider(LLMProvider):
    def __init__(self, s: Settings):
        from openai import AsyncOpenAI

        self._client = AsyncOpenAI(api_key=s.llm_api_key, base_url=s.llm_base_url)
        self._model = s.llm_model

    async def chat(self, system: str, user: str, *, json_mode: bool = False) -> str:
        kwargs: dict = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 0.2,
        }
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}
        resp = await self._client.chat.completions.create(**kwargs)
        return resp.choices[0].message.content or ""


class AnthropicProvider(LLMProvider):
    def __init__(self, s: Settings):
        self._key = s.llm_api_key
        self._base = s.llm_base_url.rstrip("/")
        self._model = s.llm_model

    async def chat(self, system: str, user: str, *, json_mode: bool = False) -> str:
        url = f"{self._base}/v1/messages" if "/v1" not in self._base else f"{self._base}/messages"
        headers = {
            "x-api-key": self._key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }
        if json_mode:
            user = user + "\n\nОтветь строго валидным JSON-объектом без пояснений."
        payload = {
            "model": self._model,
            "max_tokens": 1024,
            "system": system,
            "messages": [{"role": "user", "content": user}],
        }
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(url, headers=headers, json=payload)
            r.raise_for_status()
            data = r.json()
        parts = data.get("content", [])
        return "".join(p.get("text", "") for p in parts if p.get("type") == "text")


_provider: LLMProvider | None = None


def get_llm() -> LLMProvider | None:
    global _provider
    s = get_settings()
    if not s.llm_enabled:
        return None
    if _provider is None:
        _provider = AnthropicProvider(s) if s.llm_provider == "anthropic" else OpenAIProvider(s)
    return _provider


def extract_json(text: str) -> dict:
    """Достаём JSON-объект из ответа модели (даже если он в тексте/в ```)."""
    text = (text or "").strip()
    if not text:
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            return json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            pass
    log.warning("Не удалось распарсить JSON из ответа LLM: %.200s", text)
    return {}
