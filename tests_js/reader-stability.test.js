const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness() {
    const sent = [], timers = new Map();
    let next = 0, mutate, tick;
    const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
    const page = {location:{pathname:'/c/A',origin:'https://chatgpt.com',href:'https://chatgpt.com/c/A'}, title:'A title'};
    const pages = {};
    function node(n, role, content, complete=true) {
        const attrs = {'data-content-search-unit-key':`fallback-turn-0:${complete?2:1}:${role}`,
            'data-chatgpt-search-message-ids':id(n), 'data-talvt-turn-state':complete?'complete':'streaming'};
        return {innerText:content,getAttribute(k){return attrs[k]??null;},
            closest(selector){if(selector==='[data-chatgpt-search-message-ids]'||selector==='[data-talvt-turn-state]')return this;return null;}, attrs};
    }
    function root(name, nodes) {
        const r={nodes,getAttribute(k){return k==='data-app-shell-active-page'?(page.active===name?'true':'false'):null;},querySelectorAll(){return r.nodes;}};
        pages[name]=r;return r;
    }
    root('A',[node(1,'user','A question'),node(2,'assistant','A answer')]);page.active='A';
    const doc={body:{},documentElement:{},get title(){return page.title;},querySelectorAll(selector){
        if(selector==='[data-app-shell-active-page="true"]')return [pages[page.active]];
        if(selector==='a[href]')return [{getAttribute(){return page.location.pathname;},textContent:page.title,innerText:page.title}];
        return Object.values(pages).flatMap(r=>r.nodes);
    }};
    const chrome={runtime:{id:'test',sendMessage(payload){sent.push(JSON.parse(JSON.stringify(payload)));return Promise.resolve({ok:true,conversationId:payload.conversationId});}}};
    vm.runInNewContext(fs.readFileSync(process.env.READER_SOURCE_PATH || path.join(__dirname,'../shared/chatgpt_bridge/conversation_reader.js'),'utf8'),{
        console:{log(){},warn(){}},document:doc,location:page.location,URL,chrome,
        MutationObserver:class{constructor(fn){mutate=fn;}observe(){}disconnect(){}},
        setTimeout(fn){timers.set(++next,fn);return next;},clearTimeout(n){timers.delete(n);},setInterval(fn){tick=fn;return 1;},clearInterval(){},
    });
    return {sent,page,pages,node,root,mutate:()=>mutate(),tick:()=>tick(),
        async flush(){let f=[...timers.values()];timers.clear();f.forEach(fn=>fn());await Promise.resolve();},
        navigate(name,dom=name){page.location.pathname=`/c/${name}`;page.location.href=`https://chatgpt.com/c/${name}`;page.active=dom;page.title=name+' title';tick();},
        timers};
}

test('SPA hidden A DOM never enters B payload, including URL-before-DOM transition',async()=>{
    const r=harness();r.root('B',[r.node(3,'user','B question'),r.node(4,'assistant','B answer')]);
    assert.equal(r.sent[0].messages.length,2);
    r.navigate('B','A');await r.flush();
    assert.equal(r.sent.length,1,'URL changed but A still active: wait');
    r.page.active='B';r.mutate();await r.flush();
    assert.equal(r.sent.at(-1).conversationId,'B');
    assert.deepEqual(r.sent.at(-1).messages.map(m=>m.content),['B question','B answer']);
    r.navigate('A');await r.flush();
    assert.deepEqual(r.sent.at(-1).messages.map(m=>m.content),['A question','A answer']);
    r.root('C',[r.node(5,'user','same'),r.node(6,'assistant','same')]);r.navigate('C');await r.flush();
    assert.equal(r.sent.at(-1).conversationId,'C');assert.equal(r.sent.at(-1).messages.length,2);
});

test('stream placeholder and changed fallback key become one completed native Assistant',async()=>{
    const r=harness();r.pages.A.nodes=[r.node(7,'user','new'),r.node(8,'assistant','',false)];
    r.mutate();await r.flush();
    assert.equal(r.sent.at(-1).messages.filter(m=>m.content==='').length,0);
    r.pages.A.nodes=[r.node(7,'user','new'),r.node(8,'assistant','partial',false)];r.mutate();await r.flush();
    assert.equal(r.sent.at(-1).messages.some(m=>m.content==='partial'),false);
    r.pages.A.nodes=[r.node(7,'user','new'),r.node(8,'assistant','complete body',true)];r.mutate();await r.flush();
    const answers=r.sent.at(-1).messages.filter(m=>m.content==='complete body');
    assert.equal(answers.length,1);assert.match(answers[0].key,/^chatgpt:.*:assistant$/);
});

test('continuous mutations do not indefinitely cancel capture; virtualized nodes stay cached',async()=>{
    const r=harness();r.pages.A.nodes.push(r.node(9,'assistant','new saved'));
    r.mutate();const scheduled=[...r.timers.keys()][0];
    for(let i=0;i<20;i++)r.mutate();
    assert.equal(r.timers.size,1);
    assert.equal([...r.timers.keys()][0],scheduled,'capture deadline must not move with every mutation');
    await r.flush();assert.ok(r.sent.at(-1).messages.some(m=>m.content==='new saved'));
    r.pages.A.nodes=[r.node(10,'assistant','later')];r.mutate();await r.flush();
    assert.ok(r.sent.at(-1).messages.some(m=>m.content==='new saved'));
});

test('DOM order evidence contains the current window only, not discovery-order cache',async()=>{
    const r=harness();
    const first=r.sent[0].observedOrder;
    assert.equal(first.length,2);
    r.pages.A.nodes=[r.node(11,'user','older question'),r.node(12,'assistant','older answer'),...r.pages.A.nodes];
    r.mutate();await r.flush();
    assert.deepEqual(r.sent.at(-1).observedOrder,r.sent.at(-1).messages.slice(2).map(m=>m.key).concat(first));
    r.pages.A.nodes=r.pages.A.nodes.slice(0,2);r.mutate();await r.flush();
    assert.equal(r.sent.at(-1).observedOrder.length,2);
    assert.equal(r.sent.at(-1).messages.length,4,'raw cumulative collection stays intact');
});
