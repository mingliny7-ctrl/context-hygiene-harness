async function requestJSON(url, { fetchImpl = globalThis.fetch, signal } = {}) {
  let response;
  try {
    response = await fetchImpl(url, { cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000) });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('无法连接 Atlas 服务，请检查本地服务是否运行后重试。');
  }
  if (!response.ok) throw new Error(`Atlas 接口返回 HTTP ${response.status}，请检查服务或刷新记录。`);
  try { return await response.json(); }
  catch { throw new Error('Atlas 接口未返回有效 JSON。请使用 Atlas 启动脚本，而非静态 HTTP 服务。'); }
}

export function normalizeAtlas(payload) {
  if (payload?.schemaVersion !== 1 || payload?.provenance?.mode !== 'real' ||
      !['categories', 'conversations', 'segments'].every((key) => Array.isArray(payload[key]))) {
    throw new Error('Atlas 数据契约不匹配，未使用演示数据替代。');
  }
  const ids = new Set();
  const copy = structuredClone(payload);
  for (const [collection, kind] of [['categories', 'category'], ['conversations', 'conversation'], ['segments', 'segment']]) {
    copy[collection] = copy[collection].map((entity) => {
      if (typeof entity.id !== 'string' || !entity.id.trim() || ids.has(entity.id) || entity.kind !== kind) {
        throw new Error('Atlas 包含缺失、重复或无效节点标识，无法可靠对应数据库。');
      }
      ids.add(entity.id);
      return { ...entity,
        title: typeof entity.title === 'string' && entity.title.trim() ? entity.title : `未命名 · ${entity.id.slice(0, 12)}`,
        summary: typeof entity.summary === 'string' ? entity.summary : '暂无可用原文摘录。',
        keywords: Array.isArray(entity.keywords) ? entity.keywords.filter((item) => typeof item === 'string') : [],
        outcomes: Array.isArray(entity.outcomes) ? entity.outcomes.filter((item) => typeof item === 'string') : [],
        createdAt: Number.isFinite(Date.parse(entity.createdAt)) ? entity.createdAt : null,
        updatedAt: Number.isFinite(Date.parse(entity.updatedAt)) ? entity.updatedAt : null,
      };
    });
  }
  const categories = new Set(copy.categories.map((entity) => entity.id));
  const conversations = new Set(copy.conversations.map((entity) => entity.id));
  if (copy.conversations.some((entity) => !categories.has(entity.categoryId)) ||
      copy.segments.some((entity) => !conversations.has(entity.conversationId) || !categories.has(entity.categoryId))) {
    throw new Error('Atlas 节点父子关系不完整，无法可靠展开。');
  }
  return copy;
}

/** Real Store is the default. Mock fixtures require explicit source=demo. No silent fallback. */
export async function loadAtlas({ mode = 'real', ...options } = {}) {
  if (mode === 'demo') {
    const { mockAtlas } = await import('./mock-atlas.mjs');
    return structuredClone(mockAtlas);
  }
  return normalizeAtlas(await requestJSON('/api/atlas', options));
}

export async function loadConversation(conversationId, options = {}) {
  const payload = await requestJSON(`/api/atlas/conversations/${encodeURIComponent(conversationId)}`, options);
  if (payload?.conversationId !== conversationId || !Array.isArray(payload.messages)) throw new Error('原文会话标识与选中节点不一致。');
  const keys = new Set();
  for (const message of payload.messages) {
    if (typeof message.key !== 'string' || !message.key.trim() || keys.has(message.key) || typeof message.content !== 'string') {
      throw new Error('原文消息缺少可靠键或正文，请检查采集数据。');
    }
    keys.add(message.key);
  }
  return payload;
}

const normalize = (value) => String(value ?? '')
  .normalize('NFKC')
  .toLocaleLowerCase('en-US')
  .trim();

function searchableText(entity) {
  return normalize([
    entity.id,
    entity.title,
    entity.summary,
    ...(entity.keywords ?? []),
    ...(entity.outcomes ?? []),
  ].join(' '));
}

/**
 * Deterministic local lexical search; this is not an AI/semantic search service.
 * Space-separated terms use AND matching. A category title/keyword match also
 * scopes results to that category, and a conversation title match carries into
 * its segments. Empty input returns no results.
 *
 * Returned objects are full conversation or segment entities. The kind field
 * distinguishes them; categoryId and conversationId resolve navigation (for a
 * conversation result, conversationId equals its own id). Results rank title
 * matches first, then summary matches, then contextual matches; ties preserve
 * source order. The input fixture is never mutated.
 * @param {typeof mockAtlas} data
 * @param {string} query
 * @returns {Array<object>} Matching entities, including navigation parent keys.
 */
export function searchAtlas(data, query) {
  const terms = normalize(query).split(/\s+/u).filter(Boolean);
  if (!terms.length) return [];

  const categories = new Map(data.categories.map((category) => [category.id, category]));
  const conversations = new Map(data.conversations.map((conversation) => [conversation.id, conversation]));
  const candidates = [
    ...data.conversations.map((entity) => ({ ...entity, kind: 'conversation', conversationId: entity.id })),
    ...data.segments.map((entity) => ({ ...entity, kind: 'segment' })),
  ];

  return candidates
    .map((entity, sourceIndex) => {
      const category = categories.get(entity.categoryId);
      const parent = conversations.get(entity.conversationId);
      const title = normalize(entity.title);
      const summary = normalize(entity.summary);
      const ownText = searchableText(entity);
      const context = normalize([
        category?.title,
        ...(category?.keywords ?? []),
        entity.kind === 'segment' ? parent?.title : '',
      ].join(' '));
      const combined = `${ownText} ${context}`;
      if (!terms.every((term) => combined.includes(term))) return null;
      const score = terms.reduce((total, term) => total + (
        title.includes(term) ? 4 : summary.includes(term) ? 2 : ownText.includes(term) ? 1 : 0
      ), 0);
      return { entity, sourceIndex, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.sourceIndex - b.sourceIndex)
    .map(({ entity }) => entity);
}
