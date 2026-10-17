import test from 'node:test';
import assert from 'node:assert/strict';
import {IndexControls} from '../index-controls.mjs';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function controls(fetchImpl) {
  const node=()=>({disabled:false,textContent:'',addEventListener(_,fn){this.click=fn;}});
  const button=node(),scope=node(),status=node();let updates=0;
  const controller=new IndexControls({button,scope,status,fetchImpl,onUpdate(){updates++;}});
  return {controller,button,scope,status,get updates(){return updates;}};
}
const result=(cid,pending=2,task=null)=>({conversationId:cid,source:{status:'ready',unchanged:[],appended:Array(pending).fill('key'),reason:null},task});
test('opening and polling only read; no pending disables paid action',async()=>{
  const calls=[];
  const c=controls(async(url,options)=>{calls.push(options.method);return {ok:true,json:async()=>result('A',0)};});
  c.controller.select('A','当前真实标题');await flush();await c.controller.refresh();
  assert.deepEqual(calls,['GET','GET']);assert.equal(c.button.disabled,true);assert.match(c.status.textContent,/已是最新/);
  await c.controller.start();assert.equal(calls.length,2);
});
test('manual click posts once; task completion requests incremental graph update',async()=>{
  const calls=[];let finish;let task=null;
  const c=controls(async(url,options)=>{
    calls.push(options.method);
    if(options.method==='POST'){assert.equal(options.headers['x-atlas-action'],'manual-analysis');await new Promise(r=>finish=r);task={run_id:'1',status:'running',committed_batches:0};}
    return {ok:true,json:async()=>result('A',2,task)};
  });
  c.controller.select('A','A');await flush();
  const pending=c.controller.start();await flush();await c.controller.start();
  assert.equal(calls.filter(m=>m==='POST').length,1);
  finish();await pending;assert.equal(c.button.disabled,true);
  task={run_id:'1',status:'completed',committed_batches:1};await c.controller.refresh();assert.ok(c.updates>=1);
});
test('late response from A cannot overwrite selected B',async()=>{
  let finish;
  const c=controls(async url=>{if(url.endsWith('/A'))await new Promise(r=>finish=r);return {ok:true,json:async()=>result(url.endsWith('/A')?'A':'B',url.endsWith('/A')?99:4)};});
  c.controller.select('A','A');c.controller.select('B','B');await flush();finish();await flush();
  assert.match(c.scope.textContent,/B/);assert.match(c.status.textContent,/待分析 4 条/);assert.doesNotMatch(c.status.textContent,/99/);
});
