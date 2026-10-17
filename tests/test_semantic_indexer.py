import json
import sqlite3
import threading
import pytest
from fastapi.testclient import TestClient
from plugins.conversation_atlas.backend.incremental_index import IncrementalIndex, IndexErrorState
from plugins.conversation_atlas.backend.indexer import SemanticIndexer, Budget
from plugins.conversation_atlas.backend.llm import LLMConfig, AnalysisError
from plugins.conversation_atlas.backend.main import create_app
from shared.conversation_store.database import init_db
from shared.conversation_store.store import save_observation


def msg(n, content=None):
    role = 'user' if n % 2 else 'assistant'
    return {'key': f'chatgpt:{n:08x}-0000-4000-8000-000000000000:{role}', 'role': role,
            'content': content or f'本地技术讨论 {n}'}


def seed(i, nums):
    ms = [msg(n) for n in nums]
    save_observation('A', ms, i.source_db, observed_order=[m['key'] for m in ms])


class FakeProvider:
    config = LLMConfig()
    def __init__(self, mode='auto', gate=None):
        self.calls = []; self.mode = mode; self.gate = gate
    def complete(self, system, user):
        data = json.loads(user); self.calls.append(data)
        if self.gate: self.gate.wait(5)
        if self.mode == 'offline': raise AnalysisError('MODEL_UNAVAILABLE', 'offline')
        pending = data['pending']; tail = data['context']['segment']
        if self.mode == 'invalid': content = '{}'
        else:
            groups = [pending] if self.mode != 'split' else [pending[:2], pending[2:]]
            segments = []
            for j, group in enumerate(groups):
                segments.append({'operation': 'extend' if tail and self.mode != 'new' and j == 0 else 'create',
                                 'segment_id': tail['segment_id'] if tail and self.mode != 'new' and j == 0 else None,
                                 'message_ids': [m['key'] for m in group], 'theme_state': '主题继续',
                                 'analysis': {'title': '解释技术方案', 'summary': '讨论技术方案与限制。', 'outcomes': [],
                                              'outcome_evidence': [], 'keywords': ['方案'],
                                              'key_assistant_answers': [{'message_id': group[-1]['key'], 'reason': '解释关键方案'}]}})
            content = json.dumps({'segments': segments})
        return {'content': content, 'model': 'test-model', 'stats': {'request_id': 'test-request',
                'usage': {'prompt_tokens': 100, 'completion_tokens': 200}}}


@pytest.fixture
def index(tmp_path):
    source = tmp_path/'source.db'; init_db(source)
    return IncrementalIndex(source, tmp_path/'atlas_analysis.db')


def wait(runner):
    runner.future.result(timeout=8)
    return runner.latest('A')


def test_real_provider_contract_mocked_incremental_and_restart_no_requests(index):
    seed(index, [1,2]); provider = FakeProvider()
    runner = SemanticIndexer(index, lambda: provider)
    runner.start('A'); assert wait(runner)['status'] == 'completed'
    sid = index.read_segments('A')['segments'][0]['segment_id']
    seed(index, [1,2,3,4]); runner.start('A'); assert wait(runner)['status'] == 'completed'
    assert index.read_segments('A')['segments'][0]['segment_id'] == sid
    assert [m['key'] for m in provider.calls[1]['pending']] == [msg(3)['key'],msg(4)['key']]
    assert set(m['key'] for m in provider.calls[1]['context']['messages']).isdisjoint(m['key'] for m in provider.calls[1]['pending'])
    assert runner.start('A')['status'] == 'no_changes'
    runner.close()
    restarted = SemanticIndexer(index, lambda: pytest.fail('No provider on restart or cache hit'))
    assert restarted.start('A')['status'] == 'no_changes'
    assert len(provider.calls) == 2
    restarted.close()


