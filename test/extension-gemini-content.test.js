import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import * as gemini from '../extension/gemini-dom.js';
import * as shared from '../extension/shared.js';
import { createImageDecoder } from './helpers/image-decoder.js';

const url = 'https://gemini.google.com/u/1/app/0123456789abcdef';
const prompt = 'Describe the chart';
const html = await readFile(new URL('./fixtures/gemini-conversation.html', import.meta.url), 'utf8');
const attachmentHtml = await readFile(new URL('./fixtures/gemini-clipboard-attachment.html', import.meta.url), 'utf8');
const generatedImageHtml = await readFile(new URL('./fixtures/gemini-generated-image.html', import.meta.url), 'utf8');
const pendingRequestHtml = await readFile(new URL('./fixtures/gemini-pending-request.html', import.meta.url), 'utf8');
const visualImages = Object.fromEntries(await Promise.all(['source.png', 'source-q85.jpg', 'source-half-q85.jpg', 'different.png'].map(async name => [name, await readFile(new URL(`./fixtures/image-equivalence/${name}`, import.meta.url))])));
const source = (await readFile(new URL('../extension/content.js', import.meta.url), 'utf8'))
  .replace("await import(chrome.runtime.getURL('dom.js'))", 'globalThis.__wrongAdapter')
  .replace("await import(chrome.runtime.getURL('claude-dom.js'))", 'globalThis.__wrongAdapter')
  .replace("await import(chrome.runtime.getURL('gemini-dom.js'))", 'globalThis.__testGemini')
  .replace("await import(chrome.runtime.getURL('shared.js'))", 'globalThis.__testShared');
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const metadata = { id: '1'.repeat(64), mimeType: 'image/png', name: 'source.png', bytes: png.length };
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture({ assistant = 'gemini', initialDraft = '', noJob = false, mutation, submittedText, origin = url, pollGate, imageCount = 0, acknowledge = false, wrongBlob = false, extraAttachment = false, originalBytes = png, previewBytes = originalBytes, inputMimeType = 'image/png', previewMimeType = inputMimeType, hiddenClose = false, decoder, decoderGate, outputHtml = '<p>Gemini final answer</p>', outputImages = [], generatedOutput = false, afterSend, afterSendMs = 200, pendingForMs = null, pendingInitialText = 'ready', pendingTextAfterMs = Infinity, pendingIndicators = 'visible', streamForMs = 0, timeoutMs = 90000 } = {}) {
  const page = new JSDOM(html, { url: origin, runScripts: 'outside-only', pretendToBeVisual: true });
  const win = page.window; const doc = win.document; const input = gemini.composer(doc);
  const messages = []; const listeners = []; const pasted = []; const timers = new Map(); const jobs = [];
  const submissions = []; const imageReads = []; const previewReads = []; const decodedAtSubmission = []; const decodePromises = []; const guards = new Map();
  const inputMetadata = { ...metadata, mimeType: inputMimeType, bytes: originalBytes.length };
  let now = 1000; let serial = 0; let clicks = 0; let readinessChecks = 0; let appDraft = initialDraft; let afterInput = false; let released = 0;
  let activePolls = 0; let maxPolls = 0; let submittedAt = null; let decodeRequests = 0; let decodedImages = 0;
  const schedule = (fn, ms, repeat = 0) => { const id = ++serial; timers.set(id, { fn, at: now + ms, repeat }); return id; };
  const add = doc.addEventListener.bind(doc); const remove = doc.removeEventListener.bind(doc);
  doc.addEventListener = (type, listener, options) => { if (options === true) guards.set(type, listener); add(type, listener, options); };
  doc.removeEventListener = (type, listener, options) => { if (guards.get(type) === listener) guards.delete(type); remove(type, listener, options); };
  input.textContent = initialDraft;
  win.Date = class extends Date { static now() { return now; } };
  win.setTimeout = (fn, ms) => schedule(fn, ms);
  win.clearTimeout = id => timers.delete(id);
  win.setInterval = (fn, ms) => schedule(fn, ms, ms);
  win.clearInterval = id => timers.delete(id);
  if (decoder) {
    Object.assign(win, decoder.win);
    win.createImageBitmap = (...args) => {
      decodeRequests++;
      const pending = (async () => {
        if (decoderGate) await decoderGate.promise;
        const image = await decoder.win.createImageBitmap(...args); decodedImages++; return image;
      })();
      decodePromises.push(pending); return pending;
    };
  }
  win.__testShared = shared;
  win.__wrongAdapter = { assertReady() { throw new Error('Wrong provider adapter selected'); } };
  win.__testGemini = {
    ...gemini,
    releaseInputImages(value) { released++; gemini.releaseInputImages?.(value); },
    assertReady(...args) { readinessChecks++; return gemini.assertReady(...args); },
    readAnswerImage: value => gemini.readAnswerImage(value, { fetchImpl: async source => {
      imageReads.push(source); return new Response(png, { headers: { 'content-type': 'image/png' } });
    } }),
  };
  win.DataTransfer = class { constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; } };
  win.ClipboardEvent = class extends win.Event { constructor(type, options) { super(type, options); this.clipboardData = options.clipboardData; } };
  win.fetch = async source => {
    assert.ok(source.startsWith('blob:https://gemini.google.com/'));
    previewReads.push(source);
    return new Response(wrongBlob ? Buffer.concat([previewBytes, Buffer.from([9])]) : previewBytes, { headers: { 'content-type': previewMimeType } });
  };
  doc.execCommand = (command, _ui, value) => { assert.ok(['insertText', 'delete'].includes(command)); input.textContent = command === 'delete' ? '' : value; return true; };
  doc.addEventListener('click', event => {
    if (event.target.matches('.gem-attachment-close-button > button')) event.target.closest('.file-preview-container')?.remove();
  });
  const loadImage = element => Object.defineProperties(element, { complete: { value: true }, naturalWidth: { value: 640 }, naturalHeight: { value: 480 } });
  let history = doc.querySelector('main');
  if (pendingForMs !== null) {
    const scroller = doc.createElement('infinite-scroller'); scroller.setAttribute('data-test-id', 'chat-history-container');
    scroller.append(...history.childNodes); history.append(scroller); history = scroller;
  }
  const rowTemplate = doc.querySelector('.conversation-container').cloneNode(true);
  const appendTurn = (text, body = outputHtml, images = []) => {
    const row = rowTemplate.cloneNode(true); row.id = `new-turn-${doc.querySelectorAll('.conversation-container').length}`;
    row.querySelector('.query-text').textContent = text;
    row.querySelector('.markdown-main-panel').innerHTML = body;
    row.querySelector('thinking-overlay').textContent = 'PRIVATE NEW THOUGHT';
    for (const [index, source] of images.entries()) {
      if (generatedOutput) {
        const wrapper = doc.createElement('div'); wrapper.innerHTML = generatedImageHtml;
        const gallery = wrapper.querySelector('.generated-images');
        gallery.querySelector('single-image').setAttribute('data-image-attachment-index', String(index));
        const image = gallery.querySelector('img'); image.src = source; loadImage(image);
        row.querySelector('.markdown-main-panel').append(gallery);
      } else {
        const image = doc.createElement('img'); image.src = source; loadImage(image); row.querySelector('.markdown-main-panel').append(image);
      }
    }
    if (generatedOutput) row.querySelector('message-actions > copy-button').remove();
    history.append(row); return row;
  };
  input.addEventListener('paste', event => {
    const file = event.clipboardData.files[0]; pasted.push(file);
    if (!acknowledge) return;
    const wrapper = doc.createElement('div'); wrapper.innerHTML = attachmentHtml;
    const card = wrapper.querySelector('.file-preview-container'); card.setAttribute('data-test-gemini-attachment', '');
    if (hiddenClose) card.querySelector('.gem-attachment-close-button').style.display = 'none';
    const image = card.querySelector('img'); image.src = `blob:https://gemini.google.com/current-input-${pasted.length}`; loadImage(image);
    gemini.composerScope(input).prepend(card);
    if (extraAttachment) gemini.composerScope(input).insertAdjacentHTML('afterbegin', '<img alt="private.png" src="blob:https://gemini.google.com/extra-private-image">');
  });
  input.addEventListener('input', event => {
    afterInput = true; const value = gemini.composerText(input);
    schedule(() => { appDraft = value; }, 350);
    if (mutation && event.inputType !== 'deleteContentBackward') schedule(() => {
      if (mutation === 'draft') input.textContent = 'A human draft';
      if (mutation === 'human') { input.textContent = 'A human draft'; guards.get('input')?.({ type: 'input', isTrusted: true, target: input }); }
      if (mutation === 'navigation') win.history.replaceState({}, '', '/u/1/app/a-different-conversation');
      if (mutation === 'new-user') appendTurn('Human question', '<p>Unrelated answer</p>');
      if (mutation === 'attachment') gemini.composerScope(input).insertAdjacentHTML('afterbegin', '<div class="file-preview-container"><gem-media-attachment><img src="blob:https://gemini.google.com/private" alt="private.png"><gem-icon-button class="gem-attachment-close-button"><button aria-label="關閉附件"></button></gem-icon-button></gem-media-attachment></div>');
    }, 200);
  });
  gemini.sendButton(doc, input).addEventListener('click', () => {
    clicks++; submittedAt = now;
    const actualText = submittedText ?? appDraft;
    submissions.push({ text: actualText, images: pasted.length });
    decodedAtSubmission.push(decodedImages);
    if (actualText === gemini.composerText(input)) input.textContent = '';
    gemini.composerScope(input).querySelectorAll('[data-test-gemini-attachment]').forEach(node => node.remove());
    let row;
    if (pendingForMs === null) row = appendTurn(actualText, outputHtml, outputImages);
    else {
      const wrapper = doc.createElement('div'); wrapper.innerHTML = pendingRequestHtml;
      row = wrapper.querySelector('pending-request');
      row.querySelector('.query-text-line').textContent = actualText;
      const label = row.querySelector('.screen-reader-user-query-label'); if (label) label.textContent = actualText;
      if (pendingIndicators !== 'visible') for (const indicator of row.querySelectorAll('thinking-dots-animation, pending-response')) {
        if (pendingIndicators === 'absent') indicator.remove(); else indicator.style.display = 'none';
      }
      if (pendingInitialText !== 'ready') {
        const pending = row; const query = row.querySelector('.query-text'); const parent = query.parentElement; const markup = query.innerHTML;
        if (pendingInitialText === 'missing') query.remove();
        else if (pendingInitialText === 'empty') query.textContent = '';
        else if (pendingInitialText === 'hidden') query.style.display = 'none';
        if (Number.isFinite(pendingTextAfterMs)) schedule(() => {
          if (!pending.isConnected) return;
          query.innerHTML = markup; query.style.removeProperty('display');
          if (!query.isConnected) parent.append(query);
        }, pendingTextAfterMs);
      }
      history.append(row);
      if (Number.isFinite(pendingForMs)) schedule(() => {
        if (!row.isConnected) return;
        const durable = appendTurn(actualText, outputHtml, outputImages);
        row.replaceWith(durable); row = durable;
        if (streamForMs) {
          durable.querySelector('.markdown-main-panel').setAttribute('aria-busy', 'true');
          durable.querySelector('.response-footer').classList.remove('complete');
          schedule(() => {
            durable.querySelector('.markdown-main-panel').setAttribute('aria-busy', 'false');
            durable.querySelector('.response-footer').classList.add('complete');
          }, streamForMs);
        }
      }, pendingForMs);
    }
    if (afterSend) schedule(() => {
      if (afterSend === 'new-user') appendTurn('Human follow-up', '<p>Other answer</p>');
      if (afterSend === 'navigation') win.history.replaceState({}, '', '/u/1/app/a-different-conversation');
      if (afterSend === 'human') guards.get('input')?.({ type: 'input', isTrusted: true, target: input });
      if (afterSend === 'pending-gone') row.remove();
      if (afterSend === 'pending-wrong-text') row.querySelector('.query-text-line').textContent = 'A different question';
      if (afterSend === 'pending-replaced') row.replaceWith(row.cloneNode(true));
      if (afterSend === 'response-outside-turn') {
        row.querySelector('model-response').remove();
        appendTurn('Other question', '<p>Other answer</p>');
      }
    }, afterSendMs);
  });
  if (!noJob) jobs.push({ id: 'gemini-job', assistant, prompt, conversationUrl: url, timeoutMs,
    images: Array.from({ length: imageCount }, (_, i) => ({ ...inputMetadata, id: String(i + 1).repeat(64) })) });
  win.chrome = { runtime: {
    id: 'gemini-content-fixture', getURL: path => `chrome-extension://gemini-content-fixture/${path}`,
    onMessage: { addListener(listener) { listeners.push(listener); } },
    async sendMessage(message) {
      messages.push(message); let data = {};
      if (message.type === 'bridge:poll') {
        maxPolls = Math.max(maxPolls, ++activePolls);
        try { if (pollGate) await pollGate.promise; data = { job: jobs.shift() || null }; }
        finally { activePolls--; }
      }
      if (message.type === 'bridge:input-image') data = { imageId: message.imageId, mimeType: inputMetadata.mimeType, name: inputMetadata.name, base64: originalBytes.toString('base64') };
      if (message.type === 'bridge:image') data = { imageId: String(message.index + 2).repeat(64) };
      return { ok: true, data };
    },
  } };
  win.eval(source); await flush();
  return {
    win, doc, input, messages, pasted, jobs, submissions, imageReads, previewReads, decodedAtSubmission,
    get clicks() { return clicks; }, get afterInput() { return afterInput; }, get readinessChecks() { return readinessChecks; }, get released() { return released; }, get maxPolls() { return maxPolls; }, get now() { return now; }, get submittedAt() { return submittedAt; },
    get decodeRequests() { return decodeRequests; }, get decodedImages() { return decodedImages; },
    get result() { return messages.find(message => message.type === 'bridge:result'); }, get error() { return messages.find(message => message.type === 'bridge:error'); },
    wake(sender = { id: win.chrome.runtime.id, url: win.chrome.runtime.getURL('worker.js') }) { listeners.forEach(listener => listener({ type: 'bridge:wake' }, sender)); },
    async settleDecoders() {
      let count;
      do { count = decodePromises.length; await Promise.allSettled(decodePromises); await flush(); } while (decodePromises.length !== count);
    },
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

test('Gemini exact-origin adapter submits text once after editor commit and returns only the current answer', async () => {
  const x = await fixture();
  try {
    x.wake(); x.wake(); await x.advance(2500);
    assert.equal(x.clicks, 1); assert.equal(x.error, undefined); assert.equal(x.result?.text, 'Gemini final answer');
    assert.deepEqual(x.submissions, [{ text: prompt, images: 0 }]);
    assert.equal(x.result.timing.inputPreparationMs, 700);
    assert.equal(x.messages.filter(m => m.type === 'bridge:started').length, 1);
    assert.equal(x.messages.filter(m => m.type === 'bridge:result').length, 1);
    assert.equal(x.messages.some(m => Object.hasOwn(m, 'assistant')), false);
    assert.doesNotMatch(x.result.text, /PRIVATE|Earlier/); assert.equal(x.released, 1);
  } finally { x.close(); }
});

test('Gemini returns public formatted text and code without response controls or thinking content', async () => {
  const outputHtml = '<h2>Result</h2><p>Use <strong>this function</strong>.</p><code-block><div class="code-block-decoration header-formatted"><span>javascript</span><button>Copy code</button></div><pre><code data-test-id="code-content">const answer = 42;\nconsole.log(answer);</code></pre></code-block><ul><li>One</li><li>Two</li></ul>';
  const x = await fixture({ outputHtml });
  try {
    await x.advance(2500); assert.equal(x.error, undefined); assert.equal(x.clicks, 1);
    assert.match(x.result.text, /## Result/); assert.match(x.result.text, /\*\*this function\*\*/);
    assert.match(x.result.text, /```javascript\nconst answer = 42;\nconsole.log\(answer\);\n```/);
    assert.match(x.result.text, /- One\n- Two/); assert.doesNotMatch(x.result.text, /Copy code|PRIVATE|Earlier/);
  } finally { x.close(); }
});

test('Gemini refuses GPT, Claude, unlabeled and unknown jobs before changing the composer', async () => {
  for (const assistant of ['chatgpt', 'claude', null, 'unknown']) {
    const x = await fixture({ assistant });
    try { await x.advance(1000); assert.equal(x.clicks, 0); assert.equal(x.afterInput, false); assert.match(x.error.error, /助手与当前网页不一致/); } finally { x.close(); }
  }
});

test('Gemini-looking DOM on an unsupported origin cannot poll or act', async () => {
  for (const origin of ['https://gemini.google.com.evil.test/app/0123456789abcdef', 'http://gemini.google.com/app/0123456789abcdef', 'https://gemini.google.com:444/app/0123456789abcdef']) {
    const x = await fixture({ origin });
    try { await x.advance(5000); assert.equal(x.messages.length, 0); assert.equal(x.readinessChecks, 0); assert.equal(x.clicks, 0); } finally { x.close(); }
  }
});

test('Gemini existing drafts survive idle notifications when no job is queued', async () => {
  const x = await fixture({ initialDraft: 'Existing private draft', noJob: true });
  try {
    assert.equal(x.messages.some(m => m.type === 'bridge:started'), false); const checks = x.readinessChecks;
    x.wake({ id: 'other-extension' }); await flush(); assert.equal(x.readinessChecks, checks);
    x.wake(); x.doc.dispatchEvent(new x.win.Event('resume')); x.win.dispatchEvent(new x.win.Event('focus')); await x.advance(5000);
    assert.equal(x.messages.some(m => m.type === 'bridge:started'), false); assert.equal(gemini.composerText(x.input), 'Existing private draft'); assert.equal(x.clicks, 0);
  } finally { x.close(); }
});

test('Gemini settling blocks draft, trusted human edits, navigation, extra attachments and unrelated turns', async () => {
  for (const mutation of ['draft', 'human', 'navigation', 'attachment', 'new-user']) {
    const x = await fixture({ mutation });
    try {
      await x.advance(1000); assert.equal(x.clicks, 0, mutation); assert.ok(x.error, mutation); assert.equal(x.result, undefined);
      assert.equal(gemini.composerText(x.input), mutation === 'human' ? 'A human draft' : mutation === 'navigation' ? prompt : '');
      if (mutation === 'human') assert.match(x.error.error, /人工操作/);
    } finally { x.close(); }
  }
});

test('Gemini submitted text mismatch stops after one click and clears the unsent draft', async () => {
  const x = await fixture({ submittedText: 'Different question' });
  try {
    await x.advance(1500); x.wake(); await x.advance(5000);
    assert.equal(x.clicks, 1); assert.equal(x.result, undefined); assert.match(x.error.error, /新增网页消息与本次群消息不同/);
    assert.equal(gemini.composerText(x.input), '');
  } finally { x.close(); }
});

test('Gemini durable empty user row waits for hydration once, with the original confirmation deadline', async () => {
  for (const hydrate of [true, false]) {
    const x = await fixture({ submittedText: '' });
    try {
      await x.advance(1500);
      assert.equal(x.clicks, 1); assert.equal(x.error, undefined); assert.equal(x.result, undefined);
      if (hydrate) {
        gemini.turns(x.doc, 'user').at(-1).querySelector('.query-text').textContent = prompt;
        x.input.textContent = ''; await x.advance(2000);
        assert.equal(x.error, undefined); assert.equal(x.result?.text, 'Gemini final answer');
      } else {
        await x.advance(21000); assert.match(x.error?.error, /未确认到本次网页消息/);
        assert.equal(x.result, undefined);
      }
      x.wake(); await x.advance(1000); assert.equal(x.clicks, 1);
    } finally { x.close(); }
  }
});

test('Gemini one-to-four input image jobs stop when paste is unconfirmed, with no text-only fallback', async () => {
  for (const imageCount of [1, 2, 3, 4]) {
    const x = await fixture({ imageCount });
    try {
      await x.advance(61000); assert.equal(x.clicks, 0); assert.equal(x.pasted.length, 1);
      assert.equal(x.afterInput, false); assert.equal(gemini.composerText(x.input), '');
      assert.match(x.error.error, /Gemini 未显示本次图片附件/);
      assert.equal(x.result, undefined); assert.equal(x.released, 1);
      assert.equal(x.messages.filter(m => m.type === 'bridge:input-image').length, 1);
    } finally { x.close(); }
  }
});

test('Gemini one-to-four observed clipboard cards are byte-verified before one combined image-and-text submission', async () => {
  for (const imageCount of [1, 2, 3, 4]) {
    const x = await fixture({ imageCount, acknowledge: true });
    try {
      await x.advance(4000); assert.equal(x.error, undefined); assert.equal(x.clicks, 1);
      assert.equal(x.pasted.length, imageCount); assert.deepEqual(x.submissions, [{ text: prompt, images: imageCount }]);
      assert.equal(x.result?.text, 'Gemini final answer'); assert.equal(x.released, 1);
      assert.equal(x.messages.filter(m => m.type === 'bridge:started').length, 1);
      assert.equal(x.messages.filter(m => m.type === 'bridge:result').length, 1);
      assert.equal(x.messages.filter(m => m.type === 'bridge:input-image').length, imageCount);
      for (const [index, file] of x.pasted.entries()) assert.match(file.name, new RegExp(`^bridge-[a-f0-9-]+-${index + 1}\\.png$`));
    } finally { x.close(); }
  }
});

test('Gemini one-to-four hidden-close attachments accept JPEG and thumbnail previews only after every image passes visual verification', async () => {
  for (const preview of ['source-q85.jpg', 'source-half-q85.jpg']) for (const imageCount of [1, 2, 3, 4]) {
    const decoder = createImageDecoder(); const gate = deferred();
    const x = await fixture({ imageCount, acknowledge: true, hiddenClose: true, originalBytes: visualImages['source.png'], previewBytes: visualImages[preview], previewMimeType: 'image/jpeg', decoder, decoderGate: gate });
    try {
      await x.advance(200);
      assert.equal(x.decodeRequests, 1, 'visual decoding begins for the fresh preview');
      assert.equal(x.afterInput, false); assert.equal(x.clicks, 0); assert.equal(x.pasted.length, 1);
      gate.resolve(); await x.settleDecoders();
      for (let image = 0; image < imageCount; image++) { await x.advance(200); await x.settleDecoders(); }
      await x.advance(2500);
      assert.equal(x.error, undefined, `${preview}, ${imageCount} images`);
      assert.equal(x.clicks, 1); assert.equal(x.pasted.length, imageCount);
      assert.equal(x.previewReads.length, imageCount); assert.equal(x.decodedImages, imageCount * 2);
      assert.deepEqual(x.decodedAtSubmission, [imageCount * 2], 'the combined submission waits for all original/preview pairs');
      assert.deepEqual(x.submissions, [{ text: prompt, images: imageCount }]);
      assert.equal(x.result?.text, 'Gemini final answer'); assert.equal(x.released, 1);
      assert.equal(x.messages.filter(message => message.type === 'bridge:result').length, 1);
      assert.equal(decoder.bitmaps.length, imageCount * 2);
      assert.ok(decoder.bitmaps.every(bitmap => bitmap.closeCount === 1), 'all decoded images are released after verification');
    } finally { gate.resolve(); await x.settleDecoders(); x.close(); }
  }
});

test('Gemini a different or undecodable preview stops before inserting text or clicking Send', async () => {
  for (const previewBytes of [visualImages['different.png'], Buffer.from('not an image'), png]) {
    const decoder = createImageDecoder();
    const x = await fixture({ imageCount: 2, acknowledge: true, hiddenClose: true, originalBytes: visualImages['source.png'], previewBytes, decoder });
    try {
      await x.settleDecoders(); await x.advance(1000); await x.settleDecoders(); await x.advance(200);
      assert.ok(x.error, 'an invalid preview cannot authorize the first attachment');
      assert.equal(x.afterInput, false); assert.equal(gemini.composerText(x.input), '');
      assert.equal(x.clicks, 0); assert.equal(x.pasted.length, 1); assert.equal(x.result, undefined);
      assert.equal(x.messages.filter(message => message.type === 'bridge:input-image').length, 1);
      assert.equal(x.released, 1);
      assert.ok(decoder.bitmaps.every(bitmap => bitmap.closeCount === 1));
    } finally { await x.settleDecoders(); x.close(); }
  }
});

test('Gemini a decoder resolving after task timeout or navigation cannot resume a released image task', async () => {
  for (const stop of ['timeout', 'navigation']) {
    const decoder = createImageDecoder(); const gate = deferred();
    const x = await fixture({ imageCount: 2, acknowledge: true, hiddenClose: true, originalBytes: visualImages['source.png'], previewBytes: visualImages['source-q85.jpg'], previewMimeType: 'image/jpeg', decoder, decoderGate: gate, timeoutMs: stop === 'timeout' ? 1000 : 90000 });
    try {
      await x.advance(200); assert.equal(x.decodeRequests, 1); assert.equal(x.afterInput, false);
      if (stop === 'navigation') x.win.history.replaceState({}, '', '/u/1/app/a-different-conversation');
      await x.advance(stop === 'timeout' ? 1000 : 200);
      assert.match(x.error?.error || '', stop === 'timeout' ? /超时|未确认本次图片附件已上传完成/ : /切换了对话/);
      assert.equal(x.released, 1); const errorCount = x.messages.filter(message => message.type === 'bridge:error').length;
      gate.resolve(); await x.settleDecoders(); await x.advance(2000);
      assert.equal(x.decodeRequests, 1, 'a late original decode must not start preview decoding');
      assert.equal(x.decodedImages, 1); assert.equal(decoder.bitmaps[0].closeCount, 1, 'the cancelled task closes its late bitmap');
      assert.equal(x.afterInput, false); assert.equal(gemini.composerText(x.input), '');
      assert.equal(x.clicks, 0); assert.equal(x.pasted.length, 1); assert.equal(x.result, undefined);
      assert.equal(x.messages.filter(message => message.type === 'bridge:error').length, errorCount);
      assert.equal(x.messages.filter(message => message.type === 'bridge:input-image').length, 1);
    } finally { gate.resolve(); await x.settleDecoders(); x.close(); }
  }
});

test('Gemini altered clipboard bytes or an extra attachment never authorize a partial prompt', async () => {
  for (const options of [{ wrongBlob: true }, { extraAttachment: true }]) {
    const x = await fixture({ imageCount: 2, acknowledge: true, ...options });
    try {
      await x.advance(66000); assert.equal(x.clicks, 0); assert.equal(x.afterInput, false);
      assert.equal(x.pasted.length, 1); assert.ok(x.error); assert.equal(x.result, undefined); assert.equal(x.released, 1);
    } finally { x.close(); }
  }
});

test('Gemini returns all supported same-origin reply images in order with the text in one result', async () => {
  for (const imageCount of [1, 2, 3, 4]) {
    const outputImages = Array.from({ length: imageCount }, (_, index) => `blob:https://gemini.google.com/current-answer-${index}`);
    const x = await fixture({ outputImages });
    try {
      await x.advance(3000); assert.equal(x.clicks, 1); assert.equal(x.error, undefined);
      assert.equal(x.result.text, 'Gemini final answer'); assert.deepEqual(x.imageReads, outputImages);
      assert.deepEqual([...x.result.images], outputImages.map((_, index) => String(index + 2).repeat(64)));
      assert.deepEqual(x.messages.filter(m => m.type === 'bridge:image').map(m => m.index), outputImages.map((_, index) => index));
      assert.equal(x.messages.filter(m => m.type === 'bridge:result').length, 1);
    } finally { x.close(); }
  }
});

test('Gemini observed image-only replies with no toolbar copy return all one-to-four generated images once', async () => {
  for (const imageCount of [1, 2, 3, 4]) {
    const outputImages = Array.from({ length: imageCount }, (_, index) => `blob:https://gemini.google.com/generated-answer-${index}`);
    const x = await fixture({ outputHtml: '', outputImages, generatedOutput: true });
    try {
      await x.advance(3000); assert.equal(x.clicks, 1); assert.equal(x.error, undefined);
      assert.equal(x.result.text, ''); assert.deepEqual(x.imageReads, outputImages);
      assert.deepEqual([...x.result.images], outputImages.map((_, index) => String(index + 2).repeat(64)));
      assert.deepEqual(x.messages.filter(m => m.type === 'bridge:image').map(m => m.index), outputImages.map((_, index) => index));
      assert.equal(x.messages.filter(m => m.type === 'bridge:result').length, 1);
      const answer = gemini.turns(x.doc, 'assistant').at(-1);
      assert.equal(answer.querySelector('message-actions > copy-button'), null);
      assert.equal(answer.querySelectorAll('generated-image').length, imageCount);
      assert.equal(gemini.assertReady(x.doc), x.input, 'a completed image-only answer permits the next queued task');
    } finally { x.close(); }
  }
});

test('Gemini external illustration keeps the text and a counted warning without reading or uploading the image', async () => {
  const x = await fixture({ outputImages: ['https://untrusted.example/image.png'] });
  try {
    await x.advance(3000); assert.equal(x.clicks, 1); assert.equal(x.error, undefined);
    assert.equal(x.result.text, 'Gemini final answer\n\n提示：本次回复有 1 张外部来源图片未转发，请在 Gemini 网页查看。');
    assert.deepEqual([...x.result.images], []); assert.deepEqual(x.imageReads, []);
    assert.equal(x.messages.filter(m => m.type === 'bridge:image').length, 0);
    assert.equal(x.messages.filter(m => m.type === 'bridge:result').length, 1);
  } finally { x.close(); }
});

test('Gemini unsupported generated images and changed conversation ownership stop without reading or forwarding', async () => {
  for (const options of [
    { outputImages: ['https://untrusted.example/image.png'], generatedOutput: true, outputHtml: '' },
    { outputImages: ['blob:https://gemini.google.com/current-answer'], afterSend: 'new-user' },
    { outputImages: ['blob:https://gemini.google.com/current-answer'], afterSend: 'navigation' },
  ]) {
    const x = await fixture(options);
    try {
      await x.advance(3000); assert.equal(x.clicks, 1); assert.ok(x.error); assert.equal(x.result, undefined);
      assert.deepEqual(x.imageReads, []); assert.equal(x.messages.filter(m => m.type === 'bridge:image').length, 0);
    } finally { x.close(); }
  }
});

test('Gemini stops completion when another turn, navigation or a human edit breaks ownership', async () => {
  for (const afterSend of ['new-user', 'navigation', 'human', 'response-outside-turn']) {
    const x = await fixture({ afterSend });
    try { await x.advance(2000); assert.equal(x.clicks, 1); assert.equal(x.result, undefined); assert.ok(x.error, afterSend); } finally { x.close(); }
  }
});

test('Gemini ignores a timed-out poll response and executes a later receipt of its unstarted lease only once', async () => {
  const gate = deferred(); const x = await fixture({ pollGate: gate });
  try {
    const job = structuredClone(x.jobs[0]);
    await x.advance(60000); assert.equal(x.clicks, 0);
    gate.resolve(); await flush();
    assert.equal(x.messages.filter(m => m.type === 'bridge:started').length, 0);
    x.jobs.push(job); x.wake(); await x.advance(2500);
    assert.equal(x.clicks, 1); assert.equal(x.result?.text, 'Gemini final answer');
    assert.deepEqual(x.messages.filter(m => m.type === 'bridge:started').map(m => m.jobId), ['gemini-job']);
    assert.equal(x.error, undefined); assert.equal(x.maxPolls, 1);
  } finally { x.close(); }
});

test('Gemini observed pending user waits through short and over-twenty-second loading, then streaming, before one final result', async () => {
  for (const pendingForMs of [1000, 26000]) {
    const x = await fixture({ pendingForMs, streamForMs: 2000 });
    try {
      await x.advance(700); assert.equal(x.clicks, 1); assert.equal(x.submittedAt, x.now);
      assert.equal(x.doc.querySelectorAll('pending-request').length, 1);
      assert.equal(x.doc.querySelector('pending-request').id, '');
      await x.advance(pendingForMs - 1);
      assert.equal(x.error, undefined); assert.equal(x.result, undefined);
      assert.equal(x.messages.filter(m => m.type === 'bridge:poll').length, 1);
      assert.equal(x.messages.filter(m => m.type === 'bridge:started').length, 1);
      await x.advance(1);
      assert.equal(x.doc.querySelector('pending-request'), null);
      assert.equal(gemini.turns(x.doc, 'assistant').at(-1).querySelector('.markdown-main-panel').getAttribute('aria-busy'), 'true');
      assert.equal(x.error, undefined); assert.equal(x.result, undefined);
      await x.advance(1999); assert.equal(x.result, undefined);
      await x.advance(1); assert.equal(x.result, undefined, 'completion still requires the final stability window');
      await x.advance(799); assert.equal(x.result, undefined);
      await x.advance(1); assert.equal(x.result?.text, 'Gemini final answer');
      x.wake(); await x.advance(1000);
      assert.equal(x.error, undefined); assert.equal(x.clicks, 1); assert.equal(x.maxPolls, 1);
      assert.equal(x.messages.filter(m => m.type === 'bridge:started').length, 1);
      assert.equal(x.messages.filter(m => m.type === 'bridge:result').length, 1);
    } finally { x.close(); }
  }
});

test('Gemini pending text, node, second-user, navigation and trusted human changes stop without resubmitting', async () => {
  for (const afterSend of ['pending-wrong-text', 'pending-replaced', 'new-user', 'navigation', 'human']) {
    const x = await fixture({ pendingForMs: Infinity, afterSend });
    try {
      await x.advance(1000); assert.equal(x.clicks, 1); assert.ok(x.error, afterSend); assert.equal(x.result, undefined);
      assert.equal(x.messages.filter(m => m.type === 'bridge:started').length, 1);
      x.wake(); await x.advance(1000); assert.equal(x.clicks, 1);
      assert.equal(x.messages.filter(m => m.type === 'bridge:error').length, 1);
    } finally { x.close(); }
  }
});

test('Gemini pending disappearance after the original twenty-second confirmation window fails promptly', async () => {
  const x = await fixture({ pendingForMs: Infinity, afterSend: 'pending-gone', afterSendMs: 26000 });
  try {
    await x.advance(700); await x.advance(25999);
    assert.equal(x.error, undefined); assert.equal(x.result, undefined); assert.equal(x.clicks, 1);
    await x.advance(1);
    assert.ok(x.error); assert.match(x.error.error, /未确认|消失|基准/); assert.equal(x.result, undefined);
    assert.equal(x.doc.querySelector('pending-request'), null);
    assert.equal(x.messages.filter(m => m.type === 'bridge:started').length, 1);
  } finally { x.close(); }
});

test('Gemini permanently pending user still stops exactly at the overall job deadline', async () => {
  const x = await fixture({ pendingForMs: Infinity, timeoutMs: 30000 });
  try {
    await x.advance(29999); assert.equal(x.clicks, 1); assert.equal(x.error, undefined); assert.equal(x.result, undefined);
    assert.ok(x.doc.querySelector('pending-request'));
    await x.advance(1);
    assert.match(x.error?.error || '', /超时/); assert.equal(x.result, undefined); assert.equal(x.clicks, 1);
    assert.equal(x.messages.filter(m => m.type === 'bridge:started').length, 1);
    assert.equal(x.messages.filter(m => m.type === 'bridge:error').length, 1);
    await x.advance(1000); assert.equal(x.clicks, 1);
  } finally { x.close(); }
});

test('Gemini early pending shells wait for visible exact text without animation requirements, then finish only after durable streaming completes', async () => {
  for (const pendingInitialText of ['missing', 'empty', 'hidden']) for (const pendingIndicators of ['absent', 'hidden']) {
    const x = await fixture({ pendingForMs: 26000, pendingInitialText, pendingTextAfterMs: 1000, pendingIndicators, streamForMs: 2000 });
    try {
      await x.advance(700); assert.equal(x.clicks, 1); assert.equal(x.error, undefined);
      const pending = x.doc.querySelector('pending-request'); assert.ok(pending);
      for (let i = 0; i < 10; i++) x.wake();
      await x.advance(999); assert.equal(x.error, undefined); assert.equal(x.result, undefined);
      assert.equal(x.doc.querySelector('pending-request'), pending);
      await x.advance(1);
      assert.equal(gemini.visible(pending.querySelector('.query-text')), true);
      assert.equal(pending.querySelector('.query-text-line').textContent, prompt);
      await x.advance(24999); assert.equal(x.error, undefined); assert.equal(x.result, undefined);
      assert.equal(x.messages.filter(m => m.type === 'bridge:poll').length, 1);
      await x.advance(1); assert.equal(x.doc.querySelector('pending-request'), null);
      assert.equal(gemini.turns(x.doc, 'assistant').at(-1).querySelector('.markdown-main-panel').getAttribute('aria-busy'), 'true');
      await x.advance(2799); assert.equal(x.error, undefined); assert.equal(x.result, undefined);
      await x.advance(1); assert.equal(x.result?.text, 'Gemini final answer');
      assert.equal(x.clicks, 1); assert.equal(x.messages.filter(m => m.type === 'bridge:started').length, 1);
      assert.equal(x.messages.filter(m => m.type === 'bridge:result').length, 1); assert.equal(x.maxPolls, 1);
    } finally { x.close(); }
  }
});

test('Gemini pending shells with permanently missing, empty or hidden text stop at the original twenty-second confirmation window', async () => {
  for (const pendingInitialText of ['missing', 'empty', 'hidden']) {
    const x = await fixture({ pendingForMs: Infinity, pendingInitialText, pendingIndicators: 'absent', timeoutMs: 90000 });
    try {
      await x.advance(700); assert.equal(x.clicks, 1); assert.equal(x.error, undefined);
      await x.advance(19999); assert.equal(x.error, undefined); assert.equal(x.result, undefined);
      await x.advance(1);
      assert.match(x.error?.error || '', /未确认到本次网页消息/);
      assert.equal(x.result, undefined); assert.equal(x.clicks, 1);
      assert.equal(x.messages.filter(m => m.type === 'bridge:started').length, 1);
      await x.advance(5000); assert.equal(x.messages.filter(m => m.type === 'bridge:error').length, 1); assert.equal(x.clicks, 1);
    } finally { x.close(); }
  }
});

test('Gemini asynchronously mounted nonmatching pending text fails immediately even when loading indicators are absent or hidden', async () => {
  for (const pendingIndicators of ['absent', 'hidden']) {
    const x = await fixture({ pendingForMs: Infinity, pendingInitialText: 'missing', pendingTextAfterMs: 1000, pendingIndicators, submittedText: 'A different submitted question' });
    try {
      await x.advance(700); await x.advance(999); assert.equal(x.error, undefined); assert.equal(x.result, undefined);
      await x.advance(101); assert.match(x.error?.error || '', /新增网页消息与本次群消息不同/);
      assert.equal(x.result, undefined); assert.equal(x.clicks, 1); assert.equal(gemini.composerText(x.input), '');
      assert.equal(x.messages.filter(m => m.type === 'bridge:error').length, 1);
    } finally { x.close(); }
  }
});
