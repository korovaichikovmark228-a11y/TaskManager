"""Работа с часовыми поясами. В БД всё в UTC, пользователю — в его tz."""
from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

WEEKDAYS_RU = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"]
MONTHS_RU = [
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
]


def get_tz(tz_name: str) -> ZoneInfo:
    try:
        return ZoneInfo(tz_name)
    except Exception:
        return ZoneInfo("UTC")


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def now_local(tz_name: str) -> datetime:
    return now_utc().astimezone(get_tz(tz_name))


def to_utc(dt: datetime, tz_name: str) -> datetime:
    """Наивную дату трактуем как локальную, aware — приводим к UTC."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=get_tz(tz_name))
    return dt.astimezone(timezone.utc)


def to_local(dt: datetime, tz_name: str) -> datetime:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(get_tz(tz_name))


def fmt_dt(dt: datetime, tz_name: str, with_time: bool = True) -> str:
    """Человекочитаемая дата/время в локали пользователя, напр. '12 марта в 15:00'."""
    local = to_local(dt, tz_name)
    date_part = f"{local.day} {MONTHS_RU[local.month - 1]}"
    if with_time:
        return f"{date_part} в {local.strftime('%H:%M')}"
    return date_part
