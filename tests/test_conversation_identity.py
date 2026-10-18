"""Module 1: real Reader/Worker code, HTTP backend processes and isolated SQLite."""

import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from contextlib import contextmanager

import httpx
from fastapi.testclient import TestClient
import pytest

from app.main import create_app
from plugins.conversation_atlas.backend.main import create_app as atlas_app
from shared.conversation_store.database import get_read_connection, init_db
from shared.conversation_store.store import get_messages, save_observation


ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize('temporary', ['local-chatgpt:old-reader', 'local-chatgpt%3Aold-reader'])
def test_old_reader_cannot_persist_temporary_id(tmp_path, temporary):
    db = tmp_path / 'old-reader.db'
    with TestClient(create_app(db)) as client:
        response = client.post('/sync', json={
            'conversation_id': temporary,
            'messages': [{'key': 'u', 'role': 'user', 'content': 'draft'}],
        })
        assert response.status_code == 409
        with get_read_connection(db) as connection:
            assert connection.execute('SELECT COUNT(*) FROM conversations').fetchone()[0] == 0
            assert connection.execute('SELECT COUNT(*) FROM messages').fetchone()[0] == 0


def test_existing_temporary_history_is_preserved(tmp_path):
    db = tmp_path / 'legacy.db'
    init_db(db)
    # Fixture represents old data, not a production migration.
    import sqlite3
    with sqlite3.connect(db) as connection:
        connection.execute("INSERT INTO conversations(conversation_id) VALUES ('local-chatgpt%3Alegacy')")
        connection.execute("INSERT INTO messages(conversation_id,message_key,role,content) VALUES ('local-chatgpt%3Alegacy','u','user','historical original')")
    save_observation('canonical-other', [{'key': 'u', 'role': 'user', 'content': 'historical original'}], db)
    with TestClient(atlas_app(db)) as client:
        assert {node['id'] for node in client.get('/api/atlas').json()['conversations']} == {
            'local-chatgpt%3Alegacy', 'canonical-other',
        }
    assert get_messages('local-chatgpt%3Alegacy', db)[0]['content'] == 'historical original'


def test_sync_preserves_chatgpt_title_without_changing_message(tmp_path):
    db = tmp_path / 'title.db'
    payload = {'conversation_id': 'canonical-title', 'title': 'GPT账号协作方案',
               'messages': [{'key': 'native-user', 'role': 'user', 'content': '原始正文'}]}
    with TestClient(create_app(db)) as collector:
        assert collector.post('/sync', json=payload).status_code == 200
        payload.pop('title')  # Older extension sync cannot erase a verified title.
        assert collector.post('/sync', json=payload).status_code == 200
    with get_read_connection(db) as connection:
        assert connection.execute('SELECT original_title FROM conversations').fetchone()[0] == 'GPT账号协作方案'
        assert connection.execute('SELECT content FROM messages').fetchone()[0] == '原始正文'
    with TestClient(atlas_app(db)) as atlas:
        node = atlas.get('/api/atlas').json()['conversations'][0]
        assert node['title'] == 'GPT账号协作方案'
        assert node['titleSource'] == 'chatgpt_original_title'


