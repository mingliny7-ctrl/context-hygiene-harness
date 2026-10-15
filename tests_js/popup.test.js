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
        'statusBadge', 'messageCount', 'conversationTitle',
        'reasons', 'latestAnswer', 'connectionNotice',
    ]) {
        nodes[id] = {
            textContent: '', className: '', children: [],
            replaceChildren() {this.children = []; this.textContent = '';},
            appendChild(child) {this.children.push(child);},
        };
    }
    const local = {...localHealth};
    let onChanged;
    let poll;
    let activeUrl = tabUrl;
    let onUpdated;
    let onActivated;
    const context = {
        URL,
        Date,
        setInterval(fn) {poll=fn; return 1;},
        console: {log() {}, warn() {}, error() {}},
        document: {
            getElementById(id) {return nodes[id];},
            createElement() {return {textContent: '', className: ''};},
        },
        fetch: fetchMock,
        chrome: {
            tabs: {async query() {return [{id: 17, url: activeUrl}];},
                onUpdated:{addListener(fn){onUpdated=fn;}},
                onActivated:{addListener(fn){onActivated=fn;}},
            },
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
    return {nodes, local,
        async pollNow(){poll();await new Promise(resolve=>setImmediate(resolve));},
        navigateNow(url){activeUrl=url;onUpdated(17,{url});},
        activateNow(url){activeUrl=url;onActivated({tabId:18});},
        async navigate(url){activeUrl=url;onUpdated(17,{url});await new Promise(resolve=>setImmediate(resolve));}};
}

test('popup restores current conversation from SQLite status even without local cache', async () => {
    const p = await makePopup(
        'https://chatgpt.com/g/example/c/B',
        {'conversationHealth:A': {status:'RED',message_count:999,total_chars:9999,reasons:[],should_handoff:true}},
        async url => {
            assert.ok(url.endsWith('/conversations/B/status'));
            return {
                ok: true,
                async json() {return {
                    conversation_id: 'B', status: 'SAVED',
                    message_count: 5, total_chars: 41,
                    assistant_reply_count:3, count_status:'verified',
                    reasons: [],
                    should_handoff: false,
                };},
            };
        },
    );
    assert.equal(p.nodes.statusBadge.textContent, '已保存');
    assert.equal(p.nodes.messageCount.textContent, 3);
    assert.match(p.nodes.reasons.textContent, /不代表对话已采集完整/);
    assert.equal(p.nodes.latestAnswer.textContent, '历史保存事件未记录，等待新保存');
    assert.equal(p.local['conversationHealth:B'],undefined,'GET must not create a write acknowledgement');
});

test('popup refuses to present a deleted DB conversation as current truth', async () => {
    const p = await makePopup(
        'https://chatgpt.com/c/A',
        {'conversationHealth:A': {
            status:'RED', message_count:100,total_chars:50000,
            reasons:[],should_handoff:true,savedAt:1,
        }},
        async () => ({status: 404, ok: false}),
    );
    assert.equal(p.nodes.statusBadge.textContent, '正在采集');
    assert.match(p.nodes.reasons.textContent, /数据库尚无/);
    assert.match(p.nodes.connectionNotice.textContent, /旧状态/);
});

test('popup never presents cached risk scores when collector is offline', async () => {
    const p = await makePopup('https://chatgpt.com/c/A', {
        'conversationHealth:A': {status:'RED',message_count:81,total_chars:9999,reasons:['risk'],should_handoff:true},
    }, async () => {throw new Error('offline');});
    assert.equal(p.nodes.statusBadge.textContent, '未连接');
    assert.match(p.nodes.reasons.textContent, /无法确认当前保存结果/);
    assert.equal(p.nodes.latestAnswer.textContent, '无法确认已保存回答');
});

test('popup follows SPA title, shows only confirmed native Assistant count and no characters',async()=>{
    const p=await makePopup('https://chatgpt.com/c/A',{
        'conversationHealth:A':{conversation_id:'A',status:'SAVED',title:'真正的A标题',capture_state:'SAVED',assistant_reply_count:1,count_status:'verified'},
        'conversationHealth:B':{conversation_id:'B',status:'SAVED',title:'真正的B标题',capture_state:'SAVED'},
    },async url=>({ok:true,status:200,async json(){const id=url.includes('/A/')?'A':'B';return{conversation_id:id,status:'SAVED',assistant_reply_count:id==='A'?1:null,confirmed_assistant_reply_count:3,count_status:id==='A'?'verified':'legacy_identity_unverified'};}}));
    assert.equal(p.nodes.conversationTitle.textContent,'真正的A标题');assert.equal(p.nodes.messageCount.textContent,1);
    await p.navigate('https://chatgpt.com/c/B');
    assert.equal(p.nodes.conversationTitle.textContent,'真正的B标题');assert.equal(p.nodes.messageCount.textContent,'至少 3 条');
    assert.equal(p.nodes.statusBadge.textContent,'已保存');
    const html=fs.readFileSync(path.join(__dirname,'../shared/chatgpt_bridge/popup.html'),'utf8');
    assert.doesNotMatch(html,/totalChars|Characters/);assert.doesNotMatch(source,/totalChars|total_chars/);
});

test('popup distinguishes backend write failure from offline even with cached SAVED',async()=>{
    const p=await makePopup('https://chatgpt.com/c/A',{
        'conversationHealth:A':{conversation_id:'A',status:'SAVED',title:'A',capture_state:'FAILED',assistant_reply_count:2,count_status:'verified'},
    },async()=>({ok:false,status:500}));
    assert.equal(p.nodes.statusBadge.textContent,'保存失败');assert.equal(p.nodes.messageCount.textContent,'暂不可用');
});

test('preview uses database receipt only, clears synchronously and rejects stale navigation responses',async()=>{
    let finishB;
    const receipt = (id, text) => ({ok:true,status:200,async json(){return {
        conversation_id:id,status:'SAVED',assistant_reply_count:1,count_status:'verified',
        latest_assistant_status:'saved_event',latest_assistant_preview:text,
    };}});
    const p = await makePopup('https://chatgpt.com/c/A',{
        'conversationHealth:A':{status:'SAVED',latest_assistant_preview:'未经数据库确认的缓存'},
    },async url=>{
        if(url.includes('/B/')) return new Promise(resolve=>{finishB=resolve;});
        return receipt(url.includes('/A/')?'A':'C',url.includes('/A/')?'数据库A':'数据库C');
    });
    assert.equal(p.nodes.latestAnswer.textContent,'数据库A');
    p.navigateNow('https://chatgpt.com/c/B');
    assert.equal(p.nodes.latestAnswer.textContent,'正在确认已保存回答…');
    await new Promise(resolve=>setImmediate(resolve));
    p.activateNow('https://chatgpt.com/c/C');
    assert.equal(p.nodes.latestAnswer.textContent,'正在确认已保存回答…');
    await new Promise(resolve=>setImmediate(resolve));
    finishB(receipt('B','迟到的B'));
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(p.nodes.latestAnswer.textContent,'数据库C');
});

test('preview fails closed on wrong identity, untracked history and empty saved answers',async()=>{
    const p = await makePopup('https://chatgpt.com/c/A',{},async url=>({ok:true,status:200,async json(){
        const id=url.includes('/A/')?'A':url.includes('/B/')?'B':'wrong';
        return {conversation_id:id,status:'SAVED',count_status:'verified',assistant_reply_count:0,
            latest_assistant_status:id==='A'?'empty':'history_untracked',latest_assistant_preview:'不能显示的内容'};
    }}));
    assert.equal(p.nodes.latestAnswer.textContent,'暂无已保存的模型回答');
    await p.navigate('https://chatgpt.com/c/B');
    assert.equal(p.nodes.latestAnswer.textContent,'历史保存事件未记录，等待新保存');
    await p.navigate('https://chatgpt.com/c/C');
    assert.equal(p.nodes.latestAnswer.textContent,'无法确认已保存回答');
    assert.equal(p.nodes.statusBadge.textContent,'保存失败');
    await p.navigate('https://chatgpt.com/c/local-chatgpt%3Adraft');
    assert.equal(p.nodes.latestAnswer.textContent,'无法确认已保存回答');
    const html=fs.readFileSync(path.join(__dirname,'../shared/chatgpt_bridge/popup.html'),'utf8');
    assert.doesNotMatch(html,/<a\b|<button\b|id="handoff"/i);
    assert.match(source,/latestAnswer\.textContent/);
    assert.doesNotMatch(source,/innerHTML/);
});

test('A B A C keeps saved counts and events isolated and polling does not blank confirmed progress',async()=>{
    let paused=false, finish;
    const p=await makePopup('https://chatgpt.com/c/A',{},async url=>{
        if(paused) await new Promise(resolve=>{finish=resolve;});
        const id=url.match(/conversations\/([^/]+)/)[1];
        return {ok:true,status:200,async json(){return {
            conversation_id:id,status:'SAVED',count_status:'verified',
            assistant_reply_count:{A:3,B:4,C:0}[id],
            latest_assistant_status:id==='C'?'empty':'saved_event',
            latest_assistant_preview:`${id}刚保存的回答`,
        };}};
    });
    assert.equal(p.nodes.messageCount.textContent,3);
    await p.navigate('https://chatgpt.com/c/B');
    assert.equal(p.nodes.messageCount.textContent,4);
    assert.equal(p.nodes.latestAnswer.textContent,'B刚保存的回答');
    await p.navigate('https://chatgpt.com/c/A');
    paused=true;await p.pollNow();
    assert.equal(p.nodes.messageCount.textContent,3);
    assert.equal(p.nodes.latestAnswer.textContent,'A刚保存的回答');
    paused=false;finish();await new Promise(resolve=>setImmediate(resolve));
    await p.navigate('https://chatgpt.com/c/C');
    assert.equal(p.nodes.messageCount.textContent,0);
    assert.equal(p.nodes.latestAnswer.textContent,'暂无已保存的模型回答');
});
