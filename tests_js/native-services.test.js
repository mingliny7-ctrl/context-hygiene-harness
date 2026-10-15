const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const worker=fs.readFileSync(path.join(__dirname,'../shared/chatgpt_bridge/bridge_worker.js'),'utf8');
const controls=fs.readFileSync(path.join(__dirname,'../shared/chatgpt_bridge/popup_service_controls.js'),'utf8');

function makeWorker(respond,fetchMock=async()=>{throw new Error('not running');}){
    let listener;
    const calls=[],tabs=[];
    const runtime={id:'trusted-id',getURL:name=>'chrome-extension://trusted-id/'+name,
        onMessage:{addListener(fn){listener=fn;}},
        sendNativeMessage(host,payload,callback){calls.push({host,...payload});Promise.resolve().then(()=>respond(payload.operation)).then(callback);},
    };
    const chrome={runtime,tabs:{async create(tab){tabs.push(tab);},onRemoved:{addListener(){}}}};
    vm.runInNewContext(worker,{chrome,URL,fetch:fetchMock,console:{log(){},warn(){}}});
    return {calls,tabs,runtime,
        send(action,sender={id:runtime.id,url:runtime.getURL('popup.html')}){
            return new Promise(resolve=>listener({type:'DESKTOP_SERVICE',action},sender,resolve));
        }};
}

test('collector starts only Collector and never navigates',async()=>{
    const w=makeWorker(op=>({ok:true,service:'Collector',ready:op==='start_collector'}));
    assert.equal((await w.send('start_collector')).message,'采集服务运行中');
    assert.deepEqual(w.calls.map(c=>c.operation),['check_collector','start_collector']);
    assert.equal(w.tabs.length,0);
});

test('Atlas starts independently and opens fixed graph URL only after health',async()=>{
    const w=makeWorker(op=>({ok:true,service:'Atlas',ready:op==='start_atlas'}));
    assert.equal((await w.send('open_atlas')).ok,true);
    assert.deepEqual(w.calls.map(c=>c.operation),['check_atlas','start_atlas']);
    assert.equal(w.tabs[0].url,'http://127.0.0.1:4173/');
});

test('ready Atlas reuses service and ignores any URL in native reply',async()=>{
    const w=makeWorker(()=>({ok:true,service:'Atlas',ready:true,url:'https://bad.invalid'}));
    await w.send('open_atlas');
    assert.deepEqual(w.calls.map(c=>c.operation),['check_atlas']);
    assert.equal(w.tabs[0].url,'http://127.0.0.1:4173/');
});

test('already healthy backends work even without Native Host and do not start peers',async()=>{
    for(const collector of [true,false]) {
        const urls=[];
        const fetchMock=async url=>{
            urls.push(url);
            const body=url.endsWith('/openapi.json') ? {info:{title:collector ? 'Context Harness Conversation Collector' : 'Conversation Atlas · read-only Store integration'},
                paths:collector ? {'/sync':{},'/conversations/{conversation_id}/status':{}} : {'/api/atlas':{},'/api/atlas/conversations/{conversation_id}':{}}}
                : collector ? {status:'ok'} : {schemaVersion:1,provenance:{mode:'real'},conversations:[]};
            return {ok:true,json:async()=>body};
        };
        const w=makeWorker(()=>assert.fail('Healthy backend must not require native host'),fetchMock);
        assert.equal((await w.send(collector ? 'start_collector' : 'open_atlas')).ok,true);
        assert.equal(w.calls.length,0);
        assert.equal(w.tabs.length,collector ? 0 : 1);
        assert.ok(urls.every(url=>url.startsWith(collector ? 'http://127.0.0.1:8000/' : 'http://127.0.0.1:4173/')));
    }
});

test('concurrent duplicate Atlas clicks share native request and one tab',async()=>{
    const w=makeWorker(()=>({ok:true,service:'Atlas',ready:true}));
    await Promise.all([w.send('open_atlas'),w.send('open_atlas')]);
    assert.equal(w.calls.length,1);assert.equal(w.tabs.length,1);
});

test('host failure and mismatched identity never open Atlas',async()=>{
    for(const response of [{ok:false,error:'端口冲突'}, {ok:true,ready:true,service:'Collector'}]){
        const w=makeWorker(()=>response);
        assert.equal((await w.send('open_atlas')).ok,false);
        assert.equal(w.tabs.length,0);
    }
});

test('content scripts and invalid actions cannot invoke native execution',async()=>{
    const w=makeWorker(()=>assert.fail('Must not invoke native host'));
    assert.equal((await w.send('start_collector',{id:w.runtime.id,url:'https://chatgpt.com/c/A'})).ok,false);
    assert.equal((await w.send('exec')).ok,false);
    assert.equal(w.calls.length,0);
});

test('native registration failure has clear message without leaking OS details',async()=>{
    const w=makeWorker(()=>({ok:true}));
    w.runtime.lastError={message:'sensitive local path not exposed'};
    const response=await w.send('start_collector');
    assert.match(response.error,/注册 Native Host/);
    assert.doesNotMatch(response.error,/sensitive/);
});

test('Popup keeps pending disabled then shows only confirmed service status',async()=>{
    const nodes=Object.fromEntries(['startCollector','openAtlas','serviceActionNotice'].map(id=>[id,{textContent:'',disabled:false,addEventListener(_,fn){this.click=fn;}}]));
    let finish;
    const calls=[];
    vm.runInNewContext(controls,{document:{getElementById:id=>nodes[id]},chrome:{runtime:{sendMessage:payload=>{
        calls.push(payload);return new Promise(resolve=>{finish=resolve;});
    }}}});
    const pending=nodes.startCollector.click();
    assert.equal(nodes.startCollector.disabled,true);
    assert.match(nodes.serviceActionNotice.textContent,/正在检查/);
    finish({ok:true,ready:true,message:'采集服务运行中'});await pending;
    assert.equal(nodes.startCollector.disabled,false);
    assert.equal(nodes.serviceActionNotice.textContent,'采集服务运行中');
    assert.equal(calls[0].action,'start_collector');
    const failed=nodes.openAtlas.click();finish({ok:false,error:'端口占用'});await failed;
    assert.equal(nodes.serviceActionNotice.textContent,'端口占用');
});
