import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import * as shared from '../extension/shared.js';
import { validateInputImages } from '../extension/dom.js';

const source = (await readFile(new URL('../extension/content.js', import.meta.url), 'utf8'))
  .replace("await import(chrome.runtime.getURL('dom.js'))", 'globalThis.__testAdapter')
  .replace("await import(chrome.runtime.getURL('claude-dom.js'))", 'globalThis.__testAdapter')
  .replace("await import(chrome.runtime.getURL('gemini-dom.js'))", 'globalThis.__testAdapter')
  .replace("await import(chrome.runtime.getURL('qwen-dom.js'))", 'globalThis.__testAdapter')
  .replace("await import(chrome.runtime.getURL('shared.js'))", 'globalThis.__testShared');
const urls = { qwen: 'https://chat.qwen.ai/c/input-progress-fixture', chatgpt: 'https://chatgpt.com/c/input-progress-fixture', claude: 'https://claude.ai/chat/input-progress-fixture', gemini: 'https://gemini.google.com/app/input-progress-fixture' };
const flush = () => new Promise(resolve => setImmediate(resolve));
const metadata = { id: '1'.repeat(64), mimeType: 'image/png', name: 'source.png', bytes: 11 };
const image = { imageId: metadata.id, mimeType: metadata.mimeType, name: metadata.name, base64: 'iVBORw0KGgoBAgM=' };

