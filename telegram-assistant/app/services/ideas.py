"""Идеи и заметки."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Idea, Note
from app.schemas import ParsedItem


async def create_idea(session: AsyncSession, user_id: int, item: ParsedItem) -> Idea:
    idea = Idea(user_id=user_id, title=item.title[:512], description=item.description)
    session.add(idea)
    await session.flush()
    return idea


async def list_ideas(session: AsyncSession, user_id: int, limit: int = 30,
                     since: datetime | None = None) -> list[Idea]:
    stmt = select(Idea).where(Idea.user_id == user_id)
    if since is not None:
        stmt = stmt.where(Idea.created_at >= since)
    stmt = stmt.order_by(Idea.created_at.desc()).limit(limit)
    return list((await session.execute(stmt)).scalars())


async def count_since(session: AsyncSession, user_id: int, since: datetime) -> int:
    from sqlalchemy import func

    stmt = select(func.count(Idea.id)).where(Idea.user_id == user_id, Idea.created_at >= since)
    return int((await session.execute(stmt)).scalar() or 0)


async def create_note(session: AsyncSession, user_id: int, content: str) -> Note:
    note = Note(user_id=user_id, content=content)
    session.add(note)
    await session.flush()
    return note
