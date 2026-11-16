import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import * as dom from '../extension/dom.js';
import * as shared from '../extension/shared.js';

const url = 'https://chatgpt.com/c/content-wake-fixture';
const runtimeId = 'content-wake-extension';
const workerUrl = `chrome-extension://${runtimeId}/worker.js`;
const trustedSender = { id: runtimeId, url: workerUrl };
const prompt = 'Question';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const metadata = { id: '1'.repeat(64), mimeType: 'image/png', name: 'original.png', bytes: png.length };
const productionSource = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
const baselineSource = process.env.BRIDGE_INBOUND_BASELINE_SOURCE
  ? await readFile(process.env.BRIDGE_INBOUND_BASELINE_SOURCE, 'utf8') : null;
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture({ source = productionSource, submittedText, pollGate, startedGate, imagePreparationDelay = 0, assistant = 'chatgpt' } = {}) {
  const pageUrl = { chatgpt: url, claude: 'https://claude.ai/chat/content-wake-fixture', gemini: 'https://gemini.google.com/app/content-wake-fixture', qwen: 'https://chat.qwen.ai/c/content-wake-fixture' }[assistant];
  const page = new JSDOM('<main></main><div data-composer-body><div data-composer-attachments></div><div data-composer-markdown contenteditable="true" role="textbox"></div><button type="submit" aria-label="发送"></button></div>', { url: pageUrl, runScripts: 'outside-only', pretendToBeVisual: true });
  const win = page.window; const doc = win.document; const input = dom.composer(doc);
  const messages = []; const jobs = []; const listeners = []; const timers = new Map(); const intervalMs = [];
  let now = 1000; let serial = 0; let visibility = 'visible'; let clicks = 0; let readinessChecks = 0;
  let activePolls = 0; let maxPolls = 0; let submittedAt = null; let inputFetchAt = null;
  const schedule = (fn, ms, repeat = 0) => { const id = ++serial; timers.set(id, { fn, at: now + ms, repeat }); return id; };
  Object.defineProperty(doc, 'visibilityState', { get: () => visibility });
  win.Date = class extends Date { static now() { return now; } };
  win.setTimeout = (fn, ms) => schedule(fn, ms);
  win.clearTimeout = id => timers.delete(id);
  win.setInterval = (fn, ms) => { intervalMs.push(ms); return schedule(fn, ms, ms); };
  win.clearInterval = id => timers.delete(id);
  win.__testShared = shared;
  win.__testDom = { ...dom, assertReady(...args) { readinessChecks++; return dom.assertReady(...args); } };
  win.DataTransfer = class { constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; } };
  win.ClipboardEvent = class extends win.Event { constructor(type, options) { super(type, options); this.clipboardData = options.clipboardData; } };
  doc.execCommand = (command, _ui, text) => { assert.ok(['insertText', 'delete'].includes(command)); input.textContent = command === 'delete' ? '' : text; return true; };
  input.addEventListener('paste', event => {
    const file = event.clipboardData.files[0];
    doc.querySelector('[data-composer-attachments]').insertAdjacentHTML('beforeend', `<div data-testid="file-chip"><span>${file.name}</span><button aria-label="Remove attachment"></button></div>`);
  });
  doc.querySelector('button[type="submit"]').addEventListener('click', () => {
    clicks++; submittedAt = now;
    const text = submittedText ?? dom.composerText(input);
    if (text === dom.composerText(input)) input.textContent = '';
    doc.querySelector('[data-composer-attachments]').textContent = '';
    doc.querySelector('main').insertAdjacentHTML('beforeend', `<div data-turn-key="new-${clicks}"><div data-talvt-turn-state="complete"><div data-chatgpt-search-unit-key="new-${clicks}:0:user" data-chatgpt-search-message-ids="new-${clicks}-user"><div data-user-message-bubble="true"></div></div><div data-chatgpt-search-unit-key="new-${clicks}:1:assistant" data-chatgpt-search-message-ids="new-${clicks}-assistant"><div data-markdown-text-style="assistant-message"><p>Final answer</p></div></div><div class="turn-action-controls"><button aria-label="复制">Copy</button></div></div></div>`);
    doc.querySelector(`[data-turn-key="new-${clicks}"] [data-user-message-bubble]`).textContent = text;
  });
  win.chrome = { runtime: {
    id: runtimeId, getURL: path => `chrome-extension://${runtimeId}/${path}`,
    onMessage: { addListener(listener) { listeners.push(listener); } },
    async sendMessage(message) {
      messages.push({ ...message, at: now });
      let data = { ok: true };
      if (message.type === 'bridge:poll') {
        maxPolls = Math.max(maxPolls, ++activePolls);
        try { if (pollGate) await pollGate.promise; data = { job: jobs.shift() || null }; }
        finally { activePolls--; }
      }
      if (message.type === 'bridge:started' && startedGate) await startedGate.promise;
      if (message.type === 'bridge:input-image') {
        inputFetchAt = now;
        if (imagePreparationDelay) await new Promise(resolve => schedule(resolve, imagePreparationDelay));
        data = { imageId: metadata.id, mimeType: metadata.mimeType, name: metadata.name, base64: png.toString('base64') };
      }
      return { ok: true, data };
    }
  } };
  win.eval(source
    .replace("await import(chrome.runtime.getURL('dom.js'))", 'globalThis.__testDom')
    .replace("await import(chrome.runtime.getURL('claude-dom.js'))", 'globalThis.__testDom')
    .replace("await import(chrome.runtime.getURL('gemini-dom.js'))", 'globalThis.__testDom')
    .replace("await import(chrome.runtime.getURL('qwen-dom.js'))", 'globalThis.__testDom')
    .replace("await import(chrome.runtime.getURL('shared.js'))", 'globalThis.__testShared'));
  await flush();
  return {
    win, doc, input, messages, intervalMs,
    get now() { return now; }, get clicks() { return clicks; }, get maxPolls() { return maxPolls; },
    get activePolls() { return activePolls; }, get submittedAt() { return submittedAt; }, get inputFetchAt() { return inputFetchAt; },
    get readinessChecks() { return readinessChecks; }, get pollCount() { return messages.filter(message => message.type === 'bridge:poll').length; },
    get result() { return messages.find(message => message.type === 'bridge:result'); },
    get error() { return messages.find(message => message.type === 'bridge:error'); },
    enqueue({ id = 'wake-job', image = false } = {}) { jobs.push({ id, assistant, prompt, conversationUrl: pageUrl, timeoutMs: 240000, images: image ? [metadata] : [] }); },
    wake(sender = trustedSender, message = { type: 'bridge:wake' }, count = 1) {
      for (let i = 0; i < count; i++) for (const listener of listeners) {
        assert.equal(listener(message, sender), undefined, 'notification acknowledgement cannot wait for polling or the page job');
      }
    },
    async visibility(value) { visibility = value; doc.dispatchEvent(new win.Event('visibilitychange')); await flush(); },
    lifecycle(type, { persisted = true } = {}) {
      const event = new win.Event(type);
      if (type === 'pageshow') Object.defineProperty(event, 'persisted', { value: persisted });
      (type === 'resume' ? doc : win).dispatchEvent(event);
    },
    async elapseWithoutTimers(ms) { now += ms; await flush(); },
    async advance(ms) {
      const target = now + ms; let steps = 0;
      while (true) {
        await flush();
        const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0] || [];
        if (!timer || timer.at > target) break;
        assert.ok(++steps < 2000, 'scheduler must not spin');
        now = timer.at; timers.delete(id);
        if (timer.repeat) timers.set(id, { ...timer, at: now + timer.repeat });
        timer.fn();
      }
      now = target; await flush();
    },
    close() { timers.clear(); page.window.close(); },
  };
}

