"""Transparent V1 baseline; thresholds are heuristics, NOT validated token limits."""

from app.schemas import ContextHealth, Message


class ContextMonitor:
    def analyze(self, messages: list[Message]) -> ContextHealth:
        message_count = len(messages)
        total_chars = sum(len(message.content) for message in messages)

        correction_keywords = (
            "不是",
            "我说过了",
            "你又忘了",
            "前面已经说了",
            "你理解错了",
            "不是这个意思",
        )
        deprecated_keywords = (
            "废弃",
            "作废",
            "旧方案不用",
            "不要之前那个",
            "改成新方案",
            "之前方案不要了",
        )

        correction_count = sum(
            1
            for m in messages
            if m.role == "user" and any(w in m.content for w in correction_keywords)
        )
        deprecated_count = sum(
            1
            for m in messages
            if m.role == "user" and any(w in m.content for w in deprecated_keywords)
        )

        reasons: list[str] = []
        if message_count >= 80 or total_chars >= 50000:
            reasons.append("Conversation context is very large.")
        if correction_count >= 3:
            reasons.append("User has repeatedly corrected the assistant.")
        if deprecated_count >= 3:
            reasons.append("Conversation contains several deprecated decisions.")

        # Same as the user's tested V1 rule: two distinct reasons => RED.
        if len(reasons) >= 2:
            return ContextHealth(status="RED", reasons=reasons, should_handoff=True)
        if reasons:
            return ContextHealth(status="YELLOW", reasons=reasons, should_handoff=False)
        if message_count >= 40 or total_chars >= 20000:
            return ContextHealth(
                status="YELLOW",
                reasons=["Conversation context is becoming large."],
                should_handoff=False,
            )
        return ContextHealth(status="GREEN", reasons=[], should_handoff=False)
