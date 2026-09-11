"""Intent Parser + Entity Extractor.

Отдаёт ParseResult: намерение пользователя + список структурированных записей.
Если LLM не настроен — работает детерминированный fallback на правилах.
"""
from __future__ import annotations

import logging
from datetime import datetime

from app.ai.llm import extract_json, get_llm
from app.schemas import ParsedItem, ParseResult
from app.utils import recurrence as rec
from app.utils.timeparse import parse_when
from app.utils.tz import WEEKDAYS_RU

log = logging.getLogger(__name__)

SYSTEM = """Ты — модуль разбора сообщений личного AI-ассистента. Пользователь пишет \
или диктует мысли, задачи, идеи и цели на русском. Твоя задача — понять смысл и вернуть \
СТРОГО JSON-объект (без пояснений) по схеме:

{
  "intent": "create" | "query" | "update" | "delete" | "smalltalk",
  "items": [
    {
      "type": "task" | "idea" | "goal" | "note",
      "title": "краткая суть",
      "description": "детали или null",
      "date": "YYYY-MM-DD или null",
      "time": "HH:MM или null",
      "deadline": "YYYY-MM-DD или null (для цели)",
      "priority": "high" | "medium" | "low" | null,
      "recurrence": {"freq":"daily|weekly|monthly","interval":1,"byweekday":[0],"time":"HH:MM"} | null,
      "people": ["имена"],
      "projects": ["проекты/компании"],
      "needs_reminder": true | false,
      "vague": true | false
    }
  ],
  "query": "текст поискового запроса (если intent=query)",
  "target_ref": "на что ссылается update/delete"
}

ПРАВИЛА:
- Классифицируй: TASK — конкретное действие; IDEA — мысль/потенциальный проект; \
GOAL — желаемый результат («хочу…», «моя цель…»); NOTE — просто важная мысль.
- Одно сообщение может содержать НЕСКОЛЬКО записей — верни их все в items.
- НЕ ВЫДУМЫВАЙ дату и время. Если пользователь просит напомнить, но не назвал время — \
ставь needs_reminder=true и time=null. Если срок размытый («когда-нибудь», «на днях») — vague=true.
- Если пользователь просит напомнить о задаче — needs_reminder=true.
- Относительные даты («завтра», «через 2 часа», «в понедельник») переводи в конкретные \
date/time относительно текущего момента, который дан ниже.
- priority=high для «срочно/важно/обязательно».
- Если это вопрос к своей памяти («что я записывал про…», «какие у меня цели», \
«что я откладываю») — intent=query и заполни query.
- Отвечай ТОЛЬКО JSON."""


def _build_user_prompt(text: str, now_local: datetime, tz_name: str) -> str:
    dow = WEEKDAYS_RU[now_local.weekday()]
    return (
        f"Текущий момент пользователя: {now_local.strftime('%Y-%m-%d %H:%M')} ({dow}), "
        f"часовой пояс {tz_name}.\n\nСообщение пользователя:\n\"\"\"\n{text}\n\"\"\""
    )


async def parse(text: str, now_local: datetime, tz_name: str) -> ParseResult:
    text = (text or "").strip()
    if not text:
        return ParseResult(intent="smalltalk", raw_text=text)

    llm = get_llm()
    if llm is not None:
        try:
            raw = await llm.chat(SYSTEM, _build_user_prompt(text, now_local, tz_name), json_mode=True)
            data = extract_json(raw)
            if data:
                result = ParseResult.from_dict(data, raw_text=text)
                if result.intent == "create" and not result.items:
                    result.items = _fallback_items(text, now_local, tz_name)
                return result
        except Exception as e:  # noqa: BLE001
            log.exception("LLM parse failed, fallback to rules: %s", e)

    return _fallback_parse(text, now_local, tz_name)


# ---------------- Fallback на правилах (без сети) ----------------

_QUERY_MARKERS = (
    "что я", "какие у меня", "какие я", "покажи", "найди", "что записыв",
    "что хотел", "что я откладыв", "какие задачи", "какие идеи", "мои цели",
)


def _fallback_parse(text: str, now_local: datetime, tz_name: str) -> ParseResult:
    low = text.lower()
    if any(m in low for m in _QUERY_MARKERS) or low.endswith("?"):
        return ParseResult(intent="query", query=text, raw_text=text)
    return ParseResult(intent="create", items=_fallback_items(text, now_local, tz_name), raw_text=text)


import re as _re

_LEADING = _re.compile(r"^(напомни(\s+мне)?|надо|нужно|мне\s+надо)[\s,:-]+", _re.IGNORECASE)


def _clean_title(text: str) -> str:
    return _LEADING.sub("", text.strip()).strip() or text.strip()


def _fallback_items(text: str, now_local: datetime, tz_name: str) -> list[ParsedItem]:
    low = text.lower()
    item = ParsedItem(title=_clean_title(text))

    if low.startswith("идея") or "идея:" in low or "запиши идею" in low:
        item.type = "idea"
        item.title = text.split(":", 1)[-1].strip() if ":" in text else text
    elif "хочу" in low or "моя цель" in low or "цель" in low.split()[:2]:
        item.type = "goal"
    elif any(w in low for w in ("напомни", "надо", "нужно", "позвонить", "отправить", "сделать", "проверить", "написать")):
        item.type = "task"
    else:
        item.type = "note"

    recurr = rec.parse_recurrence(text)
    if recurr:
        item.recurrence = recurr
        item.needs_reminder = True
        item.type = "task"

    if item.type in ("task", "goal"):
        pw = parse_when(text, now_local, tz_name)
        if pw.vague:
            item.vague = True
        elif pw.dt_utc:
            local = pw.dt_utc.astimezone(now_local.tzinfo)
            if item.type == "goal":
                item.deadline = local.strftime("%Y-%m-%d")
            else:
                item.date = local.strftime("%Y-%m-%d")
                item.time = local.strftime("%H:%M") if pw.has_time else None
        if "напомни" in low or item.date:
            item.needs_reminder = True

    if any(w in low for w in ("срочно", "важно", "обязательно")):
        item.priority = "high"

    return [item]
