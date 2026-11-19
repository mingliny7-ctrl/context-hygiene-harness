import { loadAtlas, loadConversation, searchAtlas, atlasChanged } from './data/atlas-source.mjs';
import { VisiblePoller } from './polling.mjs';
import { openMessages, openAnswer } from './messages.mjs';
import { IndexControls, OpenAnalysisControls, indexRequest, indexReason } from './index-controls.mjs';
import { computeLayout, bezierPath, contentBlocks } from './layout.mjs';
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
const typeName = { category: '主题分类', conversation: '对话星球', segment: '主题', block: '概念分块' };
const state = { categoryId: null, conversationId: null, segmentId: null, selectedId: null, inspectorOpen: false, blockId: null };
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
let indexControls;
let openAnalysisControls;
let pollTimer;
let refreshingGraph = false;
let refinementView = null;
const sourceMode = new URLSearchParams(location.search).get('source') === 'demo' ? 'demo' : 'real';
const isReal = () => data?.provenance.mode === 'real';

function categoryFor(entity) {
  return data.categories.find((category) => category.id === (entity.kind === 'category' ? entity.id : entity.categoryId));
}

function entityById(id) {
  return [...data.categories, ...data.conversations, ...data.segments,
    ...data.segments.flatMap(contentBlocks)].find((entity) => entity.id === id);
}

function announce(text) { $('announcer').textContent = text; }

function choose(entity) {
  if (!entity) return;
  closeSearch();
  closeRecent();
  state.blockId = entity.kind === 'block' ? entity.block_id : null;
  state.segmentId = entity.kind === 'block' ? entity.segmentNodeId : entity.kind === 'segment' ? entity.id : null;
  state.selectedId = entity.id;
  state.inspectorOpen = entity.kind !== 'conversation';
  if (entity.kind === 'category') {
    state.categoryId = entity.id;
    state.conversationId = null;
  } else {
    state.categoryId = entity.categoryId;
    state.conversationId = entity.kind === 'conversation' ? entity.id : entity.conversationId;
  }
  renderInspector();
  renderGraph();
  updateAnalysisScope();
  const viewport = $('graph-viewport');
  const selectedNode = currentLayout.nodes.find((item) => item.id === entity.id) || currentLayout.core;
  viewport.scrollTo({
    left: Math.max(0, selectedNode.x - viewport.clientWidth * 0.65),
    top: Math.max(0, selectedNode.y - viewport.clientHeight / 2),
    behavior: reducedMotion() ? 'instant' : 'smooth',
  });
  // Result buttons disappear when a result is chosen. Transfer focus to the graph.
  const selectedButton = nodeElements.get(entity.id) || (entity.kind === 'conversation' ? $('core-open') : null);
  selectedButton?.focus({ preventScroll: true });
  announce(`已选择${typeName[entity.kind]}：${entity.title}`);
}

function reducedMotion() { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }

