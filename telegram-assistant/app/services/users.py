"""Пользователи и их настройки."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models import User


async def get_or_create(session: AsyncSession, telegram_id: int, *, username: str | None = None,
                        first_name: str | None = None) -> User:
    user = (await session.execute(select(User).where(User.telegram_id == telegram_id))).scalar_one_or_none()
    if user:
        if username and user.username != username:
            user.username = username
        return user
    user = User(
        telegram_id=telegram_id,
        username=username,
        first_name=first_name,
        timezone=get_settings().default_timezone,
    )
    session.add(user)
    await session.flush()
    return user


async def by_id(session: AsyncSession, user_id: int) -> User | None:
    return await session.get(User, user_id)


async def all_users(session: AsyncSession) -> list[User]:
    return list((await session.execute(select(User))).scalars())
