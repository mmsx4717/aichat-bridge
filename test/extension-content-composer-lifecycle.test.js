import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import * as chatgpt from '../extension/dom.js';
import * as claude from '../extension/claude-dom.js';
import * as gemini from '../extension/gemini-dom.js';
import * as qwen from '../extension/qwen-dom.js';
import { composerHTML, user as qwenUser, answer as qwenAnswer, url as qwenUrl } from './helpers/qwen-fixture.js';
import * as shared from '../extension/shared.js';

const source = (await readFile(new URL('../extension/content.js', import.meta.url), 'utf8'))
  .replace("await import(chrome.runtime.getURL('dom.js'))", 'globalThis.__testChatGPT')
  .replace("await import(chrome.runtime.getURL('claude-dom.js'))", 'globalThis.__testClaude')
  .replace("await import(chrome.runtime.getURL('gemini-dom.js'))", 'globalThis.__testGemini')
  .replace("await import(chrome.runtime.getURL('qwen-dom.js'))", 'globalThis.__testQwen')
  .replace("await import(chrome.runtime.getURL('shared.js'))", 'globalThis.__testShared');
const fixtures = {
  qwen: '<main><div id="chat-message-container"></div>' + composerHTML + '</main>',
  chatgpt: '<main></main><div data-composer-body><div data-composer-attachments></div><div data-composer-markdown contenteditable="true" role="textbox"></div><button type="submit" aria-label="发送"></button></div>',
  claude: await readFile(new URL('./fixtures/claude-conversation.html', import.meta.url), 'utf8'),
  gemini: await readFile(new URL('./fixtures/gemini-conversation.html', import.meta.url), 'utf8'),
};
const urls = { qwen: qwenUrl, chatgpt: 'https://chatgpt.com/c/composer-lifecycle-fixture', claude: 'https://claude.ai/chat/composer-lifecycle-fixture', gemini: 'https://gemini.google.com/app/composer-lifecycle-fixture' };
const adapters = { chatgpt, claude, gemini, qwen };
const flush = () => new Promise(resolve => setImmediate(resolve));
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const metadata = { id: '1'.repeat(64), mimeType: 'image/png', name: 'source.png', bytes: png.length };

