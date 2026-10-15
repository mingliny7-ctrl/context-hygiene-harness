const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(
    path.join(__dirname, '../shared/chatgpt_bridge/bridge_worker.js'), 'utf8'
);

test('worker forwards observed DOM order without using cumulative message array order',async()=>{
    let posted;
    const w=makeWorker(async(_url,options)=>{
        posted=JSON.parse(options.body);
        return {ok:true,async json(){return {conversation_id:'A',status:'SAVED',message_count:2};}};
    });
    await w.emit('A',1,[
        {key:'late',role:'assistant',content:'late'},
        {key:'early',role:'user',content:'early'},
    ],{observedOrder:['early','late']});
    assert.deepEqual(posted.observed_order,['early','late']);
});

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
    vm.runInNewContext(source, {chrome, fetch: fetchMock, URL, console: {log() {}, warn() {}}});
    return {
        local, session, badges,
        emit(conversationId, tabId, messages, extra={}, tabUrl) {
            return new Promise(resolve => {
                const result = listener(
                    {type: 'CONVERSATION_UPDATED', conversationId, messages,readerVersion:'2.0.0',...extra},
                    {tab: {id: tabId,url:tabUrl}}, resolve
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
        const status = 'SAVED';
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
    assert.equal(w.local['conversationHealth:A'].status, 'SAVED');
    assert.equal(w.local['conversationHealth:B'].status, 'SAVED');
    assert.equal(w.local['conversationHealth:A'].message_count, 1);
    assert.equal(w.local['conversationHealth:B'].message_count, 2);
    assert.equal(w.badges[17].text, 'S');
    assert.equal(w.badges[27].text, 'S');
    assert.equal(w.session['tabConversation:17'], 'A');
    assert.equal(w.session['tabConversation:27'], 'B');

    // Two tabs viewing the SAME chat should both update, but B remains separate.
    await w.emit('A', 37, [msg]);
    await w.emit('A', 17, [msg, {...msg, key: 'k2'}]);
    assert.equal(w.badges[17].text, 'S');
    assert.equal(w.badges[37].text, 'S');
    assert.equal(w.badges[27].text, 'S');
});

test('worker rejects stale navigation before HTTP and waits for HTTP ack before SAVED',async()=>{
    let release;const wait=new Promise(resolve=>release=resolve);let calls=0;
    const w=makeWorker(async(url,options)=>{calls++;await wait;return fakeServer()(url,options);});
    const stale=await w.emit('A',17,[],{sourceUrl:'https://chatgpt.com/c/A'},'https://chatgpt.com/c/B');
    assert.equal(stale.ok,false);assert.equal(calls,0);
    const pending=w.emit('B',17,[],{title:'B real',sourceUrl:'https://chatgpt.com/c/B'},'https://chatgpt.com/c/B');
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(w.local['conversationHealth:B'].capture_state,'CAPTURING');
    assert.notEqual(w.local['conversationHealth:B'].status,'SAVED');
    release();const reply=await pending;assert.equal(reply.conversationId,'B');
    assert.equal(w.local['conversationHealth:B'].capture_state,'SAVED');assert.equal(w.local['conversationHealth:B'].title,'B real');
});

test('worker refuses old Reader payloads rather than saving cross-page fallback records',async()=>{
    let calls=0;const w=makeWorker(async()=>{calls++;throw new Error('must not fetch');});
    const reply=await w.emit('A',17,[],{readerVersion:'legacy'});
    assert.equal(reply.ok,false);assert.equal(calls,0);
    assert.equal(w.local['conversationHealth:A'].needsRefresh,true);
    assert.equal(w.local['conversationHealth:A'].capture_state,'FAILED');
});

test('older in-flight response cannot paint the badge of a switched tab', async () => {
    let releaseA;
    const waitA = new Promise(resolve => { releaseA = resolve; });
    const w = makeWorker(async (_url, options) => {
        const id = JSON.parse(options.body).conversation_id;
        if (id === 'A') { await waitA; throw new Error('old request failed'); }
        return {
            ok: true,
            async json() {
                return {
                    conversation_id: id,
                    status: 'SAVED',
                    reasons: [], should_handoff: false,
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
    assert.equal((await old).ok, false);
    assert.equal(w.session['tabConversation:17'], 'B');
    assert.equal(w.badges[17].text, 'S');
});
