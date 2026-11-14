"""Deterministic local data only; no external model calls."""
import hashlib
import json
import os
import sqlite3
import subprocess
import sys

import pytest

from shared.conversation_store.database import init_db
from shared.conversation_store.store import save_observation
from plugins.conversation_atlas.backend.incremental_index import IncrementalIndex, IndexErrorState
from plugins.conversation_atlas.backend.analysis_cache import read_completed


@pytest.fixture(autouse=True)
def forbid_inference(monkeypatch):
    from plugins.conversation_atlas.backend.llm import DeepSeekProvider
    monkeypatch.setattr(DeepSeekProvider, 'complete', lambda *a: pytest.fail('B4 must never call a model'))


def message(n, body=None):
    role = 'user' if n % 2 else 'assistant'
    return {'key': f'chatgpt:{n:08x}-0000-4000-8000-000000000000:{role}',
            'role': role, 'content': body or f'本地确定性消息 {n}'}


@pytest.fixture
def index(tmp_path):
    source = tmp_path / 'source.db'
    init_db(source)
    obj = IncrementalIndex(source, tmp_path / 'atlas_analysis.db')
    obj.initialize()
    return obj


def seed(index, numbers, cid='A'):
    messages = [message(n) for n in numbers]
    save_observation(cid, messages, index.source_db, observed_order=[m['key'] for m in messages])


def update(numbers, sid='s1', operation='create'):
    answer = next(message(n)['key'] for n in numbers if n % 2 == 0)
    return {'operation': operation, 'segment_id': sid, 'message_ids': [message(n)['key'] for n in numbers],
            'theme_state': '围绕当前技术方案继续讨论',
            'analysis': {'title': '确定性测试主题', 'summary': '本地样本讨论技术方案。',
                         'outcomes': [], 'keywords': ['方案'], 'outcome_evidence': [],
                         'key_assistant_answers': [{'message_id': answer, 'reason': '解释方案'}]}}


def save(index, numbers, **kwargs):
    plan = index.plan('A')
    prepared = index.prepare_batch(plan, manual=True)
    return index.commit_batch(prepared['batch_id'], [update(numbers, **kwargs)], model='test-provider')


def test_read_only_detection_no_schema_or_provider(tmp_path, monkeypatch):
    from plugins.conversation_atlas.backend.llm import DeepSeekProvider
    monkeypatch.setattr(DeepSeekProvider, 'complete', lambda *a: pytest.fail('No model allowed'))
    source = tmp_path / 'source.db'; init_db(source)
    index = IncrementalIndex(source, tmp_path / 'absent.db')
    seed(index, [1, 2])
    assert index.inspect('A') == index.inspect('A')
    assert index.plan('A')['pending'] == [message(1), message(2)]
    assert not index.path.exists()


def test_commit_append_and_unchanged_model_switch(index):
    seed(index, [1, 2]); save(index, [1, 2])
    assert index.inspect('A')['appended'] == []
    assert len(index.inspect('A')['unchanged']) == 2
    seed(index, [1, 2, 3, 4])
    plan = index.plan('A')
    assert [m['key'] for m in plan['pending']] == [message(3)['key'], message(4)['key']]
    assert {m['key'] for m in plan['context']['messages']}.isdisjoint(m['key'] for m in plan['pending'])
    prepared = index.prepare_batch(plan, manual=True)
    index.commit_batch(prepared['batch_id'], [update([3, 4], operation='extend')], model='another-model')
    segment = index.read_segments('A')['segments'][0]
    assert segment['segment_id'] == 's1' and segment['revision'] == 2
    assert segment['start_key'] == message(1)['key'] and segment['end_key'] == message(4)['key']
    assert index.plan('A')['pending'] == []


def test_multiple_segments_one_batch_and_tail_continuation(index):
    seed(index, [1, 2, 3, 4])
    job = index.prepare_batch(index.plan('A'), manual=True)
    index.commit_batch(job['batch_id'], [update([1, 2]), update([3, 4], 's2')], model='test')
    assert [s['topic_state'] for s in index.read_segments('A')['segments']] == ['stable', 'open']
    seed(index, [1, 2, 3, 4, 5, 6])
    save(index, [5, 6], sid='s2', operation='extend')
    assert len(index.read_segments('A')['segments']) == 2


