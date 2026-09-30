const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(
    path.join(__dirname, '../shared/chatgpt_bridge/popup.js'), 'utf8'
);

async function makePopup(tabUrl, localHealth, fetchMock) {
    const nodes = {};
    for (const id of [
        'statusBadge', 'messageCount', 'totalChars',
        'reasons', 'handoff', 'connectionNotice',
    ]) {
        nodes[id] = {
            textContent: '', className: '', children: [],
            replaceChildren() {this.children = []; this.textContent = '';},
            appendChild(child) {this.children.push(child);},
        };
    }
    const local = {...localHealth};
    let onChanged;
    const context = {
        URL,
        Date,
        console: {log() {}, warn() {}, error() {}},
        document: {
            getElementById(id) {return nodes[id];},
            createElement() {return {textContent: '', className: ''};},
        },
        fetch: fetchMock,
        chrome: {
            tabs: {async query() {return [{id: 17, url: tabUrl}];}},
            storage: {
                local: {
                    async get(key) {return {[key]: local[key]};},
                    async set(values) {
                        const changes = {};
                        for (const [key, value] of Object.entries(values)) {
                            changes[key] = {oldValue: local[key], newValue: value};
                            local[key] = value;
                        }
                        if (onChanged) onChanged(changes, 'local');
                    },
                },
                onChanged: {addListener(fn) {onChanged = fn;}},
            },
        },
    };
    vm.runInNewContext(source, context);
    await new Promise(resolve => setImmediate(resolve));
    return {nodes, local};
}

test('popup restores current conversation from SQLite status even without local cache', async () => {
    const p = await makePopup(
        '<https://chatgpt.com/g/example/c/B>',
        {'conversationHealth:A': {status:'RED',message_count:999,total_chars:9999,reasons:[],should_handoff:true}},
        async url => {
            assert.ok(url.endsWith('/conversations/B/status'));
            return {
                ok: true,
                async json() {return {
                    conversation_id: 'B', status: 'YELLOW',
                    message_count: 5, total_chars: 41,
                    reasons: ['Conversation context is becoming large.'],
                    should_handoff: false,
                };},
            };
        },
    );
    assert.equal(p.nodes.statusBadge.textContent, 'YELLOW');
    assert.equal(p.nodes.messageCount.textContent, 5);
    assert.equal(p.nodes.totalChars.textContent, '41');
    assert.equal(p.nodes.reasons.children[0].textContent, '对话上下文正在变长。');
    assert.equal(p.local['conversationHealth:B'].message_count, 5);
});

test('popup refuses to present a deleted DB conversation as current truth', async () => {
    const p = await makePopup(
        '<https://chatgpt.com/c/A>',
        {'conversationHealth:A': {
            status:'RED', message_count:100,total_chars:50000,
            reasons:[],should_handoff:true,savedAt:1,
        }},
        async () => ({status: 404, ok: false}),
    );
    assert.equal(p.nodes.statusBadge.textContent, '--');
    assert.match(p.nodes.reasons.textContent, /数据库尚无/);
    assert.match(p.nodes.connectionNotice.textContent, /旧状态/);
});