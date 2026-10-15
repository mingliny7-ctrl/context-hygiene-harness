"use strict";

const statusBadge = document.getElementById("statusBadge");
const messageCount = document.getElementById("messageCount");
const totalChars = document.getElementById("totalChars");
const reasons = document.getElementById("reasons");
const handoff = document.getElementById("handoff");
const connectionNotice = document.getElementById("connectionNotice");

let currentConversationId = null;
let requestSerial = 0;
const healthKey = id => `conversationHealth:${id}`;

function conversationIdFromUrl(url) {
    try {
        const parsed = new URL(url);
        if (parsed.hostname !== "chatgpt.com") return null;
        const match = parsed.pathname.match(/\/c\/([^/]+)/);
        return match ? match[1] : null;
    } catch (_error) {
        return null;
    }
}

function waiting(text) {
    statusBadge.textContent = "--";
    statusBadge.className = "status";
    messageCount.textContent = "-";
    totalChars.textContent = "-";
    reasons.textContent = text;
    handoff.textContent = "";
    handoff.className = "handoff";
}

function render(health) {
    if (!health) return;
    if (health.status !== "SAVED") {
        waiting("旧风险评分已停用；正在读取采集状态...");
        return;
    }
    statusBadge.textContent = "已保存";
    statusBadge.className = "status";
    messageCount.textContent = health.message_count;
    totalChars.textContent = health.total_chars.toLocaleString();
    reasons.replaceChildren();
    reasons.textContent = "已保存本次观察到的消息；不代表已采集完整对话。";
    handoff.textContent = "";
    handoff.className = "handoff";
}

async function refreshPopup() {
    const serial = ++requestSerial;
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const id = conversationIdFromUrl(tabs[0]?.url);
    currentConversationId = id;
    connectionNotice.textContent = "";
    if (!id) {
        waiting("请打开一个已有聊天；新聊天创建 ID 后才能保存。");
        return;
    }

    const key = healthKey(id);
    const saved = await chrome.storage.local.get(key);
    if (requestSerial !== serial) return;
    if (saved[key]) render(saved[key]);
    else waiting("正在恢复该聊天的历史状态...");

    // SQLite is authoritative; GET restores even after extension restarts.
    try {
        const response = await fetch(
            `http://127.0.0.1:8000/conversations/${encodeURIComponent(id)}/status`
        );
        if (requestSerial !== serial || currentConversationId !== id) return;
        if (response.status === 404) {
            waiting("本地数据库尚无此聊天；等待 Reader 同步。");
            if (saved[key]) {
                connectionNotice.textContent = "浏览器中有旧状态，但当前数据库没有对应记录。";
            }
            return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const health = await response.json();
        if (requestSerial !== serial || currentConversationId !== id) return;
        // If Worker posted a newer result while GET was in flight, don't
        // overwrite its newer badge/Popup status with an older response.
        const newest = await chrome.storage.local.get(key);
        if (requestSerial !== serial || currentConversationId !== id) return;
        if ((newest[key]?.savedAt || 0) > (saved[key]?.savedAt || 0)) {
            render(newest[key]);
            return;
        }
        render(health);
        await chrome.storage.local.set({ [key]: { ...health, savedAt: Date.now() } });
    } catch (_error) {
        if (requestSerial !== serial || currentConversationId !== id) return;
        connectionNotice.textContent = saved[key]
            ? "本地后端未连接：目前显示的是上次结果。"
            : "无法连接本地后端：请启动 FastAPI 并刷新聊天页面。";
    }
}

// While Popup is open, update if the Worker saved a newer status.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !currentConversationId) return;
    const change = changes[healthKey(currentConversationId)];
    if (change?.newValue) {
        render(change.newValue);
        connectionNotice.textContent = "";
    }
});

refreshPopup().catch(error => {
    console.error("Popup failed:", error);
    waiting("读取状态失败，请刷新聊天页面。");
});
