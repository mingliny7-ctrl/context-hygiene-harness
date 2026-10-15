"""Local collection API; legacy Monitor implementation is retained but not loaded."""

from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI, HTTPException

from app.schemas import (
    AnalyzeRequest,
    ConversationSyncRequest,
    ConversationSyncResponse,
)
from shared.conversation_store.database import init_db
from shared.conversation_store.identity import is_temporary_conversation_id
from shared.conversation_store.store import (
    conversation_exists,
    get_collection_snapshot,
    save_observation,
    saved_assistant_count,
)


def create_app(db_path: str | Path | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        init_db(db_path)
        yield

    app = FastAPI(title="Context Harness Conversation Collector", lifespan=lifespan)

    @app.get("/health")
    def health():
        return {"status": "ok"}

    @app.post("/analyze")
    def analyze(request: AnalyzeRequest):
        raise HTTPException(status_code=410, detail="Context risk analysis has been retired")

    def build_receipt(conversation_id: str) -> ConversationSyncResponse:
        saved, event = get_collection_snapshot(conversation_id, db_path)
        assistant_count, count_status, confirmed_count = saved_assistant_count(saved)
        has_answers = any(m['role'] == 'assistant' and m['content'].strip() for m in saved)
        return ConversationSyncResponse(
            conversation_id=conversation_id,
            message_count=len(saved),
            assistant_reply_count=assistant_count,
            count_status=count_status,
            confirmed_assistant_reply_count=confirmed_count,
            latest_assistant_preview=event['preview'] if event else None,
            latest_assistant_status='saved_event' if event else 'history_untracked' if has_answers else 'empty',
            latest_save_revision=event['revision'] if event else None,
        )

    @app.post("/sync", response_model=ConversationSyncResponse)
    def sync_conversation(request: ConversationSyncRequest):
        # Older installed Readers may still submit ChatGPT's unsaved URL ID.
        # Reject before writing; existing historical temporary rows stay intact.
        if is_temporary_conversation_id(request.conversation_id):
            raise HTTPException(
                status_code=409,
                detail="Temporary ChatGPT conversation: wait for canonical ID",
            )
        save_observation(
            conversation_id=request.conversation_id,
            messages=[item.model_dump() for item in request.messages],
            db_path=db_path,
        )
        return build_receipt(request.conversation_id)

    @app.get(
        "/conversations/{conversation_id}/status",
        response_model=ConversationSyncResponse,
    )
    def conversation_status(conversation_id: str):
        # Lets Popup restore a conversation immediately, even before new DOM events.
        if not conversation_exists(conversation_id, db_path):
            raise HTTPException(status_code=404, detail="No stored conversation")
        return build_receipt(conversation_id)

    return app


app = create_app()
