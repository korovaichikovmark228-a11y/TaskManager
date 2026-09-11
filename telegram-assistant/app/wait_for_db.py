"""Ожидание готовности PostgreSQL перед миграциями (для docker-compose)."""
from __future__ import annotations

import sys
import time

import psycopg

from app.config import get_settings


def main() -> int:
    s = get_settings()
    # psycopg понимает URL без '+psycopg'
    dsn = s.sync_database_url.replace("+psycopg", "")
    for attempt in range(1, 61):
        try:
            with psycopg.connect(dsn, connect_timeout=3) as conn:
                conn.execute("SELECT 1")
            print("DB готова")
            return 0
        except Exception as e:  # noqa: BLE001
            print(f"Ожидаю БД ({attempt}/60): {e}")
            time.sleep(2)
    print("Не дождался БД", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
