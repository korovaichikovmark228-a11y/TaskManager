"""Структуры данных, которыми обмениваются AI-слой и остальное приложение."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

ItemType = Literal["task", "idea", "goal", "note"]
IntentType = Literal["create", "query", "update", "delete", "smalltalk"]


@dataclass
class ParsedItem:
    type: ItemType = "note"
    title: str = ""
    description: str | None = None
    date: str | None = None          # YYYY-MM-DD (локальная дата пользователя)
    time: str | None = None          # HH:MM
    deadline: str | None = None      # YYYY-MM-DD (для целей)
    priority: str | None = None      # high|medium|low
    recurrence: dict | None = None   # правило повтора (см. utils.recurrence)
    people: list[str] = field(default_factory=list)
    projects: list[str] = field(default_factory=list)
    needs_reminder: bool = False     # пользователь просил напомнить
    vague: bool = False              # время/дата неопределённы — надо уточнить

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "ParsedItem":
        allowed = {"task", "idea", "goal", "note"}
        t = str(d.get("type", "note")).lower()
        rec = d.get("recurrence")
        if isinstance(rec, str):
            rec = None
        return cls(
            type=t if t in allowed else "note",
            title=(d.get("title") or "").strip(),
            description=(d.get("description") or None),
            date=d.get("date") or None,
            time=d.get("time") or None,
            deadline=d.get("deadline") or None,
            priority=(d.get("priority") or None),
            recurrence=rec if isinstance(rec, dict) else None,
            people=list(d.get("people") or []),
            projects=list(d.get("projects") or []),
            needs_reminder=bool(d.get("needs_reminder", False)),
            vague=bool(d.get("vague", False)),
        )


@dataclass
class ParseResult:
    intent: IntentType = "create"
    items: list[ParsedItem] = field(default_factory=list)
    query: str = ""                  # для intent=query
    target_ref: str = ""             # для update/delete — что имел в виду пользователь
    raw_text: str = ""               # исходный текст (или транскрипт)

    @classmethod
    def from_dict(cls, d: dict[str, Any], raw_text: str = "") -> "ParseResult":
        intent = str(d.get("intent", "create")).lower()
        if intent not in ("create", "query", "update", "delete", "smalltalk"):
            intent = "create"
        items = [ParsedItem.from_dict(x) for x in (d.get("items") or []) if x]
        items = [x for x in items if x.title]
        return cls(
            intent=intent,
            items=items,
            query=(d.get("query") or "").strip(),
            target_ref=(d.get("target_ref") or "").strip(),
            raw_text=raw_text,
        )
