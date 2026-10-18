"""Shared SQLite connection and schema; intentionally independent of plugins."""

import os
import sqlite3
import uuid
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


def get_read_connection(db_path: str | Path | None = None) -> sqlite3.Connection:
    """Read an existing Store without creating files, tables or changing journal mode."""
    path = Path(db_path) if db_path is not None else DB_PATH
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=15)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only = ON")
    connection.execute("PRAGMA busy_timeout = 15000")
    return connection


def init_db(db_path: str | Path | None = None) -> None:
    connection = get_connection(db_path)
    try:
        existing = connection.execute("SELECT 1 FROM sqlite_master WHERE name='messages'").fetchone()
        columns = {row[1] for row in connection.execute('PRAGMA table_info(conversations)')}
        if (existing and ('original_title' not in columns or
                not connection.execute("SELECT 1 FROM sqlite_master WHERE name='message_presentations'").fetchone())):
            path = Path(db_path) if db_path is not None else DB_PATH
            backup = path.with_name(path.stem + '.reading-backup-' + uuid.uuid4().hex + '.db')
            with sqlite3.connect(backup) as destination:
                connection.backup(destination)
        # WAL helps concurrent reads while a sync transaction is writing.
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("""
            CREATE TABLE IF NOT EXISTS conversations (
                conversation_id TEXT PRIMARY KEY,
                original_title TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """)
        if 'original_title' not in {row[1] for row in connection.execute('PRAGMA table_info(conversations)')}:
            connection.execute('ALTER TABLE conversations ADD COLUMN original_title TEXT')
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
        # Additive migration: no backfill, original messages remain untouched.
        connection.execute("""
            CREATE TABLE IF NOT EXISTS collector_save_state (
                conversation_id TEXT PRIMARY KEY,
                message_key TEXT NOT NULL,
                preview TEXT NOT NULL,
                revision INTEGER NOT NULL,
                saved_at TEXT NOT NULL,
                FOREIGN KEY (conversation_id, message_key)
                    REFERENCES messages(conversation_id, message_key) ON DELETE CASCADE
            )
        """)
        connection.execute('''CREATE TABLE IF NOT EXISTS conversation_order_evidence (
            conversation_id TEXT PRIMARY KEY REFERENCES conversations(conversation_id) ON DELETE CASCADE,
            evidence TEXT NOT NULL
        )''')
        connection.execute('''CREATE TABLE IF NOT EXISTS message_presentations (
            conversation_id TEXT NOT NULL, message_key TEXT NOT NULL,
            body_digest TEXT NOT NULL, payload_json TEXT NOT NULL, captured_at TEXT NOT NULL,
            PRIMARY KEY(conversation_id,message_key),
            FOREIGN KEY(conversation_id,message_key) REFERENCES messages(conversation_id,message_key) ON DELETE CASCADE)''')
        connection.commit()
    finally:
        connection.close()