function returnToAtlas() {
  Object.assign(state, { categoryId: null, conversationId: null, segmentId: null, selectedId: null, blockId: null, inspectorOpen: false });
  closeSearch();
  closeRecent();
  renderInspector();
  renderGraph();
  $('graph-viewport').scrollTo({ left: Math.max(0, ($('graph-scene').clientWidth - $('graph-viewport').clientWidth) / 2), top: 0, behavior: reducedMotion() ? 'instant' : 'smooth' });
  updateAnalysisScope();
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
  const highlight = active => {
    if (!button.classList.contains('overview-conversation')) return;
    for (const [id, path] of edgeElements) {
      if (id === `edge:atlas-core:${item.id}`) path.classList.toggle('hovered', active);
    }
  };
  button.addEventListener('pointerenter', () => highlight(true));
  button.addEventListener('pointerleave', () => highlight(false));
  button.addEventListener('focus', () => highlight(true));
  button.addEventListener('blur', () => highlight(false));
  button.addEventListener('click', () => choose(entityById(item.id)));
  button.addEventListener('contextmenu', event => {
    if (!isReal()) return;
    event.preventDefault();
    const entity = entityById(item.id);
    if (entity?.kind === 'conversation') showConversationMenu(entity);
    else if (entity?.kind === 'segment') showTopicMenu(entity);
  });
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
  $('conversation-manage').hidden = !(conversation && isReal());
  $('breadcrumb-text').textContent = expanded ? [category?.title, conversation?.title].filter(Boolean).join(' / ') : '你的思考，自有引力。';
  $('view-label').textContent = conversation && isReal() ? '03 / STORED CONVERSATION' : conversation ? '03 / DISCUSSION SEGMENTS' : expanded ? '02 / CONVERSATIONS' : 'OVERVIEW / 全景';
  const viewport = $('graph-viewport');
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
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
  field.setSatellites(layout.nodes.filter((item) => item.kind === 'category' || item.planet).map((item) => ({ id: item.id, x: item.x, y: item.y + (item.orbOffsetY ?? -22), radius: item.planet ? item.radius : expanded ? 22 : 28, color: item.skyColor || categoryFor(item.entity)?.color || '#a9c4b5', corona: Boolean(item.planet), opacity: 0.9 })));
  $('core-label').style.left = `${layout.core.x}px`;
  $('core-label').style.top = `${layout.core.y + layout.core.radius + 24}px`;
  $('core-title').textContent = conversation?.title || 'Conversation Atlas';
  $('core-open').hidden = !conversation;
  $('core-open').textContent = '阅读原文';
  $('core-menu').hidden = !(conversation && isReal());
  $('core-label').classList.toggle('conversation-label', Boolean(conversation));

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
    button.style.setProperty('--node-color', item.skyColor || categoryFor(item.entity)?.color || '#d0d4ab');
    button.style.setProperty('--planet-size', `${item.radius * 2}px`);
    button.style.setProperty('--planet-label-top', `${32 + item.radius + 9}px`);
    button.style.setProperty('--planet-delay', `${-layout.nodes.indexOf(item) * 1.3}s`);
    button.querySelector('.node-title').textContent = item.entity.title;
    button.querySelector('.node-meta').textContent = item.kind === 'category' ? `${data.conversations.filter((entry) => entry.categoryId === item.id).length} 段对话` : item.kind === 'conversation' && isReal() ? `${item.entity.messageCount} 条消息 · ${item.entity.segmentCount || 0} 个主题` : item.kind === 'conversation' ? `${formatDate(item.entity.updatedAt)} · ${item.entity.segmentCount} 个主题` : item.kind === 'block' ? '独立概念 · 可追溯原文' : item.entity.subtopics?.length ? `${item.entity.subtopics.length} 个概念分块` : item.entity.conceptRefinement?.atomic ? '单一概念' : '尚未细分 · 点击查看';
    button.setAttribute('aria-label', `${typeName[item.kind]}：${item.entity.title}`);
    button.title = item.entity.title;
    button.setAttribute('aria-pressed', String(item.id === state.selectedId));
    if (item.kind === 'segment') button.setAttribute('aria-expanded', String(state.segmentId === item.id && Boolean(item.entity.subtopics?.length)));
    else if (item.kind !== 'block') button.setAttribute('aria-expanded', String(item.kind === 'category' ? state.categoryId === item.id : state.conversationId === item.id));
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
    const parentId = entity?.kind === 'block' ? entity.segmentNodeId : entity?.kind === 'segment' ? entity.conversationId : entity?.categoryId;
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
      path.flow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.flow.setAttribute('class', 'gravity-flow');
      path.flow.setAttribute('aria-hidden', 'true');
      $('edge-layer').append(path.flow);
      edgeElements.set(edge.id, path);
      path.getBoundingClientRect();
    }
    path.classList.toggle('exiting', false);
    path.setAttribute('class', `connection${!expanded ? ' gravity-line' : ''}${edge.to === state.selectedId || edge.from === state.selectedId ? ' highlighted' : ''}`);
    path.style.setProperty('--line-delay', `${-layout.edges.indexOf(edge) * 1.7}s`);
    const skyTarget = nextNodes.get(edge.to);
    path.style.setProperty('--gravity-color', skyTarget?.skyColor || '#bfcfbc');
    path.flow.style.setProperty('--gravity-color', skyTarget?.skyColor || '#bfcfbc');
    path.flow.style.setProperty('--line-delay', `${-layout.edges.indexOf(edge) * 1.7}s`);
    path.flow.style.display = expanded ? 'none' : '';
    path.flow.style.d = `path("${edge.path}")`;
    path.flow.setAttribute('d', edge.path);
    path.style.d = `path("${edge.path}")`;
    path.style.opacity = '1';
    // Attribute remains readable for diagnostic tools and non-CSS-d SVG support.
    path.setAttribute('d', edge.path);
  }
  for (const [id, path] of edgeElements) {
    if (nextEdges.has(id) || path.classList.contains('exiting')) continue;
    path.classList.add('exiting');
    path.style.opacity = '0';
    path.flow.style.display = 'none';
    path.style.d = `path("${bezierPath(layout.core, layout.core)}")`;
    animateRemoval(`edge:${id}`, () => { path.flow.remove(); path.remove(); edgeElements.delete(id); });
  }
  $('column-labels').replaceChildren();
  if (expanded) {
    const groups = [['segment', '主题'], ['block', '概念分块']];
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

function summaryContent(text, keywords = []) {
  const content = el('div','inspector-summary');
  // Presentation only: every source sentence remains; safe nodes instead of model HTML.
  const paragraphs = text.includes('\n') ? text.split(/\n+/) : (text.match(/[^。！？]+[。！？]?/g) || [text]);
  let group = '';
  const add = value => {
    const p = el('p');
    for (const part of value.split(/(\*\*[^*]+\*\*)/g)) {
      if (part.startsWith('**')) {p.append(el('strong','',part.slice(2,-2))); continue;}
      const keyword=keywords.slice(0,3).find(word=>word.length>1 && part.includes(word));
      if (!keyword) p.append(document.createTextNode(part));
      else {const at=part.indexOf(keyword);p.append(document.createTextNode(part.slice(0,at)),el('strong','',keyword),document.createTextNode(part.slice(at+keyword.length)));}
    }
    content.append(p);
  };
  for (const paragraph of paragraphs) {
    group += paragraph;
    if (group.length >= 95 || text.includes('\n')) { add(group); group=''; }
  }
  if (group) add(group);
  return content;
}

function renderInspector() {
  detailController?.abort(); detailGeneration += 1;
  const panel = $('inspector');
  const entity = entityById(state.selectedId);
  panel.hidden = !state.inspectorOpen || !entity;
  if (panel.hidden) return;
  panel.replaceChildren();
  const top = el('div','inspector-top');
  const close = el('button','icon-button'); close.setAttribute('aria-label','关闭详情'); close.append(icon('x-mark'));
  close.addEventListener('click',closeInspector);
  top.append(el('span','eyebrow','思考切片'),close); panel.append(top);
  const parent = entity.kind === 'block' ? entityById(entity.segmentNodeId) : entity;
  const block = entity.kind === 'block' ? entity : null;
  if (block) {
    const back = el('button','back-button',`返回 ${parent.title}`);
    back.addEventListener('click',()=>choose(parent)); panel.append(back);
  }
  const shown = block || entity;
  panel.append(el('h2','',shown.title),summaryContent(shown.summary,parent.keywords));
  if (entity.kind === 'block') renderKeyAnswers(parent,panel,entity.keyAssistantAnswers,entity.title);
  if (entity.kind === 'segment') {
    const blocks = entity.subtopics || [];
    if (isReal()) {
      const actions = el('div','topic-actions');
      const manage = el('button','quiet-button manage-entry','移除主题');
      manage.addEventListener('click',()=>showTopicMenu(entity)); actions.append(manage);
      panel.querySelector('h2').after(actions);
    }
    if (!block && blocks.length) {
      const list=el('div','content-blocks');
      for (const child of contentBlocks(entity)) {
        const button=el('button','answer-reference');
        button.append(el('strong','',child.title),el('small','',child.summary));
        button.addEventListener('click',()=>choose(child)); list.append(button);
      }
      panel.append(inspectorSection('概念分块',list));
      renderKeyAnswers(entity,panel);
    } else {
      if (isReal()) renderRefinement(entity,panel);
      renderKeyAnswers(entity,panel);
    }
  }
  if (!block && entity.outcomes?.length) {
    const list=el('ul','outcomes');
    entity.outcomes.forEach(text=>list.append(el('li','',text)));
    panel.append(inspectorSection('讨论要点',list));
  }
  if (!block && entity.keywords?.length) {
    const words=el('div','keywords'); entity.keywords.forEach(word=>words.append(el('span','keyword',word)));panel.append(words);
  }
  if (entity.kind==='conversation' && isReal()) loadInspectorMessages(entity,panel);
  panel.scrollTop=0;
}

async function loadInspectorMessages(entity, panel) {
  const generation = detailGeneration;
  detailController = new AbortController();
  const content = el('div', 'stored-messages');
  const section = inspectorSection('对话原文', content);
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
    content.append(el('p', 'inspector-summary', `${detail.messages.length} 条已存储消息 · 主题与关键回答在图谱中展开，原文入口可读取全部记录。`));
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

async function manageRequest(path, method='GET') {
  const response = await fetch(path, {method, cache:'no-store',
    headers:method==='GET' ? {} : {'x-atlas-action':'manage-conversation'}, signal:AbortSignal.timeout(15000)});
  let body;
  try { body = await response.json(); } catch { throw new Error(`本地服务返回 HTTP ${response.status}`); }
  if (!response.ok) throw new Error(body.detail?.message || body.detail || `本地服务返回 HTTP ${response.status}`);
  return body;
}

async function showCollection(kind) {
  if (!isReal()) return;
  const dialog=$('collection-dialog'), list=$('collection-list');
  $('collection-title').textContent=kind==='hidden'?'已隐藏的对话与主题':'我的收藏';
  list.replaceChildren(el('p','empty-search','正在读取…'));
  if (!dialog.open) dialog.showModal();
  try {
    const payload=await manageRequest(kind==='hidden'?'/api/atlas/hidden':'/api/atlas/bookmarks');
    if (!dialog.open) return;
    list.replaceChildren();
    const rows=kind==='hidden'?payload.conversations:payload.bookmarks;
    if (!rows.length && !(kind==='hidden' && payload.topics?.length)) list.append(el('p','empty-search',kind==='hidden'?'还没有隐藏的对话或主题。':'还没有收藏的模型回答。'));
    for (const row of rows) {
      const article=el('article','collection-item');
      article.append(el('strong','',row.title));
      if (kind==='hidden') {
        article.append(el('small','',`${row.messageCount} 条已保存消息，原文与主题仍保留`));
        const restore=el('button','quiet-button','恢复到图谱');
        restore.addEventListener('click',async()=>{
          restore.disabled=true;
          try {await manageRequest(`/api/atlas/conversations/${encodeURIComponent(row.conversationId)}/restore`,'POST');await refreshGraph();await showCollection('hidden');}
          catch(error){announce(error.message);restore.disabled=false;}
        }); article.append(restore);
      } else {
        article.append(el('p','',row.preview));
        const open=el('button','quiet-button','查看完整回答');
        open.addEventListener('click',async()=>{
          open.disabled=true;
          try {const detail=await manageRequest(`/api/atlas/bookmarks/${encodeURIComponent(row.conversationId)}/${encodeURIComponent(row.messageKey)}/answer`);
            dialog.close();openAnswer(detail,row.title);}
          catch(error){announce(error.message);open.disabled=false;}
        }); article.append(open);
        const locate=el('button','quiet-button','在对话中定位');
        locate.addEventListener('click',async()=>{
          locate.disabled=true;
          try {const detail=await loadConversation(row.conversationId);dialog.close();openMessages(detail,row.title,row.messageKey);}
          catch(error){announce(error.message);locate.disabled=false;}
        }); article.append(locate);
        const remove=el('button','quiet-button','取消收藏');
        remove.addEventListener('click',async()=>{
          remove.disabled=true;
          try {await manageRequest(`/api/atlas/bookmarks/${encodeURIComponent(row.conversationId)}/${encodeURIComponent(row.messageKey)}`,'DELETE');await showCollection('bookmarks');}
          catch(error){announce(error.message);remove.disabled=false;}
        }); article.append(remove);
      }
      list.append(article);
    }
    if (kind==='hidden' && payload.topics?.length) {
      list.append(el('h3','','已移除主题'));
      for (const row of payload.topics) {
        const article=el('article','collection-item');
        article.append(el('strong','',row.title),el('small','',row.conversationTitle));
        const restore=el('button','quiet-button','恢复主题');
        restore.addEventListener('click',async()=>{
          restore.disabled=true;
          try {await manageRequest(`/api/atlas/topics/${encodeURIComponent(row.conversationId)}/${encodeURIComponent(row.segmentId)}/restore`,'POST');await refreshGraph();await showCollection('hidden');}
          catch(error){article.append(el('p','reading-limitation',error.message));restore.disabled=false;}
        });
        article.append(restore);list.append(article);
      }
    }
  } catch(error) {list.replaceChildren(el('p','empty-search',error.message));}
}

function showConversationMenu(target) {
  const conversation=target?.kind === 'conversation' ? target : data.conversations.find(item=>item.id===state.conversationId);
  if (!conversation) return;
  const dialog=$('manage-dialog'), list=$('manage-options');
  $('manage-title').textContent=conversation.title;
  list.replaceChildren();
  const add=(label,action,className='quiet-button')=>{const button=el('button',className,label);button.addEventListener('click',action);list.append(button);};
  add('阅读对话原文',async()=>{
    dialog.close();
    try {openMessages(await loadConversation(conversation.id),conversation.title);}
    catch(error){announce(error.message);}
  });
  add('从图谱隐藏',async()=>{
    dialog.close();
    try {await manageRequest(`/api/atlas/conversations/${encodeURIComponent(conversation.id)}/hide`,'POST');returnToAtlas();await refreshGraph();announce('已从图谱隐藏；可在“已隐藏对话”中恢复。');}
    catch(error){announce(error.message);}
  });
  add('永久删除本地数据',()=>{dialog.close();showDeleteConfirmation(conversation);},'danger-button');
  dialog.showModal();
}

function showTopicMenu(topic) {
  if (!topic || !isReal()) return;
  const dialog=$('manage-dialog'), list=$('manage-options');
  $('manage-title').textContent=`移除主题：${topic.title}`;
  list.replaceChildren(el('p','reading-limitation','仅从图谱移除本主题及其概念节点，保留原始对话、索引和收藏。可在“已隐藏”中恢复；不会重新分析。'));
  const remove=el('button','danger-button','从图谱移除主题');
  remove.addEventListener('click',async()=>{
    remove.disabled=true;
    try {
      await manageRequest(`/api/atlas/topics/${encodeURIComponent(topic.conversationId)}/${encodeURIComponent(topic.segmentId)}/hide`,'POST');
      dialog.close(); state.segmentId=null; state.blockId=null; state.selectedId=topic.conversationId; state.inspectorOpen=false;
      await refreshGraph(); renderInspector(); renderGraph(); announce('主题已移除，可在已隐藏列表中恢复。');
    } catch(error) {remove.disabled=false;list.append(el('p','reading-limitation',error.message));}
  });
  list.append(remove); dialog.showModal();
}

function showDeleteConfirmation(conversation) {
  const dialog=$('delete-dialog'), button=$('delete-confirm');
  $('delete-title').textContent=`永久删除：${conversation.title}`;
  $('delete-error').hidden=true;
  button.disabled=false;
  button.onclick=async()=>{
    button.disabled=true;
    try {await manageRequest(`/api/atlas/conversations/${encodeURIComponent(conversation.id)}`,'DELETE');
      dialog.close();returnToAtlas();await refreshGraph();announce('本地对话已永久删除，采集器不会自动重新导入。');}
    catch(error){$('delete-error').textContent=error.message;$('delete-error').hidden=false;button.disabled=false;}
  };
  dialog.showModal();
}

function setupEvents() {
  $('hidden-toggle').addEventListener('click',()=>showCollection('hidden'));
  $('bookmarks-toggle').addEventListener('click',()=>showCollection('bookmarks'));
  $('collection-close').addEventListener('click',()=>$('collection-dialog').close());
  $('conversation-manage').addEventListener('click',showConversationMenu);
  $('core-menu').addEventListener('click',showConversationMenu);
  $('core-open').addEventListener('click',async()=>{
    const conversation=data.conversations.find(item=>item.id===state.conversationId);
    if (!conversation) return;
    try {openMessages(await loadConversation(conversation.id),conversation.title);}
    catch(error) {announce(error.message);}
  });
  $('manage-close').addEventListener('click',()=>$('manage-dialog').close());
  $('delete-close').addEventListener('click',()=>$('delete-dialog').close());
  $('delete-cancel').addEventListener('click',()=>$('delete-dialog').close());
  $('refine-close').addEventListener('click',()=>$('refine-dialog').close());
  $('refine-cancel').addEventListener('click',()=>$('refine-dialog').close());
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
    $('atlas-app').classList.toggle('motion-paused', paused);
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
  window.addEventListener('pagehide', () => { pollTimer?.stop(); field.destroy(); resizeObserver.disconnect(); removalTimers.forEach(clearTimeout); });
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
    $('guide-note').textContent = '打开 Atlas 自动检查并按本次预算分析新增内容，已完成索引直接复用。失败范围可用分析按钮重试；主题概念细分仍需确认预算。尚未采集的历史仍未知。';
    const q = data.quality || {};
  }
  const stats = isReal() ? [[data.quality?.storedConversationCount || 0, '存储会话'], [data.quality?.messageCount || 0, '已采集消息'], [data.quality?.storedSegmentCount || 0, '已索引主题']] : [ [data.categories.length, '主题星球'], [data.conversations.length, '段对话'], [data.segments.length, '个讨论阶段'] ];
  stats.forEach(([count, label], index) => { if (index) $('universe-stats').append(el('span', 'stat-separator')); const stat = el('span', 'stat'); stat.append(el('strong', '', String(count).padStart(2, '0')), el('span', '', label)); $('universe-stats').append(stat); });
  $('recent-count').textContent = String(data.conversations.length).padStart(2, '0');
  $('recent-panel').append(el('h2', '', isReal() ? '最近入库会话 / SQLite' : '最近对话 / 演示数据'));
  [...data.conversations].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '') || a.id.localeCompare(b.id)).slice(0, 6).forEach((entity) => $('recent-panel').append(resultButton(entity)));
  if (!data.conversations.length) $('recent-panel').append(el('p', 'empty-search', '暂无已存储会话。'));
  setupEvents();
  if (isReal()) {
    indexControls = new IndexControls({button:$('analyze-new'),scope:$('analysis-scope'),status:$('analysis-status'),onUpdate:refreshGraph});
    openAnalysisControls = new OpenAnalysisControls({status:$('auto-analysis-status'),onUpdate:refreshGraph});
    openAnalysisControls.open();
    pollTimer = new VisiblePoller(async () => {
      await refreshGraph(true);
      await indexControls.refresh();
      await refreshRefinement();
      await openAnalysisControls.refresh();
    });
    pollTimer.start();
  }
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

