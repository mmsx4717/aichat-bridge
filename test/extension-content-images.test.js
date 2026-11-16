import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import * as dom from '../extension/dom.js';
import * as shared from '../extension/shared.js';

const url = 'https://chatgpt.com/c/content-image-fixture';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const generatedImageUrl = 'https://chatgpt.com/backend-api/estuary/content?id=file-synthetic-generated';
const metadata = { id: '1'.repeat(64), mimeType: 'image/png', name: 'original.png', bytes: png.length };
const generatedFixture = await fs.readFile(new URL('./fixtures/chatgpt-modern-generated-image.html', import.meta.url), 'utf8');
// Replace only dynamic extension module loading; execute the actual orchestration unchanged.
const source = (await fs.readFile(new URL('../extension/content.js', import.meta.url), 'utf8'))
  .replace("await import(chrome.runtime.getURL('dom.js'))", 'globalThis.__testDom')
  .replace("await import(chrome.runtime.getURL('shared.js'))", 'globalThis.__testShared');

async function runFixture({ acknowledge = true, uploadError = false, changeDraft = false, extraAttachment = false, commitDelay = 0, duringSettle, imageCount = 1, submittedText, generatedOutput = false, outputImages = [], replyHtml, outputReadFailure = false, assistant = 'chatgpt' } = {}) {
  const page = new JSDOM('<main></main><div data-composer-body><div data-composer-attachments></div><div data-composer-markdown contenteditable="true" role="textbox"></div><button type="submit" aria-label="发送"></button></div>', { url, runScripts: 'outside-only' });
  const win = page.window; const doc = win.document;
  const input = dom.composer(doc); const messages = []; const pasted = []; const submissions = []; const outputReads = []; let clicks = 0; let completed;
  const done = new Promise(resolve => { completed = resolve; });
  let now = Date.now();
  let appDraft = ''; let inputAt = null; let clickAt = null;
  const pending = [];
  win.Date = class extends Date { static now() { return now; } };
  win.setInterval = () => 0;
  win.setTimeout = (callback, ms) => { if (ms !== 60000) queueMicrotask(() => {
    now += ms;
    for (const action of [...pending]) if (action.at <= now) { pending.splice(pending.indexOf(action), 1); action.run(); }
    callback();
  }); return 0; };
  win.__testDom = { ...dom, readAnswerImage: image => dom.readAnswerImage(image, { fetchImpl: async source => {
    outputReads.push(source);
    assert.equal(source, generatedImageUrl);
    if (outputReadFailure) throw new Error('fixture image read failure');
    return new Response(png, { headers: { 'content-type': 'image/png' } });
  } }) };
  win.__testShared = shared;
  win.DataTransfer = class { constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; } };
  win.ClipboardEvent = class extends win.Event { constructor(type, options) { super(type, options); this.clipboardData = options.clipboardData; } };
  doc.execCommand = (command, _ui, text) => { assert.ok(['insertText', 'delete'].includes(command)); input.textContent = command === 'delete' ? '' : text; return true; };
  doc.addEventListener('click', event => { if (event.target.matches('button[aria-label="Remove attachment"]')) event.target.closest('[data-testid="file-chip"]')?.remove(); });
  input.addEventListener('input', event => {
    // A controlled editor renders DOM immediately but its submit handler reads
    // separately committed state. An enabled attachment button does not prove
    // this state has caught up. Model both microtask and delayed task commits.
    const value = dom.composerText(input); inputAt = now;
    if (commitDelay) pending.push({ at: now + commitDelay, run: () => { appDraft = value; } });
    else queueMicrotask(() => { appDraft = value; });
    if (duringSettle && event.inputType !== 'deleteContentBackward') pending.push({ at: now + 200, run: () => {
      if (duringSettle === 'draft') input.textContent = 'A later human draft';
      if (duringSettle === 'attachment') doc.querySelector('[data-composer-attachments]').textContent = '';
      if (duringSettle === 'navigation') win.history.replaceState({}, '', '/c/a-different-conversation');
      if (duringSettle === 'new-user') doc.querySelector('main').innerHTML = '<div data-message-author-role="user" data-message-id="other-user">Another user message</div>';
      if (duringSettle === 'replace-button') {
        const button = doc.querySelector('button[type="submit"]');
        button.replaceWith(button.cloneNode(true));
      }
    } });
  });
  input.addEventListener('paste', event => {
    pasted.push(event.clipboardData.files[0]);
    if (!acknowledge) return;
    const file = pasted.at(-1);
    doc.querySelector('[data-composer-attachments]').insertAdjacentHTML('beforeend', `<div data-testid="file-chip"><span>${file.name}</span><button aria-label="Remove attachment"></button>${uploadError ? '<div role="alert">Upload failed</div>' : ''}</div>`);
    if (extraAttachment) doc.querySelector('[data-composer-attachments]').insertAdjacentHTML('beforeend', '<div data-testid="file-chip"><span>other-user.png</span><button aria-label="Remove attachment"></button></div>');
    if (changeDraft) input.textContent = 'A human draft that must survive';
  });
  doc.addEventListener('click', event => {
    if (!event.target.matches('button[type="submit"]')) return;
    clicks++; clickAt = now;
    assert.equal(dom.composerText(input), 'Describe the picture');
    assert.equal(dom.inputAttachmentState(input, pasted.map(file => file.name)).ready, true);
    const actualText = submittedText ?? appDraft;
    submissions.push({ text: actualText, images: pasted.length });
    if (actualText === dom.composerText(input)) input.textContent = '';
    doc.querySelector('[data-composer-attachments]').textContent = '';
    doc.querySelector('main').innerHTML = '<div data-turn-key="new"><div data-talvt-turn-state="complete"><div data-chatgpt-search-unit-key="new:0:user" data-chatgpt-search-message-ids="new-user"><div data-user-message-bubble="true"></div></div><div data-chatgpt-search-unit-key="new:1:assistant" data-chatgpt-search-message-ids="new-assistant"><div data-markdown-text-style="assistant-message"><p>Picture description</p></div></div><div class="turn-action-controls"><button aria-label="复制">Copy</button></div></div></div>';
    if (generatedOutput) {
      doc.querySelector('main').innerHTML = generatedFixture;
      Object.defineProperties(doc.querySelector('main img'), { complete: { value: true }, naturalWidth: { value: 1122 }, naturalHeight: { value: 1402 } });
    }
    if (replyHtml !== undefined) doc.querySelector('[data-markdown-text-style="assistant-message"]').innerHTML = replyHtml;
    for (const source of outputImages) {
      const image = doc.createElement('img'); image.src = source;
      const supported = source === generatedImageUrl;
      // External search thumbnails may stay unloaded; they must not stall text.
      Object.defineProperties(image, { complete: { value: supported }, naturalWidth: { value: supported ? 640 : 0 }, naturalHeight: { value: supported ? 480 : 0 } });
      doc.querySelector('[data-markdown-text-style="assistant-message"]').append(image);
    }
    doc.querySelector('[data-user-message-bubble]').textContent = actualText;
  });
  win.chrome = { runtime: { id: 'content-image-fixture', getURL: path => path, onMessage: { addListener() {} }, async sendMessage(message) {
    messages.push(message);
    let data = { ok: true };
    if (message.type === 'bridge:poll') data = { job: messages.filter(item => item.type === 'bridge:poll').length === 1 ? { id: 'fixture-job', assistant, prompt: 'Describe the picture', conversationUrl: url, timeoutMs: 600000, images: Array.from({ length: imageCount }, (_, i) => ({ ...metadata, id: String(i + 1).repeat(64) })) } : null };
    if (message.type === 'bridge:input-image') data = { imageId: message.imageId, mimeType: metadata.mimeType, name: metadata.name, base64: png.toString('base64') };
    if (message.type === 'bridge:image') data = { imageId: '2'.repeat(64) };
    if (['bridge:result', 'bridge:error'].includes(message.type)) completed(message);
    return { ok: true, data };
  } } };
  win.eval(source);
  let timer;
  const result = await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture did not terminate')), 5000); })]).finally(() => clearTimeout(timer));
  const state = { result, messages, pasted, clicks, submissions, outputReads, draft: dom.composerText(input), settleTime: clickAt === null ? null : clickAt - inputAt };
  page.window.close();
  return state;
}

