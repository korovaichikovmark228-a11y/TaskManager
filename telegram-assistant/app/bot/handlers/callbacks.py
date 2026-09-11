"""Обработка нажатий inline-кнопок."""
from __future__ import annotations

import logging
from datetime import timedelta

from aiogram import F, Router
from aiogram.types import CallbackQuery

from app.bot import keyboards as kb
from app.bot import pipeline
from app.db import session_scope
from app.models import EntityType, ReminderStatus
from app.services import goals as goals_svc
from app.services import reminders as rem_svc
from app.services import state as state_svc
from app.services import tasks as tasks_svc
from app.services import users as users_svc
from app.utils.tz import fmt_dt, now_local, to_utc

log = logging.getLogger(__name__)
router = Router(name="callbacks")

_SPECIAL_TIME = {"mon10": (0, "10:00"), "tue10": (1, "10:00")}


@router.callback_query(F.data == "noop")
async def cb_noop(cq: CallbackQuery):
    await cq.answer()


@router.callback_query(F.data.startswith("time:"))
async def cb_set_time(cq: CallbackQuery):
    # time:<task_id>:<HH:MM>  или  time:<task_id>:mon10
    _, rest = cq.data.split(":", 1)
    task_id_str, tail = rest.split(":", 1)
    task_id = int(task_id_str)

    async with session_scope() as s:
        user = await users_svc.get_or_create(s, cq.from_user.id)
        task = await tasks_svc.get(s, task_id)
        if not task:
            await cq.answer("Задача не найдена", show_alert=True)
            return

        if tail in _SPECIAL_TIME:  # «Пн 10:00» на следующей неделе
            dow, hhmm = _SPECIAL_TIME[tail]
            nl = now_local(user.timezone)
            days = (dow - nl.weekday()) % 7 or 7
            target = (nl + timedelta(days=days)).strftime("%Y-%m-%d")
            from app.utils.timeparse import combine
            task.due_at = combine(target, hhmm, user.timezone)
            r = await rem_svc.create(s, user.id, task.title, task.due_at,
                                     entity_type=EntityType.task, entity_id=task.id)
            when, rid = fmt_dt(task.due_at, user.timezone), r.id
        else:
            when, rid = await pipeline.attach_time_and_remind(s, user, task, tail)
        title = task.title

    await cq.message.edit_text(f"🔔 Напомню {when}: {title}", reply_markup=kb.reminder_created(rid))
    await cq.answer("Готово")


@router.callback_query(F.data.startswith("time_other:"))
async def cb_time_other(cq: CallbackQuery):
    task_id = int(cq.data.split(":", 1)[1])
    await state_svc.set_await(cq.from_user.id, {"await": "time", "task_id": task_id})
    await cq.message.answer("Во сколько напомнить? Напиши время, например 15:00")
    await cq.answer()


@router.callback_query(F.data.startswith("rem_del:"))
async def cb_rem_del(cq: CallbackQuery):
    rid = int(cq.data.split(":", 1)[1])
    async with session_scope() as s:
        r = await rem_svc.get(s, rid)
        if r:
            await rem_svc.cancel(s, r)
    await cq.message.edit_text("🗑 Напоминание удалено")
    await cq.answer()


@router.callback_query(F.data.startswith("rem_edit:"))
async def cb_rem_edit(cq: CallbackQuery):
    rid = int(cq.data.split(":", 1)[1])
    await state_svc.set_await(cq.from_user.id, {"await": "rem_time", "reminder_id": rid})
    await cq.message.answer("Пришли новое время, например 15:00")
    await cq.answer()


# --- сработавшее напоминание ---
@router.callback_query(F.data.startswith("r_done:"))
async def cb_r_done(cq: CallbackQuery):
    rid = int(cq.data.split(":", 1)[1])
    async with session_scope() as s:
        r = await rem_svc.get(s, rid)
        if r:
            r.status = ReminderStatus.done
            if r.entity_type == EntityType.task and r.entity_id:
                task = await tasks_svc.get(s, r.entity_id)
                if task:
                    await tasks_svc.complete(s, task)
    await cq.message.edit_text("☑ Отлично, отмечено выполненным!")
    await cq.answer()


@router.callback_query(F.data.startswith("r_hour:"))
async def cb_r_hour(cq: CallbackQuery):
    rid = int(cq.data.split(":", 1)[1])
    async with session_scope() as s:
        r = await rem_svc.get(s, rid)
        if r:
            await rem_svc.snooze(s, r, delta=timedelta(hours=1))
    await cq.message.edit_text("⏰ Напомню через час")
    await cq.answer()


@router.callback_query(F.data.startswith("r_tomorrow:"))
async def cb_r_tomorrow(cq: CallbackQuery):
    rid = int(cq.data.split(":", 1)[1])
    async with session_scope() as s:
        user = await users_svc.get_or_create(s, cq.from_user.id)
        r = await rem_svc.get(s, rid)
        if r:
            nl = now_local(user.timezone) + timedelta(days=1)
            to = to_utc(nl.replace(hour=9, minute=0, second=0, microsecond=0), user.timezone)
            await rem_svc.snooze(s, r, to=to)
    await cq.message.edit_text("📅 Перенёс на завтра, 09:00")
    await cq.answer()


