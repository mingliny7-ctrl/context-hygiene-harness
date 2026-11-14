/** Pure, data-driven Atlas geometry. Rendering and mock data stay outside this module. */
const CORE_ID = "atlas-core";

const size = {
  category: { width: 140, height: 90, radius: 45 },
  conversation: { width: 220, height: 64, radius: 20 },
  segment: { width: 200, height: 64, radius: 18 },
  block: { width: 190, height: 70, radius: 18 },
};

const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const dateValue = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const chronological = (left, right) => dateValue(left.createdAt) - dateValue(right.createdAt)
  || String(left.id).localeCompare(String(right.id), "en");

/** Navigation identity depends on persistent source IDs, never generated titles. */
export const contentBlockId = (segmentId, blockId) => `atlas:block:${encodeURIComponent(segmentId)}:${encodeURIComponent(blockId)}`;

export function contentBlocks(segment) {
  return (segment?.subtopics || []).filter(block => typeof block.block_id === 'string' && block.block_id)
    .map((block, order) => ({...block, id: contentBlockId(segment.id, block.block_id), kind: 'block',
      conversationId: segment.conversationId, segmentId: segment.segmentId,
      segmentNodeId: segment.id, categoryId: segment.categoryId,
      keyAssistantAnswers: block.key_assistant_answers || [],
      messageCount: block.message_ids?.length || 0, order: order + 1}));
}

function node(kind, entity, x, y, parentId, dimensions = size[kind]) {
  return { id: entity.id, kind, entity, x, y, ...dimensions, opacity: 1, parentId };
}

function boundary(source, target) {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.hypot(dx, dy);
  if (!distance) return { x: source.x, y: source.y };
  if (source.kind === "category" || source.kind === "core" || (!source.width && source.radius)) {
    const radius = source.radius || 0;
    return { x: source.x + dx / distance * radius, y: source.y + dy / distance * radius };
  }
  const halfWidth = (source.width || 0) / 2;
  const halfHeight = (source.height || 0) / 2;
  const factor = Math.min(dx ? halfWidth / Math.abs(dx) : Infinity, dy ? halfHeight / Math.abs(dy) : Infinity);
  return { x: source.x + dx * factor, y: source.y + dy * factor };
}

/** One cubic segment in every state, so SVG path strings can morph continuously. */
export function bezierPath(source, target) {
  if (source.planet || target.planet) {
    const center = n => ({ ...n, y: n.y + (n.orbOffsetY || 0), kind: 'core', radius: (n.radius || 0) + 8 });
    const start = boundary(center(source), center(target));
    const end = boundary(center(target), center(source));
    const dx = end.x - start.x, dy = end.y - start.y;
    const length = Math.hypot(dx, dy) || 1;
    const seed = [...String(target.id || '')].reduce((sum, c) => sum + c.charCodeAt(0), 0);
    const bend = (seed % 2 ? 1 : -1) * (18 + seed % 29);
    const number = v => Math.round(v * 100) / 100;
    return `M ${number(start.x)} ${number(start.y)} C ${number(start.x + dx * .28 - dy / length * bend)} ${number(start.y + dy * .28 + dx / length * bend)}, ${number(end.x - dx * .24 - dy / length * bend * .55)} ${number(end.y - dy * .24 + dx / length * bend * .55)}, ${number(end.x)} ${number(end.y)}`;
  }
  const start = boundary(source, target);
  const end = boundary(target, source);
  const bend = (end.x - start.x) * 0.5;
  const number = value => Math.round(value * 100) / 100;
  return `M ${number(start.x)} ${number(start.y)} C ${number(start.x + bend)} ${number(start.y)}, ${number(end.x - bend)} ${number(end.y)}, ${number(end.x)} ${number(end.y)}`;
}

function edgesFor(core, nodes) {
  const parents = new Map([[CORE_ID, { ...core, id: CORE_ID, kind: "core" }], ...nodes.map(item => [item.id, item])]);
  return nodes.filter(item => parents.has(item.parentId)).map(item => {
    const source = parents.get(item.parentId);
    return { id: `edge:${source.id}:${item.id}`, from: source.id, to: item.id, path: bezierPath(source, item) };
  });
}

