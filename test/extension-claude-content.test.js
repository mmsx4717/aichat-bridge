import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import * as claude from '../extension/claude-dom.js';
import * as chatgpt from '../extension/dom.js';
import * as shared from '../extension/shared.js';

const url = 'https://claude.ai/chat/11111111-1111-4111-8111-111111111111';
const html = await readFile(new URL('./fixtures/claude-conversation.html', import.meta.url), 'utf8');
const source = (await readFile(new URL('../extension/content.js', import.meta.url), 'utf8'))
  .replace("await import(chrome.runtime.getURL('dom.js'))", 'globalThis.__testChatGPT')
  .replace("await import(chrome.runtime.getURL('claude-dom.js'))", 'globalThis.__testClaude')
  .replace("await import(chrome.runtime.getURL('shared.js'))", 'globalThis.__testShared');
const clipboardAttachment = await readFile(new URL('./fixtures/claude-clipboard-attachment.html', import.meta.url), 'utf8');
const prefixedAttachment = await readFile(new URL('./fixtures/claude-prefixed-attachment.html', import.meta.url), 'utf8');
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const metadata = { id: '1'.repeat(64), mimeType: 'image/png', name: 'source.png', bytes: png.length };
const flush = () => new Promise(resolve => setImmediate(resolve));

async function fixture({ assistant = 'claude', image = false, outputImage = false, initialDraft = '', noJob = false, mutation, submittedText, acknowledge = true, renamed = false, wrongBlob = false, imageCount = 1, clearNativeSelection = false, uploadMutation, origin = url } = {}) {
  const page = new JSDOM(html, { url: origin, runScripts: 'outside-only', pretendToBeVisual: true });
  const win = page.window; const doc = win.document; const input = claude.composer(doc);
  const messages = []; const listeners = []; const pasted = []; const uploaded = []; const fileEvents = []; const timers = new Map();
  const fileInput = doc.querySelector('input[data-testid="file-upload"]');
  let selectedFiles = uploadMutation === 'initial-foreign' ? [new win.File([png], 'human.png', { type: 'image/png' })] : [];
  Object.defineProperty(fileInput, 'files', { configurable: true, get() { return selectedFiles; }, set(value) { if (uploadMutation === 'assignment-error') throw new Error('Selection denied'); selectedFiles = [...value]; } });
  Object.defineProperty(fileInput, 'value', { configurable: true, get() { return ''; }, set(value) { assert.equal(value, ''); selectedFiles = []; } });
  let released = 0; let now = 1000; let serial = 0; let clicks = 0; let readinessChecks = 0; let appDraft = initialDraft; let afterInput = false;
  const schedule = (fn, ms, repeat = 0) => { const id = ++serial; timers.set(id, { fn, at: now + ms, repeat }); return id; };
  input.textContent = initialDraft;
  win.Date = class extends Date { static now() { return now; } };
  win.setTimeout = (fn, ms) => schedule(fn, ms);
  win.clearTimeout = id => timers.delete(id);
  win.setInterval = (fn, ms) => schedule(fn, ms, ms);
  win.clearInterval = id => timers.delete(id);
  win.__testShared = shared;
  win.__testChatGPT = { ...chatgpt, assertReady() { throw new Error('Wrong provider adapter selected'); } };
  win.__testClaude = { ...claude, releaseInputImages(input) { released++; claude.releaseInputImages?.(input); }, assertReady(...args) { readinessChecks++; return claude.assertReady(...args); }, readAnswerImage: value => claude.readAnswerImage(value, { fetchImpl: async () => new Response(png, { headers: { 'content-type': 'image/png' } }) }) };
  win.DataTransfer = class { constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; } };
  win.ClipboardEvent = class extends win.Event { constructor(type, options) { super(type, options); this.clipboardData = options.clipboardData; } };
  doc.execCommand = (command, _ui, value) => { assert.ok(['insertText', 'delete'].includes(command)); input.textContent = command === 'delete' ? '' : value; return true; };
  doc.addEventListener('click', event => {
    if (!claude.composerScope(input)?.contains(event.target) || !event.target.matches('button[aria-label*="Remove"], button[data-cds-attachment-remove]')) return;
    event.target.closest('[data-testid="attachment-preview"], [data-testid="file-thumbnail"]')?.remove();
    selectedFiles = [];
  });
  const loadImage = element => Object.defineProperties(element, { complete: { value: true }, naturalWidth: { value: 640 }, naturalHeight: { value: 480 } });
  win.fetch = async source => { assert.ok(source.startsWith('blob:https://claude.ai/')); return new Response(wrongBlob ? Buffer.concat([png, Buffer.from([9])]) : png, { headers: { 'content-type': 'image/png' } }); };
  input.addEventListener('paste', event => { pasted.push(...event.clipboardData.files); });
  fileInput.addEventListener('input', () => {
    fileEvents.push('input');
    if (uploadMutation === 'replace-field') fileInput.replaceWith(fileInput.cloneNode(true));
    if (uploadMutation === 'replace-composer') input.replaceWith(input.cloneNode(true));
    if (uploadMutation === 'duplicate-field') fileInput.after(fileInput.cloneNode(true));
    if (uploadMutation === 'input-foreign-selection') selectedFiles = [new win.File([png], 'human.png', { type: 'image/png' })];
    if (uploadMutation === 'input-replaced-selection') selectedFiles = [new win.File([png], selectedFiles[0].name, { type: 'image/png' })];
    if (uploadMutation === 'input-extra-selection') selectedFiles = [selectedFiles[0], selectedFiles[0]];
    if (uploadMutation === 'input-cleared-selection') selectedFiles = [];
  });
  fileInput.addEventListener('change', () => {
    fileEvents.push('change'); if (!fileInput.files.length) return;
    assert.equal(fileInput.files.length, 1, 'each selection contains only the next image');
    const file = fileInput.files[0]; uploaded.push(file);
    if (clearNativeSelection || uploadMutation === 'cancel') selectedFiles = [];
    if (!acknowledge || uploadMutation === 'cancel') return;
    if (renamed) {
      const attachment = renamed === 'prefixed' || renamed === 'foreign' ? prefixedAttachment.replaceAll('bridge-fixture-1.png', renamed === 'foreign' ? 'bridge-foreign.png' : file.name) : clipboardAttachment;
      const tile = doc.createElement('div'); tile.innerHTML = attachment.replace(/1700000000000/g, String(1700000000000 + uploaded.length));
      const imageCard = tile.querySelector('[data-cds="MessageAttachmentsImage"]');
      imageCard.querySelector('img').src = `blob:https://claude.ai/fixture-${uploaded.length}`;
      claude.composerScope(input).prepend(imageCard); loadImage(imageCard.querySelector('img'));
    } else {
      claude.composerScope(input).insertAdjacentHTML('afterbegin', `<div data-testid="attachment-preview"><img alt="${file.name}" src="blob:https://claude.ai/${file.name}"><span>${file.name}</span><button aria-label="Remove attachment"></button></div>`);
      loadImage(claude.composerScope(input).querySelector('img'));
    }
    if (uploadMutation === 'foreign-selection') selectedFiles = [file, new win.File([png], 'human.png', { type: 'image/png' })];
    if (uploadMutation === 'replaced-selection') selectedFiles = [new win.File([png], file.name, { type: 'image/png' })];
  });
  input.addEventListener('input', event => {
    afterInput = true; const value = claude.composerText(input);
    schedule(() => { appDraft = value; }, 350);
    if (mutation && event.inputType !== 'deleteContentBackward') schedule(() => {
      if (mutation === 'draft') input.textContent = 'A human draft';
      if (mutation === 'navigation') win.history.replaceState({}, '', '/chat/22222222-2222-4222-8222-222222222222');
      if (mutation === 'new-user') doc.querySelector('main').insertAdjacentHTML('beforeend', '<div data-testid="transcript-row"><div data-testid="user-message">Human question</div></div>');
      if (mutation === 'attachment') claude.composerScope(input).insertAdjacentHTML('afterbegin', '<div data-testid="attachment-preview">private.pdf<button aria-label="Remove file"></button></div>');
    }, 200);
  });
  claude.sendButton(doc, input).addEventListener('click', () => {
    clicks++;
    const actualText = submittedText ?? appDraft;
    if (actualText === claude.composerText(input)) input.textContent = '';
    selectedFiles = [];
    claude.composerScope(input).querySelectorAll('[data-testid="attachment-preview"], [data-testid="file-thumbnail"]').forEach(node => node.remove());
    doc.querySelector('main').insertAdjacentHTML('beforeend', `<div data-testid="transcript-row" data-perf-row="user"><div data-testid="user-message"><p></p></div></div><div data-testid="transcript-row" data-perf-row="assistant" data-perf-row-streaming="false"><div class="group group/message-row"><div class="contents"><div data-testid="assistant-message" data-is-streaming="false"><div data-testid="TurnStatus" data-state="done">PRIVATE THOUGHT</div><div data-cds="Prose"><div data-perf-reply-text class="standard-markdown"><p>Claude final answer</p>${outputImage ? '<img src="https://claude.ai/api/organizations/test/files/chart/preview">' : ''}</div></div></div></div><div data-testid="message-actions" role="toolbar"><button data-testid="action-bar-copy">Copy</button><button data-testid="action-bar-retry">Retry</button></div></div></div>`);
    claude.turns(doc, 'user').at(-1).querySelector('p').textContent = actualText;
    if (outputImage) loadImage(claude.turns(doc, 'assistant').at(-1).querySelector('img'));
  });
  win.chrome = { runtime: {
    id: 'claude-content-fixture', getURL: path => `chrome-extension://claude-content-fixture/${path}`,
    onMessage: { addListener(listener) { listeners.push(listener); } },
    async sendMessage(message) {
      messages.push(message); let data = {};
      if (message.type === 'bridge:poll') data = { job: !noJob && messages.filter(item => item.type === 'bridge:poll').length === 1 ? { id: 'claude-job', assistant, prompt: 'Describe the chart', conversationUrl: url, timeoutMs: 90000, images: image ? Array.from({length:imageCount}, (_, i) => ({...metadata, id:String(i+1).repeat(64)})) : [] } : null };
      if (message.type === 'bridge:input-image') data = { imageId: message.imageId, mimeType: metadata.mimeType, name: metadata.name, base64: png.toString('base64') };
      if (message.type === 'bridge:image') data = { imageId: '2'.repeat(64) };
      return { ok: true, data };
    },
  } };
  win.eval(source); await flush();
  return {
    doc, input, messages, pasted, uploaded, fileEvents,
    get selectedFiles() { return selectedFiles; },
    get released() { return released; }, get clicks() { return clicks; }, get afterInput() { return afterInput; }, get readinessChecks() { return readinessChecks; },
    get result() { return messages.find(message => message.type === 'bridge:result'); }, get error() { return messages.find(message => message.type === 'bridge:error'); },
    wake(sender = { id: win.chrome.runtime.id, url: win.chrome.runtime.getURL('worker.js') }) { listeners.forEach(listener => listener({ type: 'bridge:wake' }, sender)); },
    async advance(ms) {
      const target = now + ms; let steps = 0;
      while (true) {
        await flush(); const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0] || [];
        if (!timer || timer.at > target) break;
        assert.ok(++steps < 3000, 'virtual clock must not spin'); now = timer.at; timers.delete(id);
        if (timer.repeat) timers.set(id, { ...timer, at: now + timer.repeat }); timer.fn();
      }
      now = target; await flush();
    },
    close() { timers.clear(); win.close(); },
  };
}

