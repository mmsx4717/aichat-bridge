import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { beginBackgroundRendering } from '../extension/qwen-dom.js';
const source = await readFile(new URL('../extension/qwen-frame-scheduler.js', import.meta.url), 'utf8');
const token = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
function fixture(url = 'https://chat.qwen.ai/c/test') {
  const { window: win } = new JSDOM('<main></main>', { url, runScripts: 'outside-only', pretendToBeVisual: true });
  let now = 0, nextId = 0, hidden = true, focused = false;
  const native = new Map(), errors = [], states = [];
  win.performance.now = () => now;
  win.requestAnimationFrame = callback => {
    if (typeof callback !== 'function') throw new TypeError('callback must be callable');
    native.set(++nextId, callback); return nextId;
  };
  win.cancelAnimationFrame = id => native.delete(Number(id) >>> 0);
  win.reportError = error => errors.push(error.message);
  Object.defineProperty(win.document, 'visibilityState', { get: () => hidden ? 'hidden' : 'visible' });
  win.document.hasFocus = () => focused;
  win.document.addEventListener('aichat:qwen:frame-state', e => states.push(e.detail));
  const original = win.requestAnimationFrame;
  win.eval(source);
  const control = (action, extra = {}) => win.document.dispatchEvent(new win.CustomEvent('aichat:qwen:frame-control', { detail: { token, action, timeoutMs: 60000, ...extra } }));
  return { win, original, native, errors, states, control, close: () => win.close(),
    advance(ms) { now += ms; }, focus() { hidden = false; focused = true; },
    paint() { for (const [id, callback] of [...native]) { if (native.delete(id)) callback.call(win, now); } },
  };
}

test('Qwen background frames require an active bounded lease and a stalled callback', () => {
  const x = fixture(); let calls = 0;
  try {
    x.win.requestAnimationFrame(function (timestamp) { calls++; assert.equal(this, x.win); assert.equal(timestamp, 1500); });
    x.advance(500); x.control('pulse'); assert.equal(calls, 0);
    x.control('start'); x.control('pulse'); assert.equal(calls, 0);
    x.advance(1000); x.control('pulse'); assert.equal(calls, 1);
    x.paint(); x.advance(1000); x.control('pulse'); assert.equal(calls, 1, 'native paint must not run a rescued callback again');
  } finally { x.close(); }
});

test('native foreground frame scheduling, cancellation and callback this remain intact', () => {
  const x = fixture(); let calls = 0;
  try {
    x.focus(); x.control('start');
    x.win.requestAnimationFrame(function () { assert.equal(this, x.win); calls++; });
    const cancelled = x.win.requestAnimationFrame(() => { throw new Error('cancelled'); });
    x.win.cancelAnimationFrame(String(cancelled));
    x.advance(3000); x.control('pulse'); assert.equal(calls, 0);
    x.paint(); assert.equal(calls, 1); assert.deepEqual(x.errors, []);
    assert.throws(() => x.win.requestAnimationFrame(null), TypeError);
  } finally { x.close(); }
});

for (const ending of ['stop', 'expiry', 'navigation', 'wrong-token']) {
  test(`Qwen frame assistance does not operate after ${ending}`, () => {
    const x = fixture(); let calls = 0;
    try {
      x.control('start', { timeoutMs: 2000 });
      x.win.requestAnimationFrame(() => calls++);
      if (ending === 'stop') x.control('stop');
      if (ending === 'navigation') x.win.history.pushState({}, '', '/c/other');
      x.advance(ending === 'expiry' ? 2001 : 1500);
      x.control('pulse', ending === 'wrong-token' ? { token: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' } : {});
      assert.equal(calls, 0); x.paint(); assert.equal(calls, 1, 'lease cleanup must not discard native callbacks');
    } finally { x.close(); }
  });
}

test('recursive callbacks wait for a subsequent pulse and exceptions do not stop other callbacks', () => {
  const x = fixture(); let calls = 0;
  try {
    x.control('start');
    x.win.requestAnimationFrame(() => { calls++; x.win.requestAnimationFrame(() => calls++); });
    x.win.requestAnimationFrame(() => { throw new Error('page callback failed'); });
    x.win.requestAnimationFrame(() => calls++);
    x.advance(1000); x.control('pulse'); assert.equal(calls, 2); assert.deepEqual(x.errors, ['page callback failed']);
    x.advance(1000); x.control('pulse'); assert.equal(calls, 3);
  } finally { x.close(); }
});

test('assistance is bounded per pulse and cancelled callbacks within a batch stay cancelled', () => {
  const x = fixture(); let calls = 0;
  try {
    x.control('start');
    let next;
    x.win.requestAnimationFrame(() => x.win.cancelAnimationFrame(next));
    next = x.win.requestAnimationFrame(() => { throw new Error('cancelled within batch'); });
    for (let n = 0; n < 100; n++) x.win.requestAnimationFrame(() => calls++);
    x.advance(1000); x.control('pulse'); assert.equal(calls, 62); assert.deepEqual(x.errors, []);
    x.advance(1000); x.control('pulse'); assert.equal(calls, 100);
  } finally { x.close(); }
});

test('other providers retain their native animation functions', () => {
  for (const url of ['https://chatgpt.com/c/test', 'https://claude.ai/chat/test', 'https://gemini.google.com/app/test']) {
    const x = fixture(url); assert.equal(x.win.requestAnimationFrame, x.original); x.close();
  }
});

test('Qwen isolated-world client stops its lease and accepts only bounded frame metadata', () => {
  const x = fixture(); let calls = 0;
  try {
    const client = beginBackgroundRendering(x.win.document, 60000);
    x.win.requestAnimationFrame(() => calls++);
    x.advance(1000); client.wake(); assert.equal(calls, 1);
    assert.deepEqual(client.stats(), { framePending: 0, frameResumed: 1 });
    client.stop(); client.stop(); x.win.requestAnimationFrame(() => calls++);
    x.advance(1000); client.wake(); assert.equal(calls, 1);
    x.paint(); assert.equal(calls, 2);
  } finally { x.close(); }
});

test('MAIN-world compatibility script is installed early and exclusively for Qwen', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  const scripts = manifest.content_scripts.filter(script => script.js.includes('qwen-frame-scheduler.js'));
  assert.equal(scripts.length, 1); assert.deepEqual(scripts[0].matches, ['https://chat.qwen.ai/*']);
  assert.equal(scripts[0].world, 'MAIN'); assert.equal(scripts[0].run_at, 'document_start');
  assert.equal(scripts[0].all_frames, false);
  assert.equal(manifest.permissions.includes('debugger'), false);
});

test('renewed start messages cannot extend the original frame-assistance deadline', () => {
  const x = fixture(); let calls = 0;
  try {
    x.control('start', { timeoutMs: 2000 });
    x.advance(1500); x.control('start', { timeoutMs: 60000 });
    x.win.requestAnimationFrame(() => calls++);
    x.advance(1500); x.control('pulse'); assert.equal(calls, 0);
  } finally { x.close(); }
});
