"""Page-open analysis uses isolated sources and deterministic providers only."""
import threading

from fastapi.testclient import TestClient

from plugins.conversation_atlas.backend.main import create_app
from plugins.conversation_atlas.backend.indexer import Budget
from test_semantic_indexer import FakeProvider, msg
from shared.conversation_store.database import init_db
from shared.conversation_store.store import save_observation


def prepare(tmp_path, count=1):
    source, derived = tmp_path/'source.db', tmp_path/'index.db'
    init_db(source)
    for cid in ['A','B','C'][:count]:
        messages = [msg(1), msg(2)]
        save_observation(cid,messages,source,observed_order=[m['key'] for m in messages])
    return source, derived


def test_open_is_explicit_endpoint_but_no_manual_click_required_and_restart_reuses(tmp_path):
    source, derived = prepare(tmp_path)
    provider = FakeProvider()
    with TestClient(create_app(source,derived,lambda:provider)) as client:
        assert client.get('/api/atlas').status_code == 200
        assert provider.calls == []
        assert client.post('/api/atlas/auto-index').status_code == 403
        assert client.post('/api/atlas/auto-index',headers={'x-atlas-action':'open-analysis','origin':'https://bad.invalid'}).status_code == 403
        assert client.post('/api/atlas/auto-index',headers={'x-atlas-action':'open-analysis'}).status_code == 202
        client.app.state.auto_index.future.result(timeout=8)
        assert client.get('/api/atlas/auto-index').json()['status'] == 'completed'
        assert len(provider.calls) == 1
        assert len(client.get('/api/atlas').json()['segments']) == 1
    with TestClient(create_app(source,derived,lambda:provider)) as client:
        client.post('/api/atlas/auto-index',headers={'x-atlas-action':'open-analysis'})
        client.app.state.auto_index.future.result(timeout=8)
        assert client.get('/api/atlas/auto-index').json()['requests'] == 0
        assert len(provider.calls) == 1


def test_open_has_one_shared_budget_and_skips_hidden_and_unreliable(tmp_path):
    source, derived = prepare(tmp_path,3)
    provider = FakeProvider()
    with TestClient(create_app(source,derived,lambda:provider,budget=Budget(requests=1))) as client:
        client.post('/api/atlas/conversations/C/hide',headers={'x-atlas-action':'manage-conversation'})
        client.post('/api/atlas/auto-index',headers={'x-atlas-action':'open-analysis'})
        client.app.state.auto_index.future.result(timeout=8)
        state=client.get('/api/atlas/auto-index').json()
        assert state['requests'] == 1 and len(provider.calls) == 1
        assert state['status'] == 'paused'
        assert client.get('/api/atlas/index-state/C').json()['source']['unchanged'] == []


def test_failed_auto_range_is_not_charged_again_on_reopen_but_manual_retry_works(tmp_path):
    source, derived = prepare(tmp_path)
    provider = FakeProvider('offline')
    with TestClient(create_app(source,derived,lambda:provider)) as client:
        for _ in range(2):
            client.post('/api/atlas/auto-index',headers={'x-atlas-action':'open-analysis'})
            client.app.state.auto_index.future.result(timeout=8)
        assert len(provider.calls) == 1
        provider.mode='auto'
        client.post('/api/atlas/index/A',headers={'x-atlas-action':'manual-analysis'})
        client.app.state.indexer.future.result(timeout=8)
        assert len(provider.calls) == 2
        assert client.get('/api/atlas/index-state/A').json()['source']['appended'] == []


def test_auto_duplicate_open_and_manual_task_do_not_run_same_range_twice(tmp_path):
    source, derived = prepare(tmp_path)
    gate = threading.Event()
    provider = FakeProvider(gate=gate)
    with TestClient(create_app(source,derived,lambda:provider)) as client:
        try:
            client.post('/api/atlas/index/A',headers={'x-atlas-action':'manual-analysis'})
            for _ in range(2):
                assert client.post('/api/atlas/auto-index',headers={'x-atlas-action':'open-analysis'}).status_code==202
                client.app.state.auto_index.future.result(timeout=8)
            assert client.get('/api/atlas/auto-index').json()['errorCode']=='TASK_BUSY'
            assert len(provider.calls)<=1
        finally:
            gate.set()
            client.app.state.indexer.future.result(timeout=8)
        assert len(provider.calls)==1


def test_unordered_and_empty_sources_do_not_create_model_or_derived_database(tmp_path):
    source, derived=prepare(tmp_path,0)
    save_observation('untrusted',[msg(1),msg(2)],source)
    with TestClient(create_app(source,derived,lambda:(_ for _ in ()).throw(AssertionError('No provider')))) as client:
        client.post('/api/atlas/auto-index',headers={'x-atlas-action':'open-analysis'})
        client.app.state.auto_index.future.result(timeout=8)
        assert client.get('/api/atlas/auto-index').json()['requests']==0
        assert not derived.exists()


def test_trailing_unanswered_question_is_left_pending_without_failing_completed_turn(tmp_path):
    source,derived=prepare(tmp_path)
    messages=[msg(1),msg(2),msg(3)]
    save_observation('A',messages,source,observed_order=[m['key'] for m in messages])
    provider=FakeProvider()
    with TestClient(create_app(source,derived,lambda:provider)) as client:
        client.post('/api/atlas/auto-index',headers={'x-atlas-action':'open-analysis'})
        client.app.state.auto_index.future.result(timeout=8)
        state=client.get('/api/atlas/index-state/A').json()
        assert state['task']['status']=='completed'
        assert state['source']['appended']==[msg(3)['key']]
        assert [m['key'] for m in provider.calls[0]['pending']]==[msg(1)['key'],msg(2)['key']]
