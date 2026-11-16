import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import * as dom from '../extension/dom.js';
import * as shared from '../extension/shared.js';

const source = (await readFile(new URL('../extension/content.js', import.meta.url), 'utf8'))
  .replace("await import(chrome.runtime.getURL('dom.js'))", 'globalThis.__testDom')
  .replace("await import(chrome.runtime.getURL('shared.js'))", 'globalThis.__testShared');
const url = 'https://chatgpt.com/c/confirmation-fixture';
const prompt = '请分析这条消息中的图片。';
const runtimeId = 'confirmation-extension';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const metadata = { id: '1'.repeat(64), mimeType: 'image/png', name: 'original.png', bytes: png.length };
const flush = () => new Promise(resolve => setImmediate(resolve));
const turn = (id, text, image = false) => `<div data-turn-key="${id}"><div data-talvt-turn-state="complete"><div data-chatgpt-search-unit-key="${id}:0:user" data-chatgpt-search-message-ids="${id}-user">${image ? '<img src="blob:https://chatgpt.com/submitted-image">' : ''}<div data-user-message-bubble="true">${text}</div></div><div data-chatgpt-search-unit-key="${id}:1:assistant" data-chatgpt-search-message-ids="${id}-answer"><div data-markdown-text-style="assistant-message"><p>Final image description</p></div></div><div class="turn-action-controls"><button aria-label="复制">Copy</button></div></div></div>`;

