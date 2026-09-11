"""Фоновые задачи планировщика.

Главный «тик» (раз в ~30 сек) — единый надёжный сканер:
  * рассылает наступившие напоминания (источник правды — таблица reminders);
  * пересоздаёт повторяющиеся напоминания;
  * уведомляет о просроченных задачах;
  * шлёт утренний/вечерний check-in и недельный отчёт по локальному времени.

Такой подход переживает перезапуск сервера: состояние — в БД, а не в памяти
процесса, поэтому напоминания не теряются.
"""
from __future__ import annotations

import logging

from aiogram import Bot
from aiogram.exceptions import TelegramForbiddenError, TelegramRetryAfter

from app.bot import keyboards as kb
from app.bot.instance import get_bot
from app.db import session_scope
from app.services import dedup
from app.services import reminders as rem_svc
from app.services import reports as reports_svc
from app.services import tasks as tasks_svc
from app.services import users as users_svc
from app.utils.tz import now_local, now_utc

log = logging.getLogger(__name__)


async def _send(bot: Bot, chat_id: int, text: str, markup=None) -> bool:
    try:
        await bot.send_message(chat_id, text, reply_markup=markup)
        return True
    except TelegramForbiddenError:
        log.info("Пользователь %s заблокировал бота", chat_id)
    except TelegramRetryAfter as e:
        log.warning("Flood limit, retry after %s", e.retry_after)
    except Exception as e:  # noqa: BLE001
        log.exception("send error to %s: %s", chat_id, e)
    return False


async def dispatch_reminders(bot: Bot) -> None:
    async with session_scope() as s:
        due = await rem_svc.due(s, now_utc())
        for r in due:
            # защита от двойной отправки при гонке воркеров
            if not await dedup.reminder_lock(r.id):
                continue
            user = await users_svc.by_id(s, r.user_id)
            if not user:
                await rem_svc.cancel(s, r)
                continue
            ok = await _send(bot, user.telegram_id, f"🔔 <b>Напоминание</b>\n\n{r.text}",
                             kb.reminder_fired(r.id))
            if ok:
                await rem_svc.mark_sent(s, r)
                await rem_svc.spawn_next_if_recurring(s, r, user.timezone)


async def notify_overdue(bot: Bot) -> None:
    async with session_scope() as s:
        rows = await tasks_svc.overdue(s, now_utc())
        for t in rows:
            user = await users_svc.by_id(s, t.user_id)
            if not user:
                continue
            ok = await _send(bot, user.telegram_id,
                             f"⚠️ <b>Задача просрочена</b>\n\n{t.title}\n\nЧто сделать?",
                             kb.overdue(t.id))
            if ok:
                t.overdue_notified = True


async def deliver_checkins_and_reports(bot: Bot) -> None:
    async with session_scope() as s:
        users = await users_svc.all_users(s)
        for user in users:
            nl = now_local(user.timezone)
            hhmm = nl.strftime("%H:%M")
            day = nl.strftime("%Y-%m-%d")

            if user.morning_checkin == hhmm and await dedup.once(f"morning:{user.id}:{day}"):
                await _send(bot, user.telegram_id, await reports_svc.build_morning(s, user))

            if user.evening_checkin == hhmm and await dedup.once(f"evening:{user.id}:{day}"):
                await _send(bot, user.telegram_id, reports_svc.build_evening_prompt())

            if (nl.weekday() == user.weekly_report_dow and user.weekly_report_time == hhmm
                    and await dedup.once(f"weekly:{user.id}:{day}")):
                text = await reports_svc.build_weekly_report(s, user)
                await _send(bot, user.telegram_id, text, kb.weekly_report())


async def tick() -> None:
    """Единая точка, которую дёргает планировщик."""
    bot = get_bot()
    try:
        await dispatch_reminders(bot)
        await notify_overdue(bot)
        await deliver_checkins_and_reports(bot)
    except Exception as e:  # noqa: BLE001
        log.exception("tick error: %s", e)
