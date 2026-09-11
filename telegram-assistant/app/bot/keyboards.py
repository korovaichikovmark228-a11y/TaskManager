"""Inline-клавиатуры. Формат callback_data: 'action:arg1:arg2'."""
from __future__ import annotations

from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, ReplyKeyboardMarkup, KeyboardButton


def _kb(rows: list[list[InlineKeyboardButton]]) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=rows)


def ask_time(task_id: int) -> InlineKeyboardMarkup:
    return _kb([
        [
            InlineKeyboardButton(text="09:00", callback_data=f"time:{task_id}:09:00"),
            InlineKeyboardButton(text="10:00", callback_data=f"time:{task_id}:10:00"),
            InlineKeyboardButton(text="11:00", callback_data=f"time:{task_id}:11:00"),
        ],
        [InlineKeyboardButton(text="Другое время", callback_data=f"time_other:{task_id}")],
    ])


def reminder_created(reminder_id: int, recurring: bool = False) -> InlineKeyboardMarkup:
    row = [
        InlineKeyboardButton(text="✏️ Изменить", callback_data=f"rem_edit:{reminder_id}"),
        InlineKeyboardButton(text="🗑 Удалить", callback_data=f"rem_del:{reminder_id}"),
    ]
    rows = [row]
    if recurring:
        rows.append([InlineKeyboardButton(text="🔁 Повтор настроен", callback_data="noop")])
    return _kb(rows)


def reminder_fired(reminder_id: int) -> InlineKeyboardMarkup:
    return _kb([
        [InlineKeyboardButton(text="☑ Сделано", callback_data=f"r_done:{reminder_id}")],
        [
            InlineKeyboardButton(text="⏰ Через час", callback_data=f"r_hour:{reminder_id}"),
            InlineKeyboardButton(text="📅 Завтра", callback_data=f"r_tomorrow:{reminder_id}"),
        ],
        [InlineKeyboardButton(text="❌ Отменить", callback_data=f"r_cancel:{reminder_id}")],
    ])


def overdue(task_id: int) -> InlineKeyboardMarkup:
    return _kb([
        [InlineKeyboardButton(text="☑ Сделано", callback_data=f"t_done:{task_id}")],
        [
            InlineKeyboardButton(text="⏰ Перенести", callback_data=f"t_postpone:{task_id}"),
            InlineKeyboardButton(text="🗑 Удалить", callback_data=f"t_del:{task_id}"),
        ],
    ])


def postpone(task_id: int) -> InlineKeyboardMarkup:
    return _kb([
        [
            InlineKeyboardButton(text="Сегодня", callback_data=f"t_pp:{task_id}:today"),
            InlineKeyboardButton(text="Завтра", callback_data=f"t_pp:{task_id}:tomorrow"),
        ],
        [
            InlineKeyboardButton(text="Следующая неделя", callback_data=f"t_pp:{task_id}:week"),
            InlineKeyboardButton(text="Выбрать дату", callback_data=f"t_pp:{task_id}:pick"),
        ],
    ])


def goal_saved(goal_id: int) -> InlineKeyboardMarkup:
    return _kb([[
        InlineKeyboardButton(text="Да, напоминать", callback_data=f"goal_nudge:{goal_id}:yes"),
        InlineKeyboardButton(text="Нет", callback_data=f"goal_nudge:{goal_id}:no"),
    ]])


def offer_reminder_next_week(task_id: int) -> InlineKeyboardMarkup:
    return _kb([[
        InlineKeyboardButton(text="Пн 10:00", callback_data=f"time:{task_id}:mon10"),
        InlineKeyboardButton(text="Вт 10:00", callback_data=f"time:{task_id}:tue10"),
        InlineKeyboardButton(text="Выбрать время", callback_data=f"time_other:{task_id}"),
    ]])


def weekly_report() -> InlineKeyboardMarkup:
    return _kb([
        [InlineKeyboardButton(text="🎯 Выбрать фокус", callback_data="wk_focus")],
        [
            InlineKeyboardButton(text="📋 Задачи", callback_data="menu_tasks"),
            InlineKeyboardButton(text="💡 Идеи", callback_data="menu_ideas"),
        ],
        [InlineKeyboardButton(text="📊 Статистика", callback_data="menu_stats")],
    ])


def main_menu() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text="🎯 Цели"), KeyboardButton(text="📋 Задачи"), KeyboardButton(text="💡 Идеи")],
            [KeyboardButton(text="🧠 Память"), KeyboardButton(text="📊 Неделя"), KeyboardButton(text="⚙️ Настройки")],
        ],
        resize_keyboard=True,
        is_persistent=True,
    )