def test_multiple_topics_and_segment_scoped_exact_user_assistant_api(index):
    seed(index, [1,2,3,4]); provider = FakeProvider('split')
    with TestClient(create_app(index.source_db, index.path, lambda: provider)) as client:
        assert not index.path.exists()
        assert client.get('/api/atlas').json()['segments'] == []
        assert client.post('/api/atlas/index/A').status_code == 403
        assert client.post('/api/atlas/index/A',headers={'x-atlas-action':'manual-analysis','origin':'https://bad.invalid'}).status_code == 403
        assert client.post('/api/atlas/index/A',headers={'x-atlas-action':'manual-analysis'}).status_code == 202
        runner = client.app.state.indexer
        assert wait(runner)['status'] == 'completed'
        graph = client.get('/api/atlas').json()
        assert len(graph['segments']) == 2
        first, second = graph['segments']
        assert first['keyAssistantAnswers'][0]['message_id'] == msg(2)['key']
        path = f"/api/atlas/answer/A/{first['segmentId']}/{msg(2)['key']}"
        answer = client.get(path).json()
        assert answer['answer']['content'] == msg(2)['content']
        assert answer['questions'][0]['key'] == msg(1)['key']
        assert answer['answer']['source_created_at'] is None
        assert client.get(f"/api/atlas/answer/A/{first['segmentId']}/{msg(4)['key']}").status_code == 404
        assert client.get('/api/atlas/index-state/A').json()['source']['appended'] == []
        assert len(provider.calls) == 1


def test_invalid_model_output_never_commits_and_repair_is_limited(index):
    seed(index, [1,2]); provider = FakeProvider('invalid')
    runner = SemanticIndexer(index, lambda: provider)
    runner.start('A'); task = wait(runner)
    assert task['status'] == 'failed' and len(provider.calls) == 2
    assert index.read_segments('A')['segments'] == []
    assert len(index.inspect('A')['appended']) == 2
    assert len(task['calls']) == 2
    assert all(c['status'] == 'invalid' for c in task['calls'])
    runner.close()


def test_duplicate_clicks_and_other_process_runner_cannot_duplicate_calls(index):
    seed(index, [1,2]); gate = threading.Event(); provider = FakeProvider(gate=gate)
    one = SemanticIndexer(index, lambda: provider)
    first = one.start('A')
    two = SemanticIndexer(index, lambda: pytest.fail('Duplicate request'))
    repeated = two.start('A')
    assert repeated['run_id'] == first['run_id']
    gate.set(); assert wait(one)['status'] == 'completed'
    one.close(); two.close()


def test_new_topic_and_failed_tail_preserve_history(index):
    seed(index,[1,2]); p = FakeProvider(); r = SemanticIndexer(index,lambda:p)
    r.start('A'); wait(r)
    sid = index.read_segments('A')['segments'][0]['segment_id']
    seed(index,[1,2,3,4]); p.mode = 'offline'
    r.start('A'); assert wait(r)['status'] == 'failed'
    assert index.read_segments('A')['segments'][0]['segment_id'] == sid
    p.mode = 'new'; r.start('A'); assert wait(r)['status'] == 'completed'
    assert len(index.read_segments('A')['segments']) == 2
    assert len(p.calls[-1]['pending']) == 2
    r.close()


def test_incomplete_turn_and_turn_budget_do_not_silently_split(index):
    seed(index,[1]); r = SemanticIndexer(index,lambda:pytest.fail('No incomplete-turn inference'))
    with pytest.raises(IndexErrorState,match='INCOMPLETE_TURN'): r.start('A')
    seed(index,[1,2,3])
    plan = index.plan('A',complete_turns=True)
    assert [m['key'] for m in plan['pending']] == [msg(1)['key'],msg(2)['key']]
    r.close()


def test_budget_and_usage_audit_no_raw_bodies_or_secrets(index):
    seed(index,[1,2]); p = FakeProvider(); r = SemanticIndexer(index,lambda:p,budget=Budget(requests=1))
    r.start('A'); task=wait(r)
    assert task['requests']==1 and task['input_tokens']==100 and task['output_tokens']==200
    persisted = json.dumps(task,ensure_ascii=False)
    assert '本地技术讨论' not in persisted
    assert json.loads(task['calls'][0]['ranges_json'])['pending']==[msg(1)['key'],msg(2)['key']]
    r.close()


