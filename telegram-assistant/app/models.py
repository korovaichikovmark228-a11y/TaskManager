"""Модели БД. Все временные метки — в UTC (timezone-aware)."""
from __future__ import annotations

import enum
from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    BigInteger,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.config import get_settings
from app.db import Base

EMB_DIM = get_settings().embeddings_dim


def utcnow() -> datetime:
    from datetime import timezone

    return datetime.now(timezone.utc)


class Priority(str, enum.Enum):
    high = "high"
    medium = "medium"
    low = "low"


class TaskStatus(str, enum.Enum):
    open = "open"
    done = "done"
    cancelled = "cancelled"


class GoalStatus(str, enum.Enum):
    active = "active"
    completed = "completed"
    paused = "paused"
    cancelled = "cancelled"


class ReminderStatus(str, enum.Enum):
    scheduled = "scheduled"
    sent = "sent"
    done = "done"
    cancelled = "cancelled"


class EntityType(str, enum.Enum):
    task = "task"
    goal = "goal"
    idea = "idea"
    note = "note"
    custom = "custom"


class CheckinType(str, enum.Enum):
    morning = "morning"
    evening = "evening"
    weekly = "weekly"
    free = "free"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    telegram_id: Mapped[int] = mapped_column(BigInteger, unique=True, index=True)
    username: Mapped[str | None] = mapped_column(String(64))
    first_name: Mapped[str | None] = mapped_column(String(128))
    timezone: Mapped[str] = mapped_column(String(64), default="Europe/Moscow")

    # Настройки check-in / отчётов (локальное время пользователя, "HH:MM").
    morning_checkin: Mapped[str | None] = mapped_column(String(5))   # None = выключено
    evening_checkin: Mapped[str | None] = mapped_column(String(5))
    weekly_report_dow: Mapped[int] = mapped_column(Integer, default=6)  # 0=Пн..6=Вс
    weekly_report_time: Mapped[str] = mapped_column(String(5), default="10:00")
    goal_nudge_days: Mapped[int] = mapped_column(Integer, default=7)  # 0 = не напоминать о целях
    ai_enabled: Mapped[bool] = mapped_column(default=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    tasks: Mapped[list["Task"]] = relationship(back_populates="user")
    goals: Mapped[list["Goal"]] = relationship(back_populates="user")


class Goal(Base):
    __tablename__ = "goals"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(512))
    description: Mapped[str | None] = mapped_column(Text)
    deadline: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[GoalStatus] = mapped_column(Enum(GoalStatus, name="goal_status"), default=GoalStatus.active)
    progress: Mapped[int] = mapped_column(Integer, default=0)  # 0..100
    last_discussed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    user: Mapped[User] = relationship(back_populates="goals")
    tasks: Mapped[list["Task"]] = relationship(back_populates="goal")


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    goal_id: Mapped[int | None] = mapped_column(ForeignKey("goals.id", ondelete="SET NULL"))
    title: Mapped[str] = mapped_column(String(512))
    description: Mapped[str | None] = mapped_column(Text)
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    priority: Mapped[Priority] = mapped_column(Enum(Priority, name="priority"), default=Priority.medium)
    status: Mapped[TaskStatus] = mapped_column(Enum(TaskStatus, name="task_status"), default=TaskStatus.open)
    recurrence: Mapped[str | None] = mapped_column(String(255))  # JSON-строка правила, если повторяется
    overdue_notified: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    user: Mapped[User] = relationship(back_populates="tasks")
    goal: Mapped[Goal | None] = relationship(back_populates="tasks")


class Idea(Base):
    __tablename__ = "ideas"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(512))
    description: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Note(Base):
    __tablename__ = "notes"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Reminder(Base):
    __tablename__ = "reminders"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    entity_type: Mapped[EntityType] = mapped_column(Enum(EntityType, name="entity_type"))
    entity_id: Mapped[int | None] = mapped_column(Integer)  # id задачи/цели и т.п.
    text: Mapped[str] = mapped_column(Text)  # что напомнить
    remind_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    status: Mapped[ReminderStatus] = mapped_column(
        Enum(ReminderStatus, name="reminder_status"), default=ReminderStatus.scheduled
    )
    recurrence: Mapped[str | None] = mapped_column(String(255))  # JSON-строка правила
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("ix_reminders_due", "status", "remind_at"),
    )


class Checkin(Base):
    __tablename__ = "checkins"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    type: Mapped[CheckinType] = mapped_column(Enum(CheckinType, name="checkin_type"))
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class MemoryItem(Base):
    """Единый семантический индекс всех важных записей (для поиска по памяти)."""

    __tablename__ = "memory_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    entity_type: Mapped[EntityType] = mapped_column(Enum(EntityType, name="entity_type"))
    entity_id: Mapped[int] = mapped_column(Integer)
    content: Mapped[str] = mapped_column(Text)
    embedding: Mapped[list[float] | None] = mapped_column(Vector(EMB_DIM))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("ix_memory_user_entity", "user_id", "entity_type", "entity_id"),
    )
