"""Cheap revision reads must notice both Store WAL and derived-index changes."""
import sqlite3
from fastapi.testclient import TestClient

from plugins.conversation_atlas.backend.main import create_app
from plugins.conversation_atlas.backend.revision import graph_revision
from shared.conversation_store.database import init_db
from shared.conversation_store.store import save_observation


def test_revision_is_stable_read_only_and_tracks_wal_and_derived_changes(tmp_path):
    source, derived = tmp_path/'store.db', tmp_path/'index.db'
    init_db(source)
    with TestClient(create_app(source, derived)) as client:
        initial = client.get('/api/atlas/revision').json()['revision']
        assert client.get('/api/atlas').json()['revision'] == initial
        assert client.get('/api/atlas/revision').json()['revision'] == initial
        assert not derived.exists()
        # Keep the WAL alive: main database mtime alone must not miss this commit.
        with sqlite3.connect(source) as writer:
            writer.execute('PRAGMA wal_autocheckpoint=0')
            writer.execute("INSERT INTO conversations(conversation_id) VALUES ('A')")
            writer.commit()
            updated = client.get('/api/atlas/revision').json()['revision']
            assert updated != initial
            assert client.get('/api/atlas').json()['conversations'][0]['id'] == 'A'
        graph = client.get('/api/atlas').json()
        assert client.post('/api/atlas/conversations/A/hide',
                           headers={'x-atlas-action':'manage-conversation'}).status_code == 200
        assert client.get('/api/atlas/revision').json()['revision'] != graph['revision']
        assert client.get('/api/atlas').json()['conversations'] == []


def test_revision_missing_store_does_not_create_files(tmp_path):
    source, derived = tmp_path/'missing.db', tmp_path/'index.db'
    with TestClient(create_app(source, derived)) as client:
        assert client.get('/api/atlas/revision').status_code == 503
    assert not source.exists() and not derived.exists()


def test_unmodified_restart_retains_revision(tmp_path):
    source, derived = tmp_path/'store.db', tmp_path/'index.db'
    init_db(source)
    before = graph_revision(source, derived)
    with TestClient(create_app(source, derived)) as client:
        assert client.get('/api/atlas/revision').json()['revision'] == before
    with TestClient(create_app(source, derived)) as client:
        assert client.get('/api/atlas/revision').json()['revision'] == before
