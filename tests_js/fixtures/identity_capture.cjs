// Controlled DOM + Chrome harness running the REAL Reader and Worker against
// a test backend. No browser installation, production DB or third-party calls.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

async function main() {
    const base = process.argv[2];
    assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
    const local = {}, session = {}, requests = [], pending = [];
    let listener, observerCallback, routeCallback;
    const timeouts = new Map();
    let timer = 0;
    const storage = state => ({
        async get(keys) {
            if (keys === null) return {...state};
            return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, state[k]]));
        },
        async set(updates) { Object.assign(state, updates); },
        async remove(key) { delete state[key]; },
    });
    const chrome = {
        runtime: {
            id: 'controlled-test-extension',
            onMessage: {addListener(fn) { listener = fn; }},
            sendMessage(payload) {
                const result = new Promise(resolve => listener(payload, {tab: {id: 17}}, resolve));
                pending.push(result);
                return result;
            },
        },
        storage: {local: storage(local), session: storage(session)},
        tabs: {onRemoved: {addListener() {}}},
        action: {async setBadgeText() {}, async setBadgeBackgroundColor() {}},
    };
    const quiet = {log() {}, warn() {}};
    const bridge = path.join(__dirname, '../../shared/chatgpt_bridge');
    vm.runInNewContext(fs.readFileSync(path.join(bridge, 'bridge_worker.js'), 'utf8'), {
        chrome, console: quiet, URL,
        async fetch(url, options) {
            assert.equal(url, 'http://127.0.0.1:8000/sync');
            requests.push(JSON.parse(options.body));
            return fetch(`${base}/sync`, options);
        },
    });
    const messages = [
        {key: 'fallback-turn-0:0:user', content: 'IDENTITY_MODULE_1\n完整用户问题'},
        {key: 'fallback-turn-0:2:assistant', content: 'ChatGPT 说：\n完整回答\n\n```python\nprint("preserved")\n```'},
    ];
    const page = {location: {pathname: '/c/local-chatgpt%3Acontrolled-draft'}, nodes: messages};
    const roots = new Map();
    const elements = () => page.nodes.map((m,i)=>({
        getAttribute(name){return name==='data-content-search-unit-key'?m.key:null;},innerText:m.content,
        closest(){return {getAttribute(name){return name==='data-chatgpt-search-message-ids'?`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`:name==='data-talvt-turn-state'?'complete':null;}};},
    }));
    vm.runInNewContext(fs.readFileSync(path.join(bridge, 'conversation_reader.js'), 'utf8'), {
        chrome, console: quiet, location: page.location, URL,
        document: {body: {},documentElement:{}, querySelectorAll(selector) {
            if(selector==='a[href]')return [];
            if(selector==='[data-app-shell-active-page="true"]'){
                if(!roots.has(page.location.pathname))roots.set(page.location.pathname,{querySelectorAll:elements});
                return [roots.get(page.location.pathname)];
            }
            return elements();
        }},
        MutationObserver: class {
            constructor(fn) {observerCallback = fn;}
            observe() {} disconnect() {}
        },
        setTimeout(fn) {timeouts.set(++timer, fn); return timer;},
        clearTimeout(id) {timeouts.delete(id);},
        setInterval(fn) {routeCallback = fn; return 1;}, clearInterval() {},
    });
    async function trigger(fn) {
        fn();
        const callbacks = [...timeouts.values()]; timeouts.clear();
        callbacks.forEach(callback => callback());
        const replies = await Promise.all(pending.splice(0));
        replies.forEach(reply => assert.equal(reply.ok, true, reply.error));
    }
    await trigger(observerCallback);
    assert.equal(requests.length, 0, 'temporary URL must not reach /sync');
    page.location.pathname = '/c/canonical-A';
    await trigger(routeCallback);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].conversation_id, 'canonical-A');
    assert.equal(requests[0].messages[0].content, messages[0].content);
    assert.equal(requests[0].messages[1].content, messages[1].content.replace(/^ChatGPT 说：\s*/, ''));
    // Same contents, same DOM keys, same tab: a DIFFERENT canonical ID remains
    // distinct. Tab identity and body equality are never alias evidence.
    if (process.argv[3] !== 'single') {
        page.location.pathname = '/g/project/c/canonical-B';
        await trigger(routeCallback);
        assert.equal(requests.length, 2);
        assert.equal(requests[1].conversation_id, 'canonical-B');
    }
    process.stdout.write(JSON.stringify({temporaryRequestCount: 0, requests}));
}
main().catch(error => {console.error(error); process.exitCode = 1;});