async function fixture({ timeoutMs = 240000, image = true } = {}) {
  const page = new JSDOM(`<main>${turn('previous', 'Previous question')}</main><div data-composer-body><div data-composer-attachments></div><div data-composer-markdown contenteditable="true" role="textbox"></div><button type="submit" aria-label="发送"></button></div>`, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const win = page.window; const doc = win.document; const input = dom.composer(doc);
  const messages = []; const jobs = []; const wakes = []; const timers = new Map(); const observers = new Set();
  const listening = new Map(); let serial = 0; let now = 1000; let clicks = 0; let scans = 0; let pasted = 0; let visibility = 'visible'; let pausedObservers = false;
  const schedule = (fn, ms, repeat = 0) => { const id = ++serial; timers.set(id, { fn, at: now + ms, repeat }); return id; };
  win.Date = class extends Date { static now() { return now; } };
  win.setTimeout = (fn, ms) => schedule(fn, ms); win.clearTimeout = id => timers.delete(id);
  win.setInterval = (fn, ms) => schedule(fn, ms, ms); win.clearInterval = id => timers.delete(id);
  Object.defineProperty(doc, 'visibilityState', { get: () => visibility });
  for (const [target, label] of [[doc, 'document'], [win, 'window']]) {
    const add = target.addEventListener.bind(target); const remove = target.removeEventListener.bind(target);
    target.addEventListener = (name, fn, options) => {
      const key = `${label}:${name}`; if (!listening.has(key)) listening.set(key, new Set());
      listening.get(key).add(fn); return add(name, fn, options);
    };
    target.removeEventListener = (name, fn, options) => { listening.get(`${label}:${name}`)?.delete(fn); return remove(name, fn, options); };
  }
  const NativeObserver = win.MutationObserver;
  win.MutationObserver = class {
    constructor(callback) {
      this.active = false;
      this.inner = new NativeObserver(records => { if (this.active && !pausedObservers) callback(records, this); });
      observers.add(this);
    }
    observe(...args) { this.active = true; this.inner.observe(...args); }
    disconnect() { this.active = false; this.inner.disconnect(); }
  };
  win.__testShared = shared;
  win.__testDom = { ...dom, findSubmittedUser(...args) { scans++; return dom.findSubmittedUser(...args); } };
  win.DataTransfer = class { constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; } };
  win.ClipboardEvent = class extends win.Event { constructor(type, options) { super(type, options); this.clipboardData = options.clipboardData; } };
  doc.execCommand = (command, _ui, text) => { assert.ok(['insertText', 'delete'].includes(command)); input.textContent = command === 'delete' ? '' : text; return true; };
  input.addEventListener('paste', event => {
    pasted++; const file = event.clipboardData.files[0];
    doc.querySelector('[data-composer-attachments]').insertAdjacentHTML('beforeend', `<div data-testid="file-chip"><span>${file.name}</span><button aria-label="Remove attachment"></button></div>`);
  });
  doc.querySelector('button[type="submit"]').addEventListener('click', () => {
    clicks++;
    assert.equal(dom.composerText(input), prompt);
    assert.equal(pasted, image ? 1 : 0);
    input.textContent = ''; doc.querySelector('[data-composer-attachments]').textContent = '';
    // App rendering is controlled independently of the timer queue. This is
    // the asynchronous gap the previous confirmation loop mishandled.
  });
  win.chrome = { runtime: {
    id: runtimeId, getURL: path => `chrome-extension://${runtimeId}/${path}`,
    onMessage: { addListener(listener) { wakes.push(listener); } },
    async sendMessage(message) {
      messages.push({ ...message, at: now }); let data = { ok: true };
      if (message.type === 'bridge:poll') data = { job: jobs.shift() || null };
      if (message.type === 'bridge:input-image') data = { imageId: metadata.id, mimeType: metadata.mimeType, name: metadata.name, base64: png.toString('base64') };
      return { ok: true, data };
    }
  } };
  win.eval(source); await flush();
  const tracked = ['document:visibilitychange', 'document:resume', 'window:pageshow', 'window:focus', 'document:beforeinput', 'document:input', 'document:keydown', 'document:paste', 'document:pointerdown'];
  const listenerCounts = () => Object.fromEntries(tracked.map(key => [key, listening.get(key)?.size || 0]));
  const idleListeners = listenerCounts();
  const advance = async ms => {
    const target = now + ms; let steps = 0;
    while (true) {
      await flush();
      const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0] || [];
      if (!timer || timer.at > target) break;
      assert.ok(++steps < 3000, 'scheduler must not spin');
      now = Math.max(now, timer.at); timers.delete(id);
      if (timer.repeat) timers.set(id, { ...timer, at: now + timer.repeat });
      timer.fn();
    }
    now = target; await flush();
  };
  return {
    doc, win, input, messages,
    get now() { return now; }, get clicks() { return clicks; }, get scans() { return scans; },
    get result() { return messages.find(message => message.type === 'bridge:result'); },
    get error() { return messages.find(message => message.type === 'bridge:error'); },
    async start() {
      jobs.push({ id: 'confirmation-job', assistant: 'chatgpt', prompt, conversationUrl: url, timeoutMs, images: image ? [metadata] : [] });
      for (const wake of wakes) wake({ type: 'bridge:wake' }, { id: runtimeId });
      await flush(); await advance(700);
      assert.equal(clicks, 1); assert.ok(scans >= 1);
    },
    async render({ text = prompt, count = 1 } = {}) {
      for (let index = 0; index < count; index++) doc.querySelector('main').insertAdjacentHTML('beforeend', turn(`submitted-${index}`, text, image));
      await flush();
    },
    freeze(ms) { pausedObservers = true; visibility = 'hidden'; now += ms; },
    async wake(type) {
      pausedObservers = false;
      if (type === 'timer') {
        const [id, timer] = [...timers].filter(([, item]) => !item.repeat).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0] || [];
        assert.ok(timer && timer.at <= now, 'confirmation timer must be overdue'); timers.delete(id); timer.fn();
      } else {
        if (type === 'visibilitychange') visibility = 'visible';
        const event = new win.Event(type); if (type === 'pageshow') Object.defineProperty(event, 'persisted', { value: true });
        (['visibilitychange', 'resume'].includes(type) ? doc : win).dispatchEvent(event);
      }
      await flush();
    },
    humanEdit() {
      for (const listener of listening.get('document:beforeinput') || []) listener({ type: 'beforeinput', isTrusted: true, target: input, inputType: 'insertText' });
      input.textContent = 'Human draft';
    },
    advance,
    assertClean() {
      assert.equal([...observers].filter(observer => observer.active).length, 0, 'both confirmation and completion observers disconnected');
      assert.deepEqual(listenerCounts(), idleListeners, 'temporary lifecycle and human-edit listeners removed');
      assert.equal([...timers.values()].filter(timer => !timer.repeat).length, 0, 'no pending confirmation/completion/RPC timeout remains');
      assert.equal(clicks, 1, 'confirmation recovery must never submit the prompt again');
    },
    close() { timers.clear(); for (const observer of observers) observer.disconnect(); page.window.close(); },
  };
}

test('an overdue 21-second confirmation timer still recognizes the already submitted image-and-text turn once', async () => {
  const x = await fixture();
  try {
    await x.start(); const initialScans = x.scans;
    x.freeze(21000); await x.render(); assert.equal(x.scans, initialScans, 'the frozen document has not run its queued checks');
    await x.wake('timer'); await x.advance(800);
    assert.equal(x.error, undefined); assert.equal(x.result.text, 'Final image description');
    assert.equal(x.messages.filter(message => message.type === 'bridge:result').length, 1);
    x.assertClean();
  } finally { x.close(); }
});

test('DOM rendering confirms a submitted message immediately without waiting for the fallback timer', async () => {
  const x = await fixture();
  try {
    await x.start(); const submittedAt = x.now; await x.render();
    await x.advance(800); assert.equal(x.result.at - submittedAt, 800);
    assert.equal(x.error, undefined); x.assertClean();
  } finally { x.close(); }
});

