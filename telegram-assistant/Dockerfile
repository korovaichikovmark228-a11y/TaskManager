FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Системные зависимости для psycopg/asyncpg сборки не нужны (используем binary-колёса).
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Ждём БД, применяем миграции, запускаем API+бота.
CMD ["sh", "-c", "python -m app.wait_for_db && alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8080"]