def test_failed_transaction_rolls_back_segments_coverage_and_checkpoint(index):
    seed(index, [1, 2, 3, 4])
    job = index.prepare_batch(index.plan('A'), manual=True)
    with sqlite3.connect(index.path) as c:
        c.execute("CREATE TRIGGER fail_second BEFORE INSERT ON atlas_indexed_messages WHEN NEW.position=2 BEGIN SELECT RAISE(ABORT,'injected'); END")
    with pytest.raises(sqlite3.IntegrityError):
        index.commit_batch(job['batch_id'], [update([1, 2]), update([3, 4], 's2')], model='test')
    assert not index.read_segments('A')['segments']
    assert len(index.inspect('A')['appended']) == 4
    assert index.batch(job['batch_id'])['status'] == 'prepared'


def test_idempotent_commit_rejects_different_result_and_duplicate_prepare(index):
    seed(index, [1, 2]); plan = index.plan('A')
    first = index.prepare_batch(plan, manual=True)
    second = index.prepare_batch(plan, manual=True)
    assert first['created'] and not second['created'] and first['batch_id'] == second['batch_id']
    receipt = index.commit_batch(first['batch_id'], [update([1, 2])], model='test')
    assert index.commit_batch(first['batch_id'], [update([1, 2])], model='test') == receipt
    with pytest.raises(IndexErrorState, match='IDEMPOTENCY_CONFLICT'):
        index.commit_batch(first['batch_id'], [update([1, 2])], model='different')
    assert index.read_segments('A')['segments'][0]['revision'] == 1


def test_completed_legacy_batch_replay_ignores_absent_refinement_receipt(index):
    from plugins.conversation_atlas.backend.incremental_index import digest, PROMPT_VERSION
    seed(index, [1, 2])
    job = index.prepare_batch(index.plan('A'), manual=True)
    result = update([1, 2])
    receipt = index.commit_batch(job['batch_id'], [result], model='test')
    # A pre-refinement release never serialized this optional local metadata.
    legacy_digest = digest({'updates': [result], 'model': 'test', 'prompt_version': PROMPT_VERSION})
    with sqlite3.connect(index.path) as connection:
        connection.execute('UPDATE atlas_index_batches SET result_digest=? WHERE batch_id=?',
                           (legacy_digest, job['batch_id']))
    assert index.commit_batch(job['batch_id'], [result], model='test') == receipt


def test_refined_concepts_stay_local_and_do_not_exhaust_incremental_context(index):
    from plugins.conversation_atlas.backend.incremental_index import encoded
    seed(index, [1, 2])
    result = update([1, 2])
    result['analysis']['subtopics'] = [
        {'block_id': f'block:{number}', 'title': title, 'summary': '概念解释' * 400,
         'message_ids': result['message_ids'],
         'key_assistant_answers': result['analysis']['key_assistant_answers']}
        for number, title in enumerate(('资源释放', '上下文协议'))]
    result['analysis']['concept_refinement'] = {
        'source_digest': 'test-digest', 'model': 'test', 'prompt_version': 'test',
        'analyzed_at': '2026-11-14T00:00:00Z', 'atomic': False, 'requests': 1, 'usage': {}}
    job = index.prepare_batch(index.plan('A'), manual=True)
    index.commit_batch(job['batch_id'], [result], model='test')
    seed(index, [1, 2, 3, 4])
    plan = index.plan('A', max_context_bytes=4000)
    assert len(encoded(plan['context']).encode()) <= 4000
    assert 'subtopics' not in plan['context']['segment']['analysis']
    assert 'concept_refinement' not in plan['context']['segment']['analysis']
    assert plan['tail_analysis']['subtopics'] == result['analysis']['subtopics']
    assert plan['tail_analysis']['concept_refinement'] == result['analysis']['concept_refinement']
    assert [m['key'] for m in plan['pending']] == [message(3)['key'], message(4)['key']]
    assert index.prepare_batch(plan, manual=True)['created']


def test_actual_new_process_restores_checkpoint_and_only_failed_tail_remains(index):
    seed(index, [1, 2]); save(index, [1, 2])
    seed(index, [1, 2, 3, 4])
    job = index.prepare_batch(index.plan('A'), manual=True)
    index.interrupt(job['batch_id'], error_code='VALIDATION_FAILED')
    code = '''import json,sys
from plugins.conversation_atlas.backend.incremental_index import IncrementalIndex
i=IncrementalIndex(sys.argv[1],sys.argv[2])
print(json.dumps({'pending':[m['key'] for m in i.plan('A')['pending']], 'segments':len(i.read_segments('A')['segments'])}))'''
    result = subprocess.run([sys.executable, '-c', code, str(index.source_db), str(index.path)],
                            capture_output=True, text=True, check=True)
    restored = json.loads(result.stdout)
    assert restored == {'pending': [message(3)['key'], message(4)['key']], 'segments': 1}
    assert index.prepare_batch(index.plan('A'), manual=True)['created']


