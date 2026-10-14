"""Recognize ChatGPT's unsaved URL identity, without guessing any aliases."""

from urllib.parse import unquote


def is_temporary_conversation_id(conversation_id: str) -> bool:
    return unquote(conversation_id).lower().startswith("local-chatgpt")
