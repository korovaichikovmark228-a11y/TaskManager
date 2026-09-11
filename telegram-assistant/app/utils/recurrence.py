"""Разбор повторяющихся правил из русской речи + расчёт следующего запуска.

Правило хранится как JSON-строка:
  {"freq": "daily|weekly|monthly", "interval": 1, "byweekday": [0], "time": "10:00"}
byweekday: 0=Пн .. 6=Вс (как в dateutil).
"""
from __future__ import annotations

import json
import re
from datetime import datetime, time

from dateutil.relativedelta import relativedelta

from app.utils.tz import get_tz, to_local, to_utc

_WEEKDAYS = {
    "понедельник": 0, "пн": 0,
    "вторник": 1, "вт": 1,
    "сред": 2, "ср": 2,
    "четверг": 3, "чт": 3,
    "пятниц": 4, "пт": 4,
    "суббот": 5, "сб": 5,
    "воскресень": 6, "вс": 6,
}

_TIME_RE = re.compile(r"(\d{1,2})([:.](\d{2}))?\s*(утра|дня|вечера|ночи)?")


def _extract_time(text: str) -> str | None:
    # ищем «в 10», «в 21:00», «в 9 утра»
    m = re.search(r"в\s+" + _TIME_RE.pattern, text, re.IGNORECASE)
    if not m:
        return None
    hh = int(m.group(1))
    mm = int(m.group(3)) if m.group(3) else 0
    mod = (m.group(4) or "").lower()
    if mod == "вечера" and hh < 12:
        hh += 12
    elif mod == "ночи" and hh < 12:
        hh += 0
    elif mod == "дня" and hh < 12:
        hh += 12
    if 0 <= hh <= 23 and 0 <= mm <= 59:
        return f"{hh:02d}:{mm:02d}"
    return None


def parse_recurrence(text: str) -> dict | None:
    """Вернуть правило или None, если повторяемости нет."""
    t = text.lower()
    # без \b: у «кажд/ежедневн/…» дальше идут буквы, границы слова там нет.
    if not re.search(r"(кажд|ежедневн|еженедельн|ежемесячн|по будням|каждую)", t):
        return None

    at = _extract_time(t)
    rule: dict = {"interval": 1}
    if at:
        rule["time"] = at

    # день недели
    for key, dow in _WEEKDAYS.items():
        if re.search(rf"кажд\w*\s+{key}", t) or re.search(rf"по\s+{key}", t):
            rule["freq"] = "weekly"
            rule["byweekday"] = [dow]
            return rule

    if re.search(r"ежедневн|каждый день|каждое утро|каждый вечер|каждую ночь", t):
        rule["freq"] = "daily"
        return rule
    if re.search(r"еженедельн|каждую неделю", t):
        rule["freq"] = "weekly"
        return rule
    if re.search(r"ежемесячн|каждый месяц", t):
        rule["freq"] = "monthly"
        return rule

    m = re.search(r"кажд\w*\s+(\d+)\s+(дн|недел|месяц)", t)
    if m:
        rule["interval"] = int(m.group(1))
        rule["freq"] = {"дн": "daily", "недел": "weekly", "месяц": "monthly"}[m.group(2)]
        return rule

    if "кажд" in t:  # «каждый ...» без явной единицы → по умолчанию ежедневно
        rule["freq"] = "daily"
        return rule
    return None


def next_occurrence(rule: dict | str, after_utc: datetime, tz_name: str) -> datetime | None:
    """Следующий момент срабатывания (UTC) строго ПОСЛЕ after_utc."""
    if isinstance(rule, str):
        try:
            rule = json.loads(rule)
        except (json.JSONDecodeError, TypeError):
            return None
    if not rule or "freq" not in rule:
        return None

    tz = get_tz(tz_name)
    after_local = to_local(after_utc, tz_name)
    interval = int(rule.get("interval", 1)) or 1

    hh, mm = 9, 0
    if rule.get("time"):
        try:
            tt = datetime.strptime(rule["time"], "%H:%M").time()
            hh, mm = tt.hour, tt.minute
        except ValueError:
            pass

    freq = rule["freq"]
    candidate = after_local.replace(hour=hh, minute=mm, second=0, microsecond=0)

    if freq == "daily":
        if candidate <= after_local:
            candidate += relativedelta(days=interval)
    elif freq == "weekly":
        byweekday = rule.get("byweekday")
        if byweekday:
            target = byweekday[0]
            days_ahead = (target - candidate.weekday()) % 7
            candidate = candidate + relativedelta(days=days_ahead)
            if candidate <= after_local:
                candidate += relativedelta(days=7 * interval)
        else:
            if candidate <= after_local:
                candidate += relativedelta(weeks=interval)
    elif freq == "monthly":
        if candidate <= after_local:
            candidate += relativedelta(months=interval)
    else:
        return None

    if candidate.tzinfo is None:
        candidate = candidate.replace(tzinfo=tz)
    return to_utc(candidate, tz_name)


def describe(rule: dict | str, tz_name: str = "") -> str:
    if isinstance(rule, str):
        try:
            rule = json.loads(rule)
        except (json.JSONDecodeError, TypeError):
            return "повтор"
    freq = rule.get("freq")
    at = rule.get("time", "")
    at_s = f" в {at}" if at else ""
    if freq == "daily":
        return f"каждый день{at_s}"
    if freq == "weekly":
        bw = rule.get("byweekday")
        if bw:
            names = ["по понедельникам", "по вторникам", "по средам", "по четвергам",
                     "по пятницам", "по субботам", "по воскресеньям"]
            return f"{names[bw[0]]}{at_s}"
        return f"каждую неделю{at_s}"
    if freq == "monthly":
        return f"каждый месяц{at_s}"
    return "повтор"
