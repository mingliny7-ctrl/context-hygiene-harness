import test from 'node:test';
import assert from 'node:assert/strict';
import { ParticleField } from '../particles.mjs';

// Exercise the renderer's lifecycle without a browser or pixel snapshots.
// The clock only advances when a test invokes a queued animation callback.
function setup(t, { reducedMotion = false, hidden = false, dpr = 3 } = {}) {
  const originalGlobals = new Map();
  const replaceGlobal = (name, value) => {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  const eventTarget = (properties = {}) => {
    const listeners = new Map();
    return {
      ...properties,
      listeners,
      addEventListener(type, callback) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(callback);
      },
      removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
      dispatch(type, event = {}) {
        for (const callback of listeners.get(type) || []) callback(event);
      },
      listenerCount(type) { return listeners.get(type)?.size || 0; },
    };
  };

  const media = eventTarget({ matches: reducedMotion });
  const document = eventTarget({ hidden });
  const window = eventTarget({ devicePixelRatio: dpr, matchMedia: () => media });
  const frames = new Map();
  let frameId = 0;
  const observers = [];
  const drawing = { clearCount: 0, pointCount: 0 };
  const context = {
    setTransform() {},
    clearRect() { drawing.clearCount += 1; },
    createRadialGradient() { return { addColorStop() {} }; },
    fillRect() {}, beginPath() {}, fill() {}, moveTo() {}, lineTo() {}, stroke() {},
    arc() { drawing.pointCount += 1; },
  };
  const canvas = {
    clientWidth: 900, clientHeight: 620, style: {}, attributes: new Map(),
    getContext: () => context,
    setAttribute(name, value) { this.attributes.set(name, value); },
  };
  replaceGlobal('window', window);
  replaceGlobal('document', document);
  replaceGlobal('requestAnimationFrame', (callback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  replaceGlobal('cancelAnimationFrame', (id) => frames.delete(id));
  replaceGlobal('ResizeObserver', class {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe(element) { this.element = element; }
    disconnect() { this.disconnected = true; }
  });
  const field = new ParticleField(canvas);
  t.after(() => {
    field.destroy();
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  return {
    field, canvas, drawing, media, window, document, frames, observers,
    advance(timestamp = 16) {
      const [id, callback] = frames.entries().next().value || [];
      assert.ok(callback, 'a frame must be scheduled before advancing the clock');
      frames.delete(id);
      callback(timestamp);
    },
  };
}

test('canvas uses CSS dimensions, caps DPR, and redraws after ResizeObserver changes', (t) => {
  const { field, canvas, window, drawing, observers } = setup(t);
  assert.equal(canvas.width, 1800);
  assert.equal(canvas.height, 1240);
  assert.equal(canvas.style.pointerEvents, 'none');
  assert.equal(canvas.attributes.get('aria-hidden'), 'true');
  assert.equal(observers[0].element, canvas);

  field.setPaused(true);
  const before = drawing.clearCount;
  canvas.clientWidth = 700;
  canvas.clientHeight = 400;
  window.devicePixelRatio = 1.5;
  observers[0].callback();
  assert.equal(canvas.width, 1050);
  assert.equal(canvas.height, 600);
  assert.ok(drawing.clearCount > before, 'paused canvases must redraw at their new size');
});

test('home corona shares the original renderer and disappears for the focused core', (t) => {
  const {field,frames,drawing}=setup(t);
  field.setPaused(true);
  field.setCore({x:450,y:310,homeSky:true});
  let before=drawing.pointCount;
  field.render();
  const withCorona=drawing.pointCount-before;
  field.setCore({x:450,y:310,homeSky:false});
  before=drawing.pointCount;
  field.render();
  assert.ok(withCorona>drawing.pointCount-before);
  assert.equal(field.core.homeSky,false);
  assert.equal(frames.size,0,'home decoration must not bypass explicit pause');
});

test('pause cancels RAF and resume or data updates never queue duplicate loops', (t) => {
  const { field, frames, advance } = setup(t);
  assert.equal(frames.size, 1);
  field.setCore({ x: 450, y: 310 });
  field.setSatellites([{ id: 'category-1', x: 620, y: 240, color: '#abc' }]);
  field.setPaused(false);
  assert.equal(frames.size, 1);
  advance();
  assert.equal(frames.size, 1);
  field.setPaused(true);
  assert.equal(frames.size, 0, 'pausing must cancel the scheduled callback');
  field.setPaused(true);
  assert.equal(frames.size, 0);
  field.setPaused(false);
  field.setPaused(false);
  assert.equal(frames.size, 1);
});

test('reduced motion starts static, responds to preference changes, and preserves explicit pause', (t) => {
  const { field, frames, media } = setup(t, { reducedMotion: true });
  assert.equal(frames.size, 0);
  media.dispatch('change', { matches: false });
  assert.equal(frames.size, 1);
  media.dispatch('change', { matches: true });
  assert.equal(frames.size, 0);
  field.setPaused(true);
  media.dispatch('change', { matches: false });
  assert.equal(frames.size, 0, 'a system preference change must not override the user pause');
  field.setPaused(false);
  assert.equal(frames.size, 1);
});

test('hidden documents cancel RAF and only resume when both visible and unpaused', (t) => {
  const { field, frames, document } = setup(t, { hidden: true });
  assert.equal(frames.size, 0);
  document.hidden = false;
  document.dispatch('visibilitychange');
  assert.equal(frames.size, 1);
  document.hidden = true;
  document.dispatch('visibilitychange');
  assert.equal(frames.size, 0);
  field.setPaused(true);
  document.hidden = false;
  document.dispatch('visibilitychange');
  assert.equal(frames.size, 0);
  field.setPaused(false);
  assert.equal(frames.size, 1);
});

test('graph changes render while paused without restarting animation', (t) => {
  const { field, frames, drawing } = setup(t);
  field.setPaused(true);
  const before = drawing.pointCount;
  field.setCore({ x: 220, y: 260, radius: 78 });
  field.setSatellites([{ id: 'category-1', x: 400, y: 240, radius: 24, color: '#abcdef' }]);
  assert.ok(drawing.pointCount > before, 'new graph content must render in static mode');
  assert.equal(frames.size, 0);
  const clearBeforeRemoval = drawing.clearCount;
  field.setSatellites([]);
  assert.ok(drawing.clearCount > clearBeforeRemoval);
  assert.equal(frames.size, 0);
});

test('destroy is idempotent and releases RAF, observer, and event listeners', (t) => {
  const { field, frames, observers, media, document, window } = setup(t);
  assert.equal(media.listenerCount('change'), 1);
  assert.equal(document.listenerCount('visibilitychange'), 1);
  assert.equal(window.listenerCount('resize'), 1);
  field.destroy();
  assert.equal(frames.size, 0);
  assert.equal(observers[0].disconnected, true);
  assert.equal(media.listenerCount('change'), 0);
  assert.equal(document.listenerCount('visibilitychange'), 0);
  assert.equal(window.listenerCount('resize'), 0);
  assert.doesNotThrow(() => field.destroy());
  field.setPaused(false);
  field.setCore({ x: 100, y: 100 });
  field.setSatellites([{ id: 'removed', x: 200, y: 200 }]);
  assert.equal(frames.size, 0, 'disposed renderers must not restart');
});
