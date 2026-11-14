"""Independent, read-only Atlas API and same-origin frontend; no Monitor dependency."""
from datetime import datetime, timezone
from pathlib import Path
import logging
import sqlite3
from contextlib import asynccontextmanager, closing

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from shared.conversation_store.store import list_stored_conversations, read_stored_conversation
from shared.conversation_store.database import get_read_connection
from .incremental_index import IncrementalIndex, IndexErrorState
from .indexer import SemanticIndexer, ExecutionLock
from .segment_api import segment_nodes, exact_answer
from .management import AtlasManagement, ManagementError
from .revision import graph_revision
from .concept_refinement import ConceptRefiner

FRONTEND = Path(__file__).resolve().parents[1] / "frontend"
logger = logging.getLogger(__name__)
UNCLASSIFIED_ID = "atlas:unclassified"


def stored_time(value):
    """SQLite CURRENT_TIMESTAMP is UTC; unavailable/invalid fields stay unknown."""
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except (TypeError, ValueError, AttributeError):
        return None


def quality(message_count, empty_count, fallback_count, conversation_id):
    return {
        "completeness": "unknown",
        "ordering": "not_evaluated",
        "emptyMessageCount": empty_count,
        "fallbackKeyCount": fallback_count,
        "suspectedTestRecord": conversation_id.startswith("test-"),
        "messageCount": message_count,
    }


def conversation_node(row):
    cid = row["conversation_id"]
    raw_excerpt = row.get("preview_content") or ""
    excerpt = " ".join(raw_excerpt.split())
    return {
        "id": cid, "kind": "conversation", "categoryId": UNCLASSIFIED_ID,
        "title": row.get('original_title') or f"原始标题待重新采集 · {cid[:12]}",
        "titleSource": "chatgpt_original_title" if row.get('original_title') else "missing_original_title",
        "needsTitleRecapture": not bool(row.get('original_title')),
        "summary": raw_excerpt[:180] if excerpt else "暂无非空消息正文。",
        "summarySource": "verbatim_excerpt", "previewMessageKey": row.get("preview_key"),
        "createdAt": stored_time(row.get("created_at")),
        "updatedAt": stored_time(row.get("updated_at")),
        "messageCount": row["message_count"], "totalChars": row["total_chars"],
        "segmentCount": 0, "classificationStatus": "unclassified", "segmentStatus": "unprocessed",
        "keywords": [], "outcomes": [],
        "quality": quality(row["message_count"], row["empty_message_count"], row["fallback_key_count"], cid),
    }


def create_app(db_path: str | Path | None = None, analysis_db_path: str | Path | None = None,
               provider_factory=None, budget=None) -> FastAPI:
    index = IncrementalIndex(db_path, analysis_db_path)
    indexer = SemanticIndexer(index, provider_factory, budget)
    refiner = ConceptRefiner(index, provider_factory, initialize=indexer.initialize)
    management = AtlasManagement(index.source_db, index.path)
    @asynccontextmanager
    async def lifespan(app):
        yield  # No migrations, model configuration or inference on startup.
        indexer.close()
        refiner.close()
    app = FastAPI(title="Conversation Atlas · read-only Store integration", lifespan=lifespan)
    app.state.indexer = indexer
    app.state.management = management
    app.state.refiner = refiner

    def management_action(request: Request):
        origin = request.headers.get('origin')
        if request.headers.get('x-atlas-action') != 'manage-conversation' or (origin and origin != str(request.base_url).rstrip('/')):
            raise HTTPException(403, '仅接受 Atlas 页面明确发起的管理操作。')

    def managed(call):
        try:
            return call()
        except ManagementError as error:
            raise HTTPException(404 if error.code == 'NOT_FOUND' else 409,
                                detail={'code': error.code, 'message': str(error)}) from error

    @app.middleware("http")
    async def no_cached_history(request: Request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(sqlite3.DatabaseError)
    async def database_unavailable(request: Request, error):
        # Log the exception type, never message bodies or raw SQL parameter values.
        logger.warning("Atlas Store unavailable: %s", type(error).__name__)
        return JSONResponse(status_code=503, content={"detail": "无法读取会话或索引库；请检查文件、表结构或占用情况。读取接口不会创建或迁移原文数据库。"})

    @app.get("/api/atlas")
    def graph():
        # Read before materializing: a concurrent commit remains visible to the
        # next revision poll, even if it happens during this multi-query read.
        revision = graph_revision(index.source_db, index.path)
        rows = list_stored_conversations(db_path)
        # Genuine committed Assistant save events; repeated sync timestamps are not activity.
        with closing(get_read_connection(db_path)) as connection:
            installed = connection.execute("SELECT 1 FROM sqlite_master WHERE name='collector_save_state'").fetchone()
            activity = dict(connection.execute('SELECT conversation_id,saved_at FROM collector_save_state')) if installed else {}
        hidden = management.hidden_ids()
        hidden_topics = management.hidden_segment_ids()
        valid_rows = [row for row in rows if isinstance(row["conversation_id"], str) and row["conversation_id"].strip() and row['conversation_id'] not in hidden]
        conversations = [conversation_node(row) for row in valid_rows]
        segments = []
        for node in conversations:
            node['lastContentSavedAt'] = stored_time(activity.get(node['id']))
            node['activitySource'] = 'committed_assistant_save' if node['lastContentSavedAt'] else 'unavailable'
            all_leaves = segment_nodes(index, node['id'])
            leaves = [s for s in all_leaves if (node['id'], s['segmentId']) not in hidden_topics]
            check = index.inspect(node['id'])
            node['indexState'] = check
            node['segmentCount'] = len(leaves)
            node['hiddenSegmentCount'] = len(all_leaves) - len(leaves)
            if leaves:
                node['segmentStatus'] = 'indexed'
                node.update(summary=leaves[0]['summary'], summarySource='first_segment_summary')
            segments.extend(leaves)
        count = sum(row["message_count"] for row in valid_rows)
        stored_count = sum(row['message_count'] for row in rows)
        stored_segment_count = len(segments) + len(hidden_topics) + sum(len([s for s in segment_nodes(index, row['conversation_id']) if (row['conversation_id'], s['segmentId']) not in hidden_topics]) for row in rows if row['conversation_id'] in hidden)
        dates = [node["createdAt"] for node in conversations if node["createdAt"]]
        updates = [node["updatedAt"] for node in conversations if node["updatedAt"]]
        categories = [{
            "id": UNCLASSIFIED_ID, "kind": "category", "title": "未分类",
            "summary": "来自现有 SQLite 的已存储会话。尚未进行 AI 分类或阶段处理。",
            "description": "读取已有数据，不代表完整历史。", "color": "#c0c5a4",
            "keywords": [], "outcomes": [], "classificationStatus": "unclassified",
            "createdAt": min(dates) if dates else None, "updatedAt": max(updates) if updates else None,
            "conversationCount": len(conversations), "messageCount": count,
        }] if conversations else []
        return {
            "schemaVersion": 1,
            "revision": revision,
            "provenance": {"mode": "real", "label": "SQLite · 持久化索引", "description": "已采集原文及已完成的主题索引；只有手动分析才调用模型。完整历史未知。"},
            "categories": categories, "conversations": conversations, "segments": segments,
            "quality": {
                "storedConversationCount": len(rows), "visibleConversationCount": len(conversations),
                "hiddenConversationCount": len(hidden), "storedSegmentCount": stored_segment_count,
                "skippedInvalidIdCount": sum(not isinstance(row['conversation_id'], str) or not row['conversation_id'].strip() for row in rows), "messageCount": stored_count,
                "visibleMessageCount": count,
                "emptyMessageCount": sum(row["empty_message_count"] for row in valid_rows),
                "fallbackKeyCount": sum(row["fallback_key_count"] for row in valid_rows),
                "suspectedTestRecordCount": sum(node["quality"]["suspectedTestRecord"] for node in conversations),
                "completeness": "unknown", "ordering": "not_evaluated",
            },
        }

    @app.get('/api/atlas/revision')
    def revision():
        return {'revision': graph_revision(index.source_db, index.path)}

    @app.get('/api/atlas/hidden')
    def hidden_conversations():
        return {'conversations': management.hidden(), 'topics': management.hidden_segments()}

    @app.post('/api/atlas/topics/{conversation_id}/{segment_id}/hide')
    def hide_topic(conversation_id: str, segment_id: str, request: Request):
        management_action(request)
        return managed(lambda: management.set_segment_hidden(conversation_id, segment_id, True))

    @app.post('/api/atlas/topics/{conversation_id}/{segment_id}/restore')
    def restore_topic(conversation_id: str, segment_id: str, request: Request):
        management_action(request)
        return managed(lambda: management.set_segment_hidden(conversation_id, segment_id, False))

    @app.get('/api/atlas/concepts/{conversation_id}/{segment_id}')
    def concepts_state(conversation_id: str, segment_id: str):
        try:
            return refiner.preview(conversation_id, segment_id)
        except IndexErrorState as error:
            raise HTTPException(409, detail={'code': str(error)}) from error

    @app.post('/api/atlas/concepts/{conversation_id}/{segment_id}', status_code=202)
    def refine_concepts(conversation_id: str, segment_id: str, request: Request):
        origin = request.headers.get('origin')
        if request.headers.get('x-atlas-action') != 'manual-analysis' or (origin and origin != str(request.base_url).rstrip('/')):
            raise HTTPException(403, '仅接受 Atlas 页面明确发起的手动细分。')
        try:
            return refiner.start(conversation_id, segment_id)
        except IndexErrorState as error:
            raise HTTPException(409, detail={'code': str(error)}) from error

    @app.post('/api/atlas/conversations/{conversation_id}/hide')
    def hide_conversation(conversation_id: str, request: Request):
        management_action(request)
        return managed(lambda: management.set_hidden(conversation_id, True))

    @app.post('/api/atlas/conversations/{conversation_id}/restore')
    def restore_conversation(conversation_id: str, request: Request):
        management_action(request)
        return managed(lambda: management.set_hidden(conversation_id, False))

    @app.delete('/api/atlas/conversations/{conversation_id}')
    def delete_conversation(conversation_id: str, request: Request):
        management_action(request)
        try:
            lock = ExecutionLock(index.path)
        except IndexErrorState:
            raise HTTPException(409, '该对话正在分析，结束后才能删除。')
        try:
            return managed(lambda: management.delete(conversation_id))
        finally:
            lock.close()

    @app.get('/api/atlas/tombstones')
    def deleted_conversations():
        return {'conversations': management.tombstones()}

    @app.post('/api/atlas/tombstones/{conversation_id}/allow-recapture')
    def allow_recapture(conversation_id: str, request: Request):
        management_action(request)
        return managed(lambda: management.allow_recapture(conversation_id))

    @app.get('/api/atlas/bookmarks')
    def bookmarks():
        return {'bookmarks': management.bookmarks()}

    @app.put('/api/atlas/bookmarks/{conversation_id}/{message_key}')
    def save_bookmark(conversation_id: str, message_key: str, request: Request):
        management_action(request)
        return managed(lambda: management.set_bookmark(conversation_id, message_key, True))

    @app.delete('/api/atlas/bookmarks/{conversation_id}/{message_key}')
    def remove_bookmark(conversation_id: str, message_key: str, request: Request):
        management_action(request)
        return managed(lambda: management.set_bookmark(conversation_id, message_key, False))

    @app.get('/api/atlas/bookmarks/{conversation_id}/{message_key}/answer')
    def bookmarked_answer(conversation_id: str, message_key: str):
        return managed(lambda: management.bookmark_answer(conversation_id, message_key))

    @app.get('/api/atlas/index-state/{conversation_id}')
    def index_state(conversation_id: str):
        return {'conversationId': conversation_id, 'source': index.inspect(conversation_id),
                'task': indexer.latest(conversation_id), 'budget': indexer.budget.__dict__}

    @app.post('/api/atlas/index/{conversation_id}', status_code=202)
    def manual_index(conversation_id: str, request: Request):
        # Cross-origin pages cannot spend API budget via a form or simple request.
        origin = request.headers.get('origin')
        if request.headers.get('x-atlas-action') != 'manual-analysis' or (origin and origin != str(request.base_url).rstrip('/')):
            raise HTTPException(403, '仅接受 Atlas 页面明确发起的手动分析。')
        try:
            return indexer.start(conversation_id)
        except IndexErrorState as error:
            raise HTTPException(409, detail={'code': str(error)}) from error

    @app.get('/api/atlas/answer/{conversation_id}/{segment_id}/{message_key}')
    def answer(conversation_id: str, segment_id: str, message_key: str):
        return exact_answer(index, conversation_id, segment_id, message_key)

    @app.get('/api/atlas/analysis/{conversation_id:path}')
    def completed_analysis(conversation_id: str):
        # Read-only and model-independent: this route can NEVER invoke inference.
        from .analysis import AnalysisError, prepare_input, cached_result
        from .analysis_cache import cache_path
        try:
            material, metadata = prepare_input(conversation_id,db_path)
        except AnalysisError as error:
            raise HTTPException(status_code=404 if error.code=='CONVERSATION_NOT_FOUND' else 409,
                                detail={'code':error.code,'message':error.detail}) from error
        hit = cached_result(conversation_id,material,metadata,cache_path(db_path,analysis_db_path))
        if hit is None:
            raise HTTPException(status_code=404,detail='暂无与当前可靠原文匹配的已完成分析；本接口不会调用模型。')
        return hit

    @app.get("/api/atlas/conversations/{conversation_id:path}")
    def detail(conversation_id: str):
        stored = read_stored_conversation(conversation_id, db_path)
        if stored is None:
            raise HTTPException(status_code=404, detail="该会话不在当前 Store 中，请刷新图谱。")
        messages = [{
            "key": item["key"], "role": item["role"], "content": item["content"],
            "firstSeenAt": stored_time(item["first_seen_at"]), "updatedAt": stored_time(item["updated_at"]),
            "sourceCreatedAt": item['source_created_at'], "sourceOrder": item['source_order'],
            "presentation": item['presentation'], "presentationStatus": item['presentation_status'],
            "observedPresentation": item['observed_presentation'],
            "orderGroup": item['order_group'], "relativeOrder": item['relative_order'], "orderStatus": item['order_status'],
        } for item in stored["messages"]]
        return {
            "conversationId": stored["conversation_id"], "messages": messages,
            "title": stored.get('original_title'),
            "titleSource": 'chatgpt_original_title' if stored.get('original_title') else 'missing_original_title',
            "createdAt": stored_time(stored["created_at"]), "updatedAt": stored_time(stored["updated_at"]),
            "quality": {**quality(len(messages), sum(not item["content"].strip() for item in messages),
                               sum(item["key"].startswith("fallback-turn-") for item in messages), conversation_id),
                        'ordering': stored['ordering']},
        }

    app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="atlas-frontend")
    return app


app = create_app()
