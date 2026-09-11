"""Цели — хранятся отдельно от задач."""
from __future__ import annotations

from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Goal, GoalStatus
from app.schemas import ParsedItem
from app.utils.timeparse import combine
from app.utils.tz import now_utc


async def create_from_item(session: AsyncSession, user_id: int, item: ParsedItem, tz_name: str) -> Goal:
    deadline = combine(item.deadline, None, tz_name) if item.deadline else None
    goal = Goal(
        user_id=user_id,
        title=item.title[:512],
        description=item.description,
        deadline=deadline,
    )
    session.add(goal)
    await session.flush()
    return goal


async def get(session: AsyncSession, goal_id: int) -> Goal | None:
    return await session.get(Goal, goal_id)


async def list_active(session: AsyncSession, user_id: int) -> list[Goal]:
    stmt = (
        select(Goal)
        .where(Goal.user_id == user_id, Goal.status == GoalStatus.active)
        .order_by(Goal.created_at.desc())
    )
    return list((await session.execute(stmt)).scalars())


async def primary(session: AsyncSession, user_id: int) -> Goal | None:
    goals = await list_active(session, user_id)
    return goals[0] if goals else None


async def stale(session: AsyncSession, user_id: int, days: int) -> list[Goal]:
    """Активные цели, к которым давно не возвращались."""
    if days <= 0:
        return []
    cutoff = now_utc() - timedelta(days=days)
    stmt = select(Goal).where(
        Goal.user_id == user_id,
        Goal.status == GoalStatus.active,
        ((Goal.last_discussed_at.is_(None)) | (Goal.last_discussed_at < cutoff)),
        Goal.created_at < cutoff,
    )
    return list((await session.execute(stmt)).scalars())


async def touch(session: AsyncSession, goal: Goal) -> None:
    goal.last_discussed_at = now_utc()


async def set_status(session: AsyncSession, goal: Goal, status: GoalStatus) -> None:
    goal.status = status
