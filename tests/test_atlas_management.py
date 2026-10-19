"""Management tests use disposable databases; never delete a real Conversation."""
import sqlite3

from fastapi.testclient import TestClient

from plugins.context_hygiene.backend.app.main import create_app as collector_app
from plugins.conversation_atlas.backend.main import create_app as atlas_app
from plugins.conversation_atlas.backend.incremental_index import IncrementalIndex
from plugins.conversation_atlas.backend.management import AtlasManagement
from shared.conversation_store.database import init_db
from shared.conversation_store.store import save_observation

ACTION = {'x-atlas-action': 'manage-conversation'}
USER = 'chatgpt:11111111-1111-4111-8111-111111111111:user'
ANSWER = 'chatgpt:22222222-2222-4222-8222-222222222222:assistant'


def seed(path, cid='official-A'):
    init_db(path)
    save_observation(cid, [{'key': USER, 'role': 'user', 'content': '请解释表格'},
                           {'key': ANSWER, 'role': 'assistant', 'content': '# 回答\n| a | b |'}],
                     path, observed_order=[USER, ANSWER], original_title='原始标题')


def test_hide_restore_bookmark_restart_and_exact_answer(tmp_path):
    source, derived = tmp_path/'source.db', tmp_path/'derived.db'
    seed(source)
    with TestClient(atlas_app(source, derived)) as client:
        assert client.get('/api/atlas/bookmarks').json() == {'bookmarks': []}
        assert client.post('/api/atlas/conversations/official-A/hide').status_code == 403
        assert client.post('/api/atlas/conversations/official-A/hide', headers=ACTION).status_code == 200
        assert client.post('/api/atlas/conversations/official-A/hide', headers=ACTION).status_code == 200
        graph = client.get('/api/atlas').json()
        assert graph['conversations'] == []
        assert graph['quality']['storedConversationCount'] == 1
        assert graph['quality']['messageCount'] == 2
        assert graph['quality']['hiddenConversationCount'] == 1
        assert client.get('/api/atlas/hidden').json()['conversations'][0]['title'] == '原始标题'
        initially_linked = client.get(f'/api/atlas/bookmarks/official-A/{ANSWER}/answer').json()
        assert initially_linked['questions'][0]['content'] == '请解释表格'
        save_observation('official-A', [{'key':'chatgpt:33333333-3333-4333-8333-333333333333:user',
                                         'role':'user','content':'隐藏后继续采集'}], source)
        assert client.get('/api/atlas/hidden').json()['conversations'][0]['messageCount'] == 3
        assert client.get('/api/atlas').json()['conversations'] == []
        assert client.put(f'/api/atlas/bookmarks/official-A/{ANSWER}', headers=ACTION).status_code == 200
        assert client.put(f'/api/atlas/bookmarks/official-A/{ANSWER}', headers=ACTION).status_code == 200
        assert len(client.get('/api/atlas/bookmarks').json()['bookmarks']) == 1
        answer = client.get(f'/api/atlas/bookmarks/official-A/{ANSWER}/answer').json()
        assert answer['answer']['content'].startswith('# 回答')
        assert answer['questions'] == []  # Missing overlap evidence must not invent a pairing.
        assert client.put(f'/api/atlas/bookmarks/official-A/{USER}', headers=ACTION).status_code == 409
    with TestClient(atlas_app(source, derived)) as client:
        assert client.get('/api/atlas').json()['conversations'] == []
        assert len(client.get('/api/atlas/bookmarks').json()['bookmarks']) == 1
        assert client.post('/api/atlas/conversations/official-A/restore', headers=ACTION).status_code == 200
        assert len(client.get('/api/atlas').json()['conversations']) == 1
        assert client.delete(f'/api/atlas/bookmarks/official-A/{ANSWER}', headers=ACTION).status_code == 200
        assert client.delete(f'/api/atlas/bookmarks/official-A/{ANSWER}', headers=ACTION).status_code == 200
        assert client.get('/api/atlas/bookmarks').json()['bookmarks'] == []


