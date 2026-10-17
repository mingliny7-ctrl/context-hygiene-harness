/** Pure, data-driven Atlas geometry. Rendering and mock data stay outside this module. */
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
  const sceneWidth = Math.max(560, width);
  const gap = 94;
  const sceneHeight = Math.max(height, leaves.length * gap + 48);
  const centerY = sceneHeight / 2;
  const core = { x: 56, y: centerY, radius: 31, opacity: .8 };
  const anchor = node('conversation', selected, sceneWidth * .32, centerY, CORE_ID,
    { width: Math.min(208, sceneWidth * .29), height: 72, radius: 24 });
  const nodes = [anchor, ...leaves.map((item,i) => node('segment', item, sceneWidth * .76,
    centerY + (i - (leaves.length - 1)/2) * gap, anchor.id,
    { width: Math.min(210, sceneWidth * .32), height: 70, radius: 22 }))];
  return { core, nodes, edges: edgesFor(core,nodes), width: sceneWidth,
    height: sceneHeight, requiredHeight: sceneHeight };
}
