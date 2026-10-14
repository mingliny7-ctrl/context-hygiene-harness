import { loadAtlas, searchAtlas } from './data/atlas-source.mjs';
import { computeLayout, bezierPath } from './layout.mjs';
import { ParticleField } from './particles.mjs';

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const icon = (name) => {
  const img = el('img');
  img.src = `icons/${name}.svg`;
  img.alt = '';
  return img;
};
const formatDate = (value) => new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai' }).format(new Date(value));
const dateTime = (value) => new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai', hour12: false }).format(new Date(value));
const typeName = { category: '主题分类', conversation: 'Conversation / 对话', segment: 'Segment / 讨论阶段' };
const state = { categoryId: null, conversationId: null, selectedId: null, inspectorOpen: false };
const nodeElements = new Map();
const edgeElements = new Map();
const removalTimers = new Map();
let data;
let currentLayout;
let lastViewportWidth = 0;
let field;
let paused = false;
let resizeObserver;
let latestResults = [];

function categoryFor(entity) {
  return data.categories.find((category) => category.id === (entity.kind === 'category' ? entity.id : entity.categoryId));
}

function entityById(id) {
  return [...data.categories, ...data.conversations, ...data.segments].find((entity) => entity.id === id);
}

function announce(text) { $('announcer').textContent = text; }

function choose(entity) {
  closeSearch();
  closeRecent();
  state.selectedId = entity.id;
  state.inspectorOpen = true;
  if (entity.kind === 'category') {
    state.categoryId = entity.id;
    state.conversationId = null;
  } else {
    state.categoryId = entity.categoryId;
    state.conversationId = entity.kind === 'conversation' ? entity.id : entity.conversationId;
  }
  renderInspector();
  renderGraph();
  const viewport = $('graph-viewport');
  const selectedNode = currentLayout.nodes.find((item) => item.id === entity.id);
  viewport.scrollTo({
    left: Math.max(0, selectedNode.x - viewport.clientWidth * 0.65),
    top: Math.max(0, selectedNode.y - viewport.clientHeight / 2),
    behavior: reducedMotion() ? 'instant' : 'smooth',
  });
  // Result buttons disappear when a result is chosen. Transfer focus to the graph.
  const selectedButton = nodeElements.get(entity.id);
  selectedButton?.focus({ preventScroll: true });
  announce(`已选择${typeName[entity.kind]}：${entity.title}`);
}

function reducedMotion() { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }

function returnToAtlas() {
  Object.assign(state, { categoryId: null, conversationId: null, selectedId: null, inspectorOpen: false });
  closeSearch();
  closeRecent();
  renderInspector();
  renderGraph();
  $('graph-viewport').scrollTo({ left: Math.max(0, ($('graph-scene').clientWidth - $('graph-viewport').clientWidth) / 2), top: 0, behavior: reducedMotion() ? 'instant' : 'smooth' });
  $('home-nav').focus({ preventScroll: true });
  announce('已返回 Atlas 全景');
}

function closeInspector() {
  state.inspectorOpen = false;
  renderInspector();
  renderGraph();
  nodeElements.get(state.selectedId)?.focus({ preventScroll: true });
  announce('详情已关闭，图谱展开状态保留');
}

function createNode(item) {
  const button = el('button', 'graph-node');
  button.dataset.nodeId = item.id;
  button.append(el('span', 'node-spark'));
  const copy = el('span', 'node-copy');
  copy.append(el('span', 'node-title'), el('span', 'node-meta'));
  button.append(copy, Object.assign(icon('chevron-right'), { className: 'node-chevron' }));
  button.addEventListener('click', () => choose(entityById(item.id)));
  return button;
}

function animateRemoval(key, fn) {
  clearTimeout(removalTimers.get(key));
  removalTimers.set(key, setTimeout(() => { fn(); removalTimers.delete(key); }, reducedMotion() ? 0 : 740));
}

