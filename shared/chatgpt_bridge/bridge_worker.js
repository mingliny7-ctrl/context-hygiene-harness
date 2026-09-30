"use strict";

console.log("[ChatGPT Bridge] Worker started.");

// Chrome can suspend service workers. All durable chat data is in SQLite.
// This Map serializes in-flight requests during the current worker lifetime.
const syncQueues = new Map();

const tabKey = tabId => `tabConversation:${tabId}`;
const healthKey = conversationId => `conversationHealth:${conversationId}`;

async function setBadge(tabId, status) {
    const styles = {
        GREEN: { text: "G", color: "#2e7d32" },
        YELLOW: { text: "Y", color: "#f9a825" },
        RED: { text: "R", color: "#c62828" },
        PENDING: { text: "…", color: "#777777" },
    };
    const style = styles[status] || { text: "!", color: "#777777" };
    try {
        await chrome.action.setBadgeText({ tabId, text: style.text });
        await chrome.action.setBadgeBackgroundColor({ tabId, color: style.color });
    } catch (_error) {
        // The tab might have closed while the HTTP request was in flight.
    }
}

async function badgeAllTabsForConversation(conversationId, status) {
    const mapping = await chrome.storage.session.get(null);
    for (const [key, value] of Object.entries(mapping)) {
        if (!key.startsWith("tabConversation:") || value !== conversationId) {
            continue;
        }
        const tabId = Number(key.slice("tabConversation:".length));
        if (Number.isInteger(tabId)) await setBadge(tabId, status);
    }
}

async function syncOnce(conversationId, messages) {
    const response = await fetch("http://127.0.0.1:8000/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            conversation_id: conversationId,
            messages,
        }),
    });
    if (!response.ok) throw new Error(`/sync returned HTTP ${response.status}`);
    const health = await response.json();
    await chrome.storage.local.set({
        [healthKey(conversationId)]: { ...health, savedAt: Date.now() },
    });
    await badgeAllTabsForConversation(conversationId, health.status);
    console.log("[Context Hygiene] Synchronized:",
                conversationId, health.message_count, health.status);
    return health;
}

async function handleUpdate(message, sender) {
    const tabId = sender.tab?.id;
    if (typeof tabId !== "number" ||
        !message.conversationId ||
        !Array.isArray(message.messages)) {
        throw new Error("Invalid Reader update payload.");
    }

    const conversationId = message.conversationId;
    const oldMapping = await chrome.storage.session.get(tabKey(tabId));
    await chrome.storage.session.set({ [tabKey(tabId)]: conversationId });
    if (oldMapping[tabKey(tabId)] !== conversationId) {
        // Don't leave conversation A's badge on a tab that switched to B.
        const cached = await chrome.storage.local.get(healthKey(conversationId));
        await setBadge(tabId, cached[healthKey(conversationId)]?.status || "PENDING");
    }

    // For the SAME conversation, preserve request order in this worker.
    const previous = syncQueues.get(conversationId) || Promise.resolve();
    const current = previous.catch(() => {}).then(
        () => syncOnce(conversationId, message.messages)
    );
    syncQueues.set(conversationId, current);

    try {
        return await current;
    } catch (error) {
        // Only current tabs of the failed conversation show an error badge.
        console.warn("[Context Hygiene] Sync failed:", String(error));
        await badgeAllTabsForConversation(conversationId, "ERROR");
        throw error;
    } finally {
        if (syncQueues.get(conversationId) === current) {
            syncQueues.delete(conversationId);
        }
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== "CONVERSATION_UPDATED") return false;
    handleUpdate(message, sender).then(
        () => sendResponse({ ok: true }),
        error => sendResponse({ ok: false, error: String(error) }),
    );
    // Keep this message channel alive until async /sync finishes.
    return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
    chrome.storage.session.remove(tabKey(tabId)).catch(() => {});
});