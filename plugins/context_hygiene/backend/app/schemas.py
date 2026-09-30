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


class ConversationSyncResponse(ContextHealth):
    conversation_id: str
    message_count: int
    total_chars: int
