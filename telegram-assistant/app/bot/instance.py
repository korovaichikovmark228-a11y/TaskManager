"""Экземпляр бота и диспетчера aiogram."""
from __future__ import annotations

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode

from app.config import get_settings

_bot: Bot | None = None
_dp: Dispatcher | None = None


def get_bot() -> Bot:
    global _bot
    if _bot is None:
        _bot = Bot(
            token=get_settings().telegram_bot_token,
            default=DefaultBotProperties(parse_mode=ParseMode.HTML),
        )
    return _bot


def get_dispatcher() -> Dispatcher:
    global _dp
    if _dp is None:
        _dp = Dispatcher()
        from app.bot.handlers import callbacks, commands, messages

        _dp.include_router(commands.router)
        _dp.include_router(callbacks.router)
        _dp.include_router(messages.router)  # текст/голос — последним (catch-all)
    return _dp
