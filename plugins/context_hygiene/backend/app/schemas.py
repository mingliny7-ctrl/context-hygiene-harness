from typing import Literal
from pydantic import BaseModel, Field


class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class AnalyzeRequest(BaseModel):
    messages: list[Message]


class ContextHealth(BaseModel):
    status: Literal["GREEN", "YELLOW", "RED"]
    reasons: list[str]
    should_handoff: bool


class BridgeMessage(Message):
    key: str = Field(min_length=1, max_length=1024)


class ConversationSyncRequest(BaseModel):
    conversation_id: str = Field(min_length=1, max_length=512)
    messages: list[BridgeMessage]


class ConversationSyncResponse(BaseModel):
    conversation_id: str
    message_count: int
    assistant_reply_count: int | None
    confirmed_assistant_reply_count: int
    count_status: Literal['verified', 'legacy_identity_unverified']
    latest_assistant_preview: str | None
    latest_assistant_status: Literal['empty', 'single_verified_answer', 'order_unverified']
    status: Literal["SAVED"] = "SAVED"
    # Legacy wire fields remain inert for already-installed extension clients.
    reasons: list[str] = Field(default_factory=list)
    should_handoff: Literal[False] = False