def test_historical_insertion_is_not_appended_and_does_not_rebuild(index):
    seed(index, [1, 4]); save(index, [1, 4])
    seed(index, [1, 2, 3, 4])
    status = index.inspect('A')
    assert status['historical'] == [message(2)['key'], message(3)['key']]
    assert status['appended'] == [] and status['status'] == 'review_required'
    with pytest.raises(IndexErrorState, match='SOURCE_REVIEW_REQUIRED'):
        index.plan('A')
    assert len(index.read_segments('A')['segments']) == 1


@pytest.mark.parametrize('body', ['改', '同一身份实际发生的更长正文变化'])
def test_body_change_marks_review_without_clearing_old_result(index, body):
    seed(index, [1, 2]); save(index, [1, 2])
    # Explicitly mutate only the isolated fixture: tests DB-level edit detection, not Reader support.
    with sqlite3.connect(index.source_db) as c:
        c.execute('UPDATE messages SET content=? WHERE message_key=?', (body, message(2)['key']))
    assert index.inspect('A')['changed'] == [message(2)['key']]
    assert index.read_segments('A')['source_status'] == 'review_required'


def test_unreliable_order_identity_and_empty_body(index):
    save_observation('A', [message(1), message(2)], index.source_db)
    assert index.inspect('A')['reason'] == 'ORDER_UNRELIABLE'
    save_observation('B', [{'key': 'fallback-turn-1', 'role': 'assistant', 'content': '正文'}],
                     index.source_db, observed_order=['fallback-turn-1'])
    assert index.inspect('B')['reason'] == 'IDENTITY_UNRELIABLE'
    seed(index, [1, 2], cid='C')
    with sqlite3.connect(index.source_db) as c:
        c.execute("UPDATE messages SET content='' WHERE conversation_id='C'")
    assert index.plan('C')['pending'] == []


def test_context_only_cannot_be_new_coverage_or_wrong_conversation_reference(index):
    seed(index, [1, 2]); save(index, [1, 2])
    seed(index, [1, 2, 3, 4]); seed(index, [5, 6], cid='B')
    job = index.prepare_batch(index.plan('A'), manual=True)
    bad = update([1, 2, 3, 4], 's2')
    with pytest.raises(IndexErrorState, match='PENDING_COVERAGE_INVALID'):
        index.commit_batch(job['batch_id'], [bad], model='test')
    bad = update([3, 4], 's2')
    bad['analysis']['key_assistant_answers'][0]['message_id'] = message(6)['key']
    with pytest.raises(IndexErrorState, match='REFERENCE_OUTSIDE_SEGMENT'):
        index.commit_batch(job['batch_id'], [bad], model='test')
    assert len(index.inspect('A')['unchanged']) == 2


def test_stale_input_refused_and_explicit_manual_required(index):
    seed(index, [1, 2]); plan = index.plan('A')
    with pytest.raises(IndexErrorState, match='MANUAL_TRIGGER_REQUIRED'):
        index.prepare_batch(plan)
    job = index.prepare_batch(plan, manual=True)
    save_observation('A', [message(2, '更长且实际变化的正文内容')], index.source_db)
    with pytest.raises(IndexErrorState, match='SOURCE_CHANGED'):
        index.commit_batch(job['batch_id'], [update([1, 2])], model='test')
    assert index.batch(job['batch_id'])['status'] == 'prepared'


def test_window_budget_no_truncation_or_full_history_fallback(index):
    # Long history is already covered; only tail references can enter context.
    seed(index, range(1, 101))
    save(index, list(range(1, 101)))
    seed(index, range(1, 113))
    plan = index.plan('A', max_input_bytes=6000, max_context_bytes=1400)
    assert len(json.dumps(plan['context'], ensure_ascii=False).encode()) < 1500
    assert plan['input_byte_upper_bound'] <= 6000
    assert [m['key'] for m in plan['pending']] == [message(n)['key'] for n in range(101, 113)]
    save_observation('B', [message(1, '长' * 3000), message(2)], index.source_db,
                     observed_order=[message(1)['key'], message(2)['key']])
    with pytest.raises(IndexErrorState, match='MESSAGE_TOO_LARGE'):
        index.plan('B', max_input_bytes=5000, max_context_bytes=500)


