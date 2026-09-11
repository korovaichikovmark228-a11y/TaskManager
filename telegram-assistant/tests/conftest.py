"""Общая настройка тестов: заполняем обязательные env до импорта приложения."""
from __future__ import annotations

import os

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "test:token")
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://u:p@localhost:5432/test")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")
# LLM/STT/эмбеддинги выключены → работает детерминированный fallback.
os.environ.setdefault("LLM_API_KEY", "")
os.environ.setdefault("EMBEDDINGS_API_KEY", "")
os.environ.setdefault("STT_API_KEY", "")
os.environ.setdefault("DEFAULT_TIMEZONE", "Europe/Moscow")
