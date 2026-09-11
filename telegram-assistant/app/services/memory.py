"""Семантическая память: индексация записей и поиск.

Если эмбеддинги настроены — используем pgvector (косинусное расстояние).
Иначе — деградация к обычному ILIKE-поиску по тексту.
"""
from __future__ import annotations

import re

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.embeddings import embed
from app.config import get_settings
from app.models import EntityType, MemoryItem

# слова-вопросы, которые не несут смысла для поиска
_STOP = {
    "что", "какие", "какая", "какой", "мои", "моих", "покажи", "найди", "про",
    "записывал", "записывала", "хотел", "хотела", "давно", "сейчас", "это",
    "мне", "меня", "весь", "все", "всё", "который", "которые",
}


def _keywords(query: str) -> list[str]:
    """Разбить запрос на значимые слова и вернуть их корни-префиксы (для морфологии)."""
    words = re.findall(r"[а-яёa-z0-9]{4,}", query.lower())
    out: list[str] = []
    for w in words:
        if w in _STOP:
            continue
        out.append(w[:5])  # префикс ловит «звонки»→«звонк»→«звонков»
    return out[:6]


async def index(session: AsyncSession, user_id: int, entity_type: EntityType,
                entity_id: int, content: str) -> None:
    vec = await embed(content)
    session.add(MemoryItem(
        user_id=user_id,
        entity_type=entity_type,
        entity_id=entity_id,
        content=content,
        embedding=vec,
    ))
    await session.flush()


async def reindex(session: AsyncSession, user_id: int, entity_type: EntityType,
                  entity_id: int, content: str) -> None:
    rows = (await session.execute(
        select(MemoryItem).where(
            MemoryItem.user_id == user_id,
            MemoryItem.entity_type == entity_type,
            MemoryItem.entity_id == entity_id,
        )
    )).scalars().all()
    for r in rows:
        await session.delete(r)
    await index(session, user_id, entity_type, entity_id, content)


async def search(session: AsyncSession, user_id: int, query: str, limit: int = 8) -> list[MemoryItem]:
    query = (query or "").strip()
    if not query:
        return []

    if get_settings().embeddings_enabled:
        vec = await embed(query)
        if vec is not None:
            stmt = (
                select(MemoryItem)
                .where(MemoryItem.user_id == user_id, MemoryItem.embedding.is_not(None))
                .order_by(MemoryItem.embedding.cosine_distance(vec))
                .limit(limit)
            )
            rows = list((await session.execute(stmt)).scalars())
            if rows:
                return rows

    # fallback: ILIKE по ключевым словам запроса (ИЛИ по каждому корню)
    kws = _keywords(query)
    if not kws:
        kws = [query.strip()[:10]]
    conds = [MemoryItem.content.ilike(f"%{kw}%") for kw in kws]
    stmt = (
        select(MemoryItem)
        .where(MemoryItem.user_id == user_id, or_(*conds))
        .order_by(MemoryItem.created_at.desc())
        .limit(limit)
    )
    return list((await session.execute(stmt)).scalars())
