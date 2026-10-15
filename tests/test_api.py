from fastapi.testclient import TestClient
from app.main import create_app
from app.context_monitor import ContextMonitor
from app.schemas import Message


def test_sync_and_restore_status_from_db(tmp_path):
    db = tmp_path / "api.db"
    with TestClient(create_app(db)) as client:
        assert client.get("/health").json() == {"status": "ok"}
        missing = client.get("/conversations/A/status")
        assert missing.status_code == 404

        first = client.post(
            "/sync",
            json={
                "conversation_id": "A",
                "messages": [
                    {"key": "u1", "role": "user", "content": "hello"},
                    {"key": "a1", "role": "assistant", "content": "world"},
                ],
            },
        )
        assert first.status_code == 200, first.text
        assert first.json()["message_count"] == 2
        assert first.json()["assistant_reply_count"] is None
        assert first.json()["count_status"] == 'legacy_identity_unverified'
        assert 'total_chars' not in first.json()
        assert first.json()["status"] == "SAVED"
        assert first.json()["reasons"] == []
        assert first.json()["should_handoff"] is False

        second = client.post(
            "/sync",
            json={
                "conversation_id": "A",
                "messages": [
                    {"key": "a1", "role": "assistant", "content": "hello-world"},
                    {"key": "u2", "role": "user", "content": "next"},
                ],
            },
        )
        assert second.json()["message_count"] == 3
        assert second.json()["assistant_reply_count"] is None

        short = client.post(
            "/sync",
            json={
                "conversation_id": "A",
                "messages": [{"key": "a1", "role": "assistant", "content": "x"}],
            },
        )
        assert short.json()["message_count"] == second.json()["message_count"]

    # Recreating app represents a fresh backend process using same database.
    with TestClient(create_app(db)) as restarted:
        restored = restarted.get("/conversations/A/status")
        assert restored.status_code == 200
        assert restored.json()["message_count"] == 3
        assert restored.json()["assistant_reply_count"] is None


def test_validation_and_conversation_isolation(tmp_path):
    with TestClient(create_app(tmp_path / "api.db")) as client:
        invalid = client.post(
            "/sync",
            json={
                "conversation_id": "A",
                "messages": [{"key": "u1", "role": "robot", "content": "x"}],
            },
        )
        assert invalid.status_code == 422
        assert client.get("/conversations/A/status").status_code == 404
        client.post(
            "/sync",
            json={
                "conversation_id": "B",
                "messages": [{"key": "u1", "role": "user", "content": "B"}],
            },
        )
        assert client.get("/conversations/A/status").status_code == 404
        assert client.get("/conversations/B/status").json()["message_count"] == 1


def test_rule_baseline_distinguishes_length_and_two_risks():
    monitor = ContextMonitor()
    just_long = [Message(role="assistant", content="x") for _ in range(81)]
    assert monitor.analyze(just_long).status == "YELLOW"
    corrections = [
        Message(role="user", content="我说过了，不是这个意思") for _ in range(3)
    ]
    deprecated = [Message(role="user", content="这个方案作废") for _ in range(3)]
    assert monitor.analyze(corrections + deprecated).status == "RED"


def test_collection_never_initializes_or_calls_monitor(tmp_path, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Risk Monitor must not execute")
    monkeypatch.setattr(ContextMonitor, "__init__", forbidden)
    monkeypatch.setattr(ContextMonitor, "analyze", forbidden)
    with TestClient(create_app(tmp_path / "no-monitor.db")) as client:
        assert client.get('/health').status_code == 200
        payload = {'conversation_id': 'collector-only', 'messages': [
            {'key': 'u', 'role': 'user', 'content': '我说过了，这个方案作废'},
        ]}
        for _ in range(3):
            response = client.post('/sync', json=payload)
            assert response.status_code == 200
            assert response.json()['status'] == 'SAVED'
            assert response.json()['message_count'] == 1
        assert client.get('/conversations/collector-only/status').json()['status'] == 'SAVED'
        assert client.post('/analyze', json={'messages': []}).status_code == 410
