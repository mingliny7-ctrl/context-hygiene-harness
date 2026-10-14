"""Conversation-level operations; browser/UI and monitoring do not write SQL."""

from pathlib import Path
from shared.conversation_store.database import get_connection
from shared.conversation_store.database import get_read_connection


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


def list_stored_conversations(db_path: str | Path | None = None) -> list[dict]:
    """Read stored metadata and a verbatim excerpt in a single SQLite snapshot.

    The Store has no title, original chronology or collection-complete field.
    This does not infer any of them or modify existing records.
    """
    connection = get_read_connection(db_path)
    try:
        rows = connection.execute("""
            SELECT c.conversation_id, c.created_at, c.updated_at,
                   COUNT(m.message_key) AS message_count,
                   COALESCE(SUM(LENGTH(m.content)), 0) AS total_chars,
                   COALESCE(SUM(CASE WHEN TRIM(m.content) = '' THEN 1 ELSE 0 END), 0)
                       AS empty_message_count,
                   COALESCE(SUM(CASE WHEN m.message_key LIKE 'fallback-turn-%'
                       THEN 1 ELSE 0 END), 0) AS fallback_key_count,
                   (SELECT p.message_key FROM messages p
                    WHERE p.conversation_id = c.conversation_id AND TRIM(p.content) != ''
                    ORDER BY CASE WHEN p.role = 'user' THEN 0 ELSE 1 END,
                        p.first_seen_at, p.rowid LIMIT 1) AS preview_key,
                   (SELECT p.content FROM messages p
                    WHERE p.conversation_id = c.conversation_id AND TRIM(p.content) != ''
                    ORDER BY CASE WHEN p.role = 'user' THEN 0 ELSE 1 END,
                        p.first_seen_at, p.rowid LIMIT 1) AS preview_content
            FROM conversations c LEFT JOIN messages m USING (conversation_id)
            GROUP BY c.conversation_id
            ORDER BY c.created_at, c.conversation_id
        """).fetchall()
        return [dict(row) for row in rows]
    finally:
        connection.close()


def read_stored_conversation(conversation_id: str, db_path: str | Path | None = None) -> dict | None:
    """Read exact stored messages in first-observed order with stable composite keys."""
    connection = get_read_connection(db_path)
    try:
        connection.execute("BEGIN")
        conversation = connection.execute(
            "SELECT conversation_id, created_at, updated_at FROM conversations WHERE conversation_id = ?",
            (conversation_id,),
        ).fetchone()
        if conversation is None:
            return None
        messages = connection.execute("""
            SELECT message_key AS key, role, content, first_seen_at, updated_at
            FROM messages WHERE conversation_id = ? ORDER BY first_seen_at, rowid
        """, (conversation_id,)).fetchall()
        return {**dict(conversation), "messages": [dict(row) for row in messages]}
    finally:
        connection.close()
