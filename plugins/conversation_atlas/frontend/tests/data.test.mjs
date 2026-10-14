import test from 'node:test';
import assert from 'node:assert/strict';
import { mockAtlas } from '../data/mock-atlas.mjs';
import { loadAtlas, searchAtlas } from '../data/atlas-source.mjs';

test('mock graph has globally stable IDs, complete metadata and valid parents', () => {
  assert.equal(mockAtlas.provenance.mode, 'mock');
  assert.equal(mockAtlas.categories.length, 5);
  assert.equal(mockAtlas.conversations.length, 15);
  assert.equal(mockAtlas.segments.length, 45);
  const entities = [...mockAtlas.categories, ...mockAtlas.conversations, ...mockAtlas.segments];
  assert.equal(new Set(entities.map((entity) => entity.id)).size, entities.length);

  const categories = new Map(mockAtlas.categories.map((entity) => [entity.id, entity]));
  const conversations = new Map(mockAtlas.conversations.map((entity) => [entity.id, entity]));
  for (const entity of entities) {
    assert.match(entity.id, /^(cat|conv|seg)-[a-z-]+$/);
    assert.ok(entity.title && entity.summary);
    assert.ok(Array.isArray(entity.keywords) && entity.keywords.length);
    assert.ok(Array.isArray(entity.outcomes) && entity.outcomes.length);
    assert.ok(Number.isFinite(Date.parse(entity.createdAt)));
    assert.ok(Date.parse(entity.updatedAt) >= Date.parse(entity.createdAt));
    assert.equal('x' in entity || 'y' in entity, false, 'source data must not encode layout');
  }
  for (const category of mockAtlas.categories) {
    assert.equal(category.kind, 'category');
    assert.match(category.color, /^#[0-9a-f]{6}$/i);
    const children = mockAtlas.conversations.filter((entity) => entity.categoryId === category.id);
    assert.equal(category.conversationCount, children.length);
    assert.equal(category.messageCount, children.reduce((sum, child) => sum + child.messageCount, 0));
  }
  for (const conversation of mockAtlas.conversations) {
    assert.equal(conversation.kind, 'conversation');
    assert.ok(categories.has(conversation.categoryId));
    const children = mockAtlas.segments.filter((entity) => entity.conversationId === conversation.id);
    assert.equal(conversation.segmentCount, children.length);
    assert.equal(conversation.messageCount, children.reduce((sum, child) => sum + child.messageCount, 0));
    assert.deepEqual(children.map((entity) => entity.order), [1, 2, 3]);
    let lastEnd = 0;
    for (const segment of children) {
      assert.equal(segment.kind, 'segment');
      assert.equal(segment.categoryId, conversation.categoryId);
      assert.equal(conversations.get(segment.conversationId), conversation);
      const { start, end } = segment.messageIndexRange;
      assert.equal(start, lastEnd + 1);
      assert.equal(segment.messageCount, end - start + 1);
      assert.ok(end <= conversation.messageCount);
      assert.equal(segment.messageRange.start, `mock-msg-${conversation.id}-${String(start).padStart(3, '0')}`);
      assert.equal(segment.messageRange.end, `mock-msg-${conversation.id}-${String(end).padStart(3, '0')}`);
      lastEnd = end;
    }
  }
});

test('loadAtlas creates isolated snapshots and never mutates the fixture', async () => {
  const first = await loadAtlas({ mode: 'demo' });
  const second = await loadAtlas({ mode: 'demo' });
  assert.deepEqual(first, mockAtlas);
  first.categories[0].title = 'changed';
  first.segments[0].outcomes.push('changed');
  assert.equal(second.categories[0].title, 'Agent 工程');
  assert.notEqual(mockAtlas.categories[0].title, 'changed');
  assert.equal(second.segments[0].outcomes.includes('changed'), false);
});

test('category matches preserve scope and full navigation metadata', () => {
  const results = searchAtlas(mockAtlas, '产品设计');
  assert.equal(results.length, 12);
  assert.ok(results.every((result) => result.categoryId === 'cat-design'));
  assert.equal(results.filter((result) => result.kind === 'conversation').length, 3);
  assert.equal(results.filter((result) => result.kind === 'segment').length, 9);
  for (const result of results) {
    assert.ok(result.summary && result.outcomes.length && result.conversationId);
    if (result.kind === 'conversation') assert.equal(result.conversationId, result.id);
  }
});

test('search uses AND terms, ranks direct titles and handles case/fullwidth normalization', () => {
  assert.deepEqual(searchAtlas(mockAtlas, '  '), []);
  assert.deepEqual(searchAtlas(mockAtlas, '不存在的关键词'), []);
  assert.deepEqual(searchAtlas(mockAtlas, 'RAG'), searchAtlas(mockAtlas, 'ｒａｇ'));
  assert.deepEqual(searchAtlas(mockAtlas, 'Debug'), searchAtlas(mockAtlas, 'DEBUG'));
  assert.equal(searchAtlas(mockAtlas, '可靠出口')[0].id, 'seg-agent-loop-exit');
  const narrowed = searchAtlas(mockAtlas, '产品设计 贝塞尔');
  assert.ok(narrowed.length > 0);
  assert.ok(narrowed.every((result) => result.categoryId === 'cat-design'));
  assert.ok(narrowed.some((result) => result.id === 'seg-design-motion-curves'));
  const exactTitle = searchAtlas(mockAtlas, '让 Agent 完成一次真实任务');
  assert.equal(exactTitle[0].id, 'conv-agent-loop');
  assert.equal(exactTitle.length, 4, 'parent title should resolve both its conversation and segments');
  assert.deepEqual(searchAtlas(mockAtlas, 'RAG'), searchAtlas(mockAtlas, 'RAG'), 'repeat calls must be deterministic');
});