test('wake bursts during an outstanding lease RPC coalesce behind a single-flight poll', async () => {
  const gate = deferred(); const x = await fixture({ pollGate: gate });
  try {
    assert.equal(x.pollCount, 1); assert.equal(x.activePolls, 1);
    x.wake(trustedSender, undefined, 30); await flush();
    assert.equal(x.pollCount, 1);
    // A fallback while the RPC is pending must not create another pending job.
    await x.advance(4500); assert.equal(x.pollCount, 1);
    gate.resolve(); await flush();
    assert.equal(x.pollCount, 2); assert.equal(x.maxPolls, 1);
    await flush(); assert.equal(x.pollCount, 2);
    assert.deepEqual(x.intervalMs, [4500]);
  } finally { x.close(); }
});

test('trusted wake during a running job produces one immediate safe poll after completion', async () => {
  const gate = deferred(); const x = await fixture({ startedGate: gate });
  try {
    x.enqueue(); x.wake(); await flush();
    assert.equal(x.messages.filter(message => message.type === 'bridge:started').length, 1);
    x.wake(trustedSender, undefined, 30); await flush();
    assert.equal(x.pollCount, 2); assert.equal(x.clicks, 0);
    gate.resolve(); await flush(); await x.advance(1500);
    assert.equal(x.clicks, 1); assert.equal(x.result.text, 'Final answer');
    assert.equal(x.result.timing.inputPreparationMs, 700);
    assert.equal(x.pollCount, 3); assert.equal(x.maxPolls, 1);
    assert.equal(x.messages.at(-1).type, 'bridge:poll');
    assert.equal(x.messages.at(-1).at, x.result.at);
  } finally { x.close(); }
});

test('two already queued jobs drain sequentially without a second wake or fallback tick', async () => {
  const x = await fixture();
  try {
    x.enqueue({ id: 'queued-first' }); x.enqueue({ id: 'queued-second' }); x.wake(); await flush();
    await x.advance(3000);
    assert.equal(x.clicks, 2); assert.equal(x.maxPolls, 1);
    assert.deepEqual(x.messages.filter(message => message.type === 'bridge:started').map(message => message.jobId), ['queued-first', 'queued-second']);
    assert.deepEqual(x.messages.filter(message => message.type === 'bridge:result').map(message => message.jobId), ['queued-first', 'queued-second']);
    assert.equal(x.pollCount, 4);
    const count = x.pollCount; await x.advance(100); assert.equal(x.pollCount, count);
  } finally { x.close(); }
});

test('only the extension worker can wake the page and sender-less messages are ignored', async () => {
  const x = await fixture();
  try {
    for (const sender of [undefined, {}, { id: 'another-extension' }, { id: runtimeId, tab: { id: 1 } }, { id: runtimeId, tab: null }, { id: runtimeId, url }, { id: runtimeId, url: workerUrl + '?query=1' }, { id: runtimeId, url: `chrome-extension://${runtimeId}/options.html` }, { id: runtimeId, url: null }]) {
      // Explicit undefined is supplied directly; fixture.wake defaults to the trusted sender.
      x.wake(sender === undefined ? null : sender);
    }
    x.wake(trustedSender, { type: 'bridge:result' });
    await flush(); assert.equal(x.pollCount, 1);
    x.wake({ id: runtimeId }); await flush(); assert.equal(x.pollCount, 2);
    x.wake(trustedSender); await flush(); assert.equal(x.pollCount, 3);
  } finally { x.close(); }
});

test('returning to a visible document polls immediately while hidden transitions do not', async () => {
  const x = await fixture();
  try {
    await x.visibility('hidden'); assert.equal(x.pollCount, 1);
    await x.visibility('visible'); assert.equal(x.pollCount, 2);
    assert.equal(x.now, 1000);
    await x.advance(4499); assert.equal(x.pollCount, 2);
    await x.advance(1); assert.equal(x.pollCount, 3);
  } finally { x.close(); }
});

test('BFCache restore, document resume and window focus wake an idle page immediately', async () => {
  const x = await fixture();
  try {
    x.lifecycle('pageshow', { persisted: false }); await flush();
    assert.equal(x.pollCount, 1, 'ordinary pageshow does not duplicate the initial poll');
    for (const [index, type] of ['pageshow', 'resume', 'focus'].entries()) {
      x.lifecycle(type); await flush();
      assert.equal(x.pollCount, index + 2);
      assert.equal(x.now, 1000, 'lifecycle recovery does not wait for the fallback timer');
    }
    assert.equal(x.maxPolls, 1);
  } finally { x.close(); }
});

test('lifecycle wake bursts during a job coalesce without leasing or submitting twice', async () => {
  const gate = deferred(); const x = await fixture({ startedGate: gate });
  try {
    x.enqueue(); x.wake(); await flush();
    for (let i = 0; i < 10; i++) for (const type of ['pageshow', 'resume', 'focus']) x.lifecycle(type);
    await flush();
    assert.equal(x.pollCount, 2); assert.equal(x.clicks, 0);
    assert.equal(x.messages.filter(message => message.type === 'bridge:started').length, 1);
    gate.resolve(); await flush(); await x.advance(1500);
    assert.equal(x.clicks, 1); assert.equal(x.result.text, 'Final answer');
    assert.equal(x.pollCount, 3); assert.equal(x.maxPolls, 1);
  } finally { x.close(); }
});

test('a late timed-out poll reply is ignored and a later unstarted lease receipt submits only once', async () => {
  const gate = deferred(); const x = await fixture({ pollGate: gate });
  try {
    x.enqueue({ id: 'late-unstarted-lease' });
    await x.advance(60000);
    assert.equal(x.pollCount, 1); assert.equal(x.clicks, 0);
    gate.resolve(); await flush();
    assert.equal(x.activePolls, 0);
    assert.equal(x.messages.filter(message => message.type === 'bridge:started').length, 0);
    assert.equal(x.clicks, 0, 'the original late promise result must not launch a page job');
    assert.equal(x.result, undefined);
    // Model the worker returning the same lease, still unstarted, on the next
    // poll. This is another receipt of one job, not a second queued prompt.
    x.enqueue({ id: 'late-unstarted-lease' }); x.wake(); await flush();
    await x.advance(1500);
    assert.deepEqual(x.messages.filter(message => message.type === 'bridge:started').map(message => message.jobId), ['late-unstarted-lease']);
    assert.deepEqual(x.messages.filter(message => message.type === 'bridge:result').map(message => message.jobId), ['late-unstarted-lease']);
    assert.equal(x.clicks, 1); assert.equal(x.result.text, 'Final answer');
    assert.equal(x.error, undefined);
  } finally { x.close(); }
});

test('idle notification and visibility polling leaves a draft intact without an internal retry loop', async () => {
  const x = await fixture();
  try {
    x.input.textContent = 'A human draft'; const checks = x.readinessChecks;
    x.wake(); await flush();
    assert.equal(x.pollCount, 2); assert.equal(x.readinessChecks, checks + 1);
    await x.advance(4400); assert.equal(x.readinessChecks, checks + 1);
    await x.visibility('hidden'); await x.visibility('visible');
    assert.equal(x.pollCount, 3); assert.equal(x.readinessChecks, checks + 2);
    for (const type of ['pageshow', 'resume', 'focus']) { x.lifecycle(type); await flush(); }
    assert.equal(x.pollCount, 6); assert.equal(x.readinessChecks, checks + 5);
    assert.equal(dom.composerText(x.input), 'A human draft');
    x.input.textContent = ''; x.wake(); await flush(); assert.equal(x.pollCount, 7);
  } finally { x.close(); }
});

test('a queued wake cannot resubmit a failed old page turn after clearing its draft', async () => {
  const x = await fixture({ submittedText: 'A different submitted question' });
  try {
    x.enqueue(); x.wake(); await flush();
    x.wake(trustedSender, undefined, 20);
    await x.advance(800);
    assert.equal(x.clicks, 1); assert.match(x.error.error, /新增网页消息与本次群消息不同/);
    assert.equal(x.result, undefined); assert.equal(x.pollCount, 3);
    assert.equal(dom.composerText(x.input), '');
    await x.advance(4500);
    assert.equal(x.clicks, 1); assert.equal(x.pollCount, 4);
    assert.equal(x.messages.filter(message => message.type === 'bridge:error').length, 1);
  } finally { x.close(); }
});

