"use strict";

// The DOM is only an observation source. The local SQLite store holds history.
console.log("[ChatGPT Bridge] Reader loaded.");

const conversationCaches = new Map(); // conversationId -> Map(messageKey -> message)
let lastSentConversationId = null;
let observer = null;
let routeTimer = null;
let syncTimer = null;
let retryTimer = null;

function getConversationId() {
    // Works for both /c/<id> and /g/<project>/c/<id> URLs.
    const match = location.pathname.match(/\/c\/([^/]+)/);
    return match ? match[1] : null;
}

function readVisibleMessages() {
    const elements = document.querySelectorAll("[data-content-search-unit-key]");
    const messages = [];

    for (const element of elements) {
        const key = element.getAttribute("data-content-search-unit-key");
        if (!key) continue;

        let role = null;
        if (key.endsWith(":user")) role = "user";
        if (key.endsWith(":assistant")) role = "assistant";
        if (role === null) continue;

        let content = element.innerText.trim();
        if (role === "assistant") {
            content = content.replace(/^ChatGPT 说：\s*/, "");
        }
        messages.push({ key, role, content });
    }
    return messages;
}

function stopInvalidatedReader() {
    if (observer) observer.disconnect();
    if (routeTimer !== null) clearInterval(routeTimer);
    if (syncTimer !== null) clearTimeout(syncTimer);
    if (retryTimer !== null) clearTimeout(retryTimer);
}

function scheduleRetry() {
    if (retryTimer !== null) return;
    retryTimer = setTimeout(() => {
        retryTimer = null;
        lastSentConversationId = null;
        syncConversationCache();
    }, 15000);
}

function syncConversationCache() {
    const conversationId = getConversationId();
    if (!conversationId) {
        // New unsaved chats can temporarily lack a /c/ ID. Capture begins
        // as soon as ChatGPT assigns one; never mix two tabs under "/".
        lastSentConversationId = null;
        return;
    }

    if (!conversationCaches.has(conversationId)) {
        conversationCaches.set(conversationId, new Map());
    }
    const cache = conversationCaches.get(conversationId);
    const visibleMessages = readVisibleMessages();
    let changed = false;

    for (const message of visibleMessages) {
        const previous = cache.get(message.key);
        if (!previous) {
            cache.set(message.key, message);
            changed = true;
        } else if (message.content.length > previous.content.length) {
            // Diagnostic only: ChatGPT fallback DOM keys aren't guaranteed
            // permanent; do not pretend this heuristic fixes all collisions.
            if (previous.content.length >= 30 &&
                !message.content.startsWith(previous.content)) {
                console.warn("[ChatGPT Bridge] Non-prefix change for existing key; " +
                             "verify ChatGPT DOM key stability:", message.key);
            }
            cache.set(message.key, message);
            changed = true;
        }
    }

    // Switching chats must emit even when the target cache didn't change.
    if (!changed && lastSentConversationId === conversationId) return;
    lastSentConversationId = conversationId;

    const messages = [...cache.values()].map(message => ({
        key: message.key,
        role: message.role,
        content: message.content,
    }));

    // Never put original chat contents in the console log.
    console.log("[ChatGPT Bridge] Sending:", conversationId, messages.length);

    try {
        if (!chrome.runtime || !chrome.runtime.id) {
            stopInvalidatedReader();
            return;
        }
        chrome.runtime.sendMessage({
            type: "CONVERSATION_UPDATED",
            conversationId,
            messages,
        }).then(reply => {
            if (!reply || !reply.ok) {
                console.warn("[ChatGPT Bridge] Backend unavailable; will retry.");
                scheduleRetry();
            }
        }).catch(error => {
            if (/Extension context invalidated/i.test(String(error))) {
                stopInvalidatedReader();
            } else {
                console.warn("[ChatGPT Bridge] Send failed; will retry.");
                scheduleRetry();
            }
        });
    } catch (error) {
        if (/Extension context invalidated/i.test(String(error))) {
            stopInvalidatedReader();
        } else {
            scheduleRetry();
        }
    }
}

function scheduleSync() {
    if (syncTimer !== null) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
        syncTimer = null;
        syncConversationCache();
    }, 500);
}

// A page mutation and a SPA URL change are two different triggers.
observer = new MutationObserver(scheduleSync);
observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
});
let observedRoute = location.pathname;
routeTimer = setInterval(() => {
    if (location.pathname !== observedRoute) {
        observedRoute = location.pathname;
        scheduleSync();
    }
}, 1200);

syncConversationCache();