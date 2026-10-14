import { loadAtlas, loadConversation, searchAtlas } from './data/atlas-source.mjs';
import { openMessages } from './messages.mjs';
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
const formatDate = (value) => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai' }).format(new Date(value)) : '时间未知';
const dateTime = (value) => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai', hour12: false }).format(new Date(value)) : '未记录';
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
let detailController;
let detailGeneration = 0;
const sourceMode = new URLSearchParams(location.search).get('source') === 'demo' ? 'demo' : 'real';
const isReal = () => data?.provenance.mode === 'real';

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
  $('view-label').textContent = conversation && isReal() ? '03 / STORED CONVERSATION' : conversation ? '03 / DISCUSSION SEGMENTS' : expanded ? '02 / CONVERSATIONS' : 'OVERVIEW / 全景';
  $('graph-hint').textContent = isReal() && !data.conversations.length ? '暂无已存储会话 · 打开已有 ChatGPT 对话并使用现有采集扩展同步' : window.innerWidth < 1100 ? '滚动探索图谱 · 点击节点查看详情' : conversation && isReal() ? '讨论阶段尚未处理 · 在详情中定位已存储原文' : conversation ? '选择讨论阶段，回看每一步思考与决定' : expanded ? '选择一段对话，查看已存储内容' : '选择一颗星球，沿着思考的轨迹探索';
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
    button.querySelector('.node-meta').textContent = item.kind === 'category' ? `${data.conversations.filter((entry) => entry.categoryId === item.id).length} 段对话 · 点击探索` : item.kind === 'conversation' && isReal() ? `${item.entity.messageCount} 条 · ${item.id.slice(-8)} · ${item.entity.quality?.suspectedTestRecord ? '疑似测试' : '未处理'}` : item.kind === 'conversation' ? `${formatDate(item.entity.updatedAt)} · ${item.entity.segmentCount} 个讨论阶段` : `阶段 ${String(item.entity.order).padStart(2, '0')} · ${item.entity.messageCount} 条消息`;
    button.setAttribute('aria-label', `${typeName[item.kind]}：${item.entity.title}`);
    button.title = item.entity.title;
    button.setAttribute('aria-pressed', String(item.id === state.selectedId));
    if (item.kind !== 'segment') button.setAttribute('aria-expanded', String(item.kind === 'category' ? state.categoryId === item.id : state.conversationId === item.id && data.segments.some((segment) => segment.conversationId === item.id)));
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
  detailController?.abort();
  detailGeneration += 1;
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
  if (isReal() && !entity.outcomes.length) outcomes.append(el('li', '', '尚未生成结论；当前只读取已存储原文。'));
  panel.append(inspectorSection('关键结论 / OUTCOMES', outcomes));
  const keywords = el('div', 'keywords');
  entity.keywords.forEach((word) => keywords.append(el('span', 'keyword', word)));
  if (isReal() && !entity.keywords.length) keywords.append(el('span', 'keyword', '分类 / 关键词未处理'));
  panel.append(inspectorSection('思考的关键词', keywords));
  const metadata = el('dl', 'metadata');
  const rows = [
    [isReal() ? '首次入库时间' : '创建时间', dateTime(entity.createdAt)],
    [isReal() ? '最近同步时间' : '最近更新', dateTime(entity.updatedAt)],
    ['所属主题', categoryFor(entity)?.title || entity.title],
    ['消息数量', `${entity.messageCount} 条${isReal() ? ' · 已存储' : ' · 模拟'}`],
  ];
  if (entity.kind === 'category') rows.push(['包含对话', `${entity.conversationCount} 段`]);
  if (entity.kind === 'conversation') rows.push(['讨论阶段', isReal() ? '未处理' : `${entity.segmentCount} 个`]);
  rows.forEach(([key, value]) => metadata.append(el('dt', '', key), el('dd', '', value)));
  panel.append(inspectorSection('时间与关联', metadata));
  if (entity.kind === 'segment') {
    const range = el('div', 'message-range');
    range.append(el('div', '', `消息 ${entity.messageIndexRange.start}–${entity.messageIndexRange.end} · 模拟范围`), el('div', '', entity.messageRange.start), el('div', '', entity.messageRange.end));
    panel.append(inspectorSection('可追溯消息范围', range));
  }
  if (entity.kind === 'conversation' && !isReal()) {
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
  if (isReal()) {
    if (entity.kind === 'conversation') {
      panel.querySelector('.inspector-summary').prepend(document.createTextNode('原文摘录（非 AI 摘要）：'));
      const q = entity.quality || {};
      panel.append(el('div', 'prototype-note', `完整性未知 · ${q.emptyMessageCount || 0} 条空正文 · ${q.fallbackKeyCount || 0} 条 fallback 键。仅保证首次观察顺序。${q.suspectedTestRecord ? ' 此 ID 带 test- 前缀，疑似测试记录；未当作真实用户成果。' : ''}`));
      loadInspectorMessages(entity, panel);
    } else {
      panel.append(el('div', 'prototype-note', '未分类是当前 UI 的虚拟分组，不是 AI 分析结果。尚未生成摘要、关键词、结论或讨论阶段。'));
    }
    panel.append(el('div', 'inspector-id', `${entity.kind === 'category' ? 'VIRTUAL GROUP ID' : 'DATABASE ID'} / ${entity.id}`));
    panel.scrollTop = 0;
    return;
  }
  const source = el('button', 'source-disabled', '打开原始对话 · 尚未接入');
  source.disabled = true;
  source.title = '当前为模拟数据，验收 UI 后再接入真实 Conversation Store。';
  source.append(icon('arrow-up-right'));
  panel.append(source, el('div', 'prototype-note', '演示内容 · 分类、摘要与阶段均为结构化模拟数据，尚未接入真实历史记录或 AI。'), el('div', 'inspector-id', `STABLE ID / ${entity.id}`));
  panel.scrollTop = 0;
}