def test_permanent_delete_cleans_derived_and_blocks_reimport(tmp_path):
    source, derived = tmp_path/'source.db', tmp_path/'derived.db'
    seed(source)
    seed(source, 'official-B')
    index = IncrementalIndex(source, derived)
    index.initialize()
    with sqlite3.connect(derived) as connection:
        connection.execute('''CREATE TABLE conversation_analysis(
            conversation_id TEXT, source_digest TEXT, schema_version INTEGER, prompt_version TEXT,
            model TEXT, analysis_status TEXT, analyzed_at TEXT, analysis_json TEXT, inference_json TEXT)''')
        connection.executemany('INSERT INTO conversation_analysis VALUES (?,?,?,?,?,?,?,?,?)',
                               [(cid,'digest',1,'prompt','model','completed','now','{}','{}')
                                for cid in ('official-A','official-B')])
        connection.execute('CREATE TABLE atlas_index_runs(run_id TEXT PRIMARY KEY,conversation_id TEXT,status TEXT,created_at TEXT)')
        connection.execute('CREATE TABLE atlas_index_calls(call_id TEXT PRIMARY KEY,run_id TEXT,started_at TEXT)')
        connection.executemany('INSERT INTO atlas_index_runs VALUES (?,?,?,?)',
                               [('run-A','official-A','completed','now'),('run-B','official-B','completed','now')])
        connection.executemany('INSERT INTO atlas_index_calls VALUES (?,?,?)', [('call-A','run-A','now'),('call-B','run-B','now')])
        connection.execute("""INSERT INTO atlas_segments VALUES
            ('official-A','segment-A',1,?,?,?,'state','open',1,'algorithm','prompt','model','now')""",
            (USER, ANSWER, '{}'))
        connection.execute("""INSERT INTO atlas_indexed_messages VALUES
            ('official-A',?,'assistant','digest',1,'segment-A')""", (ANSWER,))
        connection.execute("INSERT INTO atlas_index_batches(batch_id,conversation_id,manifest_json,status,created_at) VALUES ('batch-A','official-A','{}','completed','now')")
        connection.execute("INSERT INTO atlas_index_batches(batch_id,conversation_id,manifest_json,status,created_at) VALUES ('batch-B','official-B','{}','completed','now')")
    source_backup = tmp_path/'source.reading-backup-test.db'
    derived_backup = tmp_path/'derived.b4-backup-test.db'
    for origin, backup in ((source, source_backup), (derived, derived_backup)):
        with sqlite3.connect(origin) as reader, sqlite3.connect(backup) as destination:
            reader.backup(destination)
    for i in range(5):
        with sqlite3.connect(source) as reader, sqlite3.connect(tmp_path/f'source.reading-backup-extra-{i}.db') as destination:
            reader.backup(destination)
    with TestClient(atlas_app(source, derived)) as client:
        assert client.put(f'/api/atlas/bookmarks/official-A/{ANSWER}', headers=ACTION).status_code == 200
        assert client.post('/api/atlas/conversations/official-A/hide', headers=ACTION).status_code == 200
        response = client.delete('/api/atlas/conversations/official-A', headers=ACTION)
        assert response.status_code == 200, response.text
        assert client.get('/api/atlas/conversations/official-A').status_code == 404
        assert len(client.get('/api/atlas').json()['conversations']) == 1
        assert client.get('/api/atlas/bookmarks').json()['bookmarks'] == []
        assert client.get('/api/atlas/hidden').json()['conversations'] == []
        assert client.get('/api/atlas/tombstones').json()['conversations'][0]['conversationId'] == 'official-A'
        assert client.get('/api/atlas/conversations/official-B').status_code == 200
    with sqlite3.connect(derived) as connection:
        assert connection.execute("SELECT COUNT(*) FROM atlas_index_batches WHERE conversation_id='official-A'").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM atlas_segments WHERE conversation_id='official-A'").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM atlas_indexed_messages WHERE conversation_id='official-A'").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM atlas_index_batches WHERE conversation_id='official-B'").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM atlas_index_calls WHERE call_id='call-A'").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM atlas_index_calls WHERE call_id='call-B'").fetchone()[0] == 1
        assert connection.execute("SELECT COUNT(*) FROM conversation_analysis WHERE conversation_id='official-A'").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM conversation_analysis WHERE conversation_id='official-B'").fetchone()[0] == 1
    with sqlite3.connect(source_backup) as connection:
        assert connection.execute("SELECT COUNT(*) FROM messages WHERE conversation_id='official-A'").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM messages WHERE conversation_id='official-B'").fetchone()[0] == 2
    with sqlite3.connect(derived_backup) as connection:
        assert connection.execute("SELECT COUNT(*) FROM atlas_index_batches WHERE conversation_id='official-A'").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM atlas_index_batches WHERE conversation_id='official-B'").fetchone()[0] == 1
    with TestClient(collector_app(source)) as collector:
        payload = {'conversation_id':'official-A', 'messages':[{'key':USER,'role':'user','content':'请解释表格'}]}
        assert collector.post('/sync', json=payload).status_code == 410
    with TestClient(atlas_app(source, derived)) as client:
        assert client.post('/api/atlas/tombstones/official-A/allow-recapture', headers=ACTION).status_code == 200
    with TestClient(collector_app(source)) as collector:
        assert collector.post('/sync', json=payload).status_code == 200


