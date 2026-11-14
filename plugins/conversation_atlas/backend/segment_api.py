"""Read presentation data from Segment coverage; exact original answers remain in the Store."""
import json
from urllib.parse import quote
from fastapi import HTTPException
from shared.conversation_store.store import read_stored_conversation
from .incremental_index import fingerprint


def segment_nodes(index, cid):
    members, segments = index._state(cid)
    groups = {s['segment_id']: [m for m in members if m['segment_id'] == s['segment_id']] for s in segments}
    status = index.inspect(cid)
    ordered = sorted(segments, key=lambda s: min((m['position'] for m in groups[s['segment_id']]), default=10**9))
    result = []
    for order, s in enumerate(ordered, 1):
        scope = groups[s['segment_id']]
        keys = {m['key'] for m in scope}
        a = json.loads(s['analysis_json'])
        # Fail closed on a corrupt/mis-scoped answer list; never borrow Conversation-level references.
        answers = [r for r in a['key_assistant_answers'] if r['message_id'] in keys
                   and any(m['key'] == r['message_id'] and m['role'] == 'assistant' for m in scope)]
        result.append({'id': 'atlas:segment:' + quote(cid, safe='') + ':' + quote(s['segment_id'], safe=''),
                       'segmentId': s['segment_id'], 'kind': 'segment', 'conversationId': cid,
                       'categoryId': 'atlas:unclassified', 'title': a['title'], 'summary': a['summary'],
                       'keywords': a['keywords'], 'outcomes': a['outcomes'], 'keyAssistantAnswers': answers,
                       'subtopics': a.get('subtopics', []),
                       'conceptRefinement': a.get('concept_refinement'),
                       'order': order, 'revision': s['revision'], 'messageCount': len(scope),
                       'messageRange': {'start': s['start_key'], 'end': s['end_key']},
                       'messageIndexRange': {'start': min((m['position'] for m in scope), default=0) + 1,
                                             'end': max((m['position'] for m in scope), default=0) + 1},
                       'createdAt': None, 'updatedAt': s['analyzed_at'], 'timeSource': 'index_completed_at',
                       'topicState': s['topic_state'], 'sourceStatus': status['status'],
                       'sourceReason': status['reason'], 'model': s['model']})
    return result


def exact_answer(index, cid, sid, key):
    members, segments = index._state(cid)
    segment = next((s for s in segments if s['segment_id'] == sid), None)
    if not segment:
        raise HTTPException(404, '该讨论主题不存在。')
    analysis = json.loads(segment['analysis_json'])
    refs = analysis['key_assistant_answers'] + [r for b in analysis.get('subtopics', []) for r in b['key_assistant_answers']]
    if key not in {r['message_id'] for r in refs}:
        raise HTTPException(404, '该回答不是此主题的关键回答。')
    member = next((m for m in members if m['segment_id'] == sid and m['key'] == key and m['role'] == 'assistant'), None)
    stored = read_stored_conversation(cid, index.source_db)
    messages = stored['messages'] if stored else []
    position = next((i for i, m in enumerate(messages) if m['key'] == key and m['role'] == 'assistant'), None)
    if not member or position is None:
        raise HTTPException(409, '原始回答缺失，不能补造正文。')
    answer = messages[position]
    if fingerprint(answer)['body_digest'] != member['body_digest']:
        raise HTTPException(409, '原文已发生变化，该索引需要复核。')
    users = []
    trustworthy = stored['ordering'] in ('source_time', 'dom_relative') and index.inspect(cid)['status'] == 'ready'
    if trustworthy:
        j = position - 1
        # A preceding Assistant can be a continuation or another branch;
        # chronology alone does not establish its originating User question.
        while j >= 0 and messages[j]['role'] == 'user':
            users.insert(0, messages[j]); j -= 1
    scope = {m['key']: m for m in members if m['segment_id'] == sid}
    if any(m['key'] not in scope or fingerprint(m)['body_digest'] != scope[m['key']]['body_digest'] for m in users):
        users = []
    pack = lambda m: {k: m[k] for k in ('key', 'role', 'content', 'source_order', 'source_created_at',
                                      'first_seen_at', 'presentation', 'presentation_status', 'observed_presentation')}
    return {'conversationId': cid, 'segmentId': sid, 'answer': pack(answer),
            'questions': [pack(m) for m in users], 'contextStatus': 'ordered_adjacent' if users else 'unconfirmed',
            'ordering': stored['ordering'], 'note': '相邻用户提问按已确认页面顺序关联，未验证 ChatGPT 分支父子关系。'}
