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
    const response = await fetch("http://127.0.0.1:18000/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            conversation_id: conversationId,
            title: metadata.title,
            messages,
            observed_order: metadata.observedOrder,
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
        observedOrder: message.observedOrder,
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

const NATIVE_HOST = 'com.context_harness.desktop_host';
const ATLAS_URL = 'http://127.0.0.1:14173/';
const serviceActions = new Map();
let serviceQueue = Promise.resolve();

function nativeRequest(operation) {
    return new Promise((resolve, reject) => {
        const fail=(code,detail)=>{
            // Small diagnostic, no chat bodies, paths, environment or credentials.
            chrome.storage?.local?.set({desktopHostDiagnostic:{code,operation,
                workerVersion:'1.0.3',extensionId:chrome.runtime.id,at:Date.now()}})?.catch(()=>{});
            reject(new Error(`[${code}] ${detail}`));
        };
        if (typeof chrome.runtime.sendNativeMessage!=='function') {
            fail('NATIVE_API_UNAVAILABLE','当前扩展未提供本机通信接口，请确认已重载原扩展并授予 nativeMessaging 权限。');
            return;
        }
        chrome.runtime.sendNativeMessage(NATIVE_HOST, {operation}, result => {
            const error = chrome.runtime.lastError;
            if (error) {
                const reason=String(error.message || '');
                console.warn('[Desktop Host] Native Messaging:',reason);
                const [code,detail]=/not found/i.test(reason)
                    ? ['HOST_NOT_FOUND','Edge 未找到本地启动组件，请核对 Native Host 注册。']
                    : /forbidden|not allowed/i.test(reason)
                    ? ['HOST_FORBIDDEN','当前扩展来源未获 Native Host 授权，请核对注册的扩展 ID。']
                    : /failed to start/i.test(reason)
                    ? ['HOST_START_FAILED','Edge 无法启动本地通信进程，请检查 Native Host 安装与系统限制。']
                    : /exited|communicating|connection/i.test(reason)
                    ? ['HOST_EXITED','本地通信进程启动或握手失败，请检查 Native Host 日志。']
                    : ['NATIVE_CONNECTION_FAILED','无法连接本地启动组件。请确认已注册 Native Host，并重新加载此扩展。'];
                fail(code,detail);
            } else if (!result?.ok) {
                reject(new Error(result?.error || result?.detail || '本地服务检查或启动失败。'));
            } else resolve(result);
        });
    });
}

async function pingNativeHost() {
    const pong = await nativeRequest('ping');
    if (pong.host !== NATIVE_HOST || pong.protocol_version !== 1) throw new Error('本地通信组件握手无效。');
}

async function existingServiceReady(collector) {
    const base=collector ? 'http://127.0.0.1:18000' : ATLAS_URL.slice(0,-1);
    const title=collector ? 'Context Harness Conversation Collector' : 'Conversation Atlas · read-only Store integration';
    try {
        const get=async path => {
            const response=await fetch(base+path,{cache:'no-store',redirect:'error',
                signal:typeof AbortSignal!=='undefined' ? AbortSignal.timeout(1500) : undefined});
            if (!response.ok) throw new Error('unhealthy');
            return response.json();
        };
        const [schema,health]=await Promise.all([get('/openapi.json'),get(collector ? '/health' : '/api/atlas')]);
        if (schema?.info?.title!==title) return false;
        const paths=collector ? ['/sync','/conversations/{conversation_id}/status']
            : ['/api/atlas','/api/atlas/conversations/{conversation_id}'];
        if (!paths.every(path=>Object.hasOwn(schema.paths || {},path))) return false;
        return collector ? health?.status==='ok'
            : health?.schemaVersion===1 && health?.provenance?.mode==='real' && Array.isArray(health.conversations);
    } catch (_) {return false;}
}

function desktopAction(action) {
    if (!['check_collector','start_collector','stop_collector','open_atlas'].includes(action)) return Promise.reject(new Error('不支持的服务操作。'));
    if (serviceActions.has(action)) return serviceActions.get(action);
    const run = serviceQueue.catch(() => {}).then(async () => {
        if (action === 'check_collector') {
            if (await existingServiceReady(true)) return {ok:true,service:'Collector',ready:true,state:'ready'};
            await pingNativeHost();
            const result = await nativeRequest('check_collector');
            if (result.service !== 'Collector' || !['ready','stopped','conflict','unhealthy'].includes(result.state)
                || result.ready !== (result.state === 'ready')) throw new Error('本地服务身份响应无效。');
            return result;
        }
        if (action === 'stop_collector') {
            const result = await nativeRequest('stop_collector');
            if (result.service !== 'Collector' || result.state !== 'stopped' || result.ready !== false)
                throw new Error('尚未确认采集服务关闭。');
            return {ok:true,service:'Collector',ready:false,state:'stopped',message:'采集已关闭'};
        }
        const collector = action === 'start_collector';
        const service = collector ? 'Collector' : 'Atlas';
        const suffix = collector ? 'collector' : 'atlas';
        // A running healthy backend does not require Native Host registration.
        if (!await existingServiceReady(collector)) {
            await pingNativeHost();
            let result = await nativeRequest('check_' + suffix);
            if (result.service !== service || typeof result.ready !== 'boolean') throw new Error('本地服务身份响应无效。');
            if (!result.ready) result = await nativeRequest('start_' + suffix);
            if (!result.ready || result.service !== service) throw new Error(result.detail || '服务未通过健康检查。');
        }
        if (!collector) await chrome.tabs.create({url:ATLAS_URL});
        return {ok:true,ready:true,state:'ready',service,message:collector ? '采集服务运行中' : '图谱服务运行中，已打开图谱'};
    });
    serviceActions.set(action,run);
    serviceQueue=run;
    run.finally(() => { if (serviceActions.get(action)===run) serviceActions.delete(action); }).catch(() => {});
    return run;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'DESKTOP_SERVICE') {
        if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) {
            sendResponse({ok:false,error:'只允许 Collector Popup 操作本地服务。'});
            return false;
        }
        desktopAction(message.action).then(sendResponse, error => sendResponse({ok:false,error:error.message}));
        return true;
    }
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