function renderGraph() {
  if (!data) return;
  const expanded = Boolean(state.categoryId);
  $('atlas-app').classList.toggle('expanded', expanded);
  $('back-atlas').hidden = !expanded;
  $('graph-viewport').classList.toggle('has-inspector', state.inspectorOpen);
  const category = data.categories.find((item) => item.id === state.categoryId);
  const conversation = data.conversations.find((item) => item.id === state.conversationId);
  $('breadcrumb-text').textContent = expanded ? [category?.title, conversation?.title].filter(Boolean).join(' / ') : '你的思考，自有引力。';
  $('view-label').textContent = conversation ? '03 / DISCUSSION SEGMENTS' : expanded ? '02 / CONVERSATIONS' : 'OVERVIEW / 全景';
  $('graph-hint').textContent = window.innerWidth < 1100 ? '左右滑动探索图谱 · 点击节点查看详情' : conversation ? '选择讨论阶段，回看每一步思考与决定' : expanded ? '选择一段对话，继续展开它的讨论阶段' : '选择一颗星球，沿着思考的轨迹探索';
  const viewport = $('graph-viewport');
  const width = Math.max(1000, viewport.clientWidth);
  const height = Math.max(500, viewport.clientHeight);
  const layout = computeLayout(data, state, { width, height });
  const resizedOverview = !expanded && lastViewportWidth !== viewport.clientWidth;
  lastViewportWidth = viewport.clientWidth;
  currentLayout = layout;
  $('graph-scene').style.height = `${Math.max(height, layout.requiredHeight || layout.height)}px`;
  $('graph-scene').style.width = `${layout.width}px`;
  if (resizedOverview) viewport.scrollLeft = Math.max(0, (layout.width - viewport.clientWidth) / 2);
  $('connections').setAttribute('viewBox', `0 0 ${layout.width} ${Math.max(height, layout.requiredHeight || layout.height)}`);
  const nextNodes = new Map(layout.nodes.map((item) => [item.id, item]));
  field.setCore(layout.core);
  field.setSatellites(layout.nodes.filter((item) => item.kind === 'category').map((item) => ({ id: item.id, x: item.x, y: item.y - 22, radius: expanded ? 22 : 28, color: item.entity.color, opacity: 0.9 })));
  $('core-label').style.left = `${layout.core.x}px`;
  $('core-label').style.top = `${layout.core.y + layout.core.radius + 24}px`;

  for (const item of layout.nodes) {
    clearTimeout(removalTimers.get(`node:${item.id}`));
    removalTimers.delete(`node:${item.id}`);
    let button = nodeElements.get(item.id);
    const isNew = !button;
    if (isNew) {
      button = createNode(item);
      const parent = nextNodes.get(item.parentId) || layout.core;
      button.style.left = `${parent.x}px`;
      button.style.top = `${parent.y}px`;
      button.style.opacity = '0';
      $('node-layer').append(button);
      nodeElements.set(item.id, button);
    }
    button.inert = false;
    button.tabIndex = 0;
    button.className = `graph-node ${item.kind}${!expanded && item.kind === 'conversation' ? ' overview-conversation' : ''}${item.id === state.selectedId ? ' selected' : ''}`;
    button.style.width = `${item.width}px`;
    button.style.height = `${item.height}px`;
    button.style.setProperty('--node-color', categoryFor(item.entity)?.color || '#d0d4ab');
    button.querySelector('.node-title').textContent = item.entity.title;
    button.querySelector('.node-meta').textContent = item.kind === 'category' ? `${data.conversations.filter((entry) => entry.categoryId === item.id).length} 段对话 · 点击探索` : item.kind === 'conversation' ? `${formatDate(item.entity.updatedAt)} · ${item.entity.segmentCount} 个讨论阶段` : `阶段 ${String(item.entity.order).padStart(2, '0')} · ${item.entity.messageCount} 条消息`;
    button.setAttribute('aria-label', `${typeName[item.kind]}：${item.entity.title}`);
    button.title = item.entity.title;
    button.setAttribute('aria-pressed', String(item.id === state.selectedId));
    if (item.kind !== 'segment') button.setAttribute('aria-expanded', String(item.kind === 'category' ? state.categoryId === item.id : state.conversationId === item.id));
    const updatePosition = () => {
      button.style.left = `${item.x}px`;
      button.style.top = `${item.y}px`;
      button.style.opacity = String(item.opacity ?? 1);
    };
    if (isNew && !reducedMotion()) {
      // Establish a real start frame so newly created nodes grow from their parent.
      button.getBoundingClientRect();
    }
    updatePosition();
  }
  for (const [id, button] of nodeElements) {
    if (nextNodes.has(id) || button.classList.contains('exiting')) continue;
    button.classList.add('exiting');
    button.inert = true;
    button.tabIndex = -1;
    const entity = entityById(id);
    const parentId = entity.kind === 'segment' ? entity.conversationId : entity.categoryId;
    const parent = nextNodes.get(parentId) || layout.core;
    button.style.left = `${parent.x}px`;
    button.style.top = `${parent.y}px`;
    button.style.opacity = '0';
    animateRemoval(`node:${id}`, () => { button.remove(); nodeElements.delete(id); });
  }

  const nextEdges = new Set();
  for (const edge of layout.edges) {
    nextEdges.add(edge.id);
    clearTimeout(removalTimers.get(`edge:${edge.id}`));
    removalTimers.delete(`edge:${edge.id}`);
    let path = edgeElements.get(edge.id);
    if (!path) {
      path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const start = nextNodes.get(edge.from) || layout.core;
      path.style.d = `path("${bezierPath(start, start)}")`;
      path.style.opacity = '0';
      $('edge-layer').append(path);
      edgeElements.set(edge.id, path);
      path.getBoundingClientRect();
    }
    path.classList.toggle('exiting', false);
    path.setAttribute('class', `connection${edge.to === state.selectedId || edge.from === state.selectedId ? ' highlighted' : ''}`);
    path.style.d = `path("${edge.path}")`;
    path.style.opacity = '1';
    // Attribute remains readable for diagnostic tools and non-CSS-d SVG support.
    path.setAttribute('d', edge.path);
  }
  for (const [id, path] of edgeElements) {
    if (nextEdges.has(id) || path.classList.contains('exiting')) continue;
    path.classList.add('exiting');
    path.style.opacity = '0';
    path.style.d = `path("${bezierPath(layout.core, layout.core)}")`;
    animateRemoval(`edge:${id}`, () => { path.remove(); edgeElements.delete(id); });
  }
  $('column-labels').replaceChildren();
  if (expanded) {
    const groups = [['category', '01 / 主题'], ['conversation', '02 / 对话'], ['segment', '03 / 讨论阶段']];
    for (const [kind, label] of groups) {
      const item = layout.nodes.find((node) => node.kind === kind);
      if (item) { const span = el('span', '', label); span.style.left = `${item.x}px`; $('column-labels').append(span); }
    }
  }
}

function inspectorSection(title, content) {
  const section = el('section', 'inspector-section');
  section.append(el('h3', '', title), content);
  return section;
}

function renderInspector() {
  const panel = $('inspector');
  const entity = entityById(state.selectedId);
  panel.hidden = !state.inspectorOpen || !entity;
  if (panel.hidden) return;
  panel.replaceChildren();
  const top = el('div', 'inspector-top');
  const close = el('button', 'icon-button');
  close.setAttribute('aria-label', '关闭详情');
  close.append(icon('x-mark'));
  close.addEventListener('click', closeInspector);
  top.append(el('span', 'eyebrow', 'INSPECTOR / 思考切片'), close);
  const badge = el('span', 'type-badge');
  badge.append(el('i'), document.createTextNode(typeName[entity.kind]));
  panel.append(top, badge, el('h2', '', entity.title), el('p', 'inspector-summary', entity.summary));
  const outcomes = el('ul', 'outcomes');
  entity.outcomes.forEach((text) => outcomes.append(el('li', '', text)));
  panel.append(inspectorSection('关键结论 / OUTCOMES', outcomes));
  const keywords = el('div', 'keywords');
  entity.keywords.forEach((word) => keywords.append(el('span', 'keyword', word)));
  panel.append(inspectorSection('思考的关键词', keywords));
  const metadata = el('dl', 'metadata');
  const rows = [
    ['创建时间', dateTime(entity.createdAt)],
    ['最近更新', dateTime(entity.updatedAt)],
    ['所属主题', categoryFor(entity)?.title || entity.title],
    ['消息数量', `${entity.messageCount} 条 · 模拟`],
  ];
  if (entity.kind === 'category') rows.push(['包含对话', `${entity.conversationCount} 段`]);
  if (entity.kind === 'conversation') rows.push(['讨论阶段', `${entity.segmentCount} 个`]);
  rows.forEach(([key, value]) => metadata.append(el('dt', '', key), el('dd', '', value)));
  panel.append(inspectorSection('时间与关联', metadata));
  if (entity.kind === 'segment') {
    const range = el('div', 'message-range');
    range.append(el('div', '', `消息 ${entity.messageIndexRange.start}–${entity.messageIndexRange.end} · 模拟范围`), el('div', '', entity.messageRange.start), el('div', '', entity.messageRange.end));
    panel.append(inspectorSection('可追溯消息范围', range));
  }
  if (entity.kind === 'conversation') {
    const collapse = el('button', 'source-disabled', '收拢讨论阶段');
    collapse.append(icon('arrow-left'));
    collapse.addEventListener('click', () => {
      state.conversationId = null;
      state.selectedId = state.categoryId;
      renderInspector();
      renderGraph();
      nodeElements.get(state.categoryId)?.focus({ preventScroll: true });
      announce('讨论阶段已收拢');
    });
    panel.append(collapse);
  }
  const source = el('button', 'source-disabled', '打开原始对话 · 尚未接入');
  source.disabled = true;
  source.title = '当前为模拟数据，验收 UI 后再接入真实 Conversation Store。';
  source.append(icon('arrow-up-right'));
  panel.append(source, el('div', 'prototype-note', '演示内容 · 分类、摘要与阶段均为结构化模拟数据，尚未接入真实历史记录或 AI。'), el('div', 'inspector-id', `STABLE ID / ${entity.id}`));
  panel.scrollTop = 0;
}

