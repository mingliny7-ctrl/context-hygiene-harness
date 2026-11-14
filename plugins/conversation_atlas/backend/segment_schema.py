"""Optional, source-backed organization inside a Segment; no additional tables."""
from pydantic import BaseModel, ConfigDict, Field
from .analysis import SemanticAnalysis, KeyAssistantAnswer


class ConceptRefinement(BaseModel):
    """Local completion receipt; no source bodies, credentials, or new tables."""
    model_config = ConfigDict(extra='forbid', strict=True)
    source_digest: str
    model: str
    prompt_version: str
    analyzed_at: str
    atomic: bool
    requests: int = Field(default=1, ge=1, le=1)
    usage: dict = Field(default_factory=dict)


class ContentBlock(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    block_id: str | None = Field(default=None, max_length=128)
    title: str = Field(min_length=1, max_length=60)
    summary: str = Field(min_length=1, max_length=2000)
    message_ids: list[str] = Field(min_length=1)
    key_assistant_answers: list[KeyAssistantAnswer] = Field(min_length=1, max_length=5)


class SegmentAnalysis(SemanticAnalysis):
    # A persisted topic can accumulate valid blocks across multiple batches.
    subtopics: list[ContentBlock] = Field(default_factory=list)
    concept_refinement: ConceptRefinement | None = None


def validate_blocks(analysis, messages):
    by_key = {m['key']: m for m in messages}
    blocks = analysis.subtopics
    if len(blocks) == 1:
        raise ValueError('A simple topic must not create a redundant single block')
    ids = set()
    for block in blocks:
        if block.block_id and block.block_id in ids:
            raise ValueError('Duplicate content block identity')
        ids.add(block.block_id)
        keys = block.message_ids
        if len(set(keys)) != len(keys) or not set(keys) <= by_key.keys():
            raise ValueError('Content block source outside segment or duplicated')
        positions = [list(by_key).index(key) for key in keys]
        if positions != sorted(positions):
            raise ValueError('Content block source order invalid')
        for ref in block.key_assistant_answers:
            if ref.message_id not in keys or by_key[ref.message_id]['role'] != 'assistant':
                raise ValueError('Content block answer outside block')
