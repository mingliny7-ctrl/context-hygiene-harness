import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAtlas, loadConversation, normalizeAtlas, searchAtlas } from '../data/atlas-source.mjs';

const payload = () => ({ schemaVersion: 1, provenance: { mode: 'real' }, categories: [{ id: 'unclassified', kind: 'category' }], conversations: [{ id: 'db-A', kind: 'conversation', categoryId: 'unclassified', title: null, createdAt: 'bad', summary: null }], segments: [] });
const ok = (body) => async () => ({ ok: true, json: async () => body });

test('default loads real same-origin endpoint with no-store and does not import demo', async () => {
  let request;
  const graph = await loadAtlas({ fetchImpl: async (...args) => { request = args; return { ok: true, json: async () => payload() }; } });
  assert.equal(request[0], '/api/atlas');
  assert.equal(request[1].cache, 'no-store');
  assert.equal(graph.provenance.mode, 'real');
  assert.equal(graph.conversations[0].id, 'db-A');
  assert.equal(graph.conversations[0].createdAt, null);
  assert.match(graph.conversations[0].title, /未命名/);
  assert.deepEqual(graph.conversations[0].outcomes, []);
  assert.deepEqual(graph.segments, []);
  assert.equal(searchAtlas(graph, 'db-A')[0].id, 'db-A');
});

test('empty data stays genuinely empty', async () => {
  const p = payload(); p.categories = []; p.conversations = [];
  assert.deepEqual((await loadAtlas({ fetchImpl: ok(p) })).conversations, []);
});

test('HTTP, transport, JSON and contract failures reject without fake fallback', async () => {
  await assert.rejects(loadAtlas({ fetchImpl: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
  await assert.rejects(loadAtlas({ fetchImpl: async () => { throw new Error('offline'); } }), /无法连接/);
  await assert.rejects(loadAtlas({ fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('html'); } }) }), /JSON/);
  await assert.rejects(loadAtlas({ fetchImpl: ok({ categories: [] }) }), /数据契约/);
});

test('missing IDs, duplicates and orphan relationships cannot silently map to wrong records', () => {
  const p = payload(); p.conversations[0].id = '';
  assert.throws(() => normalizeAtlas(p), /标识/);
  p.conversations[0].id = 'unclassified';
  assert.throws(() => normalizeAtlas(p), /标识/);
  p.conversations[0].id = 'db-A'; p.conversations[0].categoryId = 'missing';
  assert.throws(() => normalizeAtlas(p), /父子关系/);
});

test('detail preserves exact keys, empty content and conversation identity', async () => {
  const messages = [{ key: 'fallback-turn-2:0:user', role: 'user', content: '<script>not markup</script>' }, { key: 'empty', role: 'assistant', content: '' }];
  let path;
  const detail = await loadConversation('id / encoded', { fetchImpl: async (url) => { path = url; return { ok: true, json: async () => ({ conversationId: 'id / encoded', messages }) }; } });
  assert.equal(path, '/api/atlas/conversations/id%20%2F%20encoded');
  assert.deepEqual(detail.messages, messages);
  await assert.rejects(loadConversation('A', { fetchImpl: ok({ conversationId: 'B', messages }) }), /不一致/);
  await assert.rejects(loadConversation('A', { fetchImpl: ok({ conversationId: 'A', messages: [{ key: '', content: 'raw' }] }) }), /可靠键/);
});

test('cancelled selections propagate cancellation for stale-response protection', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(loadConversation('A', { signal: controller.signal, fetchImpl: async (_, options) => { assert.equal(options.signal.aborted, true); throw new DOMException('cancel', 'AbortError'); } }), { name: 'AbortError' });
});