/** Only confirmed save events rank the home sky. Unknown legacy activity stays searchable. */
export function recentConversations(conversations) {
  return conversations.filter(item => dateValue(item.lastContentSavedAt) > 0)
    .sort((a, b) => dateValue(b.lastContentSavedAt) - dateValue(a.lastContentSavedAt)
      || String(a.id).localeCompare(String(b.id))).slice(0, 6);
}

function overview(conversations, width, height) {
  const core = { x: width / 2, y: height * .43, radius: Math.min(92, width * .11), opacity: 1, homeSky: true };
  const recent = recentConversations(conversations);
  const w = Math.min(168, width * .25);
  // Stable asymmetric pockets; layout never jitters on refresh or depends on title length.
  const pockets = [[-.32,-.22],[.16,-.32],[.37,-.08],[-.39,.20],[.30,.32],[-.18,.37]];
  const radii = [30,23,34,24,27,21];
  const colors = ['#aeb4e2','#d7d2bb','#a7d8cf','#b5c8e8','#dec695','#bfcfbc'];
  const nodes = recent.map((entity, i) => {
    const [px, py] = pockets[i];
    const x = Math.max(w / 2 + 16, Math.min(width - w / 2 - 16, core.x + px * width));
    const y = Math.max(56, Math.min(height - 54, core.y + py * height));
    return node('conversation', entity, x, y, CORE_ID,
      { width: w, height: 100, radius: radii[i], planet: true, orbOffsetY: -18, skyColor: colors[i] });
  });
  return { core, nodes, edges: edgesFor(core, nodes), width, height, requiredHeight: height };
}

/** A single responsive focus coordinate system, independent of entry direction. */
export function computeLayout(data = {}, state = {}, viewport = {}) {
  const width = Math.max(360, finite(viewport.width, 1000));
  const height = Math.max(350, finite(viewport.height, 500));
  const conversations = data.conversations || [];
  const selected = conversations.find(item => item.id === state.conversationId);
  if (!selected) return overview(conversations, width, height);
  const leaves = (data.segments || []).filter(item => item.conversationId === selected.id)
    .sort((a,b) => finite(a.order,0) - finite(b.order,0) || chronological(a,b));
  const selectedSegment = leaves.find(item => item.id === state.segmentId || item.id === state.selectedId)
    || leaves.find(item => contentBlocks(item).some(block => block.id === state.selectedId || block.block_id === state.blockId));
  const blocks = contentBlocks(selectedSegment);
  const sceneWidth = Math.max(blocks.length ? 800 : 560, width);
  const gap = 94;
  const selectedY = Math.max(0, leaves.indexOf(selectedSegment)) * gap;
  const topicY = leaves.map((_, i) => i * gap);
  const blockY = blocks.map((_, i) => selectedY + (i - (blocks.length - 1) / 2) * gap);
  const low = Math.min(0, ...topicY, ...blockY) - 60;
  const high = Math.max(0, ...topicY, ...blockY) + 60;
  const sceneHeight = Math.max(height, high - low);
  const shift = (sceneHeight - (high - low)) / 2 - low;
  const centerY = leaves.length ? (topicY[0] + topicY.at(-1)) / 2 + shift : sceneHeight / 2;
  // The focused particle planet owns the Conversation identity. There is no
  // duplicate rectangular Conversation node between the planet and its topics.
  const core = { id: CORE_ID, kind: 'conversation', conversationId: selected.id,
    entity: selected, x: Math.min(144, sceneWidth * .2), y: centerY,
    radius: 48, opacity: 1 };
  const topicX = sceneWidth * (blocks.length ? .48 : .67);
  const nodes = leaves.map((item,i) => node('segment', item, topicX, topicY[i] + shift, CORE_ID,
    { width: Math.min(210, sceneWidth * .32), height: 70, radius: 22 }));
  nodes.push(...blocks.map((item, i) => node('block', item, sceneWidth * .83,
    blockY[i] + shift, selectedSegment.id, {width: 190, height: 70, radius: 18})));
  return { core, nodes, edges: edgesFor(core,nodes), width: sceneWidth,
    height: sceneHeight, requiredHeight: sceneHeight };
}
