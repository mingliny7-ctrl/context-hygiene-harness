"""All inference is deterministic; no production data or real API calls."""
import json
import sqlite3
import threading

import pytest
from fastapi.testclient import TestClient

from plugins.conversation_atlas.backend.concept_refinement import ConceptRefiner
from plugins.conversation_atlas.backend.indexer import ExecutionLock, SemanticIndexer
from plugins.conversation_atlas.backend.llm import AnalysisError, LLMConfig
from plugins.conversation_atlas.backend.main import create_app
from test_atlas_topic_management import seed, snapshot


class Provider:
    config = LLMConfig()

    def __init__(self, mode='split', gate=None):
        self.calls = []
        self.mode, self.gate = mode, gate

    def complete(self, system, user):
        material = json.loads(user)
        self.calls.append(material)
        if self.gate:
            self.gate.wait(5)
        if self.mode == 'offline':
            raise AnalysisError('MODEL_UNAVAILABLE', 'offline')
        messages = material['messages']
        keys = [m['key'] for m in messages]
        answer = next(m['key'] for m in messages if m['role'] == 'assistant')
        blocks = [{'block_id': None, 'title': title, 'summary': '独立概念解释',
                   'message_ids': keys, 'key_assistant_answers': [{'message_id': answer, 'reason': '真实回答'}]}
                  for title in ('资源释放', '上下文协议')]
        if self.mode == 'bad-ref':
            blocks[0]['message_ids'] = ['not-in-this-segment']
        if self.mode == 'bad-role':
            blocks[0]['key_assistant_answers'][0]['message_id'] = keys[0]
        value = {'atomic': self.mode == 'atomic', 'subtopics': [] if self.mode == 'atomic' else blocks}
        return {'content': '{}' if self.mode == 'invalid' else json.dumps(value), 'model': 'test-only',
                'stats': {'request_id': 'test', 'usage': {'prompt_tokens': 15, 'completion_tokens': 20}}}


def test_manual_refinement_persists_blocks_and_preserves_source_coverage_and_topic(tmp_path):
    source, derived, index = seed(tmp_path)
    before = snapshot(source, derived)
    provider = Provider()
    with TestClient(create_app(source, derived, lambda: provider)) as client:
        assert client.get('/api/atlas/concepts/A/topic-1').json()['status'] == 'not_started'
        assert provider.calls == []
        assert client.post('/api/atlas/concepts/A/topic-1').status_code == 403
        assert client.post('/api/atlas/concepts/A/topic-1', headers={
            'x-atlas-action': 'manual-analysis', 'origin': 'https://untrusted.invalid'}).status_code == 403
        response = client.post('/api/atlas/concepts/A/topic-1', headers={'x-atlas-action': 'manual-analysis'})
        assert response.status_code == 202, response.text
        client.app.state.refiner.future.result(timeout=5)
        state = client.get('/api/atlas/concepts/A/topic-1').json()
        assert state['status'] == 'completed' and state['blockCount'] == 2
        graph = client.get('/api/atlas').json()
        topic = next(s for s in graph['segments'] if s['conversationId'] == 'A')
        assert len(topic['subtopics']) == 2
        answer = topic['subtopics'][0]['key_assistant_answers'][0]['message_id']
        assert client.get(f'/api/atlas/answer/A/topic-1/{answer}').status_code == 200
        assert client.post('/api/atlas/concepts/A/topic-1', headers={'x-atlas-action': 'manual-analysis'}).json()['cached']
        assert len(provider.calls) == 1
    after = snapshot(source, derived)
    assert before[0] == after[0] and before[2:] == after[2:]
    old, new = json.loads(before[1][0][5]), json.loads(after[1][0][5])
    assert {k: v for k, v in new.items() if k not in ('subtopics', 'concept_refinement')} == {k: v for k, v in old.items() if k not in ('subtopics', 'concept_refinement')}
    with sqlite3.connect(derived) as c:
        assert c.execute('SELECT count(*) FROM atlas_index_calls').fetchone()[0] == 1
        assert c.execute('SELECT status FROM atlas_index_calls').fetchone()[0] == 'committed'
    with TestClient(create_app(source, derived, lambda: pytest.fail('Cached index must not instantiate provider'))) as restarted:
        assert restarted.get('/api/atlas/concepts/A/topic-1').json()['cached']
        assert restarted.post('/api/atlas/concepts/A/topic-1', headers={'x-atlas-action': 'manual-analysis'}).json()['cached']


@pytest.mark.parametrize('mode', ['invalid', 'bad-ref', 'bad-role', 'offline'])
def test_invalid_or_failed_refinement_never_changes_successful_indexes(tmp_path, mode):
    source, derived, index = seed(tmp_path)
    before = snapshot(source, derived)
    refiner = ConceptRefiner(index, lambda: Provider(mode))
    try:
        refiner.start('A', 'topic-1')
        refiner.future.result(timeout=5)
        assert refiner.status('A', 'topic-1')['status'] == 'failed'
        assert snapshot(source, derived) == before
    finally:
        refiner.close()


