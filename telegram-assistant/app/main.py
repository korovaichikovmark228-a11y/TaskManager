"""Точка входа: FastAPI + aiogram (polling или webhook) + планировщик."""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from aiogram.types import BotCommand, Update
from fastapi import FastAPI, Header, HTTPException, Request

from app.bot.instance import get_bot, get_dispatcher
from app.config import get_settings
from app.scheduler import scheduler
from app.services import dedup

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("app")

COMMANDS = [
    BotCommand(command="start", description="Начать"),
    BotCommand(command="help", description="Что я умею"),
    BotCommand(command="tasks", description="Мои задачи"),
    BotCommand(command="goals", description="Мои цели"),
    BotCommand(command="ideas", description="Мои идеи"),
    BotCommand(command="today", description="Что сегодня"),
    BotCommand(command="week", description="Отчёт за неделю"),
    BotCommand(command="search", description="Поиск по памяти"),
    BotCommand(command="settings", description="Настройки"),
]

_polling_task: asyncio.Task | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    s = get_settings()
    bot = get_bot()
    dp = get_dispatcher()
    await bot.set_my_commands(COMMANDS)
    scheduler.start()

    global _polling_task
    if s.bot_mode == "webhook" and s.webhook_base_url:
        url = f"{s.webhook_base_url.rstrip('/')}/telegram/webhook"
        await bot.set_webhook(url, secret_token=s.webhook_secret, drop_pending_updates=False)
        log.info("Webhook установлен: %s", url)
    else:
        await bot.delete_webhook(drop_pending_updates=False)
        _polling_task = asyncio.create_task(dp.start_polling(bot, handle_signals=False))
        log.info("Запущен polling")

    try:
        yield
    finally:
        scheduler.shutdown()
        if _polling_task:
            _polling_task.cancel()
        await bot.session.close()


app = FastAPI(title="Telegram AI Personal Assistant", lifespan=lifespan)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/telegram/webhook")
async def telegram_webhook(
    request: Request,
    x_telegram_bot_api_secret_token: str | None = Header(default=None),
):
    s = get_settings()
    if s.bot_mode != "webhook":
        raise HTTPException(status_code=404, detail="webhook disabled")
    if x_telegram_bot_api_secret_token != s.webhook_secret:
        raise HTTPException(status_code=403, detail="bad secret")

    payload = await request.json()
    update_id = payload.get("update_id")
    if update_id is not None and await dedup.seen_update(update_id):
        return {"ok": True, "duplicate": True}

    update = Update.model_validate(payload)
    await get_dispatcher().feed_update(get_bot(), update)
    return {"ok": True}
