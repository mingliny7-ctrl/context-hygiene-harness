"use strict";

// The DOM is only an observation source. The local SQLite store holds history.
console.log("[ChatGPT Bridge] Reader loaded.");

const conversationCaches = new Map(); // conversationId -> Map(messageKey -> message)
const rootConversations = new WeakMap();
let lastSentConversationId = null;
let lastMetadata = "";
let navigationVersion = 0;
let observedRoute = location.pathname;
let observer = null;
let routeTimer = null;
let syncTimer = null;
let retryTimer = null;

function getConversationId() {
    // Works for both /c/<id> and /g/<project>/c/<id> URLs.
    const match = location.pathname.match(/\/c\/([^/]+)/);
    if (!match) return null;
    let id;
    try {
        id = decodeURIComponent(match[1]);
    } catch (_error) {
        return null;
    }
    // ChatGPT may put /c/local-chatgpt%3A... in the URL before saving a chat.
    // It is NOT another historical conversation. Wait for the server ID;
    // never infer aliases from tab identity or matching message bodies.
    if (id.toLowerCase().startsWith("local-chatgpt")) return null;
    return match[1];
}

function getConversationRoot(conversationId) {
    const roots = document.querySelectorAll('[data-app-shell-active-page="true"]');
    // Fail closed if the active page is not identifiable. Never use hidden
    // SPA pages or guess from their message bodies.
    if (roots.length !== 1) return null;
    const root = roots[0];
    const owner = rootConversations.get(root);
    if (owner && owner !== conversationId) return null; // URL changed before DOM
    rootConversations.set(root, conversationId);
    return root;
}

function readTitle(conversationId) {
    for (const link of document.querySelectorAll('a[href]')) {
        try {
            const path = new URL(link.getAttribute('href'), location.origin).pathname;
            if (path.match(/\/c\/([^/]+)/)?.[1] === conversationId) {
                const title = (link.innerText || link.textContent || '').trim();
                if (title) return title;
            }
        } catch (_error) { /* Ignore unrelated links. */ }
    }
    return ''; // No message excerpts masquerading as titles.
}

function readVisibleMessages(root) {
    const elements = root.querySelectorAll("[data-content-search-unit-key]");
    const messages = [];
    let pendingAssistants = 0;
    let unresolvedMessages = 0;

    for (const element of elements) {
        const domKey = element.getAttribute("data-content-search-unit-key");
        if (!domKey) continue;

        let role = null;
        if (domKey.endsWith(":user")) role = "user";
        if (domKey.endsWith(":assistant")) role = "assistant";
        if (role === null) continue;

        const source = element.closest('[data-chatgpt-search-message-ids]');
        const ids = [...new Set((source?.getAttribute('data-chatgpt-search-message-ids') || '').trim().split(/\s+/).filter(Boolean))];
        if (ids.length !== 1 || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(ids[0])) {
            unresolvedMessages++;
            continue; // A fallback position is not a persistent message identity.
        }

        let content = element.innerText.trim();
        if (role === "assistant") {
            content = content.replace(/^ChatGPT 说：\s*/, "");
            const state = element.closest('[data-talvt-turn-state]')?.getAttribute('data-talvt-turn-state');
            if (state !== 'complete' || !content.trim()) {
                pendingAssistants++;
                continue; // Re-observe this native ID; publish only a completed body.
            }
        }
        const key = `chatgpt:${ids[0].toLowerCase()}:${role}`;
        messages.push({ key, role, content });
    }
    return { messages, pendingAssistants, unresolvedMessages };
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
    if (location.pathname !== observedRoute) {
        observedRoute = location.pathname;
        navigationVersion++;
        lastSentConversationId = null;
    }
    const conversationId = getConversationId();
    if (!conversationId) {
        // Unsaved chats may lack /c/ or have a local-chatgpt placeholder.
        // The existing mutation/route triggers read the live DOM once a
        // server ID appears. Do not carry a draft cache into another route.
        lastSentConversationId = null;
        return;
    }
    const root = getConversationRoot(conversationId);
    if (!root) return;

    if (!conversationCaches.has(conversationId)) {
        conversationCaches.set(conversationId, new Map());
    }
    const cache = conversationCaches.get(conversationId);
    const observation = readVisibleMessages(root);
    const visibleMessages = observation.messages;
    const title = readTitle(conversationId);
    const observedOrder = [...new Set(visibleMessages.map(message => message.key))];
    const metadata = JSON.stringify([title, observation.pendingAssistants, observation.unresolvedMessages, observedOrder]);
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
    if (!changed && lastSentConversationId === conversationId && lastMetadata === metadata) return;
    lastSentConversationId = conversationId;
    lastMetadata = metadata;
    const version = navigationVersion;

    const messages = [...cache.values()].map(message => ({
        key: message.key,
        role: message.role,
        content: message.content,
    }));

    // Never put original chat contents in the console log.
    console.log("[ChatGPT Bridge] Sending:", conversationId, messages.length,
                "native IDs", messages.map(m => m.key), "navigation", version);

    try {
        if (!chrome.runtime || !chrome.runtime.id) {
            stopInvalidatedReader();
            return;
        }
        chrome.runtime.sendMessage({
            type: "CONVERSATION_UPDATED",
            conversationId,
            messages,
            observedOrder,
            title,
            pendingAssistants: observation.pendingAssistants,
            unresolvedMessages: observation.unresolvedMessages,
            navigationVersion: version,
            sourceUrl: location.href,
            readerVersion: '2.0.0',
        }).then(reply => {
            if (version !== navigationVersion || getConversationId() !== conversationId) return;
            if (!reply || !reply.ok) {
                console.warn("[ChatGPT Bridge] Backend unavailable; will retry.");
                scheduleRetry();
            }
        }).catch(error => {
            if (version !== navigationVersion || getConversationId() !== conversationId) return;
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
    if (syncTimer !== null) return; // Bounded throttle, not starvation-prone debounce.
    syncTimer = setTimeout(() => {
        syncTimer = null;
        syncConversationCache();
    }, 500);
}

// A page mutation and a SPA URL change are two different triggers.
observer = new MutationObserver(scheduleSync);
observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['data-app-shell-active-page', 'data-chatgpt-search-message-ids', 'data-talvt-turn-state'],
});
routeTimer = setInterval(() => {
    // Also recovers an observation if a framework replaces a container without
    // a useful callback. No scrolling or interaction is performed.
    syncConversationCache();
}, 1200);

syncConversationCache();