def test_duplicate_clicks_share_one_task_and_indexer_lock(tmp_path):
    _, _, index = seed(tmp_path)
    gate = threading.Event()
    provider = Provider(gate=gate)
    refiner = ConceptRefiner(index, lambda: provider)
    try:
        first = refiner.start('A', 'topic-1')
        assert refiner.start('A', 'topic-1')['taskId'] == first['taskId']
        with pytest.raises(ValueError, match='TASK_BUSY'):
            refiner.start('B', 'topic-1')
        with pytest.raises(ValueError, match='TASK_BUSY'):
            ExecutionLock(index.path)
        gate.set()
        refiner.future.result(timeout=5)
        assert len(provider.calls) == 1
    finally:
        gate.set()
        refiner.close()


def test_source_changes_during_inference_reject_commit(tmp_path):
    source, derived, index = seed(tmp_path)
    gate = threading.Event()
    provider = Provider(gate=gate)
    before = index._state('A')
    refiner = ConceptRefiner(index, lambda: provider)
    try:
        refiner.start('A', 'topic-1')
        with sqlite3.connect(source) as c:
            c.execute("UPDATE messages SET content='changed longer original content' WHERE conversation_id='A' AND role='assistant'")
        gate.set()
        refiner.future.result(timeout=5)
        assert refiner.tasks[('A', 'topic-1')]['status'] == 'failed'
        assert index._state('A') == before
    finally:
        gate.set()
        refiner.close()


def test_atomic_topic_cached_and_oversize_is_not_sent(tmp_path):
    _, _, index = seed(tmp_path)
    provider = Provider('atomic')
    refiner = ConceptRefiner(index, lambda: provider)
    refiner.start('A', 'topic-1'); refiner.future.result(timeout=5)
    assert refiner.status('A', 'topic-1')['atomic']
    refiner.close()
    provider = Provider()
    provider.config = LLMConfig(context_tokens=2200, output_tokens=100)
    refiner = ConceptRefiner(index, lambda: provider)
    try:
        refiner.start('B', 'topic-1'); refiner.future.result(timeout=5)
        assert refiner.status('B', 'topic-1')['errorCode'] == 'TOPIC_TOO_LARGE'
        assert provider.calls == []
    finally:
        refiner.close()


def test_topic_visibility_api_preserves_coverage_and_counts(tmp_path):
    source, derived, index = seed(tmp_path)
    before = snapshot(source, derived)
    action = {'x-atlas-action': 'manage-conversation'}
    with TestClient(create_app(source, derived)) as client:
        assert client.post('/api/atlas/topics/A/topic-1/hide').status_code == 403
        assert client.post('/api/atlas/topics/A/topic-1/hide', headers=action).status_code == 200
        graph = client.get('/api/atlas').json()
        assert graph['quality']['storedSegmentCount'] == 2
        assert [s['conversationId'] for s in graph['segments']] == ['B']
        assert client.get('/api/atlas/hidden').json()['topics'][0]['segmentId'] == 'topic-1'
        assert client.post('/api/atlas/topics/A/topic-1/restore', headers=action).status_code == 200
        assert len(client.get('/api/atlas').json()['segments']) == 2
        assert index.inspect('A')['appended'] == []
    assert snapshot(source, derived) == before


def test_permanent_delete_cannot_race_active_refinement(tmp_path):
    source, derived, _ = seed(tmp_path)
    gate = threading.Event()
    with TestClient(create_app(source, derived, lambda: Provider(gate=gate))) as client:
        try:
            client.post('/api/atlas/concepts/A/topic-1', headers={'x-atlas-action':'manual-analysis'})
            response = client.delete('/api/atlas/conversations/A', headers={'x-atlas-action':'manage-conversation'})
            assert response.status_code == 409
            assert client.get('/api/atlas/conversations/A').status_code == 200
        finally:
            gate.set()
            client.app.state.refiner.future.result(timeout=5)


def test_incomplete_block_coverage_and_duplicate_source_are_rejected(tmp_path):
    source, derived, index = seed(tmp_path)
    provider = Provider()
    original = provider.complete
    def missing_user(system, user):
        result = original(system,user)
        value = json.loads(result['content'])
        for block in value['subtopics']:
            block['message_ids'] = block['message_ids'][1:]
        result['content'] = json.dumps(value)
        return result
    provider.complete = missing_user
    before = snapshot(source,derived)
    refiner = ConceptRefiner(index,lambda:provider)
    try:
        refiner.start('A','topic-1'); refiner.future.result(timeout=5)
        assert refiner.status('A','topic-1')['errorCode'] == 'CONCEPT_COVERAGE_INVALID'
        assert snapshot(source,derived) == before
    finally:
        refiner.close()
