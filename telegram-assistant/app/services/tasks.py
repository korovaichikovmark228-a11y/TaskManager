"""Задачи."""
from __future__ import annotations

import json
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Priority, Task, TaskStatus
from app.schemas import ParsedItem
from app.utils.timeparse import combine
from app.utils.tz import now_utc

_PRIORITY = {"high": Priority.high, "medium": Priority.medium, "low": Priority.low}


def priority_of(value: str | None) -> Priority:
    return _PRIORITY.get((value or "").lower(), Priority.medium)


async def create_from_item(session: AsyncSession, user_id: int, item: ParsedItem,
                           tz_name: str, goal_id: int | None = None) -> Task:
    due_at = combine(item.date, item.time, tz_name) if item.date else None
    task = Task(
        user_id=user_id,
        goal_id=goal_id,
        title=item.title[:512],
        description=item.description,
        due_at=due_at,
        priority=priority_of(item.priority),
        recurrence=json.dumps(item.recurrence) if item.recurrence else None,
    )
    session.add(task)
    await session.flush()
    return task


async def get(session: AsyncSession, task_id: int) -> Task | None:
    return await session.get(Task, task_id)


async def list_open(session: AsyncSession, user_id: int, limit: int = 50) -> list[Task]:
    stmt = (
        select(Task)
        .where(Task.user_id == user_id, Task.status == TaskStatus.open)
        .order_by(Task.due_at.is_(None), Task.due_at, Task.priority)
        .limit(limit)
    )
    return list((await session.execute(stmt)).scalars())


async def list_today(session: AsyncSession, user_id: int, day_end_utc: datetime) -> list[Task]:
    stmt = (
        select(Task)
        .where(
            Task.user_id == user_id,
            Task.status == TaskStatus.open,
            Task.due_at.is_not(None),
            Task.due_at <= day_end_utc,
        )
        .order_by(Task.due_at)
    )
    return list((await session.execute(stmt)).scalars())


async def complete(session: AsyncSession, task: Task) -> None:
    task.status = TaskStatus.done
    task.completed_at = now_utc()


async def delete(session: AsyncSession, task: Task) -> None:
    await session.delete(task)


async def overdue(session: AsyncSession, now: datetime | None = None) -> list[Task]:
    now = now or now_utc()
    stmt = select(Task).where(
        Task.status == TaskStatus.open,
        Task.due_at.is_not(None),
        Task.due_at < now,
        Task.overdue_notified.is_(False),
    )
    return list((await session.execute(stmt)).scalars())


async def count_done_since(session: AsyncSession, user_id: int, since: datetime) -> int:
    from sqlalchemy import func

    stmt = select(func.count(Task.id)).where(
        Task.user_id == user_id,
        Task.status == TaskStatus.done,
        Task.completed_at >= since,
    )
    return int((await session.execute(stmt)).scalar() or 0)