test('Claude trusted-origin adapter handles text and image input, one send and a scoped final result', async () => {
  for (const image of [false, true]) {
    const x = await fixture({ image, outputImage: image });
    try {
      x.wake(); x.wake(); await x.advance(2500);
      assert.equal(x.clicks, 1); assert.equal(x.uploaded.length, image ? 1 : 0); assert.equal(x.pasted.length, 0);
      assert.equal(x.error, undefined); assert.equal(x.result.text, 'Claude final answer');
      assert.deepEqual([...x.result.images], image ? ['2'.repeat(64)] : []);
      assert.equal(x.result.timing.inputPreparationMs, 700);
      assert.equal(x.messages.filter(message => message.type === 'bridge:started').length, 1);
      assert.equal(x.messages.filter(message => message.type === 'bridge:result').length, 1);
      assert.equal(x.messages.some(message => Object.hasOwn(message, 'assistant')), false, 'worker derives provider, page does not assert one');
    } finally { x.close(); }
  }
});

test('Claude refuses ChatGPT jobs and unlabeled legacy jobs before any input or submission', async () => {
  for (const assistant of ['chatgpt', null, 'unknown']) {
    const x = await fixture({ assistant });
    try { await x.advance(1000); assert.equal(x.clicks, 0); assert.equal(x.afterInput, false); assert.match(x.error.error, /助手与当前网页不一致/); } finally { x.close(); }
  }
});