def test_input_accounting_preserves_exact_json_boundary_without_quadratic_encoding(index, monkeypatch):
    from plugins.conversation_atlas.backend import incremental_index as module
    messages = [message(n, '\n中文 "quotes" \\ slash 😀' * 80) for n in range(1, 21)]
    save_observation('A', messages, index.source_db, observed_order=[m['key'] for m in messages])
    original = module.encoded
    context = {'segment': None, 'messages': []}
    limit = len(original({'context': context, 'pending': messages[:8]}).encode()) + 2048
    serialized_messages = []
    def measured(value):
        if isinstance(value, dict) and 'pending' in value and 'context' in value:
            serialized_messages.append(len(value['pending']))
        return original(value)
    monkeypatch.setattr(module, 'encoded', measured)
    plan = index.plan('A', max_input_bytes=limit, max_context_bytes=1000, complete_turns=True)
    assert plan['pending'] == messages[:8]
    assert plan['input_byte_upper_bound'] == limit
    assert sum(serialized_messages) <= len(messages)
    assert index.plan('A', max_input_bytes=limit - 1, max_context_bytes=1000,
                      complete_turns=True)['pending'] == messages[:6]


def test_backup_migration_module5_compatibility_and_source_unchanged(index):
    # Existing V5 cache is preserved byte-for-byte at the row level.
    other = index.path.with_name('legacy.db')
    with sqlite3.connect(other) as c:
        c.execute('CREATE TABLE conversation_analysis (conversation_id,source_digest,schema_version,analysis_status,analysis_json)')
        c.execute("INSERT INTO conversation_analysis VALUES ('A','fingerprint',2,'completed','{}')")
    obj = IncrementalIndex(index.source_db, other)
    before = hashlib.sha256(index.source_db.read_bytes()).hexdigest()
    backup = obj.initialize()
    assert backup and backup.is_file()
    assert read_completed(other, 'A', 'fingerprint', 2)['analysis_json'] == '{}'
    assert read_completed(backup, 'A', 'fingerprint', 2)['analysis_json'] == '{}'
    assert obj.initialize() is None
    assert hashlib.sha256(index.source_db.read_bytes()).hexdigest() == before
    with pytest.raises(ValueError):
        IncrementalIndex(index.source_db, index.source_db)


def test_bounded_batches_resume_after_interruption_without_reprocessing_prefix(index):
    messages = [message(n, '本地长正文' * 50) for n in range(1, 9)]
    save_observation('A', messages, index.source_db, observed_order=[m['key'] for m in messages])
    first_plan = index.plan('A', max_input_bytes=6000, max_context_bytes=1400)
    count = len(first_plan['pending'])
    assert 0 < count < 8
    first = index.prepare_batch(first_plan, manual=True)
    index.commit_batch(first['batch_id'], [update(list(range(1, count + 1)))], model='test')
    second_plan = index.plan('A', max_input_bytes=6000, max_context_bytes=1400)
    second = index.prepare_batch(second_plan, manual=True)
    index.interrupt(second['batch_id'])
    resumed = IncrementalIndex(index.source_db, index.path).plan('A', max_input_bytes=6000, max_context_bytes=1400)
    assert resumed['manifest']['pending'] == second_plan['manifest']['pending']
    assert set(m['key'] for m in resumed['pending']).isdisjoint(m['key'] for m in first_plan['pending'])
    assert index.batch(first['batch_id'])['status'] == 'completed'


def test_folded_or_mismatched_role_is_blocked(index):
    seed(index, [1, 2])
    with sqlite3.connect(index.source_db) as c:
        c.execute('UPDATE messages SET content=? WHERE message_key=?', ('正文显示更多', message(2)['key']))
    assert index.inspect('A')['reason'] == 'BODY_COMPLETENESS_UNCONFIRMED'
    with sqlite3.connect(index.source_db) as c:
        c.execute('UPDATE messages SET role=?,content=? WHERE message_key=?', ('user', '正文', message(2)['key']))
    assert index.inspect('A')['reason'] == 'IDENTITY_UNRELIABLE'


def test_changed_order_or_missing_source_is_not_silently_reused(index):
    seed(index, [1, 2]); save(index, [1, 2])
    with sqlite3.connect(index.source_db) as c:
        c.execute('UPDATE conversation_order_evidence SET evidence=? WHERE conversation_id=?',
                  (json.dumps({'times': {}, 'observed': [message(2)['key'], message(1)['key']],
                               'edges': [[message(2)['key'], message(1)['key']]]}), 'A'))
    assert index.inspect('A')['reason'] == 'ORDER_CHANGED'