@contextmanager
def backend(db, log_path):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    env = dict(os.environ, CONVERSATION_DB_PATH=str(db))
    with log_path.open('w', encoding='utf-8') as log:
        process = subprocess.Popen([
            sys.executable, '-c',
            "import sys; sys.modules['app.context_monitor'] = None; "
            "import uvicorn; uvicorn.run('app.main:app', host='127.0.0.1', "
            f"port={port}, app_dir={str(ROOT / 'plugins/context_hygiene/backend')!r})",
        ], cwd=ROOT, env=env, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    pytest.fail(log_path.read_text(encoding='utf-8'))
                try:
                    if httpx.get(base + '/health', timeout=0.5, trust_env=False).status_code == 200:
                        break
                except httpx.HTTPError:
                    pass
                time.sleep(0.05)
            else:
                pytest.fail('Isolated backend startup timeout')
            yield process.pid, base
        finally:
            process.terminate()
            process.wait(timeout=10)


def test_identity_vertical_slice_and_actual_process_restart(tmp_path):
    db = tmp_path / 'identity.db'
    with backend(db, tmp_path / 'first-server.log') as (first_pid, base):
        # Executes production Reader AND Worker with a controlled DOM and Chrome
        # API surface; fetch really reaches the isolated uvicorn /sync.
        single = subprocess.run([
            'node', str(ROOT / 'tests_js/fixtures/identity_capture.cjs'), base, 'single',
        ], cwd=ROOT, capture_output=True, text=True, encoding='utf-8', timeout=20, check=True)
        assert json.loads(single.stdout)['temporaryRequestCount'] == 0
        with get_read_connection(db) as connection:
            assert [r[0] for r in connection.execute('SELECT conversation_id FROM conversations')] == ['canonical-A']
            assert connection.execute('SELECT COUNT(*) FROM messages').fetchone()[0] == 2
        result = subprocess.run([
            'node', str(ROOT / 'tests_js/fixtures/identity_capture.cjs'), base,
        ], cwd=ROOT, capture_output=True, text=True, encoding='utf-8', timeout=20, check=True)
        scenario = json.loads(result.stdout)
        assert scenario['temporaryRequestCount'] == 0
        expected = scenario['requests'][0]
        assert len(expected['messages']) == 2
        with httpx.Client(base_url=base, trust_env=False) as client:
            for _ in range(3):
                response = client.post('/sync', json=expected)
                assert response.status_code == 200
                assert response.json()['conversation_id'] == 'canonical-A'
                assert response.json()['message_count'] == 2
        with get_read_connection(db) as connection:
            assert [r[0] for r in connection.execute('SELECT conversation_id FROM conversations ORDER BY conversation_id')] == ['canonical-A', 'canonical-B']
            assert connection.execute('SELECT COUNT(*) FROM messages').fetchone()[0] == 4
        assert get_messages('canonical-A', db) == get_messages('canonical-B', db)
        assert get_messages('canonical-A', db) == expected['messages']

    # Both complete original bodies are readable while the backend is stopped.
    assert get_messages('canonical-A', db) == expected['messages']
    with backend(db, tmp_path / 'restarted-server.log') as (second_pid, base):
        assert second_pid != first_pid
        response = httpx.get(base + '/conversations/canonical-A/status', trust_env=False)
        assert response.status_code == 200
        assert response.json()['conversation_id'] == 'canonical-A'
        assert response.json()['message_count'] == 2
        assert response.json()['status'] == 'SAVED'
        assert get_messages('canonical-A', db) == expected['messages']

        with TestClient(atlas_app(db)) as atlas:
            graph = atlas.get('/api/atlas').json()
            assert {node['id'] for node in graph['conversations']} == {'canonical-A', 'canonical-B'}
            raw = atlas.get('/api/atlas/conversations/canonical-A').json()
            assert raw['conversationId'] == 'canonical-A'
            assert [{k: message[k] for k in ('key', 'role', 'content')} for message in raw['messages']] == expected['messages']
        with get_read_connection(db) as connection:
            assert connection.execute('SELECT COUNT(*) FROM conversations').fetchone()[0] == 2
            assert connection.execute('SELECT COUNT(*) FROM messages').fetchone()[0] == 4
    print(json.dumps({
        'test': 'identity_vertical_slice', 'database': str(db),
        'first_pid': first_pid, 'restarted_pid': second_pid,
        'temporary_http_requests': 0, 'repeat_syncs': 3,
        'after_temporary_to_formal': {'conversation_count': 1, 'message_count': 2},
        'canonical_ids': ['canonical-A', 'canonical-B'], 'message_count': 4,
        'full_bodies_preserved': True, 'atlas_readonly_compatible': True,
        'real_browser_test': False,
    }))
