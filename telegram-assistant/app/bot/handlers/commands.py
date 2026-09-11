"""Команды и кнопки главного меню."""
from __future__ import annotations

from aiogram import F, Router
from aiogram.filters import Command, CommandStart
from aiogram.types import Message

from app.bot import keyboards as kb
from app.bot import texts
from app.db import session_scope
from app.models import GoalStatus
from app.services import goals as goals_svc
from app.services import ideas as ideas_svc
from app.services import memory as memory_svc
from app.services import reports as reports_svc
from app.services import tasks as tasks_svc
from app.services import users as users_svc
from app.utils.tz import fmt_dt, now_local, to_utc

router = Router(name="commands")


async def _user(message: Message):
    async with session_scope() as s:
        u = await users_svc.get_or_create(
            s, message.from_user.id,
            username=message.from_user.username,
            first_name=message.from_user.first_name,
        )
        # отдаём «плоские» поля, чтобы не держать объект вне сессии
        return u.id, u.timezone


@router.message(CommandStart())
async def cmd_start(message: Message):
    await _user(message)
    await message.answer(texts.START, reply_markup=kb.main_menu())


@router.message(Command("help"))
async def cmd_help(message: Message):
    await message.answer(texts.HELP)


@router.message(Command("tasks"))
@router.message(F.text == "📋 Задачи")
async def cmd_tasks(message: Message):
    uid, tz = await _user(message)
    async with session_scope() as s:
        rows = await tasks_svc.list_open(s, uid, limit=30)
        if not rows:
            await message.answer("Открытых задач нет ✅")
            return
        lines = ["📋 <b>Твои задачи</b>\n"]
        for t in rows:
            when = f" — {fmt_dt(t.due_at, tz, with_time=True)}" if t.due_at else ""
            prio = texts.PRIORITY_EMOJI.get(t.priority.value, "")
            lines.append(f"{prio} {t.title}{when}")
        await message.answer("\n".join(lines))


@router.message(Command("goals"))
@router.message(F.text == "🎯 Цели")
async def cmd_goals(message: Message):
    uid, tz = await _user(message)
    async with session_scope() as s:
        rows = await goals_svc.list_active(s, uid)
        if not rows:
            await message.answer("Активных целей пока нет. Скажи «Хочу…» — и я запишу цель 🎯")
            return
        lines = ["🎯 <b>Твои цели</b>\n"]
        for g in rows:
            dl = f" (до {fmt_dt(g.deadline, tz, with_time=False)})" if g.deadline else ""
            lines.append(f"• {g.title}{dl} — {g.progress}%")
        await message.answer("\n".join(lines))


@router.message(Command("ideas"))
@router.message(F.text == "💡 Идеи")
async def cmd_ideas(message: Message):
    uid, _ = await _user(message)
    async with session_scope() as s:
        rows = await ideas_svc.list_ideas(s, uid, limit=30)
        if not rows:
            await message.answer("Идей пока нет. Скажи «Идея: …» 💡")
            return
        lines = ["💡 <b>Твои идеи</b>\n"] + [f"• {i.title}" for i in rows]
        await message.answer("\n".join(lines))


@router.message(Command("today"))
async def cmd_today(message: Message):
    uid, tz = await _user(message)
    async with session_scope() as s:
        u = await users_svc.by_id(s, uid)
        await message.answer(await reports_svc.build_morning(s, u))


@router.message(Command("week"))
@router.message(F.text == "📊 Неделя")
async def cmd_week(message: Message):
    uid, _ = await _user(message)
    async with session_scope() as s:
        u = await users_svc.by_id(s, uid)
        text = await reports_svc.build_weekly_report(s, u)
    await message.answer(text, reply_markup=kb.weekly_report())


@router.message(Command("search"))
async def cmd_search(message: Message):
    uid, _ = await _user(message)
    parts = (message.text or "").split(maxsplit=1)
    if len(parts) < 2:
        await message.answer("Напиши так: /search <что ищем>\nНапример: /search идеи про AI")
        return
    query = parts[1]
    async with session_scope() as s:
        hits = await memory_svc.search(s, uid, query, limit=8)
    if not hits:
        await message.answer("Ничего не нашёл 🤔")
        return
    lines = [f"🔎 По запросу «{query}»:\n"]
    for h in hits:
        lines.append(f"{texts.TYPE_EMOJI.get(h.entity_type.value, '•')} {h.content[:120]}")
    await message.answer("\n".join(lines))


@router.message(F.text == "🧠 Память")
async def menu_memory(message: Message):
    await message.answer("Спроси меня что угодно про свои записи, например:\n"
                         "«Что я записывал про AI?» или /search <запрос>")


@router.message(Command("settings"))
@router.message(F.text == "⚙️ Настройки")
async def cmd_settings(message: Message):
    uid, tz = await _user(message)
    async with session_scope() as s:
        u = await users_svc.by_id(s, uid)
        morning = u.morning_checkin or "выкл"
        evening = u.evening_checkin or "выкл"
        nudge = f"каждые {u.goal_nudge_days} дн." if u.goal_nudge_days else "выкл"
    dows = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]
    await message.answer(
        "⚙️ <b>Настройки</b>\n\n"
        f"🌍 Часовой пояс: {tz}\n"
        f"☀️ Утренний check-in: {morning}\n"
        f"🌙 Вечерний check-in: {evening}\n"
        f"📊 Недельный отчёт: {dows[u.weekly_report_dow]} {u.weekly_report_time}\n"
        f"🎯 Напоминания о целях: {nudge}\n"
        f"🤖 AI-анализ: {'вкл' if u.ai_enabled else 'выкл'}\n\n"
        "Изменить: напиши, например,\n"
        "«часовой пояс Europe/Kyiv», «утренний check-in 08:30», "
        "«вечерний check-in выкл», «отчёт в пятницу 18:00»."
    )