def test_no_changes_requires_no_context_rebudget_and_cross_conversation_isolation(index):
    seed(index, [1, 2]); save(index, [1, 2])
    assert index.plan('A', max_input_bytes=5000, max_context_bytes=0)['pending'] == []
    # Identical stable message IDs in a different Conversation never inherit coverage.
    seed(index, [1, 2], cid='B')
    assert len(index.inspect('B')['appended']) == 2
    assert index.read_segments('B')['segments'] == []


def test_an_active_different_window_cannot_create_concurrent_work(index):
    seed(index, [1, 2]); index.prepare_batch(index.plan('A'), manual=True)
    seed(index, [1, 2, 3, 4])
    with pytest.raises(IndexErrorState, match='BATCH_BUSY'):
        index.prepare_batch(index.plan('A'), manual=True)


def test_concurrent_manual_preparations_have_one_owner(index):
    from concurrent.futures import ThreadPoolExecutor
    seed(index, [1, 2]); plan = index.plan('A')
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: index.prepare_batch(plan, manual=True), range(4)))
    assert sum(r['created'] for r in results) == 1
    assert len({r['batch_id'] for r in results}) == 1


def test_extension_cannot_invent_reference_to_unprovided_old_message(index):
    from plugins.conversation_atlas.backend.incremental_index import encoded
    seed(index, range(1, 7)); save(index, list(range(1, 7)))
    seed(index, range(1, 9))
    full = index.plan('A')
    limit = len(encoded({'segment': full['context']['segment'], 'messages': []}).encode())
    plan = index.plan('A', max_context_bytes=limit)
    assert plan['context']['messages'] == []
    job = index.prepare_batch(plan, manual=True)
    result = update([7, 8], operation='extend')
    result['analysis']['key_assistant_answers'][0]['message_id'] = message(6)['key']
    with pytest.raises(IndexErrorState, match='REFERENCE_NOT_PROVIDED'):
        index.commit_batch(job['batch_id'], [result], model='test')


def test_real_process_exit_mid_transaction_preserves_previous_batch(index):
    seed(index, [1, 2]); save(index, [1, 2])
    seed(index, [1, 2, 3, 4])
    job = index.prepare_batch(index.plan('A'), manual=True)
    code = '''import json,os,sys
from contextlib import contextmanager
from plugins.conversation_atlas.backend.incremental_index import IncrementalIndex
i=IncrementalIndex(sys.argv[1],sys.argv[2])
original=i._write
@contextmanager
def crashing_write():
    with original() as c:
        c.create_function('crash',0,lambda:os._exit(23))
        yield c
i._write=crashing_write
with i._write() as c:
    c.execute("CREATE TRIGGER crash_on_last BEFORE INSERT ON atlas_indexed_messages WHEN NEW.position=3 BEGIN SELECT crash(); END")
i.commit_batch(sys.argv[3],json.loads(sys.argv[4]),model='test')
'''
    result = subprocess.run([sys.executable, '-c', code, str(index.source_db), str(index.path),
                             job['batch_id'], json.dumps([update([3, 4], 's2')])],
                            capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    assert result.returncode == 23
    restored = IncrementalIndex(index.source_db, index.path)
    assert [s['segment_id'] for s in restored.read_segments('A')['segments']] == ['s1']
    assert restored.inspect('A')['appended'] == [message(3)['key'], message(4)['key']]
    assert restored.batch(job['batch_id'])['status'] == 'prepared'
    restored.interrupt(job['batch_id'])
    assert restored.prepare_batch(restored.plan('A'), manual=True)['created']


def test_original_source_times_take_priority_for_native_input(index):
    messages = [{**message(2), 'source_created_at': 200}, {**message(1), 'source_created_at': 100}]
    save_observation('A', messages, index.source_db, observed_order=[m['key'] for m in messages])
    assert index.plan('A')['pending'] == [message(1), message(2)]


def test_sync_metadata_never_makes_covered_content_pending(index):
    seed(index, [1, 2]); save(index, [1, 2])
    before = index.inspect('A')
    for _ in range(3):
        seed(index, [1, 2])
    with sqlite3.connect(index.source_db) as c:
        c.execute("UPDATE messages SET updated_at='2099-01-01' WHERE conversation_id='A'")
    assert index.inspect('A') == before
    assert index.prepare_batch(index.plan('A'), manual=True)['status'] == 'no_changes'
