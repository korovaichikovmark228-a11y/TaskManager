"""Планировщик на APScheduler (AsyncIO).

Надёжность: состояние напоминаний/check-in хранится в PostgreSQL, а «тик»
лишь сканирует БД. Поэтому перезапуск процесса не теряет напоминания — при
старте следующий тик подхватит все наступившие reminders.
"""
from __future__ import annotations

import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from app.config import get_settings
from app.scheduler.jobs import tick

log = logging.getLogger(__name__)

_scheduler: AsyncIOScheduler | None = None


def start() -> AsyncIOScheduler:
    global _scheduler
    if _scheduler is not None:
        return _scheduler
    s = get_settings()
    _scheduler = AsyncIOScheduler(timezone="UTC")
    _scheduler.add_job(
        tick,
        "interval",
        seconds=s.scheduler_tick_seconds,
        id="main_tick",
        max_instances=1,
        coalesce=True,          # пропущенные тики схлопываются в один
        replace_existing=True,
        misfire_grace_time=300,  # переживаем паузы/перезапуск без потерь
    )
    _scheduler.start()
    log.info("Scheduler запущен, тик каждые %s сек", s.scheduler_tick_seconds)
    return _scheduler


def shutdown() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
