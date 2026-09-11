from datetime import datetime

from app.utils.recurrence import next_occurrence, parse_recurrence
from app.utils.tz import get_tz, to_local

TZ = "Europe/Moscow"


def test_weekly_specific_day():
    rule = parse_recurrence("каждый понедельник в 10 утра напоминай про финансы")
    assert rule["freq"] == "weekly"
    assert rule["byweekday"] == [0]
    assert rule["time"] == "10:00"


def test_daily_evening():
    rule = parse_recurrence("каждый вечер в 21:00 спрашивай что я сделал")
    assert rule["freq"] == "daily"
    assert rule["time"] == "21:00"


def test_no_recurrence():
    assert parse_recurrence("позвонить Сергею завтра") is None


def test_next_occurrence_is_future_monday():
    rule = {"freq": "weekly", "interval": 1, "byweekday": [0], "time": "10:00"}
    after = datetime(2026, 9, 11, 12, 0, tzinfo=get_tz(TZ))  # пятница
    nxt = next_occurrence(rule, after, TZ)
    assert nxt is not None
    local = to_local(nxt, TZ)
    assert local.weekday() == 0            # понедельник
    assert (local.hour, local.minute) == (10, 0)
    assert nxt > after


def test_daily_next_is_tomorrow_if_passed():
    rule = {"freq": "daily", "interval": 1, "time": "09:00"}
    after = datetime(2026, 9, 11, 12, 0, tzinfo=get_tz(TZ))  # уже прошло 09:00
    nxt = next_occurrence(rule, after, TZ)
    local = to_local(nxt, TZ)
    assert local.day == 12
    assert (local.hour, local.minute) == (9, 0)