test('content prepares the named image before one submission and returns only the matching answer', async () => {
  const result = await runFixture();
  assert.equal(result.clicks, 1); assert.equal(result.pasted.length, 1);
  assert.match(result.pasted[0].name, /^bridge-[a-f0-9-]+-1\.png$/);
  assert.deepEqual(result.messages.map(message => message.type), ['bridge:challenge-resume', 'bridge:poll', 'bridge:started', 'bridge:input-image', 'bridge:result']);
  assert.deepEqual([...result.messages.find(message => message.type === 'bridge:poll').capabilities], ['image-input-v1']);
  assert.equal(result.result.text, 'Picture description');
  assert.equal(result.result.timing.inputPreparationMs, result.settleTime);
  assert.deepEqual(result.submissions, [{ text: 'Describe the picture', images: 1 }]);
  assert.equal(result.draft, '');
});

test('ChatGPT rejects a Claude job before editing or pasting any input', async () => {
  const result = await runFixture({ assistant: 'claude' });
  assert.equal(result.clicks, 0); assert.equal(result.pasted.length, 0);
  assert.equal(result.result.type, 'bridge:error'); assert.match(result.result.error, /助手与当前网页不一致/);
  assert.equal(result.draft, '');
  assert.deepEqual(result.messages.map(message => message.type), ['bridge:challenge-resume', 'bridge:poll', 'bridge:error']);
});

test('an already-enabled image send button waits for delayed editor state and submits all images with the text once', async () => {
  for (const imageCount of [0, 1, 2, 3, 4]) {
    const result = await runFixture({ commitDelay: 350, imageCount });
    assert.equal(result.result.type, 'bridge:result');
    assert.deepEqual(result.submissions, [{ text: 'Describe the picture', images: imageCount }]);
    assert.equal(result.clicks, 1);
    assert.equal(result.draft, '');
    assert.ok(result.settleTime >= 600);
  }
});

