import hashlib
import sqlite3
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from plugins.conversation_atlas.backend.main import create_app
from shared.conversation_store.database import get_connection, get_read_connection, init_db
from shared.conversation_store.store import save_observation


def seed(path):
    init_db(path)
    save_observation("stored-A", [
        {"key": "fallback-turn-5:0:user", "role": "user", "content": "原文标题\n第二行 <script>alert(1)</script>"},
        {"key": "fallback-turn-5:1:assistant", "role": "assistant", "content": ""},
        {"key": "stable-user", "role": "user", "content": "另一个消息"},
    ], path)


def test_real_graph_and_exact_raw_message_identity(tmp_path):
    path = tmp_path / "store.db"
    seed(path)
    with TestClient(create_app(path)) as client:
        response = client.get("/api/atlas")
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        graph = response.json()
        assert graph["provenance"]["mode"] == "real"
        assert graph["segments"] == []
        assert len(graph["categories"]) == len(graph["conversations"]) == 1
        node = graph["conversations"][0]
        assert node["id"] == "stored-A"
        assert node["categoryId"] == graph["categories"][0]["id"]
        assert node["segmentStatus"] == "unprocessed"
        assert node["keywords"] == node["outcomes"] == []
        assert node["titleSource"] == "stored_message_excerpt"
        assert node["summarySource"] == "verbatim_excerpt"
        assert "原文标题" in node["summary"]
        assert node["quality"]["emptyMessageCount"] == 1
        assert node["quality"]["fallbackKeyCount"] == 2
        assert graph["quality"]["messageCount"] == 3
        raw = client.get("/api/atlas/conversations/stored-A").json()
        with get_read_connection(path) as connection:
            rows = connection.execute("SELECT message_key, role, content FROM messages WHERE conversation_id='stored-A' ORDER BY first_seen_at,rowid").fetchall()
        assert [(m["key"], m["role"], m["content"]) for m in raw["messages"]] == [tuple(row) for row in rows]
        assert raw["messages"][1]["content"] == "", "empty source records must never disappear or be synthesized"
        assert raw["quality"]["ordering"] == "first_observed_not_original"
        assert raw["conversationId"] == node["id"]


def test_restart_persists_graph_and_raw_messages_without_writes(tmp_path):
    path = tmp_path / "store.db"
    seed(path)
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    with TestClient(create_app(path)) as first:
        graph = first.get("/api/atlas").json()
        raw = first.get("/api/atlas/conversations/stored-A").json()
    with TestClient(create_app(path)) as restarted:
        assert restarted.get("/api/atlas").json() == graph
        assert restarted.get("/api/atlas/conversations/stored-A").json() == raw
        assert restarted.post("/api/atlas", json={"delete": True}).status_code == 405
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before


def test_empty_existing_store_is_real_empty_not_demo(tmp_path):
    path = tmp_path / "empty.db"
    init_db(path)
    with TestClient(create_app(path)) as client:
        graph = client.get("/api/atlas").json()
        assert graph["provenance"]["mode"] == "real"
        assert graph["categories"] == graph["conversations"] == graph["segments"] == []
        assert graph["quality"]["messageCount"] == 0
        assert client.get("/api/atlas/conversations/missing").status_code == 404


@pytest.mark.parametrize("kind", ["missing", "no-schema", "corrupt"])
def test_store_failures_return_503_without_creating_or_migrating(tmp_path, kind):
    path = tmp_path / "unavailable.db"
    if kind == "no-schema":
        sqlite3.connect(path).close()
    elif kind == "corrupt":
        path.write_text("this is not SQLite", encoding="utf-8")
    before = path.read_bytes() if path.exists() else None
    with TestClient(create_app(path)) as client:
        response = client.get("/api/atlas")
        assert response.status_code == 503
        assert "detail" in response.json()
    assert (path.read_bytes() if path.exists() else None) == before


def test_missing_title_dates_and_zero_messages_are_not_fabricated(tmp_path):
    path = tmp_path / "metadata.db"
    init_db(path)
    with get_connection(path) as connection:
        connection.execute("INSERT INTO conversations VALUES ('test-empty', '', 'not-a-date')")
    with TestClient(create_app(path)) as client:
        node = client.get("/api/atlas").json()["conversations"][0]
        assert node["title"].startswith("未命名")
        assert node["createdAt"] is None and node["updatedAt"] is None
        assert node["messageCount"] == node["segmentCount"] == 0
        assert node["quality"]["suspectedTestRecord"] is True
        assert client.get("/api/atlas/conversations/test-empty").json()["messages"] == []


def test_read_connection_cannot_write_and_original_store_writer_still_works(tmp_path):
    path = tmp_path / "store.db"
    seed(path)
    connection = get_read_connection(path)
    try:
        with pytest.raises(sqlite3.OperationalError):
            connection.execute("DELETE FROM messages")
    finally:
        connection.close()
    save_observation("stored-A", [{"key": "stable-user", "role": "user", "content": "另一个消息的完整版本"}], path)
    with TestClient(create_app(path)) as client:
        raw = client.get("/api/atlas/conversations/stored-A").json()
        assert raw["messages"][-1]["content"] == "另一个消息的完整版本"


def test_static_frontend_served_without_monitor_and_unknown_ids_isolated(tmp_path):
    path = tmp_path / "store.db"
    seed(path)
    with TestClient(create_app(path)) as client:
        assert client.get("/").status_code == 200
        assert "Conversation Atlas" in client.get("/").text
        assert client.get("/app.mjs").status_code == 200
        assert client.get("/api/atlas/conversations/stored-B").status_code == 404
        assert client.get("/conversations/stored-A/status").status_code == 404


def test_ids_with_url_characters_still_resolve_exact_store_record(tmp_path):
    path = tmp_path / "store.db"
    init_db(path)
    cid = "odd / ?#编号"
    save_observation(cid, [{"key": "key", "role": "user", "content": "exact"}], path)
    with TestClient(create_app(path)) as client:
        raw = client.get("/api/atlas/conversations/" + quote(cid, safe="")).json()
        assert raw["conversationId"] == cid
        assert raw["messages"][0]["content"] == "exact"
