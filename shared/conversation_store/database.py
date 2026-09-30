"""Shared SQLite connection and schema; intentionally independent of plugins."""

import os
import sqlite3
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DB_PATH = Path(
    os.environ.get("CONVERSATION_DB_PATH", PROJECT_ROOT / "data" / "conversations.db")
)


def get_connection(db_path: str | Path | None = None) -> sqlite3.Connection:
    path = Path(db_path) if db_path is not None else DB_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=15)
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 15000")
    return connection


def init_db(db_path: str | Path | None = None) -> None:
    connection = get_connection(db_path)
    try:
        # WAL helps concurrent reads while a sync transaction is writing.
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("""
            CREATE TABLE IF NOT EXISTS conversations (
                conversation_id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """)
        connection.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                conversation_id TEXT NOT NULL,
                message_key TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (conversation_id, message_key),
                FOREIGN KEY (conversation_id)
                    REFERENCES conversations(conversation_id)
                    ON DELETE CASCADE
            )
            """)
        connection.commit()
    finally:
        connection.close()
