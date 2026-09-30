"""Conversation-level operations; browser/UI and monitoring do not write SQL."""

from pathlib import Path
from shared.conversation_store.database import get_connection


def ensure_conversation(connection, conversation_id: str) -> None:
    connection.execute(
        """
        INSERT INTO conversations (conversation_id)
        VALUES (?)
        ON CONFLICT(conversation_id) DO UPDATE SET
            updated_at = CURRENT_TIMESTAMP
        """,
        (conversation_id,),
    )


def save_message(
    connection,
    conversation_id: str,
    message_key: str,
    role: str,
    content: str,
) -> None:
    connection.execute(
        """
        INSERT INTO messages (conversation_id, message_key, role, content)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(conversation_id, message_key) DO UPDATE SET
            role = excluded.role,
            content = excluded.content,
            updated_at = CURRENT_TIMESTAMP
        WHERE length(excluded.content) > length(messages.content)
        """,
        (conversation_id, message_key, role, content),
    )


def save_observation(
    conversation_id: str,
    messages: list[dict],
    db_path: str | Path | None = None,
) -> None:
    """Atomically merge a partial observation; absence NEVER deletes history."""
    connection = get_connection(db_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        ensure_conversation(connection, conversation_id)
        for message in messages:
            save_message(
                connection,
                conversation_id,
                message["key"],
                message["role"],
                message["content"],
            )
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def conversation_exists(
    conversation_id: str, db_path: str | Path | None = None
) -> bool:
    connection = get_connection(db_path)
    try:
        row = connection.execute(
            "SELECT 1 FROM conversations WHERE conversation_id = ?",
            (conversation_id,),
        ).fetchone()
        return row is not None
    finally:
        connection.close()


def get_messages(conversation_id: str, db_path: str | Path | None = None) -> list[dict]:
    """Return known messages in first-seen order, not guaranteed original chronology.

    ChatGPT may virtualize old turns and the reader may discover them later.
    Monitor V1 is count/keyphrase-based; no chronological inference is made.
    """
    connection = get_connection(db_path)
    try:
        rows = connection.execute(
            """
            SELECT message_key, role, content
            FROM messages
            WHERE conversation_id = ?
            ORDER BY first_seen_at ASC, rowid ASC
            """,
            (conversation_id,),
        ).fetchall()
        return [{"key": row[0], "role": row[1], "content": row[2]} for row in rows]
    finally:
        connection.close()
