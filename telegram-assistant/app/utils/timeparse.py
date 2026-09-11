"""Детерминированный разбор дат/времени из русской речи.

Используется двояко:
  * как нормализатор строк, которые вернул LLM (date="2026-09-12", time="15:00");
  * как fallback-парсер, когда LLM недоступен.

Главный принцип ТЗ: НЕ выдумывать время. Если времени в тексте нет —
возвращаем has_time=False, и бот спросит время отдельно.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, time

import dateparser
from dateparser.search import search_dates

from app.utils.tz import get_tz, to_utc

# Фразы неопределённости — конкретное напоминание без подтверждения не ставим.
VAGUE_RE = re.compile(
    r"\b(когда[- ]?нибудь|как[- ]?нибудь|при случае|на дн[яе]х|в будущем|потом|позже)\b",
    re.IGNORECASE,
)

# Явные указатели времени в тексте.
TIME_RE = re.compile(
    r"(\bв\s*\d{1,2}([:.]\d{2})?\b)"           # «в 15», «в 15:30»
    r"|(\b\d{1,2}[:.]\d{2}\b)"                   # «15:30»
    r"|(\b\d{1,2}\s*(утра|дня|вечера|ночи)\b)"   # «9 утра»
    r"|(\b(утром|днём|днем|вечером|ночью|полдень|полночь)\b)"
    r"|(через\s+\S+\s*(час|часа|часов|минут|минуту|минуты))",  # «через два часа», «через 30 минут»
    re.IGNORECASE,
)

# Указатели даты (без времени тоже считается, что дата задана).
DATE_RE = re.compile(
    r"\b(сегодня|завтра|послезавтра|понедельник|вторник|сред[ау]|четверг|пятниц[ау]|"
    r"суббот[ау]|воскресень[ея]|через\s+\d*\s*(день|дня|дней|недел|месяц|год)|"
    r"\d{1,2}\s+(январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр))",
    re.IGNORECASE,
)

APPROX_TIME = {  # для отображения, НЕ проставляется автоматически без спроса
    "утром": time(9, 0),
    "утра": time(9, 0),
    "днём": time(13, 0),
    "днем": time(13, 0),
    "дня": time(13, 0),
    "вечером": time(19, 0),
    "вечера": time(19, 0),
    "ночью": time(23, 0),
}


@dataclass
class ParsedWhen:
    dt_utc: datetime | None      # момент в UTC (если удалось определить)
    has_date: bool
    has_time: bool
    vague: bool


def _has_explicit_time(text: str) -> bool:
    return bool(TIME_RE.search(text))


def _has_date(text: str) -> bool:
    return bool(DATE_RE.search(text))


def parse_when(text: str, base_local: datetime, tz_name: str) -> ParsedWhen:
    """base_local — «сейчас» в локальном времени пользователя (aware)."""
    if VAGUE_RE.search(text):
        return ParsedWhen(dt_utc=None, has_date=False, has_time=False, vague=True)

    has_time = _has_explicit_time(text)
    has_date = _has_date(text) or has_time  # «через 2 часа» задаёт и дату, и время

    settings = {
        "RELATIVE_BASE": base_local.replace(tzinfo=None),
        "PREFER_DATES_FROM": "future",
        "TIMEZONE": tz_name,
        "RETURN_AS_TIMEZONE_AWARE": True,
        "DATE_ORDER": "DMY",
    }

    parsed = None
    # search_dates находит дату/время внутри целой фразы («напомни завтра позвонить…»).
    try:
        found = search_dates(text, languages=["ru"], settings=settings)
    except Exception:  # noqa: BLE001
        found = None
    if found:
        parsed = found[0][1]
    else:
        parsed = dateparser.parse(text, languages=["ru"], settings=settings)

    if parsed is None:
        return ParsedWhen(dt_utc=None, has_date=has_date, has_time=has_time, vague=False)

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=get_tz(tz_name))

    # Если время указано явно («в 11», «в 9 утра»), но search_dates его не захватил
    # (взял только «завтра»), — проставляем это время поверх найденной даты.
    if has_time:
        hhmm = parse_time_only(text)
        if hhmm:
            h, m = (int(x) for x in hhmm.split(":"))
            parsed = parsed.replace(hour=h, minute=m, second=0, microsecond=0)

    dt_utc = to_utc(parsed, tz_name)
    return ParsedWhen(dt_utc=dt_utc, has_date=True, has_time=has_time, vague=False)


_TIME_ONLY = re.compile(r"(?:в\s*)?(\d{1,2})[:.](\d{2})|(?:в\s+)(\d{1,2})(?:\s*(утра|дня|вечера|ночи))?")


def parse_time_only(text: str) -> str | None:
    """Извлечь «HH:MM» из короткого ответа пользователя («15:00», «в 9 утра»)."""
    m = _TIME_ONLY.search(text.lower().strip())
    if not m:
        return None
    if m.group(1) is not None:
        hh, mm = int(m.group(1)), int(m.group(2))
    else:
        hh, mm = int(m.group(3)), 0
        mod = m.group(4) or ""
        if mod in ("вечера", "дня") and hh < 12:
            hh += 12
    if 0 <= hh <= 23 and 0 <= mm <= 59:
        return f"{hh:02d}:{mm:02d}"
    return None


def combine(date_str: str, time_str: str | None, tz_name: str) -> datetime | None:
    """Собрать ISO-дату (YYYY-MM-DD) + время (HH:MM) в UTC-момент."""
    if not date_str:
        return None
    try:
        d = datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        return None
    if time_str:
        try:
            t = datetime.strptime(time_str, "%H:%M").time()
        except ValueError:
            t = time(9, 0)
        d = d.replace(hour=t.hour, minute=t.minute)
    return to_utc(d.replace(tzinfo=get_tz(tz_name)), tz_name)