test('Claude idle drafts survive and untrusted wakes cannot start a job', async () => {
  const x = await fixture({ initialDraft: 'Existing private draft', noJob: true });
  try {
    assert.equal(x.messages.some(m => m.type === 'bridge:started'), false); const checks = x.readinessChecks;
    x.wake({ id: 'other-extension' }); await flush(); assert.equal(x.readinessChecks, checks);
    x.wake(); await flush(); assert.equal(x.messages.some(m => m.type === 'bridge:started'), false);
    assert.equal(claude.composerText(x.input), 'Existing private draft'); assert.equal(x.clicks, 0);
  } finally { x.close(); }
});

test('Claude draft, navigation, attachment and extra user changes during settling preserve the draft and block send', async () => {
  for (const mutation of ['draft', 'navigation', 'attachment', 'new-user']) {
    const x = await fixture({ mutation });
    try {
      await x.advance(1000); assert.equal(x.clicks, 0, mutation); assert.ok(x.error, mutation); assert.equal(x.result, undefined);
      assert.equal(claude.composerText(x.input), mutation === 'navigation' ? 'Describe the chart' : '');
    } finally { x.close(); }
  }
});

test('Claude unacknowledged image uploads never fall back to text-only sending', async () => {
  const x = await fixture({ image: true, acknowledge: false });
  try {
    await x.advance(61000); assert.equal(x.clicks, 0); assert.equal(x.uploaded.length, 1); assert.equal(x.pasted.length, 0); assert.equal(x.afterInput, false);
    assert.match(x.error.error, /Claude 未显示本次图片附件/); assert.equal(x.result, undefined);
    assert.equal(x.released, 1);
  } finally { x.close(); }
});

test('Claude mismatched submitted user text is never retried or paired with an answer', async () => {
  const x = await fixture({ submittedText: 'Different question' });
  try {
    await x.advance(1500); x.wake(); await x.advance(5000);
    assert.equal(x.clicks, 1); assert.equal(x.result, undefined); assert.match(x.error.error, /新增网页消息与本次群消息不同/);
    assert.equal(claude.composerText(x.input), '');
  } finally { x.close(); }
});

test('Claude empty mounted user row waits for hydration once, with the original confirmation deadline', async () => {
  for (const hydrate of [true, false]) {
    const x = await fixture({ submittedText: '' });
    try {
      await x.advance(1500);
      assert.equal(x.clicks, 1); assert.equal(x.error, undefined); assert.equal(x.result, undefined);
      if (hydrate) {
        claude.turns(x.doc, 'user').at(-1).querySelector('p').textContent = 'Describe the chart';
        x.input.textContent = ''; await x.advance(2000);
        assert.equal(x.error, undefined); assert.equal(x.result?.text, 'Claude final answer');
      } else {
        await x.advance(21000); assert.match(x.error?.error, /未确认到本次网页消息/);
        assert.equal(x.result, undefined);
      }
      x.wake(); await x.advance(1000); assert.equal(x.clicks, 1);
    } finally { x.close(); }
  }
});

test('an unsupported origin cannot activate Claude even if the DOM matches', async () => {
  const x = await fixture({ origin: 'https://claude.ai.evil.test/chat/11111111-1111-4111-8111-111111111111' });
  try { await x.advance(5000); assert.equal(x.messages.length, 0); assert.equal(x.readinessChecks, 0); assert.equal(x.clicks, 0); } finally { x.close(); }
});

test('Claude native uploads keep one-to-four distinct images paired whether the page clears or retains its file selection', async () => {
  for (const renamed of [false, true, 'prefixed']) for (const imageCount of [1, 2, 3, 4]) for (const clearNativeSelection of [false, true]) {
    const x = await fixture({image:true, renamed, imageCount, clearNativeSelection});
    try {
      await x.advance(3500);
      assert.equal(x.uploaded.length,imageCount);assert.equal(x.error,undefined);assert.equal(x.pasted.length,0);
      assert.equal(new Set(x.uploaded.map(file => file.name)).size, imageCount);
      assert.deepEqual(x.fileEvents, Array.from({ length: imageCount }, () => ['input', 'change']).flat());
      assert.equal(x.clicks,1);assert.equal(x.result?.text,'Claude final answer');
      assert.equal(x.released,1);
    } finally {x.close();}
  }
});

