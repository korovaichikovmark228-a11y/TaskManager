"""Напоминания — источник правды для планировщика."""
from __future__ import annotations

import json
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import EntityType, Reminder, ReminderStatus
from app.utils import recurrence as rec
from app.utils.tz import now_utc


async def create(session: AsyncSession, user_id: int, text: str, remind_at: datetime,
                 entity_type: EntityType = EntityType.custom, entity_id: int | None = None,
                 recurrence: dict | None = None) -> Reminder:
    r = Reminder(
        user_id=user_id,
        entity_type=entity_type,
        entity_id=entity_id,
        text=text,
        remind_at=remind_at,
        recurrence=json.dumps(recurrence) if recurrence else None,
        status=ReminderStatus.scheduled,
    )
    session.add(r)
    await session.flush()
    return r


async def due(session: AsyncSession, now: datetime | None = None, limit: int = 100) -> list[Reminder]:
    now = now or now_utc()
    stmt = (
        select(Reminder)
        .where(Reminder.status == ReminderStatus.scheduled, Reminder.remind_at <= now)
        .order_by(Reminder.remind_at)
        .limit(limit)
    )
    return list((await session.execute(stmt)).scalars())


async def get(session: AsyncSession, reminder_id: int) -> Reminder | None:
    return await session.get(Reminder, reminder_id)


async def mark_sent(session: AsyncSession, r: Reminder) -> None:
    r.status = ReminderStatus.sent


async def cancel(session: AsyncSession, r: Reminder) -> None:
    r.status = ReminderStatus.cancelled


async def snooze(session: AsyncSession, r: Reminder, delta: timedelta | None = None,
                 to: datetime | None = None) -> None:
    r.remind_at = to if to is not None else (now_utc() + (delta or timedelta(hours=1)))
    r.status = ReminderStatus.scheduled


async def spawn_next_if_recurring(session: AsyncSession, r: Reminder, tz_name: str) -> Reminder | None:
    """После срабатывания повторяющегося напоминания создаёт следующее."""
    if not r.recurrence:
        return None
    nxt = rec.next_occurrence(r.recurrence, r.remind_at, tz_name)
    if nxt is None:
        return None
    return await create(
        session, r.user_id, r.text, nxt,
        entity_type=r.entity_type, entity_id=r.entity_id,
        recurrence=json.loads(r.recurrence),
    )
