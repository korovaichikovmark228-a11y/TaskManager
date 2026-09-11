from app.schemas import ParseResult


def test_multi_item_parse():
    data = {
        "intent": "create",
        "items": [
            {"type": "task", "title": "Связаться с Олегом насчёт инвестиций",
             "needs_reminder": True, "date": "2026-09-15"},
            {"type": "idea", "title": "Как увеличить аудиторию МЭТЧ"},
        ],
    }
    res = ParseResult.from_dict(data, raw_text="...")
    assert res.intent == "create"
    assert len(res.items) == 2
    assert res.items[0].type == "task"
    assert res.items[0].needs_reminder is True
    assert res.items[1].type == "idea"


def test_empty_titles_filtered():
    data = {"intent": "create", "items": [{"type": "task", "title": ""}]}
    res = ParseResult.from_dict(data)
    assert res.items == []


def test_bad_type_becomes_note():
    data = {"intent": "create", "items": [{"type": "banana", "title": "что-то"}]}
    res = ParseResult.from_dict(data)
    assert res.items[0].type == "note"