test('Claude renamed thumbnail with different bytes never sends a partial or unrelated prompt', async () => {
  for (const renamed of [true, 'prefixed']) {
    const x=await fixture({image:true,renamed,wrongBlob:true});
    try {await x.advance(61000);assert.equal(x.clicks,0);assert.equal(x.afterInput,false);assert.ok(x.error);assert.equal(x.result,undefined);assert.equal(x.released,1);}
    finally{x.close();}
  }
});

test('Claude timestamp-prefixed foreign filenames never authorize text entry or submission', async () => {
  const x = await fixture({ image: true, renamed: 'foreign' });
  try {
    await x.advance(61000);
    assert.equal(x.uploaded.length, 1); assert.equal(x.pasted.length, 0); assert.equal(x.clicks, 0); assert.equal(x.afterInput, false);
    assert.match(x.error?.error || '', /附件名称或数量/);
    assert.equal(x.result, undefined); assert.equal(x.released, 1);
  } finally { x.close(); }
});

test('Claude cancelled or unacknowledged native uploads never trigger paste fallback or text-only sending', async () => {
  const x = await fixture({ image: true, uploadMutation: 'cancel' });
  try {
    await x.advance(61000);
    assert.deepEqual(x.fileEvents, ['input', 'change']); assert.equal(x.uploaded.length, 1); assert.equal(x.pasted.length, 0);
    assert.equal(x.clicks, 0); assert.equal(x.afterInput, false); assert.ok(x.error); assert.equal(x.result, undefined);
  } finally { x.close(); }
});

test('Claude field or composer replacement during the input event stops before change and never retries elsewhere', async () => {
  for (const uploadMutation of ['replace-field', 'replace-composer', 'duplicate-field', 'assignment-error']) {
    const x = await fixture({ image: true, uploadMutation });
    try {
      await x.advance(1500);
      assert.deepEqual(x.fileEvents, uploadMutation === 'assignment-error' ? [] : ['input']);
      assert.equal(x.uploaded.length, 0); assert.equal(x.pasted.length, 0); assert.equal(x.clicks, 0); assert.equal(x.afterInput, false);
      assert.ok(x.error); assert.equal(x.result, undefined); assert.equal(x.released, 1);
    } finally { x.close(); }
  }
});

test('Claude foreign or replaced native file selections stop before entering prompt text', async () => {
  for (const uploadMutation of ['foreign-selection', 'replaced-selection']) {
    const x = await fixture({ image: true, uploadMutation });
    try {
      await x.advance(1500);
      assert.deepEqual(x.fileEvents, ['input', 'change']); assert.equal(x.uploaded.length, 1); assert.equal(x.pasted.length, 0);
      assert.equal(x.clicks, 0); assert.equal(x.afterInput, false); assert.match(x.error?.error || '', /不属于本次任务/);
      assert.equal(x.result, undefined);
    } finally { x.close(); }
  }
});

test('Claude rejects input-event file substitutions before the page receives a change event', async () => {
  for (const uploadMutation of ['input-foreign-selection', 'input-replaced-selection', 'input-extra-selection']) {
    const x = await fixture({ image: true, uploadMutation });
    try {
      await x.advance(1500);
      assert.deepEqual(x.fileEvents, ['input']); assert.equal(x.uploaded.length, 0); assert.equal(x.pasted.length, 0);
      assert.equal(x.clicks, 0); assert.equal(x.afterInput, false); assert.match(x.error?.error || '', /文件选择在上传期间发生变化/);
    } finally { x.close(); }
  }
});

test('Claude input-event selection clearing is neither restored nor retried without an attachment acknowledgment', async () => {
  const x = await fixture({ image: true, uploadMutation: 'input-cleared-selection' });
  try {
    await x.advance(61000);
    assert.deepEqual(x.fileEvents, ['input', 'change']); assert.equal(x.uploaded.length, 0); assert.equal(x.pasted.length, 0);
    assert.equal(x.selectedFiles.length, 0); assert.equal(x.clicks, 0); assert.equal(x.afterInput, false); assert.ok(x.error);
  } finally { x.close(); }
});

test('Claude clears an existing native file selection before preparing the new task image', async () => {
  const x = await fixture({ image: true, uploadMutation: 'initial-foreign' });
  try {
    await x.advance(3000);
    assert.equal(x.error, undefined); assert.equal(x.fileEvents.length, 2); assert.equal(x.uploaded.length, 1); assert.equal(x.pasted.length, 0);
    assert.equal(x.selectedFiles.length, 0); assert.equal(x.clicks, 1); assert.equal(x.result?.text, 'Claude final answer');
  } finally { x.close(); }
});