function resultButton(entity) {
  const button = el('button', 'result-item');
  const copy = el('span');
  copy.append(el('strong', '', entity.title), el('small', '', `${categoryFor(entity)?.title} / ${typeName[entity.kind]} · ${formatDate(entity.updatedAt)}`));
  button.append(copy, icon('arrow-up-right'));
  button.addEventListener('click', () => choose(entity));
  return button;
}

function openSearch() {
  const query = $('search-input').value.trim();
  const results = $('search-results');
  if (!query) { closeSearch(); return; }
  closeRecent();
  latestResults = searchAtlas(data, query);
  results.replaceChildren();
  const heading = el('div', 'result-heading');
  heading.append(el('span', '', `本地关键词匹配 · ${latestResults.length} 个结果`));
  const close = el('button', 'icon-button');
  close.type = 'button';
  close.setAttribute('aria-label', '关闭搜索结果');
  close.append(icon('x-mark'));
  close.addEventListener('click', () => { closeSearch(); $('search-input').focus(); });
  heading.append(close);
  results.append(heading);
  latestResults.slice(0, 15).forEach((entity) => results.append(resultButton(entity)));
  if (!latestResults.length) results.append(el('p', 'empty-search', '还没有找到这个想法。试试“Agent”“设计”或“RAG”。当前只搜索本地演示数据。'));
  results.hidden = false;
  $('search-input').setAttribute('aria-expanded', 'true');
  announce(`本地关键词搜索找到 ${latestResults.length} 个结果`);
}

function closeSearch() {
  $('search-results').hidden = true;
  $('search-input').setAttribute('aria-expanded', 'false');
}

function closeRecent() {
  $('recent-panel').hidden = true;
  $('recent-toggle').setAttribute('aria-expanded', 'false');
}