def test_call_failure_in_second_window_keeps_first_checkpoint(index):
    ms=[msg(n,'文'*200) for n in range(1,17)]
    save_observation('A',ms,index.source_db,observed_order=[m['key'] for m in ms])
    p=FakeProvider()
    complete=p.complete
    def second_fails(system,user):
        if p.calls:
            p.calls.append(json.loads(user));raise AnalysisError('MODEL_UNAVAILABLE','offline')
        return complete(system,user)
    p.complete=second_fails
    r=SemanticIndexer(index,lambda:p,budget=Budget(per_input=18000,context=1000))
    r.start('A');task=wait(r)
    assert task['status']=='failed' and task['committed_batches']==1
    assert len(p.calls)==2
    first_keys=[m['key'] for m in p.calls[0]['pending']]
    assert index.inspect('A')['unchanged']==first_keys
    assert set(first_keys).isdisjoint(m['key'] for m in p.calls[1]['pending'])
    r.close()


def test_task_does_not_sweep_new_messages_arriving_after_click(index):
    seed(index,[1,2]);gate=threading.Event();p=FakeProvider(gate=gate)
    r=SemanticIndexer(index,lambda:p);r.start('A')
    seed(index,[1,2,3,4]);gate.set();assert wait(r)['status']=='completed'
    assert len(p.calls)==1 and index.inspect('A')['appended']==[msg(3)['key'],msg(4)['key']]
    r.close()


def test_context_excerpts_are_labelled_bounded_and_source_hashes_remain_full(index):
    seed(index,[1,2]);p=FakeProvider();r=SemanticIndexer(index,lambda:p)
    r.start('A');wait(r)
    # Only a separate deterministic fixture gets a larger indexed historical body.
    with sqlite3.connect(index.source_db) as c:c.execute('update messages set content=? where message_key=?',('长'*3000,msg(2)['key']))
    from plugins.conversation_atlas.backend.incremental_index import fingerprint,encoded
    full=index._source('A')[-1]
    with index._write() as c:c.execute('update atlas_indexed_messages set body_digest=? where message_key=?',(fingerprint(full)['body_digest'],msg(2)['key']))
    save_observation('A',[msg(3),msg(4)],index.source_db,observed_order=[msg(n)['key'] for n in [1,2,3,4]])
    plan=index.plan('A',complete_turns=True,context_excerpt=True,max_context_bytes=1200)
    assert len(encoded(plan['context']).encode())<=1200
    assert plan['context']['messages'][-1]['contextExcerpt']
    assert plan['manifest']['context'][-1]['body_digest']==fingerprint(full)['body_digest']
    r.close()


def test_modified_question_is_not_presented_as_original_answer_context(index):
    seed(index,[1,2]);p=FakeProvider()
    with TestClient(create_app(index.source_db,index.path,lambda:p)) as client:
        runner=client.app.state.indexer;runner.start('A');wait(runner)
        sid=index._state('A')[1][0]['segment_id']
        with sqlite3.connect(index.source_db) as c:c.execute('update messages set content=? where message_key=?',('已修改的问题',msg(1)['key']))
        answer=client.get(f"/api/atlas/answer/A/{sid}/{msg(2)['key']}").json()
        assert answer['questions']==[] and answer['contextStatus']=='unconfirmed'
        assert answer['answer']['content']==msg(2)['content']


def test_source_change_after_inference_never_automatically_reanalyzes(index):
    seed(index,[1,2]);p=FakeProvider();complete=p.complete
    def source_changes(system,user):
        response=complete(system,user)
        with sqlite3.connect(index.source_db) as c:c.execute('update messages set content=? where message_key=?',('推理期间发生的原文真实变化',msg(2)['key']))
        return response
    p.complete=source_changes;r=SemanticIndexer(index,lambda:p)
    r.start('A');task=wait(r)
    assert task['status']=='failed' and task['error_code']=='SOURCE_CHANGED'
    assert len(p.calls)==1 and index.read_segments('A')['segments']==[]
    r.close()
