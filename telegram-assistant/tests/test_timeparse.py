from datetime import datetime

from app.utils.timeparse import parse_time_only, parse_when
from app.utils.tz import get_tz

TZ = "Europe/Moscow"
BASE = datetime(2026, 9, 11, 12, 0, tzinfo=get_tz(TZ))  # пятница, полдень


def test_tomorrow_has_date_no_time():
    pw = parse_when("напомни завтра позвонить Сергею", BASE, TZ)
    assert pw.has_date is True
    assert pw.has_time is False
    assert pw.vague is False
    assert pw.dt_utc is not None


def test_in_two_hours_has_time():
    pw = parse_when("через два часа проверить почту", BASE, TZ)
    assert pw.has_time is True
    assert pw.dt_utc is not None


def test_explicit_time():
    pw = parse_when("завтра в 15:00 встреча", BASE, TZ)
    assert pw.has_time is True
    # 15:00 MSK = 12:00 UTC
    assert pw.dt_utc.hour == 12


def test_vague_not_scheduled():
    pw = parse_when("когда-нибудь надо обсудить с Иваном", BASE, TZ)
    assert pw.vague is True
    assert pw.dt_utc is None


def test_parse_time_only():
    assert parse_time_only("15:00") == "15:00"
    assert parse_time_only("в 9 утра") == "09:00"
    assert parse_time_only("в 7 вечера") == "19:00"
    assert parse_time_only("непонятно") is None
