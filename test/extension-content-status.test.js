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

const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
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
const urls = { qwen: qwenUrl, chatgpt: 'https://chatgpt.com/c/status-recovery-fixture', claude: 'https://claude.ai/chat/status-recovery-fixture', gemini: 'https://gemini.google.com/app/status-recovery-fixture' };
const adapters = { chatgpt, claude, gemini, qwen };
const flush = () => new Promise(resolve => setImmediate(resolve));

async function fixture(assistant, { blocked, rpcFailure = false, pollResponse = {} } = {}) {
  const page = new JSDOM(fixtures[assistant], { url: urls[assistant], runScripts: 'outside-only', pretendToBeVisual: true });
  const win = page.window; const doc = win.document; const dom = adapters[assistant]; const input = dom.composer(doc);
  const messages = []; const jobs = []; const listeners = []; const timers = new Map();
  let now = 1000; let serial = 0; let shadow; let clicks = 0; let rpcError = rpcFailure; let blocker = null; let placeholder = null; let idleResponse = pollResponse;
  const schedule = (fn, ms, repeat = 0) => { const id = ++serial; timers.set(id, { fn, at: now + ms, repeat }); return id; };
  const attach = win.Element.prototype.attachShadow;
  win.Element.prototype.attachShadow = function(options) { const result = attach.call(this, options); if (options.mode === 'closed') shadow = result; return result; };
  win.Date = class extends Date { static now() { return now; } };
  win.setTimeout = (fn, ms) => schedule(fn, ms); win.clearTimeout = id => timers.delete(id);
  win.setInterval = (fn, ms) => schedule(fn, ms, ms); win.clearInterval = id => timers.delete(id);
  win.__testQwen = qwen; win.__testShared = shared; win.__testChatGPT = chatgpt; win.__testClaude = claude; win.__testGemini = gemini;
  doc.execCommand = (command, _ui, text) => { assert.equal(command, 'insertText'); input.textContent = text; return true; };
  const setBlocked = value => {
    if (value === 'missing') { placeholder = doc.createComment('detached composer'); input.replaceWith(placeholder); }
    else if (value === 'draft') { input.textContent = 'Existing private draft'; if (assistant === 'qwen') input.value = 'Existing private draft'; }
    else if (value === 'busy') {
      if (assistant === 'qwen') {
        blocker = doc.createElement('button'); blocker.className = 'stop'; blocker.setAttribute('aria-label', '停止'); doc.querySelector('.message-input-right-button-send').append(blocker);
      } else if (assistant === 'gemini') {
        blocker = doc.createElement('gem-icon-button'); blocker.className = 'send-button stop'; blocker.innerHTML = '<button>Stop</button>';
        doc.querySelector('[data-test-id="send-button-container"]').append(blocker);
      } else {
        blocker = doc.createElement('button'); blocker.dataset.testid = assistant === 'claude' ? 'chat-input-stop' : 'stop-button';
        doc.body.append(blocker);
      }
    }
  };
  const recover = () => {
    if (placeholder) { placeholder.replaceWith(input); placeholder = null; }
    if (blocker) { blocker.remove(); blocker = null; }
    if (dom.composerText(input) === 'Existing private draft') { input.textContent = ''; if (assistant === 'qwen') input.value = ''; }
    rpcError = false;
  };
  const geminiRow = assistant === 'gemini' ? doc.querySelector('.conversation-container').cloneNode(true) : null;
  dom.sendButton(doc, input).addEventListener('click', () => {
    clicks++; const text = dom.composerText(input); input.textContent = ''; if (assistant === 'qwen') input.value = '';
    if (assistant === 'chatgpt') {
      doc.querySelector('main').insertAdjacentHTML('beforeend', `<div data-turn-key="status-${clicks}"><div data-talvt-turn-state="complete"><div data-chatgpt-search-unit-key="status-${clicks}:0:user" data-chatgpt-search-message-ids="status-${clicks}-user"><div data-user-message-bubble="true"></div></div><div data-chatgpt-search-unit-key="status-${clicks}:1:assistant" data-chatgpt-search-message-ids="status-${clicks}-assistant"><div data-markdown-text-style="assistant-message"><p>Final answer</p></div></div><div class="turn-action-controls"><button aria-label="复制">Copy</button></div></div></div>`);
      doc.querySelector(`[data-turn-key="status-${clicks}"] [data-user-message-bubble]`).textContent = text;
    } else if (assistant === 'claude') {
      doc.querySelector('main').insertAdjacentHTML('beforeend', `<div data-testid="transcript-row" data-perf-row="user"><div data-testid="user-message" data-message-id="status-user-${clicks}"><p></p></div></div><div data-testid="transcript-row" data-perf-row="assistant" data-perf-row-streaming="false"><div data-testid="assistant-message" data-message-id="status-assistant-${clicks}" data-is-streaming="false"><div data-cds="Prose"><div data-perf-reply-text class="standard-markdown"><p>Final answer</p></div></div></div><div data-testid="message-actions" role="toolbar"><button data-testid="action-bar-copy">Copy</button><button data-testid="action-bar-retry">Retry</button></div></div>`);
      dom.turns(doc, 'user').at(-1).querySelector('p').textContent = text;
    } else if (assistant === 'qwen') {
      qwenUser(doc, text, 'status-user-' + clicks); qwenAnswer(doc, '<p>Final answer</p>', 'status-answer-' + clicks);
    } else {
      const row = geminiRow.cloneNode(true); row.id = `status-turn-${clicks}`;
      row.querySelector('.query-text').textContent = text; row.querySelector('.markdown-main-panel').innerHTML = '<p>Final answer</p>';
      doc.querySelector('main').append(row);
    }
  });
  if (blocked) setBlocked(blocked);
  win.chrome = { runtime: {
    id: 'content-status-fixture', getURL: path => `chrome-extension://content-status-fixture/${path}`,
    onMessage: { addListener(listener) { listeners.push(listener); } },
    async sendMessage(message) {
      messages.push(message);
      if (message.type === 'bridge:poll' && rpcError) return { ok: false, error: 'Fixture backend unavailable' };
      return { ok: true, data: message.type === 'bridge:poll' ? { job: jobs.shift() || null, ...idleResponse } : {} };
    },
  } };
  win.eval(source); await flush();
  return {
    doc, input, messages, recover, setBlocked,
    setRpcFailure(value) { rpcError = value; },
    setPollResponse(value) { idleResponse = value; },
    get badge() { return shadow?.querySelector('span')?.textContent || ''; },
    get badgeConnected() { return shadow?.host.isConnected === true; },
    get clicks() { return clicks; },
    navigate(value) { win.history.replaceState({}, '', value); },
    enqueue(owner = assistant) { jobs.push({ id: 'status-job', assistant: owner, platform: 'qq', prompt: 'Question', conversationUrl: urls[assistant], timeoutMs: 90000, images: [] }); },
    wake() { for (const listener of listeners) listener({ type: 'bridge:wake' }, { id: win.chrome.runtime.id, url: win.chrome.runtime.getURL('worker.js') }); },
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
  for (const blocked of ['missing', 'busy']) test(`${assistant} clears its transient ${blocked} readiness warning after the composer recovers with no queued job`, async () => {
    const x = await fixture(assistant, { blocked });
    try {
      assert.match(x.badge, /等待网页就绪/); assert.deepEqual(x.messages.map(message => message.type), assistant === 'chatgpt' ? ['bridge:challenge-resume'] : []);
      const warning = x.badge;
      x.recover(); x.wake(); await flush();
      assert.equal(x.messages.filter(m => m.type === 'bridge:poll').length, 1);
      assert.notEqual(x.badge, warning, 'a successful idle poll must not leave an obsolete readiness failure visible');
      assert.equal(x.badge, `AIChat桥接 v${version} · 机器人 · 网页已就绪，暂无可执行任务`); assert.equal(x.clicks, 0);
    } finally { x.close(); }
  });

  test(`${assistant} clears a transient backend failure after a later successful idle poll`, async () => {
    const x = await fixture(assistant, { rpcFailure: true });
    try {
      assert.match(x.badge, /Fixture backend unavailable/);
      x.recover(); x.wake(); await flush();
      assert.equal(x.messages.filter(m => m.type === 'bridge:poll').length, 2);
      assert.equal(x.badge, `AIChat桥接 v${version} · 机器人 · 网页已就绪，暂无可执行任务`); assert.equal(x.clicks, 0);
    } finally { x.close(); }
  });

  test(`${assistant} a successful idle poll preserves the most recent completed task status`, async () => {
    const x = await fixture(assistant);
    try {
      x.enqueue(); x.wake(); await x.advance(2000);
      assert.equal(x.clicks, 1); assert.equal(x.messages.filter(m => m.type === 'bridge:result').length, 1);
      assert.match(x.badge, /本次回复已交给/); const terminal = x.badge;
      x.wake(); await flush(); await x.advance(4500);
      assert.equal(x.badge, terminal); assert.equal(x.clicks, 1);
    } finally { x.close(); }
  });

  test(`${assistant} a successful idle poll preserves the most recent task failure`, async () => {
    const x = await fixture(assistant);
    try {
      x.enqueue(assistant === 'chatgpt' ? 'claude' : 'chatgpt'); x.wake(); await flush();
      assert.match(x.badge, /任务助手与当前网页不一致/); const terminal = x.badge;
      assert.equal(x.messages.filter(m => m.type === 'bridge:error').length, 1);
      x.wake(); await flush(); await x.advance(4500);
      assert.equal(x.badge, terminal); assert.equal(x.clicks, 0);
    } finally { x.close(); }
  });

  test(`${assistant} fallback polling clears a recovered readiness warning without a manual wake`, async () => {
    const x = await fixture(assistant, { blocked: 'missing' });
    try {
      const warning = x.badge; x.recover();
      await x.advance(4499); assert.equal(x.badge, warning); assert.deepEqual(x.messages.map(message => message.type), assistant === 'chatgpt' ? ['bridge:challenge-resume'] : []);
      await x.advance(1);
      assert.equal(x.badge, `AIChat桥接 v${version} · 机器人 · 网页已就绪，暂无可执行任务`);
      assert.equal(x.messages.filter(m => m.type === 'bridge:poll').length, 1); assert.equal(x.clicks, 0);
    } finally { x.close(); }
  });

  test(`${assistant} backend busy is a distinct transient state that returns to idle only after confirmed recovery`, async () => {
    const x = await fixture(assistant, { pollResponse: { busy: true } });
    try {
      assert.equal(x.badge, `AIChat桥接 v${version} · 机器人 · 网页已就绪，后台任务仍在处理中`);
      x.wake(); await flush();
      assert.equal(x.badge, `AIChat桥接 v${version} · 机器人 · 网页已就绪，后台任务仍在处理中`);
      x.setPollResponse({}); x.wake(); await flush();
      assert.equal(x.badge, `AIChat桥接 v${version} · 机器人 · 网页已就绪，暂无可执行任务`);
      assert.equal(x.clicks, 0); assert.equal(x.messages.some(m => m.type === 'bridge:started'), false);
    } finally { x.close(); }
  });

  test(`${assistant} backend notices take priority over busy and persist across idle and temporary failures`, async () => {
    const x = await fixture(assistant, { pollResponse: { busy: true, notice: 'Fixture account configuration notice' } });
    try {
      const persistent = `AIChat桥接 v${version} · 机器人 · Fixture account configuration notice`;
      assert.equal(x.badge, persistent);
      x.setPollResponse({}); x.wake(); await flush(); assert.equal(x.badge, persistent);
      x.setBlocked('missing'); x.wake(); await flush(); assert.match(x.badge, /等待网页就绪/);
      x.recover(); x.wake(); await flush(); assert.equal(x.badge, persistent);
      x.setRpcFailure(true); x.wake(); await flush(); assert.match(x.badge, /Fixture backend unavailable/);
      x.recover(); x.wake(); await flush(); assert.equal(x.badge, persistent);
      assert.equal(x.clicks, 0);
    } finally { x.close(); }
  });

  test(`${assistant} completed and failed task statuses are restored after missing composer, RPC failure and backend busy`, async () => {
    for (const successful of [true, false]) {
      const x = await fixture(assistant);
      try {
        x.enqueue(successful ? assistant : assistant === 'chatgpt' ? 'claude' : 'chatgpt'); x.wake(); await x.advance(2000);
        assert.match(x.badge, successful ? /本次回复已交给/ : /任务助手与当前网页不一致/);
        const terminal = x.badge; const clicks = x.clicks;
        x.setBlocked('missing'); x.wake(); await flush(); assert.match(x.badge, /等待网页就绪/);
        x.recover(); x.wake(); await flush(); assert.equal(x.badge, terminal);
        x.setRpcFailure(true); x.wake(); await flush(); assert.match(x.badge, /Fixture backend unavailable/);
        x.recover(); x.wake(); await flush(); assert.equal(x.badge, terminal);
        x.setPollResponse({ busy: true }); x.wake(); await flush(); assert.match(x.badge, /网页已就绪，后台任务仍在处理中$/);
        x.setPollResponse({}); x.wake(); await flush(); assert.equal(x.badge, terminal);
        assert.equal(x.clicks, clicks); assert.equal(x.messages.filter(m => m.type === (successful ? 'bridge:result' : 'bridge:error')).length, 1);
      } finally { x.close(); }
    }
  });

  test(`${assistant} returning from the homepage remounts the badge and preserves the last idle, completed, failed or notice status`, async () => {
    for (const state of ['idle', 'completed', 'failed', 'notice']) {
      const x = await fixture(assistant, state === 'notice' ? { pollResponse: { notice: 'Fixture persistent notice' } } : {});
      try {
        if (state === 'completed' || state === 'failed') {
          x.enqueue(state === 'completed' ? assistant : assistant === 'chatgpt' ? 'claude' : 'chatgpt'); x.wake(); await x.advance(2000);
          assert.match(x.badge, state === 'completed' ? /本次回复已交给/ : /任务助手与当前网页不一致/);
        }
        x.setPollResponse({});
        assert.equal(x.badgeConnected, true); const text = x.badge; const clicks = x.clicks;
        const before = x.messages.length; const starts = x.messages.filter(m => m.type === 'bridge:started').length;
        x.navigate('/'); x.wake(); await flush();
        assert.equal(x.badgeConnected, false); assert.equal(x.messages.length, before, 'a homepage never polls for conversation work');
        x.navigate(urls[assistant]); x.wake(); await flush();
        assert.equal(x.badgeConnected, true, 'an idle successful poll must reattach a removed badge');
        assert.equal(x.badge, text); assert.equal(x.clicks, clicks);
        assert.equal(x.messages.length, before + 1); assert.equal(x.messages.at(-1).type, 'bridge:poll');
        assert.equal(x.messages.filter(m => m.type === 'bridge:started').length, starts);
      } finally { x.close(); }
    }
  });
}
