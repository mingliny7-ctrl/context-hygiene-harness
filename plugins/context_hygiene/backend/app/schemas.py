from typing import Literal
from pydantic import BaseModel, Field, model_validator, field_validator
from shared.conversation_store.presentation import validate_presentation


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
    source_created_at: float | None = Field(default=None, gt=0, allow_inf_nan=False)
    presentation: dict | None = None

    @field_validator('presentation')
    @classmethod
    def check_presentation(cls, value):
        return validate_presentation(value)


class ConversationSyncRequest(BaseModel):
    conversation_id: str = Field(min_length=1, max_length=512)
    title: str | None = Field(default=None, max_length=512)
    messages: list[BridgeMessage]
    observed_order: list[str] | None = None

    @model_validator(mode='after')
    def validate_observed_order(self):
        if self.observed_order is not None:
            if len(set(self.observed_order)) != len(self.observed_order) or not set(self.observed_order) <= {m.key for m in self.messages}:
                raise ValueError('DOM order must contain unique keys from this observation')
        return self


class ConversationSyncResponse(BaseModel):
    conversation_id: str
    message_count: int
    assistant_reply_count: int | None
    confirmed_assistant_reply_count: int
    count_status: Literal['verified', 'legacy_identity_unverified']
    latest_assistant_preview: str | None
    latest_assistant_status: Literal['empty', 'saved_event', 'history_untracked']
    latest_save_revision: int | None
    status: Literal["SAVED"] = "SAVED"
    # Legacy wire fields remain inert for already-installed extension clients.
    reasons: list[str] = Field(default_factory=list)
    should_handoff: Literal[False] = False