// This fixture isolates the shared input orchestration from each provider's
// separately tested upload implementation. Attachment readiness is controlled
// explicitly so progress must track actual validation, not elapsed time.
async function fixture(assistant, { native = ['claude', 'qwen'].includes(assistant), failAttach = false } = {}) {
  const page = new JSDOM('<main></main><div contenteditable="true"></div><button>Send</button>', { url: urls[assistant], runScripts: 'outside-only', pretendToBeVisual: true });
  const win = page.window; const doc = win.document; const input = doc.querySelector('[contenteditable]'); const button = doc.querySelector('button');
  const messages = []; const statuses = []; const calls = []; const timers = new Map();
  let now = 1000; let serial = 0; let clicks = 0; let shadow; let received = false; let releaseImage; let state = { ready: false, reason: 'no-attachment' };
  const schedule = (fn, ms, repeat = 0) => { const id = ++serial; timers.set(id, { fn, at: now + ms, repeat }); return id; };
  const attach = win.Element.prototype.attachShadow;
  win.Element.prototype.attachShadow = function(options) { shadow = attach.call(this, options); return shadow; };
  const textContent = Object.getOwnPropertyDescriptor(win.Node.prototype, 'textContent');
  Object.defineProperty(win.Node.prototype, 'textContent', { ...textContent, set(value) { if (this.tagName === 'SPAN' && this.getRootNode() === shadow) statuses.push(String(value)); textContent.set.call(this, value); } });
  const badge = () => shadow?.querySelector('span')?.textContent || '';
  win.Date = class extends Date { static now() { return now; } };
  win.setTimeout = (fn, ms) => schedule(fn, ms); win.clearTimeout = id => timers.delete(id);
  win.setInterval = (fn, ms) => schedule(fn, ms, ms); win.clearInterval = id => timers.delete(id);
  const addImage = route => (document, editor, payload, name) => {
    assert.equal(document, doc); assert.equal(editor, input); assert.deepEqual(payload, image);
    assert.match(name, /^bridge-.+-1\.png$/); calls.push({ route, badge: badge() });
    if (failAttach) throw new Error('Fixture file input unavailable');
  };
  win.__testShared = shared;
  win.__testAdapter = {
    MAX_TOTAL_IMAGE_BYTES: 30 * 1024 * 1024, validateInputImages,
    composer: () => input, composerText: editor => editor.textContent,
    hasAttachments: () => false,
    clearDraft: (_doc, editor) => { editor.textContent = ''; },
    composerInteraction: target => target === input, assertReady: () => input,
    snapshot: () => ({}), newUsers: () => [], generating: () => false,
    inputAttachmentState: (_input, names) => names.length ? state : { ready: true },
    pasteInputImage: addImage('paste'),
    ...(native ? { attachInputImage: addImage('native') } : {}),
    insertPrompt: (_doc, editor, prompt) => { editor.textContent = prompt; },
    sendButton: () => button,
    findSubmittedUser: () => clicks ? input : null,
    finalCandidate: () => clicks ? { text: 'Final answer', images: [] } : null,
  };
  button.addEventListener('click', () => { clicks++; input.textContent = ''; });
  win.chrome = { runtime: {
    id: 'input-progress-fixture', getURL: path => `chrome-extension://input-progress-fixture/${path}`,
    onMessage: { addListener() {} },
    async sendMessage(message) {
      messages.push(message);
      if (message.type === 'bridge:poll') {
        const job = received ? null : { id: 'input-progress-job', assistant, platform: 'qq', prompt: 'Question', conversationUrl: urls[assistant], timeoutMs: 90000, images: [metadata] };
        received = true; return { ok: true, data: { job } };
      }
      if (message.type === 'bridge:input-image') return await new Promise(resolve => { releaseImage = () => resolve({ ok: true, data: image }); });
      return { ok: true, data: {} };
    },
  } };
  win.eval(source); await flush();
  return {
    messages, statuses, calls,
    get badge() { return badge(); }, get clicks() { return clicks; },
    get result() { return messages.find(message => message.type === 'bridge:result'); },
    get error() { return messages.find(message => message.type === 'bridge:error'); },
    async releaseImage() { releaseImage(); await flush(); },
    setState(value) { state = value; },
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
  test(`${assistant} input progress follows reading, provider addition and each attachment validation stage before one send`, async () => {
    const x = await fixture(assistant); const label = shared.ASSISTANT_NAMES[assistant];
    try {
      assert.match(x.badge, /正在读取群消息图片 1\/1$/); assert.equal(x.calls.length, 0); assert.equal(x.clicks, 0);
      await x.releaseImage();
      assert.deepEqual(x.calls.map(call => call.route), [['claude', 'qwen'].includes(assistant) ? 'native' : 'paste']);
      assert.ok(x.calls[0].badge.endsWith(`正在向 ${label} 添加图片 1/1`));
      assert.ok(x.badge.endsWith(`等待 ${label} 确认图片 1/1：等待附件出现`));
      const unchanged = x.statuses.length; await x.advance(400); assert.equal(x.statuses.length, unchanged, 'unchanged verification reason must not rewrite the badge');
      for (const [reason, detail] of [['uploading', '等待上传完成'], ['verifying', '核对图片内容'], ['name-mismatch', '确认附件身份']]) {
        x.setState({ ready: false, reason }); await x.advance(200);
        assert.ok(x.badge.endsWith(`等待 ${label} 确认图片 1/1：${detail}`));
        assert.equal(x.clicks, 0); assert.equal(x.result, undefined);
      }
      x.setState({ ready: true }); await x.advance(2000);
      assert.equal(x.error, undefined); assert.equal(x.result?.text, 'Final answer'); assert.equal(x.clicks, 1);
      assert.equal(x.calls.length, 1); assert.equal(x.messages.filter(message => message.type === 'bridge:result').length, 1);
    } finally { x.close(); }
  });
}

test('Claude file addition timeout reports missing webpage confirmation without retrying paste or sending', async () => {
  const x = await fixture('claude');
  try {
    await x.releaseImage(); await x.advance(60000);
    assert.equal(x.clicks, 0); assert.equal(x.result, undefined); assert.equal(x.calls.length, 1);
    assert.deepEqual(x.calls.map(call => call.route), ['native']);
    assert.match(x.error?.error, /Claude 未显示本次图片附件，文件添加尚未获得网页确认/);
    assert.doesNotMatch(x.error.error, /模拟粘贴/);
  } finally { x.close(); }
});

test('a failed native image addition stops without falling back to paste or sending', async () => {
  const x = await fixture('claude', { failAttach: true });
  try {
    await x.releaseImage(); await x.advance(1000);
    assert.deepEqual(x.calls.map(call => call.route), ['native']);
    assert.match(x.error?.error, /Fixture file input unavailable/);
    assert.equal(x.clicks, 0); assert.equal(x.result, undefined);
  } finally { x.close(); }
});
