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
        assert first.json()["total_chars"] == 10
        assert first.json()["status"] == "GREEN"

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
        assert second.json()["total_chars"] == len("hellohello-worldnext")

        short = client.post(
            "/sync",
            json={
                "conversation_id": "A",
                "messages": [{"key": "a1", "role": "assistant", "content": "x"}],
            },
        )
        assert short.json()["total_chars"] == second.json()["total_chars"]

    # Recreating app represents a fresh backend process using same database.
    with TestClient(create_app(db)) as restarted:
        restored = restarted.get("/conversations/A/status")
        assert restored.status_code == 200
        assert restored.json()["message_count"] == 3
        assert restored.json()["total_chars"] == len("hellohello-worldnext")


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
