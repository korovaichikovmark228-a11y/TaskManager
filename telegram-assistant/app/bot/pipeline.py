"""Оркестрация: текст пользователя → разбор → записи в БД → короткий ответ.

Используется и для текстовых, и для голосовых сообщений (после транскрипции).
"""
from __future__ import annotations

from dataclasses import dataclass

from aiogram.types import InlineKeyboardMarkup
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai import intent as intent_ai
from app.bot import keyboards as kb
from app.bot import texts
from app.models import EntityType, User
from app.schemas import ParsedItem, ParseResult
from app.services import goals as goals_svc
from app.services import ideas as ideas_svc
from app.services import memory as memory_svc
from app.services import reminders as rem_svc
from app.services import tasks as tasks_svc
from app.services import state as state_svc
from app.utils.timeparse import combine
from app.utils.tz import fmt_dt, now_local


@dataclass
class Reply:
    text: str
    keyboard: InlineKeyboardMarkup | None = None


async def process_text(session: AsyncSession, user: User, text: str) -> list[Reply]:
    nl = now_local(user.timezone)
    result: ParseResult = await intent_ai.parse(text, nl, user.timezone)

    if result.intent == "query":
        return [await _handle_query(session, user, result.query or text)]
    if result.intent in ("update", "delete", "smalltalk"):
        # В MVP расширенное редактирование через свободный текст сводим к заметке/подсказке.
        return [Reply("Понял. Пока такие правки делаются кнопками под записями 🙂")]

    if not result.items:
        return [Reply(texts.NO_DATA)]

    if len(result.items) == 1:
        return await _handle_single(session, user, result.items[0])
    return await _handle_multiple(session, user, result.items)


async def _index(session: AsyncSession, user: User, etype: EntityType, eid: int, content: str) -> None:
    await memory_svc.index(session, user.id, etype, eid, content)


async def _create_task_with_reminder(session: AsyncSession, user: User, item: ParsedItem) -> list[Reply]:
    task = await tasks_svc.create_from_item(session, user.id, item, user.timezone)
    await _index(session, user, EntityType.task, task.id, f"{item.title} {item.description or ''}")

    # есть дата и время → ставим напоминание сразу
    if item.needs_reminder and item.date and item.time:
        r = await rem_svc.create(
            session, user.id, item.title, task.due_at,
            entity_type=EntityType.task, entity_id=task.id, recurrence=item.recurrence,
        )
        when = fmt_dt(task.due_at, user.timezone, with_time=True)
        return [Reply(f"🔔 Напомню {when}: {item.title}",
                      kb.reminder_created(r.id, recurring=bool(item.recurrence)))]

    # дата есть, времени нет → спрашиваем время
    if item.needs_reminder and item.date and not item.time:
        return [Reply(f"📌 {item.title}\n\n{texts.ASK_TIME}", kb.ask_time(task.id))]

    # просил напомнить, но срок размытый → предлагаем следующую неделю (не выдумываем)
    if item.needs_reminder and item.vague:
        return [Reply(f"📌 {item.title}\n\nСрок не назван. Поставить напоминание на следующую неделю?",
                      kb.offer_reminder_next_week(task.id))]

    # обычная задача без напоминания
    prio = texts.PRIORITY_EMOJI.get(task.priority.value, "")
    return [Reply(f"✅ Задача добавлена: {prio} {item.title}".strip())]


async def _handle_single(session: AsyncSession, user: User, item: ParsedItem) -> list[Reply]:
    if item.type == "task":
        return await _create_task_with_reminder(session, user, item)

    if item.type == "goal":
        goal = await goals_svc.create_from_item(session, user.id, item, user.timezone)
        await _index(session, user, EntityType.goal, goal.id, f"{item.title} {item.description or ''}")
        deadline = f"\n\nДедлайн: {fmt_dt(goal.deadline, user.timezone, with_time=False)}" if goal.deadline else ""
        return [Reply(f"🎯 Цель записана\n\n{item.title}{deadline}\n\n"
                      f"Хочешь, чтобы я периодически возвращал тебя к этой цели?",
                      kb.goal_saved(goal.id))]

    if item.type == "idea":
        idea = await ideas_svc.create_idea(session, user.id, item)
        await _index(session, user, EntityType.idea, idea.id, f"{item.title} {item.description or ''}")
        return [Reply(f"💡 Идея сохранена: {item.title}")]

    note = await ideas_svc.create_note(session, user.id, item.title)
    await _index(session, user, EntityType.note, note.id, item.title)
    return [Reply(f"📝 Записал: {item.title}")]


