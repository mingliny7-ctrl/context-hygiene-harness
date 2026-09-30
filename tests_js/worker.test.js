const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(
    path.join(__dirname, '../shared/chatgpt_bridge/bridge_worker.js'), 'utf8'
);

function makeWorker(fetchMock) {
    const local = {};
    const session = {};
    const badges = {};
    let listener;
    const storage = state => ({
        async get(keys) {
            if (keys === null) return {...state};
            const items = typeof keys === 'string' ? [keys] : keys;
            return Object.fromEntries(items.map(k => [k, state[k]]));
        },
        async set(updates) { Object.assign(state, updates); },
        async remove(key) { delete state[key]; },
    });
    const chrome = {
        runtime: {onMessage: {addListener(callback) { listener = callback; }}},
        storage: {local: storage(local), session: storage(session)},
        tabs: {onRemoved: {addListener() {}}},
        action: {
            async setBadgeText({tabId, text}) { badges[tabId] = {...badges[tabId], text}; },
            async setBadgeBackgroundColor({tabId, color}) {
                badges[tabId] = {...badges[tabId], color};
            },
        },
    };
    vm.runInNewContext(source, {chrome, fetch: fetchMock, console: {log() {}, warn() {}}});
    return {
        local, session, badges,
        emit(conversationId, tabId, messages) {
            return new Promise(resolve => {
                const result = listener(
                    {type: 'CONVERSATION_UPDATED', conversationId, messages},
                    {tab: {id: tabId}}, resolve
                );
                assert.equal(result, true);
            });
        },
    };
}

function fakeServer() {
    return async (_url, options) => {
        const body = JSON.parse(options.body);
        const count = body.messages.length;
        const status = count >= 2 ? 'YELLOW' : 'GREEN';
        return {
            ok: true,
            async json() {
                return {
                    conversation_id: body.conversation_id,
                    status,
                    reasons: [],
                    should_handoff: false,
                    message_count: count,
                    total_chars: 20,
                };
            },
        };
    };
}

test('worker saves distinct per-conversation statuses and badges per tab', async () => {
    const w = makeWorker(fakeServer());
    const msg = {key: 'k1', role: 'user', content: 'hello'};
    assert.equal((await w.emit('A', 17, [msg])).ok, true);
    assert.equal((await w.emit('B', 27, [msg, {...msg, key: 'k2'}])).ok, true);
    assert.equal(w.local['conversationHealth:A'].status, 'GREEN');
    assert.equal(w.local['conversationHealth:B'].status, 'YELLOW');
    assert.equal(w.badges[17].text, 'G');
    assert.equal(w.badges[27].text, 'Y');
    assert.equal(w.session['tabConversation:17'], 'A');
    assert.equal(w.session['tabConversation:27'], 'B');

    // Two tabs viewing the SAME chat should both update, but B remains separate.
    await w.emit('A', 37, [msg]);
    await w.emit('A', 17, [msg, {...msg, key: 'k2'}]);
    assert.equal(w.badges[17].text, 'Y');
    assert.equal(w.badges[37].text, 'Y');
    assert.equal(w.badges[27].text, 'Y');
});

test('older in-flight response cannot paint the badge of a switched tab', async () => {
    let releaseA;
    const waitA = new Promise(resolve => { releaseA = resolve; });
    const w = makeWorker(async (_url, options) => {
        const id = JSON.parse(options.body).conversation_id;
        if (id === 'A') await waitA;
        return {
            ok: true,
            async json() {
                return {
                    conversation_id: id,
                    status: id === 'A' ? 'RED' : 'GREEN',
                    reasons: [], should_handoff: id === 'A',
                    message_count: 1, total_chars: 1,
                };
            },
        };
    });
    const old = w.emit('A', 17, [{key: 'k', role: 'user', content: 'old'}]);
    // Let A's initial tab mapping finish before navigating to B.
    await new Promise(resolve => setImmediate(resolve));
    const fresh = w.emit('B', 17, [{key: 'k', role: 'user', content: 'new'}]);
    assert.equal((await fresh).ok, true);
    releaseA();
    assert.equal((await old).ok, true);
    assert.equal(w.session['tabConversation:17'], 'B');
    assert.equal(w.badges[17].text, 'G');
});