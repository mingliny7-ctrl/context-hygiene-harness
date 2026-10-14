import test from "node:test";
import assert from "node:assert/strict";
import { computeLayout, bezierPath } from "../layout.mjs";
import { mockAtlas } from "../data/mock-atlas.mjs";

const date = offset => new Date(Date.UTC(2026, 0, 1 + offset)).toISOString();

function fixture(categoryCount, conversationCount = categoryCount, segmentCount = 3) {
  const categories = Array.from({ length: categoryCount }, (_, index) => ({ id: `category-${index}`, createdAt: date(index) }));
  const conversations = Array.from({ length: conversationCount }, (_, index) => ({
    id: `conversation-${index}`, categoryId: categories[index % categoryCount]?.id, createdAt: date(index),
  }));
  const segments = conversations.flatMap((conversation, index) => Array.from({ length: segmentCount }, (_, order) => ({
    id: `segment-${index}-${order}`, conversationId: conversation.id, createdAt: date(index + order), order: order + 1,
  })));
  return { categories, conversations, segments };
}

function assertFinite(layout) {
  for (const item of [layout.core, ...layout.nodes]) for (const key of ["x", "y", "radius", "opacity"]) {
    assert.ok(Number.isFinite(item[key]), `${item.id || "core"}.${key}`);
  }
  assert.ok(layout.width >= 1000);
  assert.ok(layout.height >= 500);
  assert.equal(layout.height, layout.requiredHeight);
  for (const item of layout.nodes) {
    assert.ok(item.entity);
    assert.equal(item.id, item.entity.id);
    assert.ok(item.y - item.height / 2 >= 0);
    assert.ok(item.y + item.height / 2 <= layout.requiredHeight);
  }
  for (const edge of layout.edges) {
    assert.match(edge.path, /^M [-\d.]+ [-\d.]+ C [-\d.]+ [-\d.]+, [-\d.]+ [-\d.]+, [-\d.]+ [-\d.]+$/);
    assert.doesNotMatch(edge.path, /NaN|Infinity/);
  }
}

function assertColumnsDoNotOverlap(layout) {
  for (const kind of ["conversation", "segment"]) {
    const nodes = layout.nodes.filter(item => item.kind === kind).sort((a, b) => a.y - b.y);
    for (let index = 1; index < nodes.length; index += 1) {
      if (nodes[index].x === nodes[index - 1].x) {
        assert.ok(nodes[index].y - nodes[index - 1].y >= (nodes[index].height + nodes[index - 1].height) / 2 + 14);
      }
    }
  }
}

test("overview supports 0, 1, and 20 categories with stable entities and finite paths", () => {
  for (const count of [0, 1, 20]) {
    const data = fixture(count);
    const layout = computeLayout(data, {}, { width: 320, height: 240 });
    assertFinite(layout);
    assert.equal(layout.nodes.filter(item => item.kind === "category").length, count);
    assert.equal(layout.nodes.filter(item => item.kind === "conversation").length, count);
    for (let index = 0; index < layout.nodes.length; index += 1) {
      const left = layout.nodes[index];
      for (const right of layout.nodes.slice(index + 1)) {
        assert.ok(Math.abs(left.x - right.x) >= (left.width + right.width) / 2 + 14
          || Math.abs(left.y - right.y) >= (left.height + right.height) / 2 + 14, `${left.id} overlaps ${right.id}`);
      }
    }
  }
});

test("overview selects the latest conversation by timestamp, independently of input order", () => {
  const data = fixture(1, 3, 0);
  data.conversations.reverse();
  const layout = computeLayout(data);
  assert.equal(layout.nodes.find(item => item.kind === "conversation").id, "conversation-2");
});