@router.callback_query(F.data.startswith("r_cancel:"))
async def cb_r_cancel(cq: CallbackQuery):
    rid = int(cq.data.split(":", 1)[1])
    async with session_scope() as s:
        r = await rem_svc.get(s, rid)
        if r:
            await rem_svc.cancel(s, r)
    await cq.message.edit_text("❌ Отменено")
    await cq.answer()


# --- просроченные задачи ---
@router.callback_query(F.data.startswith("t_done:"))
async def cb_t_done(cq: CallbackQuery):
    tid = int(cq.data.split(":", 1)[1])
    async with session_scope() as s:
        task = await tasks_svc.get(s, tid)
        if task:
            await tasks_svc.complete(s, task)
    await cq.message.edit_text("☑ Задача выполнена!")
    await cq.answer()


@router.callback_query(F.data.startswith("t_del:"))
async def cb_t_del(cq: CallbackQuery):
    tid = int(cq.data.split(":", 1)[1])
    async with session_scope() as s:
        task = await tasks_svc.get(s, tid)
        if task:
            await tasks_svc.delete(s, task)
    await cq.message.edit_text("🗑 Удалено")
    await cq.answer()


@router.callback_query(F.data.startswith("t_postpone:"))
async def cb_t_postpone(cq: CallbackQuery):
    tid = int(cq.data.split(":", 1)[1])
    try:
        await cq.message.edit_reply_markup(reply_markup=None)
    except Exception:  # noqa: BLE001
        pass
    await cq.message.answer("На когда перенести?", reply_markup=kb.postpone(tid))
    await cq.answer()


@router.callback_query(F.data.startswith("t_pp:"))
async def cb_t_pp(cq: CallbackQuery):
    _, rest = cq.data.split(":", 1)
    tid_str, choice = rest.split(":", 1)
    tid = int(tid_str)
    async with session_scope() as s:
        user = await users_svc.get_or_create(s, cq.from_user.id)
        task = await tasks_svc.get(s, tid)
        if not task:
            await cq.answer("Задача не найдена", show_alert=True)
            return
        nl = now_local(user.timezone)
        if choice == "pick":
            await state_svc.set_await(cq.from_user.id, {"await": "pick_date", "task_id": tid})
            await cq.message.answer("Напиши дату, например 25 декабря или 2026-12-25")
            await cq.answer()
            return
        if choice == "today":
            new_local = nl + timedelta(hours=3)
        elif choice == "tomorrow":
            new_local = (nl + timedelta(days=1)).replace(hour=9, minute=0, second=0, microsecond=0)
        else:  # week
            new_local = (nl + timedelta(days=7)).replace(hour=9, minute=0, second=0, microsecond=0)
        task.due_at = to_utc(new_local, user.timezone)
        task.overdue_notified = False
        await rem_svc.create(s, user.id, task.title, task.due_at,
                             entity_type=EntityType.task, entity_id=task.id)
        when = fmt_dt(task.due_at, user.timezone)
    await cq.message.edit_text(f"📅 Перенёс: {when}")
    await cq.answer()


# --- цели ---
@router.callback_query(F.data.startswith("goal_nudge:"))
async def cb_goal_nudge(cq: CallbackQuery):
    _, rest = cq.data.split(":", 1)
    gid_str, choice = rest.split(":", 1)
    async with session_scope() as s:
        user = await users_svc.get_or_create(s, cq.from_user.id)
        goal = await goals_svc.get(s, int(gid_str))
        if choice == "yes":
            if not user.goal_nudge_days:
                user.goal_nudge_days = 7
            msg = "Буду периодически возвращать тебя к этой цели 👍"
        else:
            msg = "Хорошо, не буду напоминать об этой цели."
        if goal:
            await goals_svc.touch(s, goal)
    await cq.message.edit_text(f"🎯 Цель сохранена. {msg}")
    await cq.answer()


# --- недельный отчёт ---
@router.callback_query(F.data == "wk_focus")
async def cb_wk_focus(cq: CallbackQuery):
    await state_svc.set_await(cq.from_user.id, {"await": "note"})
    await cq.message.answer("Какой фокус выбираешь на неделю? Напиши — сохраню.")
    await cq.answer()


@router.callback_query(F.data.in_({"menu_tasks", "menu_ideas", "menu_stats"}))
async def cb_menu(cq: CallbackQuery):
    action = cq.data
    async with session_scope() as s:
        user = await users_svc.get_or_create(s, cq.from_user.id)
        if action == "menu_tasks":
            rows = await tasks_svc.list_open(s, user.id, limit=20)
            text = "📋 Задачи:\n" + ("\n".join(f"• {t.title}" for t in rows) or "пусто")
        elif action == "menu_ideas":
            from app.services import ideas as ideas_svc
            rows = await ideas_svc.list_ideas(s, user.id, limit=20)
            text = "💡 Идеи:\n" + ("\n".join(f"• {i.title}" for i in rows) or "пусто")
        else:
            done = await tasks_svc.count_done_since(s, user.id,
                                                    to_utc(now_local(user.timezone) - timedelta(days=7), user.timezone))
            open_n = len(await tasks_svc.list_open(s, user.id, limit=999))
            text = f"📊 За неделю выполнено: {done}\nОткрытых задач: {open_n}"
    await cq.message.answer(text)
    await cq.answer()
