"""Сборка отчётов: недельный стратегический и дневные сводки."""
from __future__ import annotations

from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Idea, Priority, Reminder, ReminderStatus, Task, TaskStatus, User
from app.services import goals as goals_svc
from app.utils.tz import now_local, to_utc


async def _open_count(session: AsyncSession, user_id: int) -> int:
    stmt = select(func.count(Task.id)).where(Task.user_id == user_id, Task.status == TaskStatus.open)
    return int((await session.execute(stmt)).scalar() or 0)


async def _important_open(session: AsyncSession, user_id: int, limit: int = 3) -> list[Task]:
    stmt = (
        select(Task)
        .where(Task.user_id == user_id, Task.status == TaskStatus.open, Task.priority == Priority.high)
        .order_by(Task.due_at.is_(None), Task.due_at)
        .limit(limit)
    )
    return list((await session.execute(stmt)).scalars())


async def build_weekly_report(session: AsyncSession, user: User) -> str:
    since = now_local(user.timezone) - timedelta(days=7)
    since_utc = to_utc(since, user.timezone)

    done = int((await session.execute(
        select(func.count(Task.id)).where(
            Task.user_id == user.id, Task.status == TaskStatus.done, Task.completed_at >= since_utc,
        )
    )).scalar() or 0)
    remaining = await _open_count(session, user.id)
    important = await _important_open(session, user.id)
    new_ideas = int((await session.execute(
        select(func.count(Idea.id)).where(Idea.user_id == user.id, Idea.created_at >= since_utc)
    )).scalar() or 0)

    goal = await goals_svc.primary(session, user.id)
    stale = await goals_svc.stale(session, user.id, user.goal_nudge_days or 7)

    lines = ["🧭 <b>Твоя неделя</b>\n"]
    if goal:
        lines.append(f"🎯 Главная цель: {goal.title}\n")
    lines.append(f"☑ Выполнено задач: {done}")
    lines.append(f"⏳ Осталось: {remaining}")
    if important:
        lines.append("\n🔥 Важные незакрытые задачи:")
        for t in important:
            lines.append(f"— {t.title}")
    lines.append(f"\n💡 Новых идей: {new_ideas}")
    if stale:
        lines.append(f"\n📌 Ты давно не возвращался к цели: «{stale[0].title}»")
    lines.append("\nЧто хочешь сделать главным фокусом следующей недели?")
    return "\n".join(lines)


async def build_morning(session: AsyncSession, user: User) -> str:
    nl = now_local(user.timezone)
    day_end = nl.replace(hour=23, minute=59, second=59, microsecond=0)
    day_end_utc = to_utc(day_end, user.timezone)

    tasks_today = list((await session.execute(
        select(Task).where(
            Task.user_id == user.id, Task.status == TaskStatus.open,
            Task.due_at.is_not(None), Task.due_at <= day_end_utc,
        ).order_by(Task.due_at)
    )).scalars())
    important = [t for t in tasks_today if t.priority == Priority.high]

    day_start_utc = to_utc(nl.replace(hour=0, minute=0, second=0, microsecond=0), user.timezone)
    rem_count = int((await session.execute(
        select(func.count(Reminder.id)).where(
            Reminder.user_id == user.id, Reminder.status == ReminderStatus.scheduled,
            Reminder.remind_at >= day_start_utc, Reminder.remind_at <= day_end_utc,
        )
    )).scalar() or 0)
    goal = await goals_svc.primary(session, user.id)

    lines = ["☀️ <b>Доброе утро</b>\n", "Сегодня у тебя:\n"]
    lines.append(f"🔥 {len(important) or len(tasks_today)} важных задач")
    lines.append(f"⏰ {rem_count} напоминаний")
    lines.append(f"🎯 {1 if goal else 0} ключевая цель")
    lines.append("\nГлавный фокус дня?")
    return "\n".join(lines)


def build_evening_prompt() -> str:
    return "🌙 <b>Вечерний check-in</b>\n\nЧто сегодня продвинуло тебя к твоим главным целям?"