test("five-category mock overview fits standard viewports and keeps core label clear", () => {
  for (const viewport of [{ width: 1388, height: 573 }, { width: 1000, height: 500 }]) {
    const layout = computeLayout(mockAtlas, {}, viewport);
    assertFinite(layout);
    assert.equal(layout.width, viewport.width);
    assert.equal(layout.height, viewport.height);
    assert.equal(layout.core.radius, 80);
    const label = { x: layout.core.x, y: layout.core.y + 149, width: 320, height: 90 };
    for (const item of layout.nodes) {
      assert.ok(item.x - item.width / 2 >= 0);
      assert.ok(item.x + item.width / 2 <= viewport.width);
      if (item.kind === "category") assert.ok(item.y - 50 >= 0, "particle satellite remains inside graph");
      assert.ok(Math.abs(item.x - label.x) >= (item.width + label.width) / 2 + 14
        || Math.abs(item.y - label.y) >= (item.height + label.height) / 2 + 14, `${item.id} crosses core label`);
    }
  }
});

test("hierarchy follows left to right columns and chronological order", () => {
  const data = fixture(1, 20, 3);
  data.conversations.reverse();
  const state = { categoryId: "category-0", conversationId: "conversation-0" };
  const layout = computeLayout(data, state, { width: 1000, height: 500 });
  assertFinite(layout);
  assertColumnsDoNotOverlap(layout);
  assert.deepEqual(layout.nodes.filter(item => item.kind === "conversation").map(item => item.id),
    Array.from({ length: 20 }, (_, index) => `conversation-${index}`));
  assert.equal(layout.core.x, 90);
  assert.equal(layout.nodes.find(item => item.kind === "category").x, 245);
  assert.equal(layout.nodes.find(item => item.kind === "conversation").x, 520);
  assert.equal(layout.nodes.find(item => item.kind === "segment").x, 820);
  assert.ok(layout.requiredHeight > 500);
});

test("hierarchy supports empty, single, and large conversation columns", () => {
  for (const count of [0, 1, 20]) {
    const layout = computeLayout(fixture(1, count, 0), { categoryId: "category-0" });
    assertFinite(layout);
    assertColumnsDoNotOverlap(layout);
    assert.equal(layout.nodes.filter(item => item.kind === "conversation").length, count);
    if (count > 6) assert.ok(layout.requiredHeight > 500);
  }
});

test("segment ranges stay centered on their conversation with no sibling collisions", () => {
  for (const count of [0, 1, 3, 7, 20]) {
    const data = fixture(1, 3, count);
    const state = { categoryId: "category-0", conversationId: "conversation-0" };
    const layout = computeLayout(data, state, { width: 1380, height: 500 });
    assertFinite(layout);
    assertColumnsDoNotOverlap(layout);
    const parent = layout.nodes.find(item => item.id === state.conversationId);
    const leaves = layout.nodes.filter(item => item.kind === "segment");
    if (leaves.length) assert.equal((leaves[0].y + leaves.at(-1).y) / 2, parent.y);
    if (count > 6) assert.ok(layout.requiredHeight > 500);
  }
});

test("chronological ties break by stable ID and invalid state safely returns overview", () => {
  const data = fixture(1, 3, 0);
  data.conversations.forEach(item => { item.createdAt = date(0); });
  const state = { categoryId: "category-0", conversationId: "not-in-category" };
  const first = computeLayout(data, state);
  data.conversations.reverse();
  assert.deepEqual(computeLayout(data, state), first);
  assert.equal(first.nodes.filter(item => item.kind === "segment").length, 0);
  assertFinite(computeLayout(data, { categoryId: "deleted" }, { width: NaN, height: Infinity }));
});

test("segments preserve explicit message order when their timestamps tie", () => {
  const data = fixture(1, 1, 3);
  data.segments.forEach(item => { item.createdAt = date(0); });
  data.segments.reverse();
  const layout = computeLayout(data, { categoryId: "category-0", conversationId: "conversation-0" });
  assert.deepEqual(layout.nodes.filter(item => item.kind === "segment").map(item => item.entity.order), [1, 2, 3]);
});

test("bezier endpoints use sphere and button boundaries with one morphable cubic", () => {
  const category = { x: 245, y: 250, radius: 45, width: 140, height: 90, kind: "category" };
  const conversation = { x: 520, y: 250, radius: 20, width: 220, height: 64, kind: "conversation" };
  assert.equal(bezierPath(category, conversation), "M 290 250 C 350 250, 350 250, 410 250");
  assert.doesNotMatch(bezierPath(category, category), /NaN|Infinity/);
});
