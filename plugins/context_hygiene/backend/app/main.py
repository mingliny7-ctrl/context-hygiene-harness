"""Local-only Context Hygiene API. Shared Store is not owned by this plugin."""

from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI, HTTPException

from app.context_monitor import ContextMonitor
from app.schemas import (
    AnalyzeRequest,
    ContextHealth,
    ConversationSyncRequest,
    ConversationSyncResponse,
    Message,
)
from shared.conversation_store.database import init_db
from shared.conversation_store.store import (
    conversation_exists,
    get_messages,
    save_observation,
)


def create_app(db_path: str | Path | None = None) -> FastAPI:
    monitor = ContextMonitor()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        init_db(db_path)
        yield

    app = FastAPI(title="Context Hygiene MVP", lifespan=lifespan)

    @app.get("/health")
    def health():
        return {"status": "ok"}

    @app.post("/analyze", response_model=ContextHealth)
    def analyze(request: AnalyzeRequest):
        # Kept to debug the original rule-only API; /sync is the browser entrypoint.
        return monitor.analyze(request.messages)

    def build_status(conversation_id: str) -> ConversationSyncResponse:
        saved = get_messages(conversation_id, db_path)
        monitor_input = [
            Message(role=item["role"], content=item["content"]) for item in saved
        ]
        result = monitor.analyze(monitor_input)
        return ConversationSyncResponse(
            conversation_id=conversation_id,
            status=result.status,
            reasons=result.reasons,
            should_handoff=result.should_handoff,
            message_count=len(monitor_input),
            total_chars=sum(len(m.content) for m in monitor_input),
        )

    @app.post("/sync", response_model=ConversationSyncResponse)
    def sync_conversation(request: ConversationSyncRequest):
        save_observation(
            conversation_id=request.conversation_id,
            messages=[item.model_dump() for item in request.messages],
            db_path=db_path,
        )
        return build_status(request.conversation_id)

    @app.get(
        "/conversations/{conversation_id}/status",
        response_model=ConversationSyncResponse,
    )
    def conversation_status(conversation_id: str):
        # Lets Popup restore a conversation immediately, even before new DOM events.
        if not conversation_exists(conversation_id, db_path):
            raise HTTPException(status_code=404, detail="No stored conversation")
        return build_status(conversation_id)

    return app


app = create_app()
