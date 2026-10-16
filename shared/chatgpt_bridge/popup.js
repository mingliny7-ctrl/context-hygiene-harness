"use strict";

const statusBadge = document.getElementById("statusBadge");
const messageCount = document.getElementById("messageCount");
const conversationTitle = document.getElementById("conversationTitle");
const reasons = document.getElementById("reasons");
const latestAnswer = document.getElementById("latestAnswer");
const connectionNotice = document.getElementById("connectionNotice");

let currentConversationId = null;
let currentTabId = null;
let requestSerial = 0;
const healthKey = id => `conversationHealth:${id}`;

function conversationIdFromUrl(url) {
    try {
        const parsed = new URL(url);
        if (parsed.hostname !== "chatgpt.com") return null;
        const match = parsed.pathname.match(/\/c\/([^/]+)/);
        if (match && decodeURIComponent(match[1]).toLowerCase().startsWith('local-chatgpt')) return null;
        return match ? match[1] : null;
    } catch (_error) {
        return null;
    }
}

function waiting(text, state='CAPTURING') {
    statusBadge.textContent = {CAPTURING:'正在采集',DISCONNECTED:'未连接',FAILED:'保存失败'}[state] || '正在采集';
    statusBadge.className = "status";
    messageCount.textContent = "暂不可用";
    reasons.textContent = text;
    latestAnswer.textContent = '无法确认已保存回答';
}

function render(health, fromDatabase = false) {
    if (!health) return;
    if (health.status !== "SAVED") {
        waiting("旧风险评分已停用；正在读取采集状态...");
        return;
    }
    const state = health.capture_state || 'SAVED';
    statusBadge.textContent = {SAVED:'已保存',CAPTURING:'正在采集',DISCONNECTED:'未连接',FAILED:'保存失败'}[state] || '正在采集';
    statusBadge.className = "status";
    messageCount.textContent = !fromDatabase ? '正在确认…'
        : Number.isInteger(health.assistant_reply_count) ? health.assistant_reply_count
        : Number.isInteger(health.confirmed_assistant_reply_count)
            ? `至少 ${health.confirmed_assistant_reply_count} 条` : '暂不可用';
    if (health.title) conversationTitle.textContent = health.title;
    reasons.replaceChildren();
    reasons.textContent = health.count_status === 'legacy_identity_unverified'
        ? `已确认保存 ${health.confirmed_assistant_reply_count ?? 0} 条原始ID模型回复；旧消息身份未归一，总数暂不可用。`
        : '仅统计数据库已保存的有效模型回复，不代表对话已采集完整。';
    if (health.unresolvedMessages) reasons.textContent += ' 部分消息身份尚未确认，正在等待页面提供来源。';
    if (health.needsRefresh) reasons.textContent = '此页面仍在运行旧Reader，请刷新这个ChatGPT页面后继续采集。';
    latestAnswer.textContent = !fromDatabase ? '正在确认已保存回答…'
        : health.latest_assistant_status === 'empty' ? '暂无已保存的模型回答'
        : health.latest_assistant_status === 'saved_event' && typeof health.latest_assistant_preview === 'string'
            ? health.latest_assistant_preview
            : '历史保存事件未记录，等待新保存';
}

function clearConversation() {
    requestSerial++;
    currentConversationId = null;
    conversationTitle.textContent = '正在获取对话名称';
    messageCount.textContent = '暂不可用';
    latestAnswer.textContent = '正在确认已保存回答…';
    statusBadge.textContent = '正在采集';
    reasons.textContent = '';
    connectionNotice.textContent = '';
}

async function refreshPopup() {
    const serial = ++requestSerial;
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (requestSerial !== serial) return;
    currentTabId = tabs[0]?.id;
    const id = conversationIdFromUrl(tabs[0]?.url);
    if (id !== currentConversationId) {
        conversationTitle.textContent = '正在获取对话名称';
        latestAnswer.textContent = '正在确认已保存回答…';
        messageCount.textContent = '暂不可用';
    }
    currentConversationId = id;
    connectionNotice.textContent = "";
    if (!id) {
        waiting("请打开一个已有聊天；新聊天创建 ID 后才能保存。");
        return;
    }

    const key = healthKey(id);
    const saved = await chrome.storage.local.get(key);
    if (requestSerial !== serial) return;
    // Polling must not blank an already DB-confirmed result every 1.5 seconds.
    if (saved[key]?.title) conversationTitle.textContent = saved[key].title;

    // SQLite is authoritative; GET restores even after extension restarts.
    try {
        const response = await fetch(
            `http://127.0.0.1:18000/conversations/${encodeURIComponent(id)}/status`
        );
        if (requestSerial !== serial || currentConversationId !== id) return;
        if (response.status === 404) {
            waiting("本地数据库尚无此聊天；等待 Reader 同步。");
            if (saved[key]) {
                connectionNotice.textContent = "浏览器中有旧状态，但当前数据库没有对应记录。";
            }
            return;
        }
        if (!response.ok) {
            const error = new Error(`HTTP ${response.status}`);
            error.httpStatus = response.status;
            throw error;
        }
        const health = await response.json();
        if (requestSerial !== serial || currentConversationId !== id) return;
        if (health.conversation_id !== id) {
            const error = new Error('Mismatched conversation receipt');
            error.httpStatus = 502;
            throw error;
        }
        // If Worker posted a newer result while GET was in flight, don't
        // overwrite its newer badge/Popup status with an older response.
        const newest = await chrome.storage.local.get(key);
        if (requestSerial !== serial || currentConversationId !== id) return;
        const metadata = newest[key] || saved[key] || {};
        const state = metadata.capture_state === 'FAILED' ? 'FAILED'
            : metadata.pendingAssistants || metadata.unresolvedMessages || ['CAPTURING','DISCONNECTED'].includes(metadata.capture_state) ? 'CAPTURING' : 'SAVED';
        render({...metadata, ...health, capture_state:state}, true);
        // Worker owns the write acknowledgement. GET cannot turn an older
        // receipt into a newer save or overwrite an in-flight operation.
    } catch (_error) {
        if (requestSerial !== serial || currentConversationId !== id) return;
        waiting('无法确认当前保存结果，请检查本地采集服务。', _error.httpStatus ? 'FAILED' : 'DISCONNECTED');
        connectionNotice.textContent = saved[key]
            ? "无法确认当前数据库状态，请检查本地采集服务。"
            : "无法连接本地后端：请点击下方“启动服务”。";
    }
}

// While Popup is open, update if the Worker saved a newer status.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !currentConversationId) return;
    const change = changes[healthKey(currentConversationId)];
    if (change?.newValue) {
        refreshPopup().catch(() => waiting('无法确认保存结果。', 'DISCONNECTED'));
    }
});

// Clear synchronously on navigation, before awaiting tab/storage/HTTP reads.
chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (tabId === currentTabId && change.url) {
        clearConversation();
        refreshPopup().catch(() => waiting('无法确认保存结果。', 'DISCONNECTED'));
    }
});
chrome.tabs.onActivated.addListener(() => {
    clearConversation();
    refreshPopup().catch(() => waiting('无法确认保存结果。', 'DISCONNECTED'));
});

refreshPopup().catch(error => {
    console.error("Popup failed:", error);
    waiting("读取状态失败，请刷新聊天页面。",'FAILED');
});

if (typeof setInterval === 'function') setInterval(() => {
    refreshPopup().catch(() => waiting('无法连接采集服务。','DISCONNECTED'));
}, 1500);