test('visibility, BFCache restore, resume and focus can recover confirmation before an overdue timer runs', async () => {
  for (const event of ['visibilitychange', 'pageshow', 'resume', 'focus']) {
    const x = await fixture();
    try {
      await x.start(); x.freeze(21000); await x.render();
      await x.wake(event); await x.advance(800);
      assert.equal(x.error, undefined, event); assert.equal(x.result.text, 'Final image description', event);
      x.assertClean();
    } finally { x.close(); }
  }
});

test('an expired overall job deadline rejects even a correct completed turn before another DOM scan', async () => {
  const x = await fixture({ timeoutMs: 10000 });
  try {
    await x.start(); const initialScans = x.scans;
    x.freeze(21000); await x.render(); await x.wake('timer');
    assert.equal(x.result, undefined); assert.match(x.error.error, /等待 ChatGPT 回复超时/);
    assert.equal(x.scans, initialScans, 'overall deadline is enforced before looking for a submitted user');
    x.assertClean();
  } finally { x.close(); }
});

test('a genuinely missing user turn still fails after 20 seconds and cannot restart when the DOM changes later', async () => {
  const x = await fixture();
  try {
    await x.start(); const submittedAt = x.now;
    await x.advance(20000);
    assert.equal(x.result, undefined); assert.match(x.error.error, /未确认到本次网页消息.*不会重复点击发送/);
    assert.equal(x.error.at - submittedAt, 20000); x.assertClean();
    const scans = x.scans; await x.render();
    for (const event of ['visibilitychange', 'pageshow', 'resume', 'focus']) await x.wake(event);
    await x.advance(1000);
    assert.equal(x.scans, scans, 'finished confirmation listeners do not resume an old job');
    assert.equal(x.messages.filter(message => message.type === 'bridge:error').length, 1);
    assert.equal(x.result, undefined); x.assertClean();
  } finally { x.close(); }
});

test('a late check still rejects wrong prompts and multiple newly submitted turns', async () => {
  for (const [render, pattern] of [[{ text: 'Different human question' }, /新增网页消息与本次群消息不同/], [{ count: 2 }, /检测到其他新消息/]]) {
    const x = await fixture();
    try {
      await x.start(); x.freeze(21000); await x.render(render); await x.wake('timer');
      assert.equal(x.result, undefined); assert.match(x.error.error, pattern); x.assertClean();
    } finally { x.close(); }
  }
});

test('navigation and trusted human edits still stop a recovered confirmation before scanning', async () => {
  for (const scenario of ['navigation', 'human']) {
    const x = await fixture();
    try {
      await x.start(); const initialScans = x.scans;
      x.freeze(21000); await x.render();
      if (scenario === 'navigation') x.win.history.replaceState({}, '', '/c/a-different-conversation');
      else x.humanEdit();
      await x.wake('focus');
      assert.equal(x.result, undefined); assert.match(x.error.error, scenario === 'navigation' ? /切换了对话/ : /人工操作输入框/);
      assert.equal(x.scans, initialScans); if (scenario === 'human') assert.equal(dom.composerText(x.input), 'Human draft');
      x.assertClean();
    } finally { x.close(); }
  }
});

test('a post-send editor remount still recovers the already submitted image-and-text turn once', async () => {
  const x = await fixture();
  try {
    await x.start();
    x.freeze(21000); await x.render();
    x.input.replaceWith(x.input.cloneNode(true));
    await x.wake('focus'); await x.advance(800);
    assert.equal(x.error, undefined);
    assert.equal(x.result.text, 'Final image description');
    assert.equal(x.messages.filter(message => message.type === 'bridge:started').length, 1);
    assert.equal(x.messages.filter(message => message.type === 'bridge:result').length, 1);
    x.assertClean();
  } finally { x.close(); }
});

test('a partial ChatGPT user body may finish rendering before the original confirmation deadline', async () => {
  const x = await fixture({ image: false });
  try {
    await x.start(); await x.render({ text: '请分析' });
    await x.advance(5000);
    assert.equal(x.error, undefined); assert.equal(x.result, undefined); assert.equal(x.clicks, 1);
    x.doc.querySelector('[data-turn-key="submitted-0"] [data-user-message-bubble]').textContent = prompt;
    await flush(); await x.advance(800);
    assert.equal(x.error, undefined); assert.equal(x.result.text, 'Final image description'); x.assertClean();
  } finally { x.close(); }
});

test('a ChatGPT prompt prefix never authorizes an answer or extends the 20-second confirmation limit', async () => {
  const x = await fixture({ image: false });
  try {
    await x.start(); await x.render({ text: '请分析' });
    await x.advance(20000);
    assert.equal(x.result, undefined); assert.match(x.error.error, /提问正文尚未完整.*已识别 3\/12 字符/);
    x.assertClean();
  } finally { x.close(); }
});
