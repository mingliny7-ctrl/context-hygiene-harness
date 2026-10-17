import test from 'node:test';
import assert from 'node:assert/strict';
import {computeLayout, recentConversations, bezierPath} from '../layout.mjs';
const conversations=Array.from({length:20},(_,i)=>({id:`c${i}`,categoryId:'all',lastContentSavedAt:new Date(2026,0,i+1).toISOString()}));
const data={categories:[{id:'all'}],conversations,segments:Array.from({length:3},(_,i)=>({id:`s${i}`,conversationId:'c19',order:i}))};
test('home connects only six latest confirmed saves directly, never sync timestamps or segments',()=>{
  const snapshot=structuredClone(data); snapshot.conversations.push({id:'legacy',updatedAt:'2099-01-01'});
  const result=computeLayout(snapshot,{}, {width:1100,height:520});
  assert.deepEqual(result.nodes.map(n=>n.id),['c19','c18','c17','c16','c15','c14']);
  assert.equal(result.edges.length,6); assert.ok(result.edges.every(e=>e.from==='atlas-core'));
  assert.equal(result.nodes.filter(n=>n.kind==='segment').length,0);
  snapshot.conversations.reverse(); assert.deepEqual(recentConversations(snapshot.conversations).map(n=>n.id),result.nodes.map(n=>n.id));
});
test('unknown activity stays searchable but is not assigned invented recency',()=>{
  assert.equal(computeLayout({conversations:[{id:'old',createdAt:'2026-01-01'}]}).nodes.length,0);
});
test('entry from every sky direction reaches the same anchor without all history being laid out',()=>{
  const sky=computeLayout(data,{}, {width:1100,height:520});
  for(const entry of sky.nodes){
    const focused=computeLayout(data,{conversationId:entry.id},{width:1100,height:520});
    const anchor=focused.nodes.find(n=>n.id===entry.id);
    assert.equal(anchor.x,352); assert.equal(anchor.y,260);
    assert.equal(focused.nodes.filter(n=>n.kind==='conversation').length,1);
    assert.deepEqual(computeLayout(data,{}, {width:1100,height:520}),sky);
  }
});
test('responsive focus keeps short topic sets within the scene and uses trusted segment order',()=>{
  for(const width of [560,720,1000,1380]){
    const result=computeLayout({...data,segments:[...data.segments].reverse()},{conversationId:'c19'},{width,height:500});
    assert.deepEqual(result.nodes.filter(n=>n.kind==='segment').map(n=>n.id),['s0','s1','s2']);
    for(const n of result.nodes){assert.ok(n.x-n.width/2>=0);assert.ok(n.x+n.width/2<=result.width);assert.ok(n.y-n.height/2>=0);assert.ok(n.y+n.height/2<=result.height);}
    assert.ok(result.nodes[0].x<result.nodes[1].x);
  }
});
test('many segments use a vertical scene without node collisions',()=>{
  const segments=Array.from({length:20},(_,i)=>({id:`s${i}`,conversationId:'c19',order:i}));
  const result=computeLayout({...data,segments},{conversationId:'c19'},{width:800,height:500});
  assert.ok(result.height>500); const leaves=result.nodes.slice(1);
  for(let i=1;i<leaves.length;i++)assert.ok(leaves[i].y-leaves[i-1].y>leaves[i].height);
});
test('bezier keeps one finite morphable cubic including collapsed endpoints',()=>{
  assert.equal(bezierPath({x:0,y:0,radius:20,kind:'core'},{x:100,y:0,width:40,height:40}),'M 20 0 C 50 0, 50 0, 80 0');
  assert.doesNotMatch(bezierPath({x:0,y:0},{x:0,y:0}),/NaN|Infinity/);
});