def test_unknown_derived_dependency_refuses_delete_and_rolls_back(tmp_path):
    source, derived = tmp_path/'source.db', tmp_path/'derived.db'
    seed(source)
    with sqlite3.connect(derived) as connection:
        connection.execute('CREATE TABLE future_feature(conversation_id TEXT, item TEXT)')
        connection.execute("INSERT INTO future_feature VALUES ('official-A','keep')")
    with TestClient(atlas_app(source, derived)) as client:
        response = client.delete('/api/atlas/conversations/official-A', headers=ACTION)
        assert response.status_code == 409
        assert response.json()['detail']['code'] == 'UNKNOWN_DEPENDENCY'
        assert client.get('/api/atlas/conversations/official-A').status_code == 200
        assert client.get('/api/atlas/tombstones').json()['conversations'] == []
    with sqlite3.connect(derived) as connection:
        assert connection.execute('SELECT item FROM future_feature').fetchone()[0] == 'keep'


def test_failure_after_derived_delete_rolls_back_both_databases(tmp_path, monkeypatch):
    source, derived = tmp_path/'source.db', tmp_path/'derived.db'
    seed(source)
    index = IncrementalIndex(source, derived)
    index.initialize()
    with sqlite3.connect(derived) as connection:
        connection.execute("INSERT INTO atlas_index_batches(batch_id,conversation_id,manifest_json,status,created_at) VALUES ('batch-A','official-A','{}','completed','now')")
    original = AtlasManagement._purge_schema
    def fail_after_purge(connection, schema, cid, derived_flag):
        original(connection, schema, cid, derived_flag)
        if schema == 'atlas':
            raise RuntimeError('simulated failure before commit')
    monkeypatch.setattr(AtlasManagement, '_purge_schema', staticmethod(fail_after_purge))
    with TestClient(atlas_app(source, derived)) as client:
        try:
            client.delete('/api/atlas/conversations/official-A', headers=ACTION)
        except RuntimeError:
            pass
        else:
            raise AssertionError('injected transaction failure did not propagate')
    with sqlite3.connect(source) as connection:
        assert connection.execute("SELECT COUNT(*) FROM messages WHERE conversation_id='official-A'").fetchone()[0] == 2
        assert connection.execute("SELECT COUNT(*) FROM collector_tombstones WHERE conversation_id='official-A'").fetchone()[0] == 0
    with sqlite3.connect(derived) as connection:
        assert connection.execute("SELECT COUNT(*) FROM atlas_index_batches WHERE conversation_id='official-A'").fetchone()[0] == 1
