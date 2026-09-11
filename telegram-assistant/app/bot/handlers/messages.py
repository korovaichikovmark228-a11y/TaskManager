"""Основной обработчик: текст и голос (естественный язык)."""
from __future__ import annotations

import logging

from aiogram import F, Router
from aiogram.types import Message

from app.ai import stt
from app.bot import keyboards as kb
from app.bot import pipeline
from app.bot.instance import get_bot
from app.db import session_scope
from app.services import dedup
from app.services import settings_nl
from app.services import state as state_svc
from app.services import users as users_svc
from app.utils.timeparse import parse_time_only

log = logging.getLogger(__name__)
router = Router(name="messages")


async def _guard(message: Message) -> bool:
    if not await dedup.allow(message.from_user.id):
        await message.answer("Слишком много сообщений подряд, подожди немного 🙏")
        return False
    return True


@router.message(F.voice | F.audio)
async def on_voice(message: Message):
    if not await _guard(message):
        return
    await message.bot.send_chat_action(message.chat.id, "typing")
    voice = message.voice or message.audio
    try:
        buf = await get_bot().download(voice.file_id)
        audio = buf.read()
    except Exception as e:  # noqa: BLE001
        log.exception("voice download: %s", e)
        await message.answer("Не смог скачать голосовое, попробуй ещё раз 🙏")
        return

    text = await stt.transcribe(audio)
    if not text:
        await message.answer("Пока не получилось распознать голос. Можешь написать текстом?")
        return
    await message.answer(f"🎧 Распознал: «{text}»")
    await _handle_text(message, text)


@router.message(F.text)
async def on_text(message: Message):
    if not await _guard(message):
        return
    await _handle_text(message, message.text)


async def _handle_text(message: Message, text: str):
    tg_id = message.from_user.id

    # 1) ждём ли мы ответ (время/дату) для конкретной задачи?
    pending = await state_svc.pop_await(tg_id)
    if pending and await _handle_pending(message, pending, text):
        return

    async with session_scope() as s:
        user = await users_svc.get_or_create(
            s, tg_id, username=message.from_user.username, first_name=message.from_user.first_name,
        )

        # 2) это команда настройки?
        changed = await settings_nl.try_apply(s, user, text)
        if changed:
            await message.answer(f"Готово. {changed}")
            return

        # 3) основной сценарий — свободный текст
        replies = await pipeline.process_text(s, user, text)

    for r in replies:
        await message.answer(r.text, reply_markup=r.keyboard)


async def _handle_pending(message: Message, pending: dict, text: str) -> bool:
    """Обработать ожидаемый ввод. Вернуть True, если ввод поглощён."""
    from app.models import EntityType, ReminderStatus
    from app.services import ideas as ideas_svc
    from app.services import reminders as rem_svc
    from app.services import tasks as tasks_svc
    from app.utils.timeparse import combine, parse_when
    from app.utils.tz import fmt_dt, now_local, to_local

    kind = pending.get("await")
    task_id = pending.get("task_id")
    tg_id = message.from_user.id

    if kind == "time" and task_id:
        hhmm = parse_time_only(text)
        if not hhmm:
            await message.answer("Не понял время. Напиши, например, 15:00")
            await state_svc.set_await(tg_id, pending)  # ждём снова
            return True
        async with session_scope() as s:
            user = await users_svc.get_or_create(s, tg_id)
            task = await tasks_svc.get(s, task_id)
            if not task:
                await message.answer("Задача не найдена 🤔")
                return True
            when, rid = await pipeline.attach_time_and_remind(s, user, task, hhmm)
            title = task.title
        await message.answer(f"🔔 Напомню {when}: {title}", reply_markup=kb.reminder_created(rid))
        return True

    if kind == "rem_time":
        rid = pending.get("reminder_id")
        hhmm = parse_time_only(text)
        if not hhmm:
            await message.answer("Не понял время. Напиши, например, 15:00")
            await state_svc.set_await(tg_id, pending)
            return True
        async with session_scope() as s:
            user = await users_svc.get_or_create(s, tg_id)
            r = await rem_svc.get(s, rid)
            if not r:
                await message.answer("Напоминание не найдено 🤔")
                return True
            date_str = to_local(r.remind_at, user.timezone).strftime("%Y-%m-%d")
            r.remind_at = combine(date_str, hhmm, user.timezone)
            r.status = ReminderStatus.scheduled
            when = fmt_dt(r.remind_at, user.timezone)
        await message.answer(f"🔔 Обновил: напомню {when}")
        return True

    if kind == "pick_date" and task_id:
        pw = parse_when(text, now_local(await _user_tz(tg_id)), await _user_tz(tg_id))
        if not pw.dt_utc:
            await message.answer("Не понял дату. Напиши, например, 25 декабря или 2026-12-25")
            await state_svc.set_await(tg_id, pending)
            return True
        async with session_scope() as s:
            user = await users_svc.get_or_create(s, tg_id)
            task = await tasks_svc.get(s, task_id)
            if not task:
                await message.answer("Задача не найдена 🤔")
                return True
            task.due_at = pw.dt_utc
            task.overdue_notified = False
            await rem_svc.create(s, user.id, task.title, task.due_at,
                                 entity_type=EntityType.task, entity_id=task.id)
            when = fmt_dt(task.due_at, user.timezone)
        await message.answer(f"📅 Перенёс: {when}")
        return True

    if kind == "note":
        from app.services import memory as memory_svc
        async with session_scope() as s:
            user = await users_svc.get_or_create(s, tg_id)
            note = await ideas_svc.create_note(s, user.id, text)
            await memory_svc.index(s, user.id, EntityType.note, note.id, text)
        await message.answer("Записал как фокус недели 👍")
        return True

    return False


async def _user_tz(tg_id: int) -> str:
    async with session_scope() as s:
        user = await users_svc.get_or_create(s, tg_id)
        return user.timezone