test('draft, attachments, conversation or user-turn changes while the editor settles block submission', async () => {
  for (const duringSettle of ['draft', 'attachment', 'navigation', 'new-user']) {
    const result = await runFixture({ duringSettle, commitDelay: 350 });
    assert.equal(result.clicks, 0, duringSettle);
    assert.equal(result.result.type, 'bridge:error');
    assert.equal(result.draft, duringSettle === 'navigation' ? 'Describe the picture' : '');
  }
});

test('a send button replaced by the editor is reacquired after settling', async () => {
  const result = await runFixture({ duringSettle: 'replace-button', commitDelay: 350 });
  assert.equal(result.result.type, 'bridge:result');
  assert.equal(result.clicks, 1);
  assert.ok(result.settleTime >= 700);
});

test('an unexpectedly image-only submitted turn fails once and clears the unsent text', async () => {
  const result = await runFixture({ submittedText: '' });
  assert.equal(result.result.type, 'bridge:error');
  assert.match(result.result.error, /未确认到本次网页消息/);
  assert.equal(result.clicks, 1);
  assert.equal(result.draft, '');
});

test('the observed generated gallery reaches image upload and final result without a normal assistant marker', async () => {
  const result = await runFixture({ generatedOutput: true, commitDelay: 350 });
  assert.equal(result.clicks, 1);
  assert.equal(result.result.type, 'bridge:result');
  assert.equal(result.result.text, '');
  assert.deepEqual([...result.result.images], ['2'.repeat(64)]);
  assert.deepEqual(result.messages.map(message => message.type), ['bridge:challenge-resume', 'bridge:poll', 'bridge:started', 'bridge:input-image', 'bridge:image', 'bridge:result']);
  const image = result.messages.find(message => message.type === 'bridge:image');
  assert.equal(image.mimeType, 'image/png');
  assert.equal(image.base64, png.toString('base64'));
});

test('unconfirmed, failed or additional attachments never fall back to a text-only submission', async () => {
  for (const options of [{ acknowledge: false }, { uploadError: true }, { extraAttachment: true }]) {
    const result = await runFixture(options);
    assert.equal(result.clicks, 0); assert.equal(result.pasted.length, 1);
    assert.equal(result.result.type, 'bridge:error');
    assert.equal(result.messages.filter(message => message.type === 'bridge:started').length, 1);
    assert.equal(result.draft, '');
  }
});

test('external reply illustrations cannot block text, code, or supported reply images', async () => {
  for (const withGeneratedImage of [false, true]) {
    const result = await runFixture({ imageCount: 0,
      replyHtml: '<h2>Claude review</h2><p>Text after the illustration.</p><pre><code class="language-js">const x = 1;</code></pre>',
      outputImages: ['https://note.com/fixture-image.png', ...(withGeneratedImage ? [generatedImageUrl] : [])],
    });
    assert.equal(result.clicks, 1); assert.equal(result.result.type, 'bridge:result');
    assert.match(result.result.text, /## Claude review/); assert.match(result.result.text, /Text after the illustration/);
    assert.match(result.result.text, /```js\nconst x = 1;\n```/);
    assert.match(result.result.text, /1 张外部.*未转发/);
    assert.deepEqual(result.outputReads, withGeneratedImage ? [generatedImageUrl] : []);
    assert.deepEqual([...result.result.images], withGeneratedImage ? ['2'.repeat(64)] : []);
    assert.equal(result.messages.filter(message => message.type === 'bridge:result').length, 1);
  }
});

test('an external-image-only final answer sends an explicit omission notice without fetching it', async () => {
  const result = await runFixture({ imageCount: 0, replyHtml: '', outputImages: ['https://note.com/fixture-image.png'] });
  assert.equal(result.result.type, 'bridge:result');
  assert.match(result.result.text, /1 张外部.*未转发/); assert.match(result.result.text, /ChatGPT 网页/);
  assert.deepEqual([...result.result.images], []); assert.deepEqual(result.outputReads, []);
});

test('supported reply image failures still stop delivery even beside omitted external illustrations', async () => {
  const result = await runFixture({ imageCount: 0, outputImages: [generatedImageUrl, 'https://note.com/fixture-image.png'], outputReadFailure: true });
  assert.equal(result.result.type, 'bridge:error'); assert.match(result.result.error, /无法读取本次回复图片/);
  assert.equal(result.messages.some(message => message.type === 'bridge:result'), false);
  assert.deepEqual(result.outputReads, [generatedImageUrl]);
});

test('a changed draft during image preparation blocks send and is cleared on failure', async () => {
  const result = await runFixture({ changeDraft: true });
  assert.equal(result.clicks, 0);
  assert.equal(result.result.type, 'bridge:error');
  assert.match(result.result.error, /页面内容已变化/);
  assert.equal(result.draft, '');
});
