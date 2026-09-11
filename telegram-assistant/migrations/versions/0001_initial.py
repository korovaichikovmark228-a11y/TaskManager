"""Начальная схема: расширение pgvector, все таблицы, индекс эмбеддингов.

Схема создаётся из моделей SQLAlchemy (единый источник правды), поэтому
миграция и модели не расходятся.

Revision ID: 0001
Revises:
Create Date: 2026-09-11
"""
from alembic import op

from app.db import Base
from app import models  # noqa: F401  — регистрирует таблицы в metadata

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    # pgvector нужен до создания колонок типа vector
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    Base.metadata.create_all(bind=bind)
    # ANN-индекс для семантического поиска (косинус)
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_memory_embedding "
        "ON memory_items USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)"
    )


def downgrade() -> None:
    bind = op.get_bind()
    op.execute("DROP INDEX IF EXISTS ix_memory_embedding")
    Base.metadata.drop_all(bind=bind)
