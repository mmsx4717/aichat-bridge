import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import * as gemini from '../extension/gemini-dom.js';
import * as qwen from '../extension/qwen-dom.js';
import * as shared from '../extension/shared.js';
import { composerHTML, user as qwenUser, answer as qwenAnswer } from './helpers/qwen-fixture.js';

const frameSource = await readFile(new URL('../extension/qwen-frame-scheduler.js', import.meta.url), 'utf8');
const geminiHTML = await readFile(new URL('./fixtures/gemini-conversation.html', import.meta.url), 'utf8');
const source = (await readFile(new URL('../extension/content.js', import.meta.url), 'utf8'))
  .replace("await import(chrome.runtime.getURL('gemini-dom.js'))", 'globalThis.__adapter')
  .replace("await import(chrome.runtime.getURL('qwen-dom.js'))", 'globalThis.__adapter')
  .replace("await import(chrome.runtime.getURL('shared.js'))", 'globalThis.__shared');
const flush = () => new Promise(resolve => setImmediate(resolve));

// Use each real adapter (including its completion gates), not ChatGPT's DOM
// with a different job label. Worker notifications advance waits while every
// page timer is deliberately held; no visibility/focus event is dispatched.
async function fixture(provider, change = () => {}, failObservation = false) {
  const adapter = provider === 'qwen' ? qwen : gemini;
  const url = provider === 'qwen' ? 'https://chat.qwen.ai/c/fixture-conversation' : 'https://gemini.google.com/app/1111111111111111';
  const html = provider === 'qwen' ? `<main><div id="chat-message-container"></div>${composerHTML}</main>` : geminiHTML;
  const { window: win } = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const doc = win.document, input = adapter.composer(doc), send = adapter.sendButton(doc, input);
  const listeners = [], messages = [], timers = new Map();
  let now = 1000, nextTimer = 0, clicks = 0, actionClicks = 0, leased = false, answer;
  Object.defineProperty(doc, 'visibilityState', { value: 'hidden' });
  Object.defineProperty(doc, 'hidden', { value: true });
  win.Date = class extends Date { static now() { return now; } };
  win.performance.now = () => now;
  win.setTimeout = win.setInterval = fn => { const id = ++nextTimer; timers.set(id, fn); return id; };
  win.clearTimeout = win.clearInterval = id => timers.delete(id);
  doc.execCommand = (command, _ui, text) => {
    assert.equal(command, 'insertText'); input.textContent = text;
    input.dispatchEvent(new win.InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    return true;
  };
  if (provider === 'qwen') {
    // JSDOM does not suspend native rAF when visibility is overridden. Model
    // the same paused frame queue as paused timers, independently of CPU load.
    const frames = new Map(); let frameId = 0;
    win.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
    win.cancelAnimationFrame = id => frames.delete(id);
    win.eval(frameSource);
  }
  win.__adapter = adapter; win.__shared = shared;
  const template = provider === 'gemini' ? doc.querySelector('.conversation-container').cloneNode(true) : null;
  send.addEventListener('click', () => {
    clicks++;
    const prompt = adapter.composerText(input);
    if (provider === 'qwen') {
      input.value = ''; qwenUser(doc, prompt);
      answer = qwenAnswer(doc, '<p>Background answer</p>');
    } else {
      input.textContent = '';
      const row = template.cloneNode(true); row.id = 'background-turn';
      row.querySelector('.query-text').textContent = prompt;
      row.querySelector('.markdown-main-panel').innerHTML = '<p>Background answer</p>';
      doc.querySelector('main').append(row); answer = row.querySelector('model-response');
    }
    // Hover-only response UI is hidden while the user is in another tab.
    const footer = answer.querySelector('.response-footer, .response-message-footer');
    footer.style.visibility = 'hidden';
    const actions = answer.querySelector('message-actions');
    if (actions) actions.style.visibility = 'hidden';
    answer.querySelectorAll('button').forEach(button => button.addEventListener('click', () => actionClicks++));
    change({ doc, answer, send, footer, provider });
  });
  win.chrome = { runtime: {
    id: 'background-fixture', getURL: path => `chrome-extension://background-fixture/${path}`,
    onMessage: { addListener(listener) { listeners.push(listener); } },
    async sendMessage(message) {
      messages.push(message);
      if (failObservation && message.type === 'bridge:qwen-observation') throw new Error('Diagnostic storage unavailable');
      let data = {};
      if (message.type === 'bridge:poll') {
        data = { job: leased ? null : { id: 'background-job', assistant: provider, platform: 'qq', conversationUrl: url, prompt: 'Background question', timeoutMs: 90000, images: [] } };
        leased = true;
      }
      return { ok: true, data };
    },
  } };
  win.eval(source); await flush();
  return {
    doc, messages, get answer() { return answer; }, get clicks() { return clicks; }, get actionClicks() { return actionClicks; },
    get result() { return messages.find(message => message.type === 'bridge:result'); },
    get error() { return messages.find(message => message.type === 'bridge:error'); },
    async pulse(ms = 1000, count = 1) {
      now += ms;
      for (let i = 0; i < count; i++) for (const listener of listeners) listener({ type: 'bridge:wake' }, { id: win.chrome.runtime.id, url: win.chrome.runtime.getURL('worker.js') });
      await flush();
    },
    close() { timers.clear(); win.close(); },
  };
}

for (const provider of ['qwen', 'gemini']) {
  test(`${provider}: hidden hover controls and suspended page timers do not block one background result`, async () => {
    const x = await fixture(provider);
    try {
      for (let i = 0; i < 6; i++) await x.pulse(1000, 5);
      assert.equal(x.error, undefined); assert.equal(x.clicks, 1);
      assert.equal(x.result?.text, 'Background answer');
      assert.equal(x.result.timing.background, true);
      assert.equal(x.messages.filter(message => message.type === 'bridge:result').length, 1);
      assert.equal(x.actionClicks, 0); assert.equal(x.doc.visibilityState, 'hidden');
    } finally { x.close(); }
  });

  for (const gate of ['busy', 'missing-action', 'disabled-action', 'disabled-parent', 'duplicate-action', 'duplicate-footer', 'hidden-attribute', 'aria-hidden', 'inert', 'display-none', 'hidden-body', 'wrong-owner']) {
    test(`${provider}: background completion still rejects ${gate}`, async () => {
      const x = await fixture(provider, ({ doc, answer, send, footer }) => {
        const action = answer.querySelector(provider === 'qwen' ? 'button[class$="-regenerate"]' : 'regenerate-button button');
        if (gate === 'busy') {
          if (provider === 'qwen') send.querySelector('use').setAttribute('xlink:href', '#stop');
          else answer.querySelector('.markdown-main-panel').setAttribute('aria-busy', 'true');
        }
        if (gate === 'missing-action') action.remove();
        if (gate === 'disabled-action') action.disabled = true;
        if (gate === 'disabled-parent') {
          const fieldset = doc.createElement('fieldset'); fieldset.disabled = true;
          action.before(fieldset); fieldset.append(action);
        }
        if (gate === 'duplicate-action') action.after(action.cloneNode(true));
        if (gate === 'duplicate-footer') footer.after(footer.cloneNode(true));
        if (gate === 'hidden-attribute') footer.hidden = true;
        if (gate === 'aria-hidden') footer.setAttribute('aria-hidden', 'true');
        if (gate === 'inert') footer.setAttribute('inert', '');
        if (gate === 'display-none') footer.style.display = 'none';
        if (gate === 'hidden-body') answer.style.visibility = 'hidden';
        if (gate === 'wrong-owner') {
          if (provider === 'qwen') footer.querySelector('[data-msg-id]').dataset.chatId = 'other-conversation';
          else doc.querySelector('main').append(answer);
        }
      });
      try {
        for (let i = 0; i < 6; i++) await x.pulse();
        assert.equal(x.result, undefined); assert.equal(x.clicks, 1); assert.equal(x.actionClicks, 0);
        await x.pulse(90000);
        assert.equal(x.result, undefined); assert.ok(x.error);
      } finally { x.close(); }
    });
  }

  test(`${provider}: a late completed DOM is forwarded on a worker pulse without activating the tab`, async () => {
    const x = await fixture(provider, ({ answer }) => answer.querySelector(provider === 'qwen' ? '.response-message-footer' : '.response-footer').style.display = 'none');
    try {
      for (let i = 0; i < 6; i++) await x.pulse();
      assert.equal(x.result, undefined);
      x.answer.querySelector('.response-message-footer, .response-footer').style.removeProperty('display');
      await flush(); await x.pulse();
      assert.equal(x.result?.text, 'Background answer'); assert.equal(x.clicks, 1); assert.equal(x.actionClicks, 0);
    } finally { x.close(); }
  });
}

for (const failObservation of [false, true]) {
  test(`Qwen passive diagnostics do not affect single background completion, diagnostic failure=${failObservation}`, async () => {
    const x = await fixture('qwen', () => {}, failObservation);
    try {
      for (let i = 0; i < 6; i++) await x.pulse();
      const reports = x.messages.filter(message => message.type === 'bridge:qwen-observation');
      assert.ok(reports.length > 0);
      for (const report of reports) {
        assert.ok(report.samples.every(sample => sample.hidden && Object.entries(sample).every(([key, value]) => key === 'phase' ? ['prepare', 'submit', 'answer', 'delivery'].includes(value) : ['boolean', 'number'].includes(typeof value))));
        assert.doesNotMatch(JSON.stringify(report.samples), /Background answer|Background question/);
      }
      assert.equal(x.result?.text, 'Background answer'); assert.equal(x.error, undefined);
      assert.equal(x.result.observation.at(-1).phase, 'delivery');
      assert.equal(x.result.observation[0].phase, 'prepare');
      assert.equal(x.clicks, 1); assert.equal(x.actionClicks, 0); assert.equal(x.doc.visibilityState, 'hidden');
      assert.equal(x.messages.filter(message => message.type === 'bridge:result').length, 1);
    } finally { x.close(); }
  });
}

test('Qwen records a completed answer while prompt rendering still delays ownership confirmation', async () => {
  const x = await fixture('qwen', ({ doc }) => {
    doc.querySelector('.user-message-content').textContent = 'Back';
  });
  try {
    await x.pulse(); await x.pulse();
    for (let i = 0; i < 6; i++) await x.pulse(5000);
    assert.equal(x.result, undefined); assert.equal(x.error, undefined);
    const latest = x.messages.filter(message => message.type === 'bridge:qwen-observation').at(-1).samples.at(-1);
    assert.equal(latest.phase, 'submit'); assert.equal(latest.hidden, true);
    assert.equal(latest.bodyChars, 'Background answer'.length);
    assert.equal(latest.complete, true); assert.equal(latest.candidate, false);
    x.doc.querySelector('.user-message-content').textContent = 'Background question';
    await flush(); await x.pulse(); await x.pulse();
    assert.equal(x.result?.text, 'Background answer'); assert.equal(x.clicks, 1);
    assert.ok(x.result.observation.some(s => s.phase === 'submit'));
    assert.equal(x.result.observation.at(-1).phase, 'delivery');
  } finally { x.close(); }
});

test('Qwen background frame assistance renders the prompt and footer before normal ownership/completion checks', async () => {
  const x = await fixture('qwen', ({ doc, answer }) => {
    const prompt = doc.querySelector('.user-message-content');
    const expected = prompt.textContent; prompt.textContent = '';
    const footer = answer.querySelector('.response-message-footer'); footer.remove();
    doc.defaultView.requestAnimationFrame(() => { prompt.textContent = expected; answer.append(footer); });
  });
  try {
    for (let i = 0; i < 7; i++) await x.pulse();
    assert.equal(x.result?.text, 'Background answer'); assert.equal(x.error, undefined);
    assert.equal(x.doc.visibilityState, 'hidden'); assert.equal(x.clicks, 1); assert.equal(x.actionClicks, 0);
    assert.ok(x.result.observation.at(-1).frameResumed >= 1);
    let after = 0; x.doc.defaultView.requestAnimationFrame(() => after++);
    for (let i = 0; i < 3; i++) await x.pulse();
    assert.equal(after, 0, 'frame assistance ends with the job');
  } finally { x.close(); }
});