async function fixture(assistant, { remount, action, rpcDelays = {}, timeoutMs = 90000, initialDraft = '', initialAttachment = false, failFirst = false, queuedJobs = 1 } = {}) {
  const page = new JSDOM(fixtures[assistant], { url: urls[assistant], runScripts: 'outside-only', pretendToBeVisual: true });
  const win = page.window; const doc = win.document; const dom = adapters[assistant]; const originalInput = dom.composer(doc);
  const messages = []; const timers = new Map(); const guards = new Map(); const listeners = [];
  let now = 1000; let serial = 0; let clicks = 0; let currentInput = originalInput; let currentScope = dom.composerScope(originalInput); let remounts = 0; let rows = 0; let offered = 0; let removals = 0; let injected = false; let failedState;
  const schedule = (fn, ms, repeat = 0) => { const id = ++serial; timers.set(id, { fn, at: now + ms, repeat }); return id; };
  const add = doc.addEventListener.bind(doc); const remove = doc.removeEventListener.bind(doc);
  doc.addEventListener = (type, listener, options) => { if (options === true) guards.set(type, listener); add(type, listener, options); };
  doc.removeEventListener = (type, listener, options) => { if (guards.get(type) === listener) guards.delete(type); remove(type, listener, options); };
  win.Date = class extends Date { static now() { return now; } };
  win.setTimeout = (fn, ms) => schedule(fn, ms); win.clearTimeout = id => timers.delete(id);
  win.setInterval = (fn, ms) => schedule(fn, ms, ms); win.clearInterval = id => timers.delete(id);
  win.__testQwen = qwen; win.__testShared = shared; win.__testChatGPT = chatgpt; win.__testClaude = claude; win.__testGemini = gemini;
  doc.execCommand = (command, _ui, text) => { assert.ok(['insertText', 'delete'].includes(command)); currentInput.textContent = command === 'delete' ? '' : text; return true; };
  currentInput.textContent = initialDraft; if (assistant === 'qwen') currentInput.value = initialDraft;
  const attachment = () => {
    const card = doc.createElement(assistant === 'gemini' ? 'gem-media-attachment' : 'div'); card.dataset.cleanupAttachment = '';
    if (assistant === 'qwen') { card.className = 'vision-item-container'; card.innerHTML = '<img alt="stale.png"><button class="close-button" style="visibility:hidden"></button>'; currentScope.querySelector('.file-card-list').append(card); }
    else if (assistant === 'gemini') { card.innerHTML = '<img alt=""><gem-icon-button class="gem-attachment-close-button"><button aria-label="關閉附件"></button></gem-icon-button>'; currentScope.prepend(card); }
    else { card.dataset.testid = 'attachment-preview'; card.innerHTML = '<img alt="stale.png"><button aria-label="Remove attachment"></button>'; currentScope.prepend(card); }
    card.querySelector('button').addEventListener('click', () => { removals++; card.remove(); });
  };
  if (initialAttachment) attachment();
  const remountComposer = (draft = '') => {
    const replacement = currentScope.cloneNode(true); currentScope.replaceWith(replacement); currentScope = replacement;
    currentInput = dom.composer(doc); currentInput.textContent = draft; if (assistant === 'qwen') currentInput.value = draft; remounts++;
  };
  const geminiTemplate = assistant === 'gemini' ? doc.querySelector('.conversation-container').cloneNode(true) : null;
  const appendResponse = (question, final = false) => {
    const id = `lifecycle-${++rows}`; let complete;
    if (assistant === 'chatgpt') {
      const row = doc.createElement('div'); row.setAttribute('data-turn-key', id);
      row.innerHTML = `<div data-talvt-turn-state="streaming"><div data-chatgpt-search-unit-key="${id}:0:user" data-chatgpt-search-message-ids="${id}-user"><div data-user-message-bubble="true"></div></div><div data-chatgpt-search-unit-key="${id}:1:assistant" data-chatgpt-search-message-ids="${id}-assistant" data-is-streaming="true"><div data-markdown-text-style="assistant-message"><p>Final answer</p></div></div><div class="turn-action-controls"><button aria-label="复制">Copy</button></div></div>`;
      row.querySelector('[data-user-message-bubble]').textContent = question; doc.querySelector('main').append(row);
      complete = () => { row.querySelector('[data-is-streaming]').setAttribute('data-is-streaming', 'false'); row.querySelector('[data-talvt-turn-state]').setAttribute('data-talvt-turn-state', 'complete'); };
    } else if (assistant === 'claude') {
      const userRow = doc.createElement('div'); userRow.dataset.testid = 'transcript-row'; userRow.innerHTML = `<div data-testid="user-message" data-message-id="${id}-user"><p></p></div>`;
      userRow.querySelector('p').textContent = question;
      const answerRow = doc.createElement('div'); answerRow.dataset.testid = 'transcript-row'; answerRow.setAttribute('data-perf-row-streaming', 'true');
      answerRow.innerHTML = `<div data-testid="assistant-message" data-message-id="${id}-assistant" data-is-streaming="true"><div data-cds="Prose"><div data-perf-reply-text class="standard-markdown"><p>Final answer</p></div></div></div><div data-testid="message-actions" role="toolbar"><button data-testid="action-bar-copy">Copy</button><button data-testid="action-bar-retry">Retry</button></div>`;
      doc.querySelector('main').append(userRow, answerRow);
      complete = () => { answerRow.setAttribute('data-perf-row-streaming', 'false'); answerRow.querySelector('[data-is-streaming]').setAttribute('data-is-streaming', 'false'); };
    } else if (assistant === 'qwen') {
      qwenUser(doc, question, id + '-user'); const row = qwenAnswer(doc, '<p>Final answer</p>', id + '-answer'); row.setAttribute('aria-busy', 'true'); complete = () => row.removeAttribute('aria-busy');
    } else {
      const row = geminiTemplate.cloneNode(true); row.id = id; row.querySelector('.query-text').textContent = question;
      row.querySelector('.markdown-main-panel').innerHTML = '<p>Final answer</p>'; row.querySelector('.markdown-main-panel').setAttribute('aria-busy', 'true'); row.querySelector('.response-footer').classList.remove('complete');
      doc.querySelector('main').append(row);
      complete = () => { row.querySelector('.markdown-main-panel').setAttribute('aria-busy', 'false'); row.querySelector('.response-footer').classList.add('complete'); };
    }
    if (final) complete(); return complete;
  };
  const afterRemountAction = () => {
    if (action === 'human') { currentInput.textContent = 'Human replacement draft'; if (assistant === 'qwen') currentInput.value = 'Human replacement draft'; guards.get('input')?.({ type: 'input', isTrusted: true, target: currentInput }); }
    if (action === 'navigation') win.history.replaceState({}, '', assistant === 'gemini' ? '/app/different-conversation' : assistant === 'claude' ? '/chat/different-conversation' : '/c/different-conversation');
    if (action === 'second-user') appendResponse('A human follow-up', true);
  };
  originalInput.addEventListener('input', () => {
    if (remount === 'before-send') schedule(() => remountComposer('Human replacement draft'), 200);
    if (failFirst && !injected && dom.composerText(currentInput) === 'Question') { injected = true; attachment(); }
  });
  dom.sendButton(doc, originalInput).addEventListener('click', () => {
    clicks++; const question = dom.composerText(currentInput); currentInput.textContent = ''; if (assistant === 'qwen') currentInput.value = '';
    if (remount === 'on-submit') remountComposer();
    if (remount === 'while-confirming' || remount === 'temporary-gap') schedule(() => {
      if (remount === 'temporary-gap') {
        const previous = currentScope; const marker = doc.createComment('layout remount'); const replacement = previous.cloneNode(true); previous.replaceWith(marker);
        schedule(() => { marker.replaceWith(replacement); currentScope = replacement; currentInput = dom.composer(doc); remounts++; }, 500);
      } else remountComposer();
    }, 200);
    schedule(() => {
      const complete = appendResponse(question);
      schedule(complete, 1000);
    }, 1000);
    if (remount === 'while-generating') schedule(() => { remountComposer(); if (action) schedule(afterRemountAction, 100); }, 1200);
  });
  win.chrome = { runtime: {
    id: 'content-lifecycle-fixture', getURL: path => `chrome-extension://content-lifecycle-fixture/${path}`,
    onMessage: { addListener(listener) { listeners.push(listener); } },
    async sendMessage(message) {
      messages.push(message); let data = {};
      if (rpcDelays[message.type]) await new Promise(resolve => schedule(resolve, rpcDelays[message.type]));
      if (message.type === 'bridge:poll') data = { job: offered < queuedJobs ? { id: `lifecycle-job-${++offered}`, assistant, platform: 'qq', prompt: 'Question', conversationUrl: urls[assistant], timeoutMs, images: remount === 'input-image-fetch' ? [metadata] : [] } : null };
      if (message.type === 'bridge:error') failedState = { text: dom.composerText(currentInput), attachments: dom.hasAttachments(currentInput) };
      if (message.type === 'bridge:input-image') { remountComposer('Human replacement draft'); data = { imageId: metadata.id, mimeType: metadata.mimeType, name: metadata.name, base64: png.toString('base64') }; }
      return { ok: true, data };
    },
  } };
  win.eval(source); await flush();
  return {
    doc, originalInput, messages,
    get input() { return currentInput; }, get clicks() { return clicks; }, get remounts() { return remounts; }, get removals() { return removals; }, get failedState() { return failedState; },
    get result() { return messages.find(m => m.type === 'bridge:result'); }, get error() { return messages.find(m => m.type === 'bridge:error'); },
    wake() { listeners.forEach(listener => listener({ type: 'bridge:wake' }, { id: win.chrome.runtime.id, url: win.chrome.runtime.getURL('worker.js') })); },
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

for (const assistant of shared.ASSISTANTS) {
  test(`${assistant} clears existing text and native attachments only when a new task starts`, async () => {
    const x = await fixture(assistant, { initialDraft: 'Existing draft', initialAttachment: true });
    try {
      await x.advance(5000);
      assert.equal(x.error, undefined); assert.equal(x.result?.text, 'Final answer'); assert.equal(x.clicks, 1); assert.equal(x.removals, 1);
      assert.equal(adapters[assistant].composerText(x.input), ''); assert.equal(adapters[assistant].hasAttachments(x.input), false);
    } finally { x.close(); }
  });

  test(`${assistant} polling without a queued task leaves the draft and attachments untouched`, async () => {
    const x = await fixture(assistant, { initialDraft: 'Existing draft', initialAttachment: true, queuedJobs: 0 });
    try {
      x.wake(); await x.advance(5000);
      assert.equal(x.error, undefined); assert.equal(x.clicks, 0); assert.equal(x.removals, 0);
      assert.equal(adapters[assistant].composerText(x.input), 'Existing draft'); assert.equal(adapters[assistant].hasAttachments(x.input), true);
    } finally { x.close(); }
  });

  test(`${assistant} clears a failed task's text and attachment before running the next queued task`, async () => {
    const x = await fixture(assistant, { failFirst: true, queuedJobs: 2 });
    try {
      await x.advance(6000);
      assert.ok(x.error); assert.deepEqual(x.failedState, { text: '', attachments: false });
      assert.equal(x.removals, 1); assert.equal(x.clicks, 1); assert.equal(x.result?.text, 'Final answer');
      assert.equal(x.messages.filter(m => m.type === 'bridge:started').length, 2);
      assert.equal(x.messages.filter(m => m.type === 'bridge:error').length, 1);
      assert.equal(x.messages.filter(m => m.type === 'bridge:result').length, 1);
    } finally { x.close(); }
  });

  test(`${assistant} a slow but valid backend acknowledgement does not abort submission or misreport a delivered answer`, async () => {
    for (const type of ['bridge:started', 'bridge:result']) {
      const x = await fixture(assistant, { rpcDelays: { [type]: 18000 } });
      try {
        await x.advance(22000);
        assert.equal(x.error, undefined, `${type} should retain the worker's response budget`);
        assert.equal(x.result?.text, 'Final answer'); assert.equal(x.clicks, 1);
        assert.equal(x.messages.filter(m => m.type === 'bridge:started').length, 1);
        assert.equal(x.messages.filter(m => m.type === 'bridge:result').length, 1);
      } finally { x.close(); }
    }
  });

  test(`${assistant} late backend confirmations still respect the task deadline and bounded RPC timeout without submitting`, async () => {
    for (const [delay, timeoutMs] of [[18000, 10000], [70000, 90000]]) {
      const x = await fixture(assistant, { rpcDelays: { 'bridge:started': delay }, timeoutMs });
      try {
        await x.advance(delay + 1000);
        assert.match(x.error?.error || '', /超时/); assert.equal(x.clicks, 0); assert.equal(x.result, undefined);
        assert.equal(x.messages.filter(m => m.type === 'bridge:started').length, 1);
        assert.equal(x.messages.filter(m => m.type === 'bridge:error').length, 1);
      } finally { x.close(); }
    }
  });

  test(`${assistant} layout composer remounts after the only send click do not interrupt confirming or collecting the same answer`, async () => {
    for (const remount of ['on-submit', 'while-confirming', 'temporary-gap', 'while-generating']) {
      const x = await fixture(assistant, { remount });
      try {
        await x.advance(2200); assert.equal(x.error, undefined, remount); assert.equal(x.result, undefined, 'a streaming response must not be forwarded');
        assert.equal(x.originalInput.isConnected, false); assert.equal(x.remounts, 1); assert.equal(x.clicks, 1);
        x.wake(); await x.advance(1300);
        assert.equal(x.error, undefined, remount); assert.equal(x.result?.text, 'Final answer');
        assert.equal(x.messages.filter(m => m.type === 'bridge:started').length, 1); assert.equal(x.messages.filter(m => m.type === 'bridge:result').length, 1); assert.equal(x.clicks, 1);
      } finally { x.close(); }
    }
  });

  test(`${assistant} remounting the composer before send or during image retrieval still blocks submission and preserves the replacement draft`, async () => {
    for (const remount of ['before-send', 'input-image-fetch']) {
      const x = await fixture(assistant, { remount });
      try {
        await x.advance(1500); assert.equal(x.clicks, 0); assert.ok(x.error); assert.match(x.error.error, /输入框被替换|输入框发生变化/);
        assert.equal(adapters[assistant].composerText(x.input), 'Human replacement draft'); assert.equal(x.result, undefined);
        assert.equal(x.messages.filter(m => m.type === 'bridge:error').length, 1);
      } finally { x.close(); }
    }
  });

  test(`${assistant} composer remounts do not bypass trusted human edits, conversation navigation or new-user ownership checks`, async () => {
    for (const action of ['human', 'navigation', 'second-user']) {
      const x = await fixture(assistant, { remount: 'while-generating', action });
      try {
        await x.advance(3500); assert.equal(x.clicks, 1); assert.ok(x.error, action); assert.equal(x.result, undefined);
        assert.match(x.error.error, action === 'human' ? /人工操作/ : action === 'navigation' ? /切换了对话/ : /其他|新消息|混淆/);
        if (action === 'human') assert.equal(adapters[assistant].composerText(x.input), 'Human replacement draft');
        assert.equal(x.messages.filter(m => m.type === 'bridge:error').length, 1);
      } finally { x.close(); }
    }
  });
}
