import sqlite3
from concurrent.futures import ThreadPoolExecutor
import pytest

from shared.conversation_store.database import get_connection, init_db
from shared.conversation_store.store import (
    conversation_exists,
    get_messages,
    save_observation,
)


def test_schema_repeatable_and_foreign_key_enforced(tmp_path):
    db = tmp_path / "subdir" / "test.db"
    init_db(db)
    init_db(db)
    connection = get_connection(db)
    try:
        tables = {
            item[0]
            for item in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        assert {"conversations", "messages"} <= tables
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "INSERT INTO messages (conversation_id, message_key, role, content) "
                "VALUES (?, ?, ?, ?)",
                ("missing", "m1", "user", "hello"),
            )
    finally:
        connection.rollback()
        connection.close()


def test_partial_snapshot_merge_idempotence_and_restart(tmp_path):
    db = tmp_path / "test.db"
    init_db(db)
    first = [
        {"key": "u1", "role": "user", "content": "first"},
        {"key": "a1", "role": "assistant", "content": "short"},
    ]
    save_observation("A", first, db)
    save_observation("A", first, db)  # duplicate sync is harmless
    assert len(get_messages("A", db)) == 2

    save_observation(
        "A",
        [
            {"key": "a1", "role": "assistant", "content": "a longer answer"},
            {"key": "u2", "role": "user", "content": "next"},
        ],
        db,
    )
    assert len(get_messages("A", db)) == 3
    save_observation(
        "A",
        [
            {"key": "a1", "role": "assistant", "content": "x"},
        ],
        db,
    )
    assert get_messages("A", db)[1]["content"] == "a longer answer"

    # Simulate process restart: new DB connection / reinitialization.
    init_db(db)
    assert len(get_messages("A", db)) == 3


def test_different_conversations_can_reuse_message_keys(tmp_path):
    db = tmp_path / "test.db"
    init_db(db)
    save_observation(
        "A",
        [{"key": "fallback-turn-0:0:user", "role": "user", "content": "A data"}],
        db,
    )
    save_observation(
        "B",
        [{"key": "fallback-turn-0:0:user", "role": "user", "content": "B data"}],
        db,
    )
    assert get_messages("A", db)[0]["content"] == "A data"
    assert get_messages("B", db)[0]["content"] == "B data"


def test_empty_snapshot_does_not_delete_history(tmp_path):
    db = tmp_path / "test.db"
    init_db(db)
    save_observation("A", [{"key": "one", "role": "user", "content": "remember"}], db)
    save_observation("A", [], db)
    assert conversation_exists("A", db)
    assert len(get_messages("A", db)) == 1


def test_transaction_rolls_back_partial_batch_on_error(tmp_path):
    db = tmp_path / "test.db"
    init_db(db)
    with pytest.raises(KeyError):
        save_observation(
            "A",
            [
                {"key": "ok", "role": "user", "content": "first"},
                {"key": "bad", "role": "assistant"},  # missing content
            ],
            db,
        )
    assert not conversation_exists("A", db)
    assert get_messages("A", db) == []


def test_sql_parameterization_handles_punctuation(tmp_path):
    db = tmp_path / "test.db"
    init_db(db)
    unusual_id = "A'); DROP TABLE messages; --"
    save_observation(unusual_id, [{"key": "x", "role": "user", "content": "value"}], db)
    assert len(get_messages(unusual_id, db)) == 1
    assert get_messages("unrelated", db) == []


def test_concurrent_syncs_do_not_lose_distinct_messages(tmp_path):
    db = tmp_path / "test.db"
    init_db(db)

    def save_one(i):
        save_observation(
            "A", [{"key": f"key{i}", "role": "user", "content": f"text{i}"}], db
        )

    with ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(save_one, range(12)))
    assert len(get_messages("A", db)) == 12


def test_existing_same_schema_db_remains_compatible(tmp_path):
    """Simulates the user's earlier classroom DB that already has data."""
    db = tmp_path / "prior.db"
    connection = sqlite3.connect(db)
    try:
        connection.execute("""CREATE TABLE conversations (
            conversation_id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)""")
        connection.execute("""CREATE TABLE messages (
            conversation_id TEXT NOT NULL,
            message_key TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (conversation_id, message_key),
            FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id)
            ON DELETE CASCADE)""")
        connection.execute(
            "INSERT INTO conversations (conversation_id) VALUES (?)", ("prior-A",)
        )
        connection.execute(
            "INSERT INTO messages (conversation_id,message_key,role,content) "
            "VALUES (?,?,?,?)",
            ("prior-A", "older", "user", "earlier saved text"),
        )
        connection.commit()
    finally:
        connection.close()
    init_db(db)
    save_observation(
        "prior-A", [{"key": "new", "role": "assistant", "content": "added"}], db
    )
    result = get_messages("prior-A", db)
    assert len(result) == 2
    assert result[0]["content"] == "earlier saved text"
