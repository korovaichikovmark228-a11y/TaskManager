# Telegram AI Personal Assistant

Личный Telegram-бот — AI-секретарь и внешняя память. Пользователь пишет или
надиктовывает что угодно (мысль, задачу, идею, цель), а бот сам понимает смысл,
раскладывает по типам, при необходимости ставит напоминание и возвращает
информацию в нужный момент.

> Принцип: пользователь думает, **что** нужно сделать. Бот думает, **как** это
> сохранить и **когда** вернуть.

## Возможности (MVP)

- Текстовый и **голосовой** ввод (Telegram voice → speech-to-text → разбор).
- AI-классификация на **TASK / IDEA / GOAL / NOTE** + извлечение даты, времени,
  дедлайна, людей, проектов, приоритета, повторяемости.
- Естественный язык: «напомни через два часа проверить почту», «в понедельник
  написать Денису», «хочу выйти на 1 млн ₽/мес».
- Напоминания, в т.ч. **повторяющиеся** («каждый понедельник в 10…»).
- Бот **не выдумывает** время: если срок не назван — спрашивает; если размытый
  («когда-нибудь») — предлагает поставить на следующую неделю.
- Цели с дедлайном/статусом/прогрессом + периодические «возвраты» к цели.
- **Семантический поиск по памяти** (pgvector) с деградацией к keyword-поиску.
- Просроченные задачи (перенести / выполнить / удалить).
- **Еженедельный отчёт** и ежедневные **утренний/вечерний check-in**.
- Команды `/tasks /goals /ideas /today /week /search /settings` и главное меню.
- Часовые пояса (в БД всё в UTC), приоритеты, связь задач с целями.

## Архитектура

| Слой | Технология |
|------|------------|
| Backend / webhook | FastAPI |
| Telegram | aiogram 3 |
| БД | PostgreSQL + pgvector |
| Кэш / антидубли / состояние | Redis |
| Планировщик | APScheduler (AsyncIO), состояние — в БД |
| LLM | OpenAI-совместимый **или** Anthropic (переключается в `.env`) |
| Speech-to-text | Whisper (провайдер заменяем) |
| Деплой | Docker Compose |

AI разделён на модули (`app/ai/`): **intent** (намерение + сущности),
**embeddings** (память), **stt** (голос), **llm** (провайдер). Если ключей LLM нет,
работает детерминированный разбор на правилах (`app/utils/`), так что бот
остаётся работоспособным.

### Почему напоминания не теряются

Источник правды — таблица `reminders` в PostgreSQL. Планировщик раз в ~30 сек
лишь **сканирует** БД и рассылает наступившие напоминания, пересоздавая
повторяющиеся. Поэтому перезапуск процесса/сервера ничего не теряет: следующий
тик подхватит всё, что наступило. Двойную отправку при гонках предотвращает
Redis-lock (`reminder_lock`), дубли Telegram-update — `seen_update`.

## Быстрый старт (Docker)

```bash
cd telegram-assistant
cp .env.example .env
# впишите TELEGRAM_BOT_TOKEN и ключи LLM/STT/эмбеддингов
docker compose up -d --build
docker compose logs -f app
```

Compose поднимет `db` (образ `pgvector/pgvector:pg16`), `redis` и `app`.
Контейнер `app` при старте ждёт БД, применяет миграции (`alembic upgrade head`)
и запускает FastAPI + бота. Проверка живости: `GET /health`.

По умолчанию `BOT_MODE=polling` — бот работает сразу, без домена. Для продакшена
на VPS с доменом и HTTPS переключитесь на webhook:

```env
BOT_MODE=webhook
WEBHOOK_BASE_URL=https://your-domain.example
WEBHOOK_SECRET=длинная-случайная-строка
```

(Webhook-эндпоинт: `POST /telegram/webhook`, проверяется секретным заголовком.)

## Локальный запуск без Docker

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# поднимите PostgreSQL с pgvector и Redis, пропишите DATABASE_URL/REDIS_URL в .env
alembic upgrade head
uvicorn app.main:app --reload --port 8080
```

## Провайдеры AI

- **OpenAI**: `LLM_PROVIDER=openai`, `LLM_BASE_URL=https://api.openai.com/v1`.
- **OpenRouter**: тот же `openai`-провайдер, `LLM_BASE_URL=https://openrouter.ai/api/v1`.
- **Anthropic**: `LLM_PROVIDER=anthropic`, `LLM_BASE_URL=https://api.anthropic.com`.
- **Whisper** для голоса — любой OpenAI-совместимый `/audio/transcriptions`.

Все ключи — только в `.env` (в коде секретов нет; `.env` в `.gitignore`).

## Тесты

```bash
source .venv/bin/activate
pytest -q
```

Юнит-тесты покрывают разбор дат/времени, повторяемость (и расчёт следующего
срабатывания), классификацию намерений (fallback без сети) и схемы разбора.

## Структура

```
app/
  main.py            FastAPI + запуск бота (polling/webhook) + планировщик
  config.py          настройки из окружения
  db.py  models.py   БД (SQLAlchemy async) и модели
  schemas.py         структуры разбора
  ai/                llm, stt, embeddings, intent
  services/          users, tasks, goals, ideas, reminders, memory, reports, dedup, state, settings_nl
  bot/               instance, handlers (commands/messages/callbacks), keyboards, texts, pipeline
  scheduler/         scheduler (APScheduler) + jobs (тик: напоминания/просрочка/check-in/отчёт)
  utils/             timeparse, recurrence, tz
migrations/          Alembic
tests/               pytest
```

## Безопасность

- Идентификация — по Telegram ID; пользователь видит только свои данные (все
  выборки фильтруются по `user_id`).
- Секреты — через переменные окружения.
- Антиспам (rate-limit), защита от повторной обработки update и двойных
  напоминаний — через Redis (с безопасной деградацией, если Redis недоступен).

## Что дальше (не в MVP)

Архитектура готова к интеграциям (Google Calendar, Notion, Gmail, Slack, CRM,
web-интерфейс) — они намеренно не реализованы в MVP.
