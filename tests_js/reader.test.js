const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(
    path.join(__dirname, '../shared/chatgpt_bridge/conversation_reader.js'),
    'utf8'
);

function makeReader(initialRoute, nodes) {
    const sent = [];
    const timeouts = new Map();
    let nextTimeout = 1;
    let observerCallback;
    let routeCallback;
    const page = {
        location: { pathname: initialRoute },
        nodes,
    };
    const chrome = {
        runtime: {
            id: 'test-extension',
            sendMessage(payload) {
                sent.push(payload);
                return Promise.resolve({ok: true});
            },
        },
    };
    const context = {
        console: {log() {}, warn() {}},
        location: page.location,
        document: {
            body: {},
            querySelectorAll() {
                return page.nodes.map(({key, content}) => ({
                    getAttribute() { return key; },
                    innerText: content,
                }));
            },
        },
        chrome,
        MutationObserver: class {
            constructor(callback) { observerCallback = callback; }
            observe() {}
            disconnect() {}
        },
        setTimeout(callback) {
            const id = nextTimeout++;
            timeouts.set(id, callback);
            return id;
        },
        clearTimeout(id) { timeouts.delete(id); },
        setInterval(callback) { routeCallback = callback; return 555; },
        clearInterval() {},
    };
    vm.runInNewContext(source, context);
    return {
        sent,
        page,
        async mutation() {
            observerCallback();
            const callbacks = [...timeouts.values()];
            timeouts.clear();
            callbacks.forEach(fn => fn());
            await Promise.resolve();
        },
        async routeCheck() {
            routeCallback();
            const callbacks = [...timeouts.values()];
            timeouts.clear();
            callbacks.forEach(fn => fn());
            await Promise.resolve();
        },
    };
}

test('reader keeps longer observed text even after the DOM shrinks', async () => {
    const r = makeReader('/c/A', [
        {key: 'turn-1:0:user', content: 'original very long message'},
        {key: 'turn-1:2:assistant', content: 'ChatGPT 说：a long reply'},
    ]);
    assert.equal(r.sent.length, 1);
    assert.equal(r.sent[0].messages.length, 2);
    assert.equal(r.sent[0].messages[1].content, 'a long reply');
    r.page.nodes = [
        {key: 'turn-1:0:user', content: 'tiny'},
        {key: 'turn-1:2:assistant', content: 'a'},
    ];
    await r.mutation();
    assert.equal(r.sent.length, 1, 'a shrink must not emit a smaller snapshot');
    r.page.nodes = [{key: 'turn-1:0:user', content: 'original very long message and new text'}];
    await r.mutation();
    assert.equal(r.sent.length, 2);
    assert.equal(r.sent[1].messages[0].content, 'original very long message and new text');
    assert.equal(r.sent[1].messages[1].content, 'a long reply');
});

test('reader isolates conversation caches and re-emits on chat switch', async () => {
    const r = makeReader('/c/A', [{key: 'k1:user', content: 'from A'}]);
    assert.equal(r.sent.at(-1).conversationId, 'A');
    r.page.location.pathname = '/g/g-p-demo/c/B';
    r.page.nodes = [{key: 'k1:user', content: 'from B'}];
    await r.routeCheck();
    assert.equal(r.sent.at(-1).conversationId, 'B');
    assert.equal(r.sent.at(-1).messages[0].content, 'from B');

    r.page.location.pathname = '/c/A';
    r.page.nodes = [{key: 'k1:user', content: 'from A'}];
    await r.routeCheck();
    assert.equal(r.sent.at(-1).conversationId, 'A');
    assert.equal(r.sent.at(-1).messages[0].content, 'from A');
    assert.equal(r.sent.length, 3);
});

test('reader waits until an unsaved chat has a real conversation ID', async () => {
    const r = makeReader('/', [{key: 't1:0:user', content: 'draft'}]);
    assert.equal(r.sent.length, 0);
    r.page.location.pathname = '/c/assigned-new-id';
    await r.routeCheck();
    assert.equal(r.sent.length, 1);
    assert.equal(r.sent[0].conversationId, 'assigned-new-id');
});

test('extension manifest has required MV3 permissions and localhost host access', () => {
    const manifest = JSON.parse(fs.readFileSync(
        path.join(__dirname, '../shared/chatgpt_bridge/manifest.json'), 'utf8'
    ));
    assert.equal(manifest.manifest_version, 3);
    assert.ok(manifest.permissions.includes('tabs'));
    assert.ok(manifest.permissions.includes('storage'));
    assert.ok(manifest.host_permissions.includes('<http://127.0.0.1:8000/*>'));
});