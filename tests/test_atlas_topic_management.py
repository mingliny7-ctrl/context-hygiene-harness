"""Theme visibility is reversible; all mutations use isolated test databases."""
import json
import sqlite3

import pytest

from plugins.conversation_atlas.backend.incremental_index import IncrementalIndex
from plugins.conversation_atlas.backend.management import AtlasManagement, ManagementError
from shared.conversation_store.database import init_db
from shared.conversation_store.store import save_observation


def seed(tmp_path):
    source, derived = tmp_path / 'source.db', tmp_path / 'derived.db'
    init_db(source)
    messages = [{'key': f'chatgpt:{n:08x}-0000-4000-8000-000000000000:{role}',
                 'role': role, 'content': f'真实测试正文 {n}'}
                for n, role in ((1, 'user'), (2, 'assistant'))]
    for cid in ('A', 'B'):
        save_observation(cid, messages, source, observed_order=[m['key'] for m in messages],
                         original_title='原始对话 ' + cid)
    index = IncrementalIndex(source, derived)
    index.initialize()
    for cid in ('A', 'B'):
        plan = index.plan(cid)
        batch = index.prepare_batch(plan, manual=True)
        index.commit_batch(batch['batch_id'], [{
            'operation': 'create', 'segment_id': 'topic-1',
            'message_ids': [m['key'] for m in messages], 'theme_state': '主题状态',
            'analysis': {'title': '独立测试主题', 'summary': '测试概念说明。',
                         'outcomes': [], 'keywords': ['概念'], 'outcome_evidence': [],
                         'key_assistant_answers': [{'message_id': messages[1]['key'], 'reason': '解释概念'}]}
        }], model='test-only')
    with sqlite3.connect(derived) as c:
        c.execute('CREATE TABLE conversation_analysis(conversation_id TEXT,analysis_json TEXT)')
        c.execute('INSERT INTO conversation_analysis VALUES (?,?)', ('A', '{"summary":"旧缓存"}'))
    return source, derived, index


def snapshot(source, derived):
    with sqlite3.connect(source) as c:
        raw = c.execute('SELECT * FROM messages ORDER BY conversation_id,message_key').fetchall()
    with sqlite3.connect(derived) as c:
        segments = c.execute('SELECT * FROM atlas_segments ORDER BY conversation_id,segment_id').fetchall()
        coverage = c.execute('SELECT * FROM atlas_indexed_messages ORDER BY conversation_id,message_key').fetchall()
        cache = c.execute('SELECT * FROM conversation_analysis').fetchall()
    return raw, segments, coverage, cache


def test_topic_hide_restore_is_idempotent_persistent_and_preserves_indexes(tmp_path):
    source, derived, index = seed(tmp_path)
    before = snapshot(source, derived)
    management = AtlasManagement(source, derived)
    assert management.hidden_segment_ids() == set()
    assert management.hidden_segments() == []
    result = management.set_segment_hidden('A', 'topic-1', True)
    assert result == {'conversationId': 'A', 'segmentId': 'topic-1', 'hidden': True}
    first = management.hidden_segments()
    assert first[0]['title'] == '独立测试主题'
    assert first[0]['conversationTitle'] == '原始对话 A'
    management.set_segment_hidden('A', 'topic-1', True)
    assert management.hidden_segments() == first
    assert management.hidden_segment_ids('A') == {'topic-1'}
    assert management.hidden_segment_ids('B') == set()
    assert management.hidden_segment_ids() == {('A', 'topic-1')}
    restarted = AtlasManagement(source, derived)
    assert restarted.hidden_segments() == first
    assert index.inspect('A')['appended'] == []
    assert snapshot(source, derived) == before
    restarted.set_segment_hidden('A', 'topic-1', False)
    restarted.set_segment_hidden('A', 'topic-1', False)
    assert restarted.hidden_segments() == []
    assert restarted.hidden_segment_ids() == set()
    assert snapshot(source, derived) == before


def test_missing_topic_never_creates_visibility_or_changes_coverage(tmp_path):
    source, derived, _ = seed(tmp_path)
    management = AtlasManagement(source, derived)
    before = snapshot(source, derived)
    for cid, sid in (('missing', 'topic-1'), ('A', 'missing')):
        with pytest.raises(ManagementError) as error:
            management.set_segment_hidden(cid, sid, True)
        assert error.value.code == 'NOT_FOUND'
    assert management.hidden_segment_ids() == set()
    assert snapshot(source, derived) == before
    assert list(tmp_path.glob('derived.management-backup-*.db')) == []


def test_upgrade_backs_up_legacy_management_tables_once(tmp_path):
    source, derived, _ = seed(tmp_path)
    with sqlite3.connect(derived) as c:
        c.execute('CREATE TABLE atlas_conversation_visibility(conversation_id TEXT PRIMARY KEY,hidden_at TEXT NOT NULL)')
        c.execute('CREATE TABLE atlas_bookmarks(conversation_id TEXT,message_key TEXT,created_at TEXT,PRIMARY KEY(conversation_id,message_key))')
        c.execute("INSERT INTO atlas_conversation_visibility VALUES ('B','old')")
    management = AtlasManagement(source, derived)
    backup = management.initialize()
    assert backup is not None and backup.is_file()
    with sqlite3.connect(backup) as c:
        assert c.execute("SELECT hidden_at FROM atlas_conversation_visibility WHERE conversation_id='B'").fetchone() == ('old',)
        assert c.execute("SELECT 1 FROM sqlite_master WHERE name='atlas_segment_visibility'").fetchone() is None
    assert management.hidden_ids() == {'B'}
    assert management.initialize() is None
    assert len(list(tmp_path.glob('derived.management-backup-*.db'))) == 1


def test_whole_conversation_delete_removes_only_its_topic_visibility(tmp_path):
    source, derived, _ = seed(tmp_path)
    management = AtlasManagement(source, derived)
    for cid in ('A', 'B'):
        management.set_segment_hidden(cid, 'topic-1', True)
    management.delete('A')
    assert management.hidden_segment_ids() == {('B', 'topic-1')}
    assert [row['conversationId'] for row in management.hidden_segments()] == ['B']
    with sqlite3.connect(derived) as c:
        assert c.execute("SELECT count(*) FROM atlas_segments WHERE conversation_id='A'").fetchone()[0] == 0
        assert c.execute("SELECT count(*) FROM atlas_segments WHERE conversation_id='B'").fetchone()[0] == 1
        assert c.execute("SELECT count(*) FROM atlas_indexed_messages WHERE conversation_id='B'").fetchone()[0] == 2
