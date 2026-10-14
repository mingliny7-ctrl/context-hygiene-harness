import { mockAtlas } from './mock-atlas.mjs';

/**
 * Data boundary used by the prototype renderer.
 * Replace this function's implementation when a real API is approved; callers
 * keep the same category → conversation → segment contract.
 * @returns {Promise<typeof mockAtlas>} A fresh local fixture, never shared state.
 */
export async function loadAtlas() {
  return structuredClone(mockAtlas);
}

const normalize = (value) => String(value ?? '')
  .normalize('NFKC')
  .toLocaleLowerCase('en-US')
  .trim();

function searchableText(entity) {
  return normalize([
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