function setupEvents() {
  $('home-nav').addEventListener('click', returnToAtlas);
  $('back-atlas').addEventListener('click', returnToAtlas);
  document.querySelector('.brand').addEventListener('click', (event) => { event.preventDefault(); returnToAtlas(); });
  $('search-form').addEventListener('submit', (event) => { event.preventDefault(); openSearch(); });
  $('search-input').addEventListener('input', openSearch);
  $('search-input').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' && !$('search-results').hidden) { event.preventDefault(); $('search-results').querySelector('.result-item')?.focus(); }
  });
  document.querySelectorAll('.search-example').forEach((button) => button.addEventListener('click', () => { $('search-input').value = button.dataset.query; openSearch(); $('search-input').focus(); }));
  $('recent-toggle').addEventListener('click', () => {
    const willOpen = $('recent-panel').hidden;
    closeSearch();
    $('recent-panel').hidden = !willOpen;
    $('recent-toggle').setAttribute('aria-expanded', String(willOpen));
  });
  const showGuide = () => { closeRecent(); closeSearch(); $('guide-dialog').showModal(); };
  $('guide-toggle').addEventListener('click', showGuide);
  $('guide-close').addEventListener('click', () => $('guide-dialog').close());
  $('guide-done').addEventListener('click', () => $('guide-dialog').close());
  $('guide-dialog').addEventListener('click', (event) => { if (event.target === $('guide-dialog')) { const rect = event.target.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close(); } });
  $('motion-toggle').addEventListener('click', () => {
    paused = !paused;
    field.setPaused(paused);
    $('motion-toggle').setAttribute('aria-pressed', String(paused));
    $('motion-toggle').querySelector('img').src = `icons/${paused ? 'play' : 'pause'}.svg`;
    $('motion-toggle').querySelector('span').textContent = paused ? '继续动效' : '暂停动效';
  });
  document.addEventListener('keydown', (event) => {
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if (event.key === '/' && !typing && !$('guide-dialog').open) { event.preventDefault(); $('search-input').focus(); }
    if (event.key !== 'Escape' || $('guide-dialog').open) return;
    if (!$('search-results').hidden) { closeSearch(); $('search-input').focus(); }
    else if (!$('recent-panel').hidden) { closeRecent(); $('recent-toggle').focus(); }
    else if (state.inspectorOpen) closeInspector();
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.search-dock')) closeSearch();
    if (!event.target.closest('#recent-toggle, #recent-panel')) closeRecent();
  });
  window.addEventListener('pagehide', () => { field.destroy(); resizeObserver.disconnect(); removalTimers.forEach(clearTimeout); });
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => renderGraph());
}

try {
  data = await loadAtlas();
  field = new ParticleField($('particle-field'));
  const stats = [ [data.categories.length, '主题星球'], [data.conversations.length, '段对话'], [data.segments.length, '个讨论阶段'] ];
  stats.forEach(([count, label], index) => { if (index) $('universe-stats').append(el('span', 'stat-separator')); const stat = el('span', 'stat'); stat.append(el('strong', '', String(count).padStart(2, '0')), el('span', '', label)); $('universe-stats').append(stat); });
  $('recent-count').textContent = String(data.conversations.length).padStart(2, '0');
  $('recent-panel').append(el('h2', '', '最近对话 / 演示数据'));
  [...data.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).slice(0, 6).forEach((entity) => $('recent-panel').append(resultButton(entity)));
  setupEvents();
  resizeObserver = new ResizeObserver(renderGraph);
  resizeObserver.observe($('graph-viewport'));
  renderGraph();
  $('graph-viewport').scrollLeft = Math.max(0, ($('graph-scene').clientWidth - $('graph-viewport').clientWidth) / 2);
} catch (error) {
  console.error('Atlas prototype failed to initialize:', error);
  $('load-error').hidden = false;
  $('load-error').textContent = '图谱暂时无法载入。请通过本地 HTTP 服务启动，并检查浏览器控制台。启动方式见前端 README。';
}
