import test from 'node:test';
import assert from 'node:assert/strict';
import {VisiblePoller} from '../polling.mjs';
import {atlasChanged} from '../data/atlas-source.mjs';

test('default timers retain the browser global receiver', () => {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  const calls = [];
  try {
    globalThis.setTimeout = function(fn, delay) {
      assert.equal(this, globalThis); calls.push(delay); return 7;
    };
    globalThis.clearTimeout = function(id) {
      assert.equal(this, globalThis); calls.push(id);
    };
    const page = {hidden:false, addEventListener(){}, removeEventListener(){}};
    const poller = new VisiblePoller(async()=>{}, {document:page});
    poller.start(); poller.stop();
    assert.deepEqual(calls, [4000, 7]);
  } finally {
    globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear;
  }
});

test('unchanged revision requires only a small read request', async () => {
  let calls = 0;
  const fetchImpl = async (path, options) => {
    calls++; assert.equal(path, '/api/atlas/revision');
    assert.equal(options.cache, 'no-store');
    return {ok:true, json:async()=>({revision:'r1'})};
  };
  assert.equal(await atlasChanged('r1', {fetchImpl}), false);
  assert.equal(await atlasChanged('r0', {fetchImpl}), true);
  assert.equal(calls, 2);
});

test('hidden page pauses requests, resume is immediate and ticks never overlap', async () => {
  const timers = new Map(); let timerId = 0, calls = 0, finish;
  const listeners = new Set();
  const page = {hidden:false, addEventListener(_, fn){listeners.add(fn);},
    removeEventListener(_, fn){listeners.delete(fn);}};
  const poller = new VisiblePoller(async () => {calls++; await new Promise(r=>finish=r);},
    {document:page, setTimer:fn=>{timers.set(++timerId, fn); return timerId;},
      clearTimer:id=>timers.delete(id)});
  poller.start(); poller.start(); assert.equal(timers.size,1);
  page.hidden=true; listeners.forEach(fn=>fn()); assert.equal(timers.size,0);
  await poller.run(); assert.equal(calls,0);
  page.hidden=false; listeners.forEach(fn=>fn()); assert.equal(calls,1);
  await poller.run(); assert.equal(calls,1);
  page.hidden=true; listeners.forEach(fn=>fn());
  finish(); await new Promise(resolve=>setImmediate(resolve)); assert.equal(timers.size,0);
  page.hidden=false; listeners.forEach(fn=>fn()); assert.equal(calls,2);
  poller.stop(); finish(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(timers.size,0); assert.equal(listeners.size,0);
});
