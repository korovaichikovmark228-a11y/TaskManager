"""Проверяем детерминированный разбор без LLM (fallback)."""
from datetime import datetime

import pytest

from app.ai import intent
from app.utils.tz import get_tz

TZ = "Europe/Moscow"
BASE = datetime(2026, 9, 11, 12, 0, tzinfo=get_tz(TZ))


@pytest.mark.asyncio
async def test_goal_detected():
    res = await intent.parse("Хочу выйти на доход 1 млн рублей в месяц", BASE, TZ)
    assert res.intent == "create"
    assert res.items[0].type == "goal"


@pytest.mark.asyncio
async def test_idea_detected():
    res = await intent.parse("Идея: сделать AI-секретаря для предпринимателей", BASE, TZ)
    assert res.items[0].type == "idea"


@pytest.mark.asyncio
async def test_task_with_reminder():
    res = await intent.parse("Напомни завтра позвонить Сергею", BASE, TZ)
    item = res.items[0]
    assert item.type == "task"
    assert item.needs_reminder is True
    assert item.date is not None          # завтра распознано
    assert item.time is None              # время не названо → спросим


@pytest.mark.asyncio
async def test_query_detected():
    res = await intent.parse("Что я записывал про AI?", BASE, TZ)
    assert res.intent == "query"


@pytest.mark.asyncio
async def test_recurring_task():
    res = await intent.parse("каждый понедельник в 10 утра проверять финансы", BASE, TZ)
    item = res.items[0]
    assert item.recurrence is not None
    assert item.recurrence["freq"] == "weekly"
