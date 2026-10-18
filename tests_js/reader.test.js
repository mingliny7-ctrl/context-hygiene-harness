const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(
    path.join(__dirname, '../shared/chatgpt_bridge/conversation_reader.js'),
    'utf8'
);

function makeReader(initialRoute, nodes, readingCapture, links = [], tabTitle = 'ChatGPT') {
    const sent = [];
    const timeouts = new Map();
    let nextTimeout = 1;
    let observerCallback;
    let routeCallback;
    const page = {
        location: { pathname: initialRoute, origin:'https://chatgpt.com', get href(){return this.origin+this.pathname;} },
        nodes,
    };
    const roots = new Map();
    function elements() {
        return page.nodes.map(({key, content}) => {
            let n=0;for(const char of key)n=(n*31+char.charCodeAt(0))>>>0;
            const id=`00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
            return {getAttribute(name){return name==='data-content-search-unit-key'?key:null;},innerText:content,
                closest(selector){return {owner:true,querySelectorAll(){return [{}];},getAttribute(name){return name==='data-chatgpt-search-message-ids'?id:name==='data-talvt-turn-state'?'complete':null;}};}};
        });
    }
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
        ...(readingCapture ? {AtlasReadingCapture:readingCapture} : {}),
        console: {log() {}, warn() {}},
        location: page.location,
        URL,
        document: {
            title: tabTitle,
            body: {},
            documentElement: {},
            querySelectorAll(selector) {
                if(selector==='a[href]')return links;
                if(selector==='[data-app-shell-active-page="true"]'){
                    if(!roots.has(page.location.pathname))roots.set(page.location.pathname,{querySelectorAll:elements});
                    return [roots.get(page.location.pathname)];
                }
                return elements();
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

test('reader accepts only the exact ChatGPT sidebar row as original title', () => {
    const link = (href, title, sidebar) => ({
        getAttribute(name) { return name === 'href' ? href : null; },
        hasAttribute(name) { return name === 'data-interactive-row-link' && sidebar; },
        innerText: title,
    });
    const r = makeReader('/g/project/c/real-id', [{key:'turn-1:0:user',content:'question'}], null, [
        link('#skip', '跳转到内容', false),
        link('/g/project/c/other-id', '其他对话', true),
        link('/g/project/c/real-id', '视频内容总结', true),
    ]);
    assert.equal(r.sent[0].title, '视频内容总结');
});

test('direct conversation page can use its tab title but a project page cannot', () => {
    const direct = makeReader('/c/real-id', [{key:'turn-1:0:user',content:'question'}], null, [], 'GPT账号协作方案');
    assert.equal(direct.sent[0].title, 'GPT账号协作方案');
    const project = makeReader('/g/project/c/real-id', [{key:'turn-1:0:user',content:'question'}], null, [], '视频总结提炼');
    assert.equal(project.sent[0].title, '');
});

test('a visible ChatGPT reply-load error never replaces a saved assistant body', () => {
    const r = makeReader('/c/real-id', [
        {key:'turn-1:0:user',content:'question'},
        {key:'turn-1:1:assistant',content:'ChatGPT 说：无法加载此回复'},
    ]);
    assert.equal(r.sent[0].messages.length, 1);
    assert.equal(r.sent[0].messages[0].role, 'user');
    assert.equal(r.sent[0].pendingAssistants, 1);
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

for (const temporary of ['local-chatgpt:draft-1', 'local-chatgpt%3Adraft-1']) {
    test(`reader waits through ${temporary} and reads full canonical messages`, async () => {
        const r = makeReader(`/c/${temporary}`, [
            {key: 'turn-0:0:user', content: '完整用户问题'},
            {key: 'turn-0:2:assistant', content: 'ChatGPT 说：完整模型回答\n```python\nprint(1)\n```'},
        ]);
        await r.mutation();
        assert.equal(r.sent.length, 0, 'temporary IDs must not reach the worker');
        r.page.location.pathname = '/c/canonical-1';
        await r.routeCheck();
        assert.equal(r.sent.length, 1);
        assert.equal(r.sent[0].conversationId, 'canonical-1');
        assert.equal(r.sent[0].messages[0].content, '完整用户问题');
        assert.equal(r.sent[0].messages[1].content, '完整模型回答\n```python\nprint(1)\n```');
    });
}

test('temporary draft is not copied into a different existing conversation', async () => {
    const r = makeReader('/c/local-chatgpt%3Adraft-1', [
        {key: 'same:user', content: 'unrelated draft'},
    ]);
    r.page.location.pathname = '/g/project/c/existing-B';
    r.page.nodes = [{key: 'same:user', content: 'existing B'}];
    await r.routeCheck();
    assert.equal(r.sent.length, 1);
    assert.equal(r.sent[0].conversationId, 'existing-B');
    assert.equal(r.sent[0].messages.length, 1);
    assert.equal(r.sent[0].messages[0].content, 'existing B');
});

test('extension manifest has required MV3 permissions and localhost host access', () => {
    const manifest = JSON.parse(fs.readFileSync(
        path.join(__dirname, '../shared/chatgpt_bridge/manifest.json'), 'utf8'
    ));
    assert.equal(manifest.manifest_version, 3);
    assert.ok(manifest.permissions.includes('tabs'));
    assert.ok(manifest.permissions.includes('storage'));
    assert.ok(manifest.host_permissions.includes('http://127.0.0.1:18000/*'));
});

test('presentation changes resend the same body without weakening shorter-text preservation', async()=>{
    let tag='p';
    const r=makeReader('/c/A',[{key:'native:assistant',content:'完整模型回答'}],{
        documentFor:()=>({version:1,nodes:[{tag,text:'完整模型回答'}]}),hasImage:()=>false,
    });
    assert.equal(r.sent[0].messages[0].presentation.nodes[0].tag,'p');
    tag='strong';await r.mutation();
    assert.equal(r.sent[1].messages[0].presentation.nodes[0].tag,'strong');
    assert.equal(r.sent[1].messages[0].content,r.sent[0].messages[0].content);
    r.page.nodes[0].content='短';tag='h2';await r.mutation();
    assert.equal(r.sent.length,2);
});

test('reading attachments use only the native owner containing exactly one text unit',()=>{
    const r=makeReader('/c/A',[{key:'native:user',content:'带图片的提问'}],{
        documentFor:node=>({version:1,nodes:[{tag:node.owner?'img':'p',src:null,alt:'用户附件'}]}),hasImage:()=>true,
    });
    assert.equal(r.sent[0].messages[0].presentation.nodes[0].tag,'img');
    assert.equal(r.sent[0].messages[0].content,'带图片的提问');
});
