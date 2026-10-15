"""Independent, read-only Atlas API and same-origin frontend; no Monitor dependency."""
from datetime import datetime, timezone
from pathlib import Path
import logging
import sqlite3

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from shared.conversation_store.store import list_stored_conversations, read_stored_conversation

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
        "title": excerpt[:48] or f"未命名会话 · {cid[:12]}",
        "titleSource": "stored_message_excerpt" if excerpt else "id_fallback",
        "summary": raw_excerpt[:180] if excerpt else "暂无非空消息正文。",
        "summarySource": "verbatim_excerpt", "previewMessageKey": row.get("preview_key"),
        "createdAt": stored_time(row.get("created_at")),
        "updatedAt": stored_time(row.get("updated_at")),
        "messageCount": row["message_count"], "totalChars": row["total_chars"],
        "segmentCount": 0, "classificationStatus": "unclassified", "segmentStatus": "unprocessed",
        "keywords": [], "outcomes": [],
        "quality": quality(row["message_count"], row["empty_message_count"], row["fallback_key_count"], cid),
    }


def create_app(db_path: str | Path | None = None) -> FastAPI:
    app = FastAPI(title="Conversation Atlas · read-only Store integration")

    @app.middleware("http")
    async def no_cached_history(request: Request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(sqlite3.DatabaseError)
    async def database_unavailable(request: Request, error):
        # Log the exception type, never message bodies or raw SQL parameter values.
        logger.warning("Atlas Store unavailable: %s", type(error).__name__)
        return JSONResponse(status_code=503, content={"detail": "无法读取已有会话库；请检查数据库文件、表结构或占用情况。Atlas 不会创建或迁移数据库。"})

    @app.get("/api/atlas")
    def graph():
        rows = list_stored_conversations(db_path)
        valid_rows = [row for row in rows if isinstance(row["conversation_id"], str) and row["conversation_id"].strip()]
        conversations = [conversation_node(row) for row in valid_rows]
        count = sum(row["message_count"] for row in valid_rows)
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
            "provenance": {"mode": "real", "label": "SQLite · 已采集数据", "description": "已存储的观察记录，完整性未知；没有 AI 分类、摘要或阶段结果。"},
            "categories": categories, "conversations": conversations, "segments": [],
            "quality": {
                "storedConversationCount": len(rows), "visibleConversationCount": len(conversations),
                "skippedInvalidIdCount": len(rows) - len(valid_rows), "messageCount": count,
                "emptyMessageCount": sum(row["empty_message_count"] for row in valid_rows),
                "fallbackKeyCount": sum(row["fallback_key_count"] for row in valid_rows),
                "suspectedTestRecordCount": sum(node["quality"]["suspectedTestRecord"] for node in conversations),
                "completeness": "unknown", "ordering": "not_evaluated",
            },
        }

    @app.get("/api/atlas/conversations/{conversation_id:path}")
    def detail(conversation_id: str):
        stored = read_stored_conversation(conversation_id, db_path)
        if stored is None:
            raise HTTPException(status_code=404, detail="该会话不在当前 Store 中，请刷新图谱。")
        messages = [{
            "key": item["key"], "role": item["role"], "content": item["content"],
            "firstSeenAt": stored_time(item["first_seen_at"]), "updatedAt": stored_time(item["updated_at"]),
            "sourceCreatedAt": item['source_created_at'], "sourceOrder": item['source_order'],
            "orderGroup": item['order_group'], "relativeOrder": item['relative_order'], "orderStatus": item['order_status'],
        } for item in stored["messages"]]
        return {
            "conversationId": stored["conversation_id"], "messages": messages,
            "createdAt": stored_time(stored["created_at"]), "updatedAt": stored_time(stored["updated_at"]),
            "quality": {**quality(len(messages), sum(not item["content"].strip() for item in messages),
                               sum(item["key"].startswith("fallback-turn-") for item in messages), conversation_id),
                        'ordering': stored['ordering']},
        }

    app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="atlas-frontend")
    return app


app = create_app()
