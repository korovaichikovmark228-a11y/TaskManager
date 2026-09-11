"""Мини-разбор настроек из свободного текста (без LLM).

Примеры: «часовой пояс Europe/Kyiv», «утренний check-in 08:30»,
«вечерний check-in выкл», «отчёт в пятницу 18:00», «напоминать о целях каждые 5 дней»,
«ai выкл».
Возвращает описание изменения или None, если это не настройка.
"""
from __future__ import annotations

import re

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import User

_DOW = {
    "понедельник": 0, "вторник": 1, "среда": 2, "среду": 2, "четверг": 3,
    "пятница": 4, "пятницу": 4, "суббота": 5, "субботу": 5, "воскресенье": 6,
}
_TIME = r"(\d{1,2}[:.]\d{2})"


def _norm_time(s: str) -> str:
    return s.replace(".", ":")


async def try_apply(session: AsyncSession, user: User, text: str) -> str | None:
    t = text.lower().strip()

    m = re.search(r"часов\w* пояс\w*\s+([\w/+-]+)", t)
    if m:
        user.timezone = text[m.start(1):m.end(1)]
        return f"🌍 Часовой пояс: {user.timezone}"

    if "утренн" in t and "check" in t:
        if "выкл" in t:
            user.morning_checkin = None
            return "☀️ Утренний check-in выключен"
        tm = re.search(_TIME, t)
        if tm:
            user.morning_checkin = _norm_time(tm.group(1))
            return f"☀️ Утренний check-in: {user.morning_checkin}"

    if "вечерн" in t and "check" in t:
        if "выкл" in t:
            user.evening_checkin = None
            return "🌙 Вечерний check-in выключен"
        tm = re.search(_TIME, t)
        if tm:
            user.evening_checkin = _norm_time(tm.group(1))
            return f"🌙 Вечерний check-in: {user.evening_checkin}"

    if "отчёт" in t or "отчет" in t:
        dow = next((v for k, v in _DOW.items() if k in t), None)
        tm = re.search(_TIME, t)
        if dow is not None:
            user.weekly_report_dow = dow
        if tm:
            user.weekly_report_time = _norm_time(tm.group(1))
        if dow is not None or tm:
            dows = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]
            return f"📊 Недельный отчёт: {dows[user.weekly_report_dow]} {user.weekly_report_time}"

    if "цел" in t and ("напомина" in t or "nudge" in t):
        if "выкл" in t:
            user.goal_nudge_days = 0
            return "🎯 Напоминания о целях выключены"
        dm = re.search(r"(\d+)\s*дн", t)
        if dm:
            user.goal_nudge_days = int(dm.group(1))
            return f"🎯 Напоминания о целях: каждые {user.goal_nudge_days} дн."

    if re.fullmatch(r"ai (вкл|выкл|on|off)", t) or ("ai-анализ" in t):
        user.ai_enabled = not ("выкл" in t or "off" in t)
        return f"🤖 AI-анализ: {'вкл' if user.ai_enabled else 'выкл'}"

    return None