test('input preparation timing includes image retrieval and editor stabilization after started acknowledgement', async () => {
  const startedGate = deferred(); const x = await fixture({ startedGate, imagePreparationDelay: 300 });
  try {
    x.enqueue({ image: true }); x.wake(); await flush();
    await x.advance(1000); assert.equal(x.clicks, 0);
    startedGate.resolve(); await flush();
    await x.advance(1800);
    assert.equal(x.result.timing.inputPreparationMs, 1000);
    assert.equal(x.submittedAt - x.inputFetchAt, 1000);
    assert.equal(x.result.timing.imagePreparationMs, 0);
    assert.equal(x.clicks, 1);
  } finally { x.close(); }
});

async function inboundBenchmark(source, image) {
  const x = await fixture({ source });
  try {
    assert.equal(x.pollCount, 1);
    await x.advance(100); const queuedAt = x.now;
    x.enqueue({ image }); x.wake(); await flush();
    await x.advance(6000);
    const started = x.messages.find(message => message.type === 'bridge:started');
    assert.equal(x.clicks, 1); assert.ok(x.result); assert.ok(started);
    return { queueToStartedMs: started.at - queuedAt, startedToClickMs: x.submittedAt - started.at, queueToClickMs: x.submittedAt - queuedAt };
  } finally { x.close(); }
}

test('inbound wake benchmark keeps queue-to-click latency to the existing editor stabilization', async t => {
  for (const image of [false, true]) {
    const result = await inboundBenchmark(productionSource, image);
    t.diagnostic(`${image ? 'ready-input-image' : 'text'} virtual-clock: ${JSON.stringify(result)}`);
    assert.deepEqual(result, { queueToStartedMs: 0, startedToClickMs: 700, queueToClickMs: 700 });
  }
});

test('optional inbound before/after benchmark runs both actual content sources on the same virtual clock', { skip: !baselineSource }, async t => {
  for (const image of [false, true]) {
    const before = await inboundBenchmark(baselineSource, image);
    const after = await inboundBenchmark(productionSource, image);
    t.diagnostic(`${image ? 'ready-input-image' : 'text'} virtual-clock before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    assert.equal(before.queueToStartedMs, 4400);
    assert.equal(before.startedToClickMs, 700);
    assert.equal(before.queueToClickMs - after.queueToClickMs, 4400);
  }
});


for (const assistant of shared.ASSISTANTS) test(`${assistant}: trusted worker wake finishes a quiet hidden answer while page timers are suspended`, async () => {
  const x = await fixture({ assistant });
  try {
    x.enqueue(); x.wake(); await flush(); await x.advance(700);
    assert.equal(x.clicks, 1); assert.equal(x.result, undefined);
    await x.visibility('hidden'); await x.elapseWithoutTimers(1000);
    assert.equal(x.result, undefined, 'no DOM mutation or timer has completed the stable answer');
    x.wake({ id: 'foreign-extension' }); await flush();
    assert.equal(x.result, undefined, 'untrusted messages do not drive the active waiter');
    x.wake(); await flush();
    assert.equal(x.result?.text, 'Final answer');
    assert.equal(x.result.timing.background, true); assert.equal(x.clicks, 1);
  } finally { x.close(); }
});

for (const type of ['resume', 'pageshow', 'focus']) test(`${type} resumes the active answer check without waiting for a clamped timer`, async () => {
  const x = await fixture();
  try {
    x.enqueue(); x.wake(); await flush(); await x.advance(700);
    await x.visibility('hidden'); await x.elapseWithoutTimers(1000);
    x.lifecycle(type); await flush();
    assert.equal(x.result?.text, 'Final answer'); assert.equal(x.clicks, 1);
  } finally { x.close(); }
});

test('background wake retains completion markers and the original deadline', async () => {
  const x = await fixture();
  try {
    x.enqueue(); x.wake(); await flush(); await x.advance(700);
    x.doc.querySelector('[data-talvt-turn-state]').setAttribute('data-talvt-turn-state', 'streaming');
    await flush(); await x.visibility('hidden'); await x.elapseWithoutTimers(1000);
    x.wake(); await flush(); assert.equal(x.result, undefined);
    await x.elapseWithoutTimers(240000); x.wake(); await flush();
    assert.match(x.error?.error || '', /超时/); assert.equal(x.result, undefined); assert.equal(x.clicks, 1);
  } finally { x.close(); }
});
