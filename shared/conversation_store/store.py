"""Conversation-level operations; browser/UI and monitoring do not write SQL."""

from pathlib import Path
import json
import re
from shared.conversation_store.database import get_connection
from shared.conversation_store.database import get_read_connection
from shared.conversation_store.identity import is_temporary_conversation_id
from shared.conversation_store.message_order import save_order_evidence, order_messages
from shared.conversation_store.presentation import save_presentation, body_digest


def saved_assistant_count(messages: list[dict]) -> tuple[int | None, str, int]:
    """Only native-identity rows can prove unique saved answers.

    Old positional keys may contain duplicates; never clean or infer their aliases.
    """
    answers = [m for m in messages if m['role'] == 'assistant' and m['content'].strip()]
    native = re.compile(r'^chatgpt:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:assistant$')
    confirmed = sum(bool(native.fullmatch(m['key'])) for m in answers)
    if confirmed != len(answers):
        return None, 'legacy_identity_unverified', confirmed
    return len(answers), 'verified', confirmed


def ensure_conversation(connection, conversation_id: str, original_title: str | None = None) -> None:
    title = original_title.strip() if isinstance(original_title, str) else None
    if not title:
        title = None
    connection.execute(
        """
        INSERT INTO conversations (conversation_id, original_title)
        VALUES (?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET
            updated_at = CURRENT_TIMESTAMP,
            original_title = COALESCE(excluded.original_title, conversations.original_title)
        """,
        (conversation_id, title),
    )


def get_collection_snapshot(conversation_id: str, db_path=None) -> tuple[list[dict], dict | None]:
    """Read count inputs and the committed save event from the same snapshot."""
    connection = get_read_connection(db_path)
    try:
        connection.execute('BEGIN')
        messages = connection.execute(
            'SELECT message_key AS key, role, content FROM messages WHERE conversation_id=?',
            (conversation_id,),
        ).fetchall()
        event = connection.execute(
            'SELECT message_key, preview, revision FROM collector_save_state WHERE conversation_id=?',
            (conversation_id,),
        ).fetchone()
        valid_event = event and any(row['key'] == event['message_key'] and
                                    row['role'] == 'assistant' and row['content'].strip()
                                    for row in messages)
        return [dict(row) for row in messages], dict(event) if valid_event else None
    finally:
        connection.close()


def save_message(
    connection,
    conversation_id: str,
    message_key: str,
    role: str,
    content: str,
) -> None:
    changed = connection.execute(
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
    # rowcount is zero for a duplicate/shorter observation: not a save event.
    # The event rolls back with the original write if any later message fails.
    if changed.rowcount and role == 'assistant' and content.strip():
        text = ' '.join(content.split())
        preview = text[:16] + ('…' if len(text) > 16 else '')
        connection.execute("""
            INSERT INTO collector_save_state
                (conversation_id, message_key, preview, revision, saved_at)
            VALUES (?, ?, ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            ON CONFLICT(conversation_id) DO UPDATE SET
                message_key=excluded.message_key, preview=excluded.preview,
                revision=collector_save_state.revision+1, saved_at=excluded.saved_at
        """, (conversation_id, message_key, preview))


def save_observation(
    conversation_id: str,
    messages: list[dict],
    db_path: str | Path | None = None,
    observed_order: list[str] | None = None,
    original_title: str | None = None,
) -> None:
    """Atomically merge a partial observation; absence NEVER deletes history."""
    if is_temporary_conversation_id(conversation_id):
        raise ValueError("Wait for ChatGPT's canonical conversation ID before saving")
    connection = get_connection(db_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        ensure_conversation(connection, conversation_id, original_title)
        for message in messages:
            save_message(
                connection,
                conversation_id,
                message["key"],
                message["role"],
                message["content"],
            )
            save_presentation(connection, conversation_id, message)
        save_order_evidence(connection, conversation_id, messages, observed_order)
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
    """Read stored metadata and verbatim excerpts without inferring missing titles."""
    connection = get_read_connection(db_path)
    try:
        title_column = ('c.original_title' if 'original_title' in
                        {row[1] for row in connection.execute('PRAGMA table_info(conversations)')}
                        else 'NULL')
        rows = connection.execute(f"""
            SELECT c.conversation_id, {title_column} AS original_title, c.created_at, c.updated_at,
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
        title_column = ('original_title' if 'original_title' in
                        {row[1] for row in connection.execute('PRAGMA table_info(conversations)')}
                        else 'NULL')
        conversation = connection.execute(
            f"SELECT conversation_id, {title_column} AS original_title, created_at, updated_at FROM conversations WHERE conversation_id = ?",
            (conversation_id,),
        ).fetchone()
        if conversation is None:
            return None
        messages = connection.execute("""
            SELECT message_key AS key, role, content, first_seen_at, updated_at
            FROM messages WHERE conversation_id = ?
        """, (conversation_id,)).fetchall()
        # Atlas also supports older stores without migrating them on read.
        table = connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_order_evidence'").fetchone()
        evidence = connection.execute('SELECT evidence FROM conversation_order_evidence WHERE conversation_id=?', (conversation_id,)).fetchone() if table else None
        available = connection.execute("SELECT 1 FROM sqlite_master WHERE name='message_presentations'").fetchone()
        presentations = {row['message_key']: dict(row) for row in connection.execute('SELECT * FROM message_presentations WHERE conversation_id=?', (conversation_id,))} if available else {}
        material = []
        for row in messages:
            item = dict(row)
            saved = presentations.get(item['key'])
            matches = saved and saved['body_digest'] == body_digest(item['content'])
            item.update(presentation=json.loads(saved['payload_json']) if matches else None,
                        observed_presentation=json.loads(saved['payload_json']) if saved and not matches else None,
                        presentation_status='captured_dom' if matches else 'source_mismatch' if saved else 'text_only',
                        presentation_captured_at=saved['captured_at'] if saved else None)
            material.append(item)
        ordered, ordering = order_messages(material, json.loads(evidence[0]) if evidence else None)
        return {**dict(conversation), "messages": ordered, "ordering": ordering}
    finally:
        connection.close()