async def _handle_multiple(session: AsyncSession, user: User, items: list[ParsedItem]) -> list[Reply]:
    lines = ["Записал несколько вещей:\n"]
    first_task_needs_time_id: int | None = None
    for i, item in enumerate(items, 1):
        if item.type == "task":
            task = await tasks_svc.create_from_item(session, user.id, item, user.timezone)
            await _index(session, user, EntityType.task, task.id, item.title)
            if item.needs_reminder and item.date and item.time:
                await rem_svc.create(session, user.id, item.title, task.due_at,
                                     entity_type=EntityType.task, entity_id=task.id,
                                     recurrence=item.recurrence)
            elif item.needs_reminder and first_task_needs_time_id is None:
                first_task_needs_time_id = task.id
            lines.append(texts.item_line(i, "task", item.title))
        elif item.type == "goal":
            goal = await goals_svc.create_from_item(session, user.id, item, user.timezone)
            await _index(session, user, EntityType.goal, goal.id, item.title)
            lines.append(texts.item_line(i, "goal", item.title))
        elif item.type == "idea":
            idea = await ideas_svc.create_idea(session, user.id, item)
            await _index(session, user, EntityType.idea, idea.id, item.title)
            lines.append(texts.item_line(i, "idea", item.title))
        else:
            note = await ideas_svc.create_note(session, user.id, item.title)
            await _index(session, user, EntityType.note, note.id, item.title)
            lines.append(texts.item_line(i, "note", item.title))

    replies = [Reply("\n".join(lines))]
    if first_task_needs_time_id is not None:
        replies.append(Reply("Для задачи с напоминанием поставить время на следующую неделю?",
                             kb.offer_reminder_next_week(first_task_needs_time_id)))
    return replies


async def _handle_query(session: AsyncSession, user: User, query: str) -> Reply:
    hits = await memory_svc.search(session, user.id, query, limit=8)
    if not hits:
        return Reply("По этому запросу в памяти ничего не нашёл 🤔")
    emoji = texts.TYPE_EMOJI
    lines = ["Вот что нашёл в твоей памяти:\n"]
    for h in hits:
        lines.append(f"{emoji.get(h.entity_type.value, '•')} {h.content[:120]}")
    return Reply("\n".join(lines))


# --- вспомогательное для callbacks: доустановить время задаче и создать напоминание ---
async def attach_time_and_remind(session: AsyncSession, user: User, task, time_str: str) -> tuple[str, int]:
    """Проставить задаче время, создать напоминание. Вернуть (когда, reminder_id)."""
    if task.due_at:
        date_str = fmt_iso_date(task.due_at, user.timezone)
    else:
        date_str = now_local(user.timezone).strftime("%Y-%m-%d")
    task.due_at = combine(date_str, time_str, user.timezone)
    r = await rem_svc.create(session, user.id, task.title, task.due_at,
                             entity_type=EntityType.task, entity_id=task.id,
                             recurrence=_task_recurrence(task))
    return fmt_dt(task.due_at, user.timezone, with_time=True), r.id


def fmt_iso_date(dt, tz_name: str) -> str:
    from app.utils.tz import to_local
    return to_local(dt, tz_name).strftime("%Y-%m-%d")


def _task_recurrence(task) -> dict | None:
    import json
    if task.recurrence:
        try:
            return json.loads(task.recurrence)
        except (json.JSONDecodeError, TypeError):
            return None
    return None
