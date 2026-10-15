"use strict";

console.log("[ChatGPT Bridge] Worker started.");

// Chrome can suspend service workers. All durable chat data is in SQLite.
// This Map serializes in-flight requests during the current worker lifetime.
const syncQueues = new Map();
const latestCapture = new Map();
const latestTabUpdate = new Map();
let updateSerial = 0;

const tabKey = tabId => `tabConversation:${tabId}`;
const healthKey = conversationId => `conversationHealth:${conversationId}`;

async function setBadge(tabId, status) {
    const styles = {
        SAVED: { text: "S", color: "#526a85" },
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

async function syncOnce(conversationId, messages, metadata, serial) {
    const response = await fetch("http://127.0.0.1:8000/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            conversation_id: conversationId,
            messages,
        }),
    });
    if (!response.ok) {
        const error = new Error(`/sync returned HTTP ${response.status}`);
        error.httpStatus = response.status;
        throw error;
    }
    const health = await response.json();
    if (health.conversation_id !== conversationId || health.status !== 'SAVED') {
        const error = new Error('Invalid collection acknowledgement');
        error.httpStatus = 502;
        throw error;
    }
    if (latestCapture.get(conversationId) === serial) {
        await chrome.storage.local.set({
            [healthKey(conversationId)]: { ...health, ...metadata,
                capture_state: metadata.pendingAssistants || metadata.unresolvedMessages ? 'CAPTURING' : 'SAVED',
                savedAt: Date.now() },
        });
        await badgeAllTabsForConversation(conversationId, metadata.pendingAssistants || metadata.unresolvedMessages ? 'PENDING' : 'SAVED');
    }
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
    const idFromUrl = url => {
        try { return new URL(url).pathname.match(/\/c\/([^/]+)/)?.[1]; }
        catch (_error) { return null; }
    };
    if ((message.sourceUrl && idFromUrl(message.sourceUrl) !== conversationId) ||
        (sender.tab.url && idFromUrl(sender.tab.url) !== conversationId)) {
        throw new Error('Stale Reader navigation');
    }
    const serial = ++updateSerial;
    latestCapture.set(conversationId, serial);
    latestTabUpdate.set(tabId, serial);
    if (message.readerVersion !== '2.0.0') {
        const prior = await chrome.storage.local.get(healthKey(conversationId));
        if (latestCapture.get(conversationId) === serial) {
            await chrome.storage.local.set({[healthKey(conversationId)]: {
                ...prior[healthKey(conversationId)], conversation_id:conversationId,
                capture_state:'FAILED', needsRefresh:true,
            }});
        }
        throw new Error('STALE_READER: refresh this ChatGPT page');
    }
    const metadata = {
        title: typeof message.title === 'string' ? message.title.slice(0,512) : '',
        pendingAssistants: message.pendingAssistants || 0,
        unresolvedMessages: message.unresolvedMessages || 0,
        readerVersion: message.readerVersion || 'legacy',
        needsRefresh:false,
        observedKeys: message.messages.map(m => m.key),
    };
    const oldMapping = await chrome.storage.session.get(tabKey(tabId));
    if (latestTabUpdate.get(tabId) === serial) {
        await chrome.storage.session.set({ [tabKey(tabId)]: conversationId });
    }
    if (latestTabUpdate.get(tabId) === serial && oldMapping[tabKey(tabId)] !== conversationId) {
        // Don't leave conversation A's badge on a tab that switched to B.
        const cached = await chrome.storage.local.get(healthKey(conversationId));
        await setBadge(tabId, cached[healthKey(conversationId)]?.status === "SAVED" ? "SAVED" : "PENDING");
    }
    if (latestCapture.get(conversationId) === serial) {
        const prior = await chrome.storage.local.get(healthKey(conversationId));
        if (latestCapture.get(conversationId) === serial) {
            await chrome.storage.local.set({[healthKey(conversationId)]: {
                ...prior[healthKey(conversationId)], ...metadata,
                conversation_id: conversationId, capture_state:'CAPTURING', startedAt:Date.now(),
            }});
        }
    }

    // For the SAME conversation, preserve request order in this worker.
    const previous = syncQueues.get(conversationId) || Promise.resolve();
    const current = previous.catch(() => {}).then(
        () => syncOnce(conversationId, message.messages, metadata, serial)
    );
    syncQueues.set(conversationId, current);

    try {
        return await current;
    } catch (error) {
        // Only current tabs of the failed conversation show an error badge.
        console.warn("[Context Hygiene] Sync failed:", String(error));
        if (latestCapture.get(conversationId) === serial) {
            const prior = await chrome.storage.local.get(healthKey(conversationId));
            await chrome.storage.local.set({[healthKey(conversationId)]: {
                ...prior[healthKey(conversationId)], ...metadata, conversation_id:conversationId,
                capture_state: error.httpStatus ? 'FAILED' : 'DISCONNECTED', error:String(error),
            }});
            await badgeAllTabsForConversation(conversationId, "ERROR");
        }
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
        receipt => sendResponse({ ok: true, conversationId:message.conversationId, receipt }),
        error => sendResponse({ ok: false, error: String(error) }),
    );
    // Keep this message channel alive until async /sync finishes.
    return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
    chrome.storage.session.remove(tabKey(tabId)).catch(() => {});
});
