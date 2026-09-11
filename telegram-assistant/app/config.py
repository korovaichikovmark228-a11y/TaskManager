"""Конфигурация приложения. Все секреты — только через переменные окружения."""
from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # --- Telegram ---
    telegram_bot_token: str = Field(..., alias="TELEGRAM_BOT_TOKEN")
    # polling — для локальной разработки; webhook — для VPS.
    bot_mode: str = Field("polling", alias="BOT_MODE")  # polling | webhook
    webhook_base_url: str = Field("", alias="WEBHOOK_BASE_URL")  # https://example.com
    webhook_secret: str = Field("change-me", alias="WEBHOOK_SECRET")

    # --- Database ---
    database_url: str = Field(..., alias="DATABASE_URL")  # postgresql+asyncpg://...

    # --- Redis ---
    redis_url: str = Field("redis://localhost:6379/0", alias="REDIS_URL")

    # --- LLM ---
    llm_provider: str = Field("openai", alias="LLM_PROVIDER")  # openai | anthropic
    llm_api_key: str = Field("", alias="LLM_API_KEY")
    llm_base_url: str = Field("https://api.openai.com/v1", alias="LLM_BASE_URL")
    llm_model: str = Field("gpt-4o-mini", alias="LLM_MODEL")

    # --- Embeddings ---
    embeddings_api_key: str = Field("", alias="EMBEDDINGS_API_KEY")
    embeddings_base_url: str = Field("https://api.openai.com/v1", alias="EMBEDDINGS_BASE_URL")
    embeddings_model: str = Field("text-embedding-3-small", alias="EMBEDDINGS_MODEL")
    embeddings_dim: int = Field(1536, alias="EMBEDDINGS_DIM")

    # --- Speech-to-text ---
    stt_provider: str = Field("openai", alias="STT_PROVIDER")  # openai (whisper)
    stt_api_key: str = Field("", alias="STT_API_KEY")
    stt_base_url: str = Field("https://api.openai.com/v1", alias="STT_BASE_URL")
    stt_model: str = Field("whisper-1", alias="STT_MODEL")

    # --- Defaults / behaviour ---
    default_timezone: str = Field("Europe/Moscow", alias="DEFAULT_TIMEZONE")
    scheduler_tick_seconds: int = Field(30, alias="SCHEDULER_TICK_SECONDS")

    # Sync (psycopg) URL, derived from database_url, for Alembic & APScheduler jobstore.
    @property
    def sync_database_url(self) -> str:
        url = self.database_url
        return (
            url.replace("+asyncpg", "+psycopg")
            .replace("postgresql+psycopg", "postgresql+psycopg")
        )

    @property
    def llm_enabled(self) -> bool:
        return bool(self.llm_api_key)

    @property
    def embeddings_enabled(self) -> bool:
        return bool(self.embeddings_api_key)

    @property
    def stt_enabled(self) -> bool:
        return bool(self.stt_api_key)


@lru_cache
def get_settings() -> Settings:
    return Settings()