async function loadInspectorMessages(entity, panel) {
  const generation = detailGeneration;
  detailController = new AbortController();
  const content = el('div', 'stored-messages');
  const section = inspectorSection('原始消息 / SQLITE', content);
  const open = el('button', 'source-disabled source-enabled', '正在读取原文…');
  open.disabled = true;
  panel.querySelector('h2').after(open);
  content.append(el('p', 'inspector-summary', '正在读取对应原文…'));
  panel.append(section);
  try {
    const detail = await loadConversation(entity.id, { signal: detailController.signal });
    if (generation !== detailGeneration || !state.inspectorOpen || state.selectedId !== entity.id) return;
    content.replaceChildren();
    open.textContent = `查看全部 ${detail.messages.length} 条原始消息`;
    open.disabled = false;
    open.addEventListener('click', () => openMessages(detail, entity.title, entity.previewMessageKey));
    content.append(el('p', 'inspector-summary', `${detail.messages.length} 条已存储消息 · 点击预览定位`));
    detail.messages.slice(0, 4).forEach((message, index) => {
      const button = el('button', 'message-preview');
      button.dataset.messageKey = message.key;
      button.append(el('small', '', `观察序号 ${index + 1} · ${message.role}`), el('span', '', message.content.trim() ? message.content.slice(0, 130) : '〔正文为空〕'), el('code', '', message.key));
      button.addEventListener('click', () => openMessages(detail, entity.title, message.key));
      content.append(button);
    });
    if (!detail.messages.length) content.append(el('p', 'empty-search', '此会话尚无已存储消息。'));
  } catch (error) {
    if (generation !== detailGeneration || detailController.signal.aborted) return;
    open.textContent = '重试读取原文';
    open.disabled = false;
    open.addEventListener('click', () => choose(entity));
    content.replaceChildren(el('p', 'prototype-note', error.message));
    const retry = el('button', 'source-disabled source-enabled', '重试读取原文');
    retry.addEventListener('click', () => choose(entity));
    content.append(retry);
  }
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
  if (!latestResults.length) results.append(el('p', 'empty-search', isReal() ? '暂无匹配。当前只搜索已加载的标题、原文摘录和 ID，不搜索完整正文，也不进行语义检索。' : '还没有找到这个想法。试试“Agent”“设计”或“RAG”。当前只搜索本地演示数据。'));
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
    if (event.key !== 'Escape' || $('guide-dialog').open || document.getElementById('raw-dialog')?.open) return;
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

async function initialize() {
  if (sourceMode === 'real') {
    $('search-input').setAttribute('aria-label', '搜索已存储会话');
    $('search-scope').textContent = '标题 / 摘录 / ID · 关键词匹配';
  }
try {
  $('load-error').hidden = true;
  $('source-label').textContent = '正在读取…';
  data = await loadAtlas({ mode: sourceMode });
  field = new ParticleField($('particle-field'));
  $('universe-stats').replaceChildren();
  $('recent-panel').replaceChildren();
  $('source-label').textContent = isReal() ? 'SQLite · 已采集' : '演示数据';
  $('search-input').setAttribute('aria-label', isReal() ? '搜索已存储会话' : '搜索演示对话');
  if (isReal()) {
    $('search-scope').textContent = '标题 / 摘录 / ID · 关键词匹配';
    $('guide-note').textContent = '当前读取现有 SQLite。完整历史与原始顺序未验证；分类、阶段和结论尚未处理。点击会话详情中的原文入口，可按存储消息键定位记录。演示模式只可通过 ?source=demo 明确开启。';
    const q = data.quality || {};
    $('data-notice').hidden = false;
    $('data-notice').textContent = `${data.conversations.length} 条持久化会话 · ${q.messageCount || 0} 条消息 · ${q.emptyMessageCount || 0} 条空正文 · 完整性未知${q.suspectedTestRecordCount ? ` · 含 ${q.suspectedTestRecordCount} 条疑似测试 ID` : ''}`;
  }
  const stats = isReal() ? [[data.conversations.length, '存储会话'], [data.quality?.messageCount || 0, '已采集消息'], [data.segments.length, '阶段 · 待处理']] : [ [data.categories.length, '主题星球'], [data.conversations.length, '段对话'], [data.segments.length, '个讨论阶段'] ];
  stats.forEach(([count, label], index) => { if (index) $('universe-stats').append(el('span', 'stat-separator')); const stat = el('span', 'stat'); stat.append(el('strong', '', String(count).padStart(2, '0')), el('span', '', label)); $('universe-stats').append(stat); });
  $('recent-count').textContent = String(data.conversations.length).padStart(2, '0');
  $('recent-panel').append(el('h2', '', isReal() ? '最近入库会话 / SQLite' : '最近对话 / 演示数据'));
  [...data.conversations].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '') || a.id.localeCompare(b.id)).slice(0, 6).forEach((entity) => $('recent-panel').append(resultButton(entity)));
  if (!data.conversations.length) $('recent-panel').append(el('p', 'empty-search', '暂无已存储会话。'));
  setupEvents();
  resizeObserver = new ResizeObserver(renderGraph);
  resizeObserver.observe($('graph-viewport'));
  renderGraph();
  $('graph-viewport').scrollLeft = Math.max(0, ($('graph-scene').clientWidth - $('graph-viewport').clientWidth) / 2);
} catch (error) {
  console.error('Atlas failed to initialize:', error.message);
  $('source-label').textContent = '读取失败';
  $('load-error').hidden = false;
  $('load-error').replaceChildren(el('p', '', error.message), el('p', 'prototype-note', '没有回退到模拟数据。请运行 scripts/start_atlas.ps1 启动独立 Atlas 服务。'));
  const retry = el('button', 'primary-button', '重试加载');
  retry.addEventListener('click', initialize);
  $('load-error').append(retry);
}
}
await initialize();
