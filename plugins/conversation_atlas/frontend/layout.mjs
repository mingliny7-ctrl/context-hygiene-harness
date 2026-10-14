/** Pure, data-driven Atlas geometry. Rendering and mock data stay outside this module. */
const MIN_WIDTH = 1000;
const MIN_HEIGHT = 500;
const MARGIN = 52;
const CORE_ID = "atlas-core";

const size = {
  category: { width: 140, height: 90, radius: 45 },
  conversation: { width: 220, height: 64, radius: 20 },
  segment: { width: 200, height: 64, radius: 18 },
};

const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const dateValue = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const chronological = (left, right) => dateValue(left.createdAt) - dateValue(right.createdAt)
  || String(left.id).localeCompare(String(right.id), "en");

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

function overlaps(left, right, gap = 14) {
  return Math.abs(left.x - right.x) < (left.width + right.width) / 2 + gap
    && Math.abs(left.y - right.y) < (left.height + right.height) / 2 + gap;
}

function overview(categories, conversations, width, requestedHeight) {
  const coreRadius = 80;
  if (!categories.length) {
    const core = { x: width / 2, y: requestedHeight / 2, radius: coreRadius, opacity: 1 };
    return { core, nodes: [], edges: [], width, height: requestedHeight, requiredHeight: requestedHeight };
  }

  const latest = new Map();
  for (const conversation of [...conversations].sort(chronological)) latest.set(conversation.categoryId, conversation);
  let radiusX = Math.max(416, width * 0.31);
  let radiusY = Math.max(189, requestedHeight * 0.378);
  let nodes = [];
  // Expanding the ellipse preserves the composition while allowing any data count.
  // The finite cap also prevents hostile/malformed data from causing an endless layout loop.
  for (let attempt = 0; attempt < 300; attempt += 1) {
    nodes = [];
    categories.forEach((category, index) => {
      const angle = -Math.PI / 2 + index / categories.length * Math.PI * 2;
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      const categoryNode = node("category", category, cosine * radiusX, sine * radiusY, CORE_ID);
      nodes.push(categoryNode);
      const conversation = latest.get(category.id);
      if (conversation) {
        // Treat each category and its recent conversation as one vertical cluster.
        // The 82px center gap leaves 14px between their interactive bounding boxes.
        nodes.push(node("conversation", conversation,
          categoryNode.x,
          categoryNode.y + 82,
          category.id,
          { width: 172, height: 46, radius: 18 }));
      }
    });
    const coreBox = { x: 0, y: 0, width: coreRadius * 2, height: coreRadius * 2 };
    const labelBox = { x: 0, y: coreRadius + 69, width: 320, height: 90 };
    const colliding = nodes.some((item, index) => overlaps(item, coreBox, 3) || overlaps(item, labelBox, 14)
      || nodes.slice(index + 1).some(other => overlaps(item, other)));
    if (!colliding) break;
    radiusX += 12;
    radiusY += 28;
  }

  // Category particle satellites extend 50px above the button's center.
  const top = Math.min(-coreRadius, ...nodes.map(item => item.y - (item.kind === "category" ? 50 : item.height / 2)));
  const bottom = Math.max(coreRadius + 114, ...nodes.map(item => item.y + item.height / 2));
  const offset = Math.max(requestedHeight * 0.48, -top + 1);
  const requiredHeight = Math.ceil(Math.max(requestedHeight, bottom + offset + 1));
  const requiredWidth = Math.ceil(Math.max(width, 2 * (Math.max(...nodes.map(item => Math.abs(item.x) + item.width / 2)) + 14)));
  for (const item of nodes) { item.x += requiredWidth / 2; item.y += offset; }
  const core = { x: requiredWidth / 2, y: offset, radius: coreRadius, opacity: 1 };
  return { core, nodes, edges: edgesFor(core, nodes), width: requiredWidth, height: requiredHeight, requiredHeight };
}

/**
 * Input: {categories, conversations, segments}, UI state, available scene dimensions.
 * Node x/y are centers. The scene keeps a 1000px minimum width; its host owns scrolling.
 */
export function computeLayout(data = {}, state = {}, viewport = {}) {
  const width = Math.max(MIN_WIDTH, finite(viewport.width, MIN_WIDTH));
  const requestedHeight = Math.max(MIN_HEIGHT, finite(viewport.height, MIN_HEIGHT));
  const categories = [...(data.categories || [])].sort(chronological);
  const conversations = data.conversations || [];
  const segments = data.segments || [];
  const category = categories.find(item => item.id === state.categoryId);
  if (!category) return overview(categories, conversations, width, requestedHeight);

  const children = conversations.filter(item => item.categoryId === category.id).sort(chronological);
  const selectedConversation = children.find(item => item.id === state.conversationId);
  const leaves = selectedConversation
    ? segments.filter(item => item.conversationId === selectedConversation.id)
      .sort((left, right) => finite(left.order, 0) - finite(right.order, 0) || chronological(left, right))
    : [];
  const rowGap = 92;
  const segmentGap = 86;
  const scaleX = width / MIN_WIDTH;
  const initialHeight = Math.max(requestedHeight, (children.length - 1) * rowGap + size.conversation.height + MARGIN * 2);
  const centerY = initialHeight / 2;
  const core = { x: 90 * scaleX, y: centerY, radius: 44, opacity: 1 };
  const nodes = [node("category", category, 245 * scaleX, centerY, CORE_ID)];
  children.forEach((conversation, index) => nodes.push(node("conversation", conversation,
    520 * scaleX, centerY + (index - (children.length - 1) / 2) * rowGap, category.id)));
  const parentNode = nodes.find(item => item.id === selectedConversation?.id);
  if (parentNode) leaves.forEach((segment, index) => nodes.push(node("segment", segment,
    820 * scaleX, parentNode.y + (index - (leaves.length - 1) / 2) * segmentGap, parentNode.id)));

  const top = Math.min(core.y - core.radius, ...nodes.map(item => item.y - item.height / 2));
  const bottom = Math.max(core.y + core.radius, ...nodes.map(item => item.y + item.height / 2));
  const offset = Math.max(0, MARGIN - top);
  core.y += offset;
  for (const item of nodes) item.y += offset;
  const requiredHeight = Math.ceil(Math.max(initialHeight, bottom + offset + MARGIN));
  return { core, nodes, edges: edgesFor(core, nodes), width, height: requiredHeight, requiredHeight };
}