function updateAnalysisScope() {
  const conversation = data.conversations.find(item => item.id === state.conversationId);
  indexControls?.select(conversation?.id || null, conversation?.title);
}

async function refreshGraph(checkRevision = false) {
  if (!isReal() || refreshingGraph) return;
  refreshingGraph = true;
  try {
    if (checkRevision && !await atlasChanged(data.revision)) return;
    const next = await loadAtlas();
    if (JSON.stringify(next) === JSON.stringify(data)) return;
    const oldSelected = JSON.stringify(entityById(state.selectedId));
    data = next;
    if (state.conversationId && !data.conversations.some(item=>item.id===state.conversationId))
      Object.assign(state,{categoryId:null,conversationId:null,segmentId:null,selectedId:null,inspectorOpen:false,blockId:null});
    if (state.selectedId && !entityById(state.selectedId)) {
      Object.assign(state,{selectedId:state.conversationId,segmentId:null,blockId:null,inspectorOpen:false});
    }
    // renderGraph reuses keyed node/edge DOM and the existing ParticleField, retaining expansion and scroll.
    renderGraph();
    updateAnalysisScope();
    if (state.inspectorOpen && oldSelected !== JSON.stringify(entityById(state.selectedId))) {
      const scroll = $('inspector').scrollTop; renderInspector(); $('inspector').scrollTop = scroll;
    }
    $('recent-panel').replaceChildren(el('h2', '', '最近入库会话 / SQLite'));
    [...data.conversations].sort((a,b)=>(b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0,6).forEach(item=>$('recent-panel').append(resultButton(item)));
    $('recent-count').textContent = String(data.conversations.length).padStart(2,'0');
    const count = $('universe-stats').querySelectorAll('.stat strong');
    if (count[0]) count[0].textContent = String(data.quality?.storedConversationCount || 0).padStart(2,'0');
    if (count[1]) count[1].textContent = String(data.quality?.messageCount || 0).padStart(2,'0');
    if (count[2]) count[2].textContent = String(data.quality?.storedSegmentCount || 0).padStart(2,'0');
    $('source-label').textContent = data.segments.length ? 'SQLite · 语义索引' : 'SQLite · 已采集';
  } catch (error) { announce(`图谱更新暂未完成：${error.message}`); }
  finally { refreshingGraph = false; }
}

function renderKeyAnswers(entity, panel, references, displayTitle = entity.title) {
  const generation = detailGeneration;
  if (entity.sourceStatus !== 'ready') panel.append(el('p','prototype-note',indexReason(entity.sourceReason) || '该索引来源需要复核'));
  const list = el('div','key-answer-list');
  for (const [i,ref] of (references || entity.keyAssistantAnswers || []).entries()) {
    const button = el('button','answer-reference');
    button.append(el('strong','',`阅读回答 ${i+1}`),el('small','',ref.reason));
    button.addEventListener('click',async()=>{
      button.disabled = true;
      try {
        const detail = await indexRequest(`/api/atlas/answer/${encodeURIComponent(entity.conversationId)}/${encodeURIComponent(entity.segmentId)}/${encodeURIComponent(ref.message_id)}`);
        if ((state.selectedId === entity.id || entityById(state.selectedId)?.segmentNodeId === entity.id) && generation === detailGeneration) openAnswer(detail,displayTitle);
      } catch(error) { announce(error.message); button.append(el('small','',error.message)); }
      finally {button.disabled=false;}
    });
    list.append(button);
  }
  if (!list.children.length) list.append(el('p','prototype-note','暂无可验证的关键回答引用。'));
  const section = inspectorSection('关键回答 · 查看完整原文',list);
  panel.querySelector('.inspector-summary').after(section);
}

function renderRefinement(entity, panel) {
  const section=el('section','inspector-section');
  const button=el('button','refine-button','细分为概念');
  const status=el('p','reading-limitation',entity.conceptRefinement?.atomic ? '此主题上次被识别为单一概念。' : '尚未建立概念分块。细分仅使用本主题原文，不重分析整个对话。');
  section.append(button,status);
  const actions=panel.querySelector('.topic-actions');
  if (actions) actions.after(section); else panel.append(section);
  refinementView={entity,button,status,generation:detailGeneration,busy:false};
  const view=refinementView;
  button.addEventListener('click',()=>requestRefinement(view));
  refreshRefinement();
}

async function refreshRefinement() {
  const view=refinementView;
  if (!view || view.busy || view.generation!==detailGeneration || state.selectedId!==view.entity.id) return;
  view.busy=true;
  try {
    const task=await indexRequest(`/api/atlas/concepts/${encodeURIComponent(view.entity.conversationId)}/${encodeURIComponent(view.entity.segmentId)}`);
    if (view.generation!==detailGeneration) return;
    view.task=task;
    const active=['queued','running'].includes(task.status);
    view.button.disabled=active || task.status==='completed';
    view.button.textContent=active?'正在细分…':task.status==='completed'?'已完成概念分析':'细分为概念';
    if (active) view.status.textContent='只分析当前主题，成功后自动展开概念分块。';
    else if (task.status==='failed') view.status.textContent=`细分未完成：${indexReason(task.errorCode)}。原主题保留，可手动重试。`;
    else if (task.status==='completed') {
      view.status.textContent=task.atomic?'模型将此主题判断为单一概念；可直接查看关键回答。':`已保存 ${task.blockCount} 个概念分块。`;
      if (task.blockCount && !view.entity.subtopics?.length) await refreshGraph();
    }
  } catch(error) {
    if (view.generation===detailGeneration) view.status.textContent=`暂不能细分：${error.message}`;
  } finally {view.busy=false;}
}

async function requestRefinement(view) {
  if (!view || view.busy || view.generation!==detailGeneration) return;
  await refreshRefinement();
  if (view.generation!==detailGeneration || view.button.disabled) return;
  const budget=view.task?.budget;
  if (!budget) {view.status.textContent='无法确认本次预算，未发送模型请求。';return;}
  if (!budget.fits) {view.status.textContent='当前主题超过模型完整输入容量，未截断、未调用模型。';return;}
  if (!budget.configured) {view.status.textContent='请先配置本机 DeepSeek 密钥。';return;}
  const dialog=$('refine-dialog'), confirm=$('refine-confirm');
  $('refine-title').textContent=`细分主题：${view.entity.title}`;
  $('refine-budget').textContent=`仅提交本主题 ${budget.messageCount} 条真实消息。最多 1 次 ${budget.model} 请求，输入保守上界 ${budget.inputUpper.toLocaleString()} Token，输出最多 ${budget.outputLimit.toLocaleString()} Token。结果会持久化，成功后重复打开不再请求。`;
  confirm.disabled=false;
  confirm.onclick=async()=>{
    confirm.disabled=true; view.button.disabled=true; dialog.close();
    try {
      await indexRequest(`/api/atlas/concepts/${encodeURIComponent(view.entity.conversationId)}/${encodeURIComponent(view.entity.segmentId)}`,'POST');
      await refreshRefinement();
    } catch(error) {view.status.textContent=error.message;view.button.disabled=false;}
  };
  dialog.showModal();
}
