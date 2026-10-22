import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ASSISTANTS } from '../extension/shared.js';
import { BridgeStore as QQStore } from '../extension/qq-store.js';
const url = 'https://chatgpt.com/c/abcdefgh-1234';
const sessionId = 'session_123456789';
const cancellableJobId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const tick = () => new Promise(resolve => setImmediate(resolve));
let counter = 0;
let activeWorker;
after(() => activeWorker?.stopPageWakePulse());
function event() { return { listeners: [], addListener(fn) { this.listeners.push(fn); } }; }
async function setup({ store, request, contextPresent = false, createHost, platform = 'qq', assistant = 'chatgpt', sendTabMessage, initialStatus, dual = false } = {}) {
  activeWorker?.stopPageWakePulse();
  store ||= { browserId: 'browser-one' };
  const tab = { id: 7, windowId: 1, active: false, autoDiscardable: true, url, title: 'Test conversation' };
  const calls = [];
  const startupCalls = [];
  let initializing = true;
  const activePlatforms = Object.fromEntries(ASSISTANTS.map(id => [id, id === assistant ? platform : 'qq']));
  const enabled = Object.fromEntries(ASSISTANTS.map(id => [id, id === 'chatgpt' || id === assistant]));
  const testUrl = ({ chatgpt: url, claude: 'https://claude.ai/chat/claude-fixture-1234', gemini: 'https://gemini.google.com/app/gemini-fixture-1234', qwen:'https://chat.qwen.ai/c/qwen-fixture-1234' })[assistant];
  tab.url = testUrl;
  const hostCreates = [];
  const contextChecks = [];
  const fetchCalls = [];
  const alarms = [];
  const tabMessages = [];
  const tabUpdates = [];
  const otherTabs = new Map();
  const chrome = {
    storage: { local: {
      async setAccessLevel(value) { store.access = value.accessLevel; },
      async get(keys) { return structuredClone(keys === null ? store : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in store).map(k => [k, store[k]]))); },
      async set(values) { Object.assign(store, structuredClone(values)); },
      async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k]; },
    } },
    alarms: { async create(name, options) { alarms.push({ name, options }); }, onAlarm: event() },
    tabs: {
      async get(id) { if (id === tab.id) return { ...tab }; if (otherTabs.has(id)) return { ...otherTabs.get(id) }; throw new Error('No tab'); },
      async query() { return [{ ...tab }, ...otherTabs.values()]; },
      async update(id, properties) {
        const target = id === tab.id ? tab : otherTabs.get(id);
        if (!target) throw new Error('No tab');
        tabUpdates.push({ tabId: id, properties: structuredClone(properties) });
        if (properties.active) for (const other of [tab, ...otherTabs.values()]) if (other.windowId === target.windowId) other.active = false;
        Object.assign(target, properties); return { ...target };
      },
      async sendMessage(tabId, message, options) { tabMessages.push({ tabId, message: structuredClone(message), options: structuredClone(options) }); return sendTabMessage?.(tabId, message, options); },
      onRemoved: event(), onUpdated: event(),
    },
    runtime: {
      id: 'extension-id', getURL: path => 'chrome-extension://extension-id/' + path,
      async getContexts(query) {
        contextChecks.push(query);
        return contextPresent ? [{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: chrome.runtime.getURL('offscreen.html') }] : [];
      },
      async sendMessage(message) {
        assert.equal(message.target, 'bridge-host');
        const path = message.route;
        const body = structuredClone(message.body);
        const startupStatus = initializing && path === '/v1/status';
        (startupStatus ? startupCalls : calls).push({ path, body, message: structuredClone(message) });
        const owner = body?.assistant || 'chatgpt';
        let active = activePlatforms[owner];
        if (!dual && !['/v1/status', '/v1/platform', '/v1/assistant'].includes(path) && body?.platform !== active) return { ok: false, status: 409, error: 'Platform mismatch' };
        // Bootstrap sees a stable initial queue, independently from request
        // failures/delays that a test introduces after setup has completed.
        let result = startupStatus ? initialStatus?.(body) : request ? await request(path, body, calls) : undefined;
        if (result?.malformed) return { ok: true };
        if (result && Object.hasOwn(result, 'envelope')) return result.envelope;
        if (result === undefined) {
          if (path === '/v1/poll') result = { job: { id: 'job-1', platform: dual ? body.platform : active, leaseToken: 'lease-secret', prompt: 'Hello', conversationUrl: body.conversationUrl, timeoutMs: 600000 } };
          else if (path === '/v1/status') result = { configured: false, appId: '', platform: active, connection: { state: 'stopped' }, groups: [], jobs: [], delivery: [] };
          else if (path === '/v1/channel') { result = { ok: true, platform: body.platform, enabled: body.enabled }; }
          else if (path === '/v1/assistant') { enabled[owner] = body.enabled; result = { ok: true, assistant: owner, enabled: body.enabled }; }
          else if (path === '/v1/platform') { active = activePlatforms[owner] = body.platform; result = { ok: true, platform: active }; }
          else if (path === '/v1/moderation' && !Object.hasOwn(body, 'words')) result = { valid: true, words: ['色情', 'porn'] };
          else result = { ok: true };
        }
        const data = result && Object.hasOwn(result, 'body') ? result.body : result;
        if (path === '/v1/status' && data && !data.status) { if (!Object.hasOwn(data, 'assistant')) data.assistant = owner; if (!Object.hasOwn(data, 'enabled')) data.enabled = enabled[owner]; }
        if (path === '/v1/poll' && data?.job && typeof data.job === 'object' && !Object.hasOwn(data.job, 'assistant')) data.job.assistant = owner;
        if (result?.status >= 400) return { ok: false, status: result.status, error: result.body?.error || result.error || 'Synthetic host failure' };
        return { ok: true, data: result && Object.hasOwn(result, 'body') ? result.body : result };
      },
      async openOptionsPage() {}, onMessage: event(), onInstalled: event(), onStartup: event(),
    },
    offscreen: { async createDocument(options) {
      hostCreates.push(options);
      if (createHost) await createHost(options);
      contextPresent = true;
    } },
    action: { onClicked: event() },
  };
  globalThis.chrome = chrome;
  globalThis.fetch = async (...args) => { fetchCalls.push(args); throw new Error('Service worker must not use network transport'); };
  activeWorker = await import(`../extension/worker.js?isolated=${++counter}`); await tick(); await tick();
  await flushWakes();
  initializing = false;
  const sender = { id: chrome.runtime.id, frameId: 0, url: testUrl, tab: { ...tab } };
  const optionsSender = { id: chrome.runtime.id, url: chrome.runtime.getURL('options.html') };
  const send = (message, who = sender) => new Promise(resolve => {
    const keepOpen = chrome.runtime.onMessage.listeners[0]({ sessionId, conversationUrl: testUrl, ...message }, who, resolve);
    if (!keepOpen) resolve(undefined);
  }).then(async reply => {
    if (['options:bind', 'options:platform', 'options:assistant', 'options:cancel-job'].includes(message.type) && reply?.ok) { await new Promise(resolve => setTimeout(resolve, 0)); for (let i = 0; i < 6; i++) await tick(); }
    return reply;
  });
  const alarm = async () => { chrome.alarms.onAlarm.listeners[0]({ name: 'bot-bridge-maintenance' }); for (let i = 0; i < 12; i++) await tick(); };
  const startup = async () => { chrome.runtime.onStartup.listeners[0](); for (let i = 0; i < 12; i++) await tick(); };
  return { store, tab, chrome, sender, optionsSender, send, alarm, startup, tabMessages, tabUpdates, otherTabs, calls, startupCalls, hostCreates, contextChecks, fetchCalls, alarms, setHostPresent(value) { contextPresent = value; } };
}
test('worker authenticates sender, keeps credentials out of content and uses actual tab identity', async () => {
  const x = await setup();
  assert.equal(x.store.access, 'TRUSTED_CONTEXTS');
  const denied = await x.send({ platform: 'qq', type: 'options:config', appId: 'x', appSecret: 'x' }); assert.equal(denied.ok, false); assert.equal(x.calls.length, 0);
  const poll = await x.send({ type: 'bridge:poll', tabId: 999, browserId: 'spoof' });
  assert.equal(poll.ok, true); assert.equal(poll.data.job.prompt, 'Hello');
  assert.equal('leaseToken' in poll.data.job, false); assert.equal('token' in poll.data.job, false);
  assert.deepEqual(x.calls.find(call => call.path === '/v1/poll').body, { assistant: 'chatgpt', platform: 'qq', browserId: 'browser-one', tabId: 7, conversationUrl: url, capabilities: [] });
  x.tab.url = 'https://chatgpt.com/c/different-1234';
  assert.equal((await x.send({ type: 'bridge:started', jobId: 'job-1' })).ok, false);
  assert.equal(x.calls.filter(c => c.path.endsWith('/started')).length, 0);
});
test('MV3 worker restart preserves lease and never repeats started acknowledgement', async () => {
  let x = await setup(); await x.send({ type: 'bridge:poll' });
  x = await setup({ store: x.store });
  assert.equal((await x.send({ type: 'bridge:started', jobId: 'job-1' })).ok, true);
  assert.equal((await x.send({ type: 'bridge:started', jobId: 'job-1' })).ok, false);
  assert.equal(x.calls.filter(c => c.path.endsWith('/started')).length, 1);
});
test('page reload fails the outstanding job instead of resending the prompt', async () => {
  const x = await setup(); await x.send({ type: 'bridge:poll' }); await x.send({ type: 'bridge:started', jobId: 'job-1' });
  const response = await x.send({ type: 'bridge:poll', sessionId: 'new_page_session_1234' });
  assert.equal(response.data.job, null); assert.equal(x.store['bot.bridge.job.7'], undefined);
  assert.equal(x.calls.filter(c => c.path === '/v1/poll').length, 1); assert.equal(x.calls.filter(c => c.path.endsWith('/error')).length, 1);
});

const recoveryCheckpoint = { userKey: 'message:current-user', prompt: 'Hello', imageSources: [] };
test('explicit ChatGPT challenge recovery survives worker/page reload and permits only one retry on the original lease', async () => {
  let x = await setup(); await x.send({ type: 'bridge:poll' }); await x.send({ type: 'bridge:started', jobId: 'job-1' });
  const deadline = x.store['bot.bridge.job.7'].expiresAt;
  assert.equal((await x.send({ type: 'bridge:challenge-prepare', jobId: 'job-1', checkpoint: recoveryCheckpoint })).ok, true);
  assert.equal((await x.send({ type: 'bridge:challenge-prepare', jobId: 'job-1', checkpoint: recoveryCheckpoint })).ok, false);
  assert.equal((await x.send({ type: 'bridge:challenge-resume' })).data.job, null);
  x = await setup({ store: x.store });
  const resumedSession = 'reloaded_session_123';
  const resumed = await x.send({ type: 'bridge:challenge-resume', sessionId: resumedSession });
  assert.equal(resumed.ok, true); assert.deepEqual(resumed.data.job.recovery, recoveryCheckpoint);
  assert.doesNotMatch(JSON.stringify(resumed.data), /lease-secret|browser-one/);
  assert.equal(x.store['bot.bridge.job.7'].expiresAt, deadline);
  assert.ok(resumed.data.job.timeoutMs <= deadline - Date.now() + 10);
  assert.equal((await x.send({ type: 'bridge:challenge-retry', jobId: 'job-1' })).ok, false);
  assert.equal((await x.send({ type: 'bridge:challenge-retry', jobId: 'job-1', sessionId: resumedSession })).ok, true);
  assert.equal((await x.send({ type: 'bridge:challenge-retry', jobId: 'job-1', sessionId: resumedSession })).ok, false);
  assert.equal((await x.send({ type: 'bridge:result', jobId: 'job-1', sessionId: resumedSession, text: 'Recovered answer' })).ok, true);
  assert.equal(x.calls.filter(call => call.path.endsWith('/started') || call.path === '/v1/poll').length, 0);
  assert.equal(x.calls.filter(call => call.path.endsWith('/result')).length, 1);
});
test('challenge recovery rejects changed prompts, expired leases, other providers and foreign senders', async () => {
  for (const assistant of ['chatgpt', 'claude', 'gemini', 'qwen']) {
    const x = await setup({ assistant }); await x.send({ type: 'bridge:poll' });
    assert.equal((await x.send({ type: 'bridge:challenge-prepare', jobId: 'job-1', checkpoint: recoveryCheckpoint })).ok, false);
    await x.send({ type: 'bridge:started', jobId: 'job-1' });
    assert.equal((await x.send({ type: 'bridge:challenge-prepare', jobId: 'job-1', checkpoint: { ...recoveryCheckpoint, prompt: 'Changed' } })).ok, false);
    if (assistant !== 'chatgpt') {
      assert.equal((await x.send({ type: 'bridge:challenge-prepare', jobId: 'job-1', checkpoint: recoveryCheckpoint })).ok, false);
      assert.equal((await x.send({ type: 'bridge:challenge-resume' })).ok, false);
    }
    assert.equal((await x.send({ type: 'bridge:challenge-prepare', jobId: 'job-1', checkpoint: recoveryCheckpoint }, { ...x.sender, frameId: 1 })).ok, false);
    x.store['bot.bridge.job.7'].expiresAt = Date.now();
    assert.equal((await x.send({ type: 'bridge:challenge-prepare', jobId: 'job-1', checkpoint: recoveryCheckpoint })).ok, false);
    assert.equal(x.store['bot.bridge.job.7'].challengeRecovery, undefined);
  }
});
test('second page reload after challenge retry is terminal instead of retrying generation again', async () => {
  const x = await setup(); await x.send({ type: 'bridge:poll' }); await x.send({ type: 'bridge:started', jobId: 'job-1' });
  await x.send({ type: 'bridge:challenge-prepare', jobId: 'job-1', checkpoint: recoveryCheckpoint });
  await x.send({ type: 'bridge:challenge-resume', sessionId: 'reloaded_session_123' });
  await x.send({ type: 'bridge:challenge-retry', jobId: 'job-1', sessionId: 'reloaded_session_123' });
  const again = await x.send({ type: 'bridge:challenge-resume', sessionId: 'second_reload_session_123' });
  assert.equal(again.data.job, null); assert.equal(x.store['bot.bridge.job.7'], undefined);
  assert.equal(x.calls.filter(call => call.path.endsWith('/error')).length, 1);
  assert.equal(x.calls.filter(call => call.path === '/v1/poll').length, 1);
});
test('a lease arriving after the page 15-second timeout is recovered without a second backend poll or duplicate start', async t => {
  let finishLease;
  const x = await setup({ request: path => path === '/v1/poll' ? new Promise(resolve => { finishLease = resolve; }) : undefined });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const delayedReply = x.send({ type: 'bridge:poll' });
  while (!finishLease) await tick();
  const abandoned = Promise.race([delayedReply, new Promise(resolve => setTimeout(() => resolve('page-timeout'), 15000))]);
  t.mock.timers.tick(15000);
  assert.equal(await abandoned, 'page-timeout');
  t.mock.timers.tick(3000);
  finishLease({ job: { id: 'late-job', platform: 'qq', leaseToken: 'late-secret', prompt: 'Delayed prompt', conversationUrl: url, timeoutMs: 120000 } });
  const original = (await delayedReply).data.job;
  const deadline = x.store['bot.bridge.job.7'].expiresAt;
  t.mock.timers.tick(4500);
  const recovered = (await x.send({ type: 'bridge:poll' })).data.job;
  assert.deepEqual(recovered, { ...original, timeoutMs: 115500 });
  assert.equal(x.store['bot.bridge.job.7'].expiresAt, deadline);
  assert.equal(x.store['bot.bridge.job.7'].leaseToken, 'late-secret');
  assert.equal(x.calls.filter(call => call.path === '/v1/poll').length, 1);
  assert.doesNotMatch(JSON.stringify(recovered), /late-secret|browser-one|session_123456789/);
  assert.equal((await x.send({ type: 'bridge:started', jobId: 'late-job' })).ok, true);
  assert.equal(x.store['bot.bridge.job.7'].prompt, undefined);
  assert.equal((await x.send({ type: 'bridge:poll' })).data.job, null);
  assert.equal((await x.send({ type: 'bridge:started', jobId: 'late-job' })).ok, false);
  assert.equal(x.calls.filter(call => call.path.endsWith('/started')).length, 1);
});

test('recovering a lease requires its original browser, tab, page session and conversation', async () => {
  for (const mutate of [
    x => { x.store.browserId = 'another-browser'; },
    x => { x.store['bot.bridge.job.7'].tabId = 8; },
    x => { x.tab.url = 'https://chatgpt.com/c/another-conversation'; },
    x => { x.store['bot.bridge.job.7'].assistant = 'claude'; },
  ]) {
    const x = await setup(); await x.send({ type: 'bridge:poll' });
    mutate(x);
    assert.equal((await x.send({ type: 'bridge:poll' })).ok, false);
    assert.equal(x.calls.filter(call => call.path === '/v1/poll').length, 1);
    assert.equal(x.calls.filter(call => call.path.endsWith('/started')).length, 0);
  }
  const x = await setup(); await x.send({ type: 'bridge:poll' });
  const response = await x.send({ type: 'bridge:poll', sessionId: 'reloaded_page_session_123' });
  assert.equal(response.data.job, null);
  assert.equal(x.store['bot.bridge.job.7'], undefined);
  assert.equal(x.calls.filter(call => call.path === '/v1/poll').length, 1);
  assert.equal(x.calls.filter(call => call.path.endsWith('/error')).length, 1);
});

test('missing, invalid, expired or already starting lease prompts cannot be re-offered', async () => {
  for (const modify of [
    job => { delete job.prompt; }, job => { job.prompt = ''; }, job => { job.prompt = 'x'.repeat(12001); },
    job => { job.state = 'starting'; }, job => { job.state = 'started'; }, job => { job.expiresAt = Date.now(); },
  ]) {
    const x = await setup(); await x.send({ type: 'bridge:poll' });
    modify(x.store['bot.bridge.job.7']);
    assert.equal((await x.send({ type: 'bridge:poll' })).data.job, null);
    assert.equal(x.calls.filter(call => call.path === '/v1/poll').length, 1);
    assert.equal(x.calls.filter(call => call.path.endsWith('/started')).length, 0);
  }
});

test('re-offered input images still require page capabilities and a failed task drops its recoverable prompt', async () => {
  const x = await setup({ request: path => path === '/v1/poll' ? inputPoll([inputMeta]) : path.endsWith('/error') ? { status: 503, error: 'offline' } : undefined });
  const original = (await x.send(inputPollMessage)).data.job;
  assert.equal((await x.send({ type: 'bridge:poll', capabilities: [] })).ok, false);
  const recovered = (await x.send(inputPollMessage)).data.job;
  assert.deepEqual(recovered.images, original.images);
  assert.equal(recovered.id, original.id);
  assert.equal(x.calls.filter(call => call.path === '/v1/poll').length, 1);
  await x.send({ type: 'bridge:error', jobId: original.id, error: 'page stopped' });
  assert.equal(x.store['bot.bridge.job.7'].state, 'error-pending');
  assert.equal(x.store['bot.bridge.job.7'].prompt, undefined);
});

test('the recoverable prompt is removed before a delayed started acknowledgement', async () => {
  let confirm;
  const x = await setup({ request: path => path.endsWith('/started') ? new Promise(resolve => { confirm = resolve; }) : undefined });
  await x.send({ type: 'bridge:poll' });
  const starting = x.send({ type: 'bridge:started', jobId: 'job-1' });
  while (!confirm) await tick();
  assert.equal(x.store['bot.bridge.job.7'].state, 'starting');
  assert.equal(x.store['bot.bridge.job.7'].prompt, undefined);
  const polling = x.send({ type: 'bridge:poll' });
  confirm({ ok: true });
  assert.equal((await starting).ok, true);
  assert.equal((await polling).data.job, null);
  assert.equal(x.calls.filter(call => call.path === '/v1/poll').length, 1);
});
test('network failure persists final result and alarm retries only result delivery', async () => {
  let fail = true;
  const x = await setup({ request: path => { if (path.endsWith('/result') && fail) throw new TypeError('offline'); } });
  await x.send({ type: 'bridge:poll' }); await x.send({ type: 'bridge:started', jobId: 'job-1' });
  const result = await x.send({ type: 'bridge:result', jobId: 'job-1', text: 'Final answer' });
  assert.equal(result.data.pending, true); assert.equal(x.store['bot.bridge.job.7'].text, 'Final answer');
  // A late error after handing the answer over must not destroy its durable outbox.
  await x.send({ type: 'bridge:error', jobId: 'job-1', error: 'late timeout' }); assert.equal(x.store['bot.bridge.job.7'].state, 'result-pending');
  fail = false; await x.alarm(); assert.equal(x.store['bot.bridge.job.7'], undefined);
  assert.equal(x.calls.filter(c => c.path.endsWith('/started')).length, 1); assert.equal(x.calls.filter(c => c.path.endsWith('/result')).length, 2);
});
test('terminal result errors 400/409 release tab occupancy and leave visible notice', async () => {
  for (const status of [400, 409]) {
    const x = await setup({ request: path => path.endsWith('/result') ? { status, body: { error: '任务已结束' } } : undefined });
    await x.send({ type: 'bridge:poll' }); await x.send({ type: 'bridge:started', jobId: 'job-1' });
    const result = await x.send({ type: 'bridge:result', jobId: 'job-1', text: 'Final answer' });
    assert.equal(result.data.failed, true); assert.equal(x.store['bot.bridge.job.7'], undefined); assert.match(x.store['bot.bridge.notice.qq.7'].error, /未回传/);
    assert.equal(x.calls.filter(c => c.path.endsWith('/error')).length, 1, 'the host job must be ended before its worker lease is removed');
    await x.alarm(); assert.equal(x.calls.filter(c => c.path.endsWith('/result')).length, 1);
  }
});
test('permanently rejected replies retain failure cleanup across a host outage and never retry generation or the rejected result', async () => {
  for (const assistant of ASSISTANTS) for (const platform of ['qq', 'feishu']) {
    let cleanupOffline = true;
    const x = await setup({ assistant, platform, request: path => {
      if (path.endsWith('/result')) return { status: 400, error: '回复无法完整转换' };
      if (path.endsWith('/error') && cleanupOffline) throw new Error('Host temporarily offline');
    } });
    await x.send({ type: 'bridge:poll' }); await x.send({ type: 'bridge:started', jobId: 'job-1' });
    const result = await x.send({ type: 'bridge:result', jobId: 'job-1', text: 'Rejected final answer' });
    assert.equal(result.data.failed, true, `${assistant}/${platform}`);
    assert.equal(x.store['bot.bridge.job.7'].state, 'error-pending');
    assert.match(x.store['bot.bridge.job.7'].error, /未回传.*回复无法完整转换/);
    assert.equal(x.store['bot.bridge.job.7'].text, undefined);
    cleanupOffline = false; await x.alarm();
    assert.equal(x.store['bot.bridge.job.7'], undefined);
    assert.equal(x.calls.filter(c => c.path.endsWith('/result')).length, 1);
    assert.equal(x.calls.filter(c => c.path.endsWith('/started')).length, 1);
    assert.equal(x.calls.filter(c => c.path === '/v1/poll').length, 1);
    assert.equal(x.calls.filter(c => c.path.endsWith('/error')).length, 2);
  }
});
test('a real QQ reply-size rejection ends the original host job and immediately unblocks the next question for every assistant', async () => {
  for (const assistant of ASSISTANTS) {
    const storage = { state: null, async readState() { return structuredClone(this.state); }, async listImageKeys() { return []; },
      async commit({ expectedRevision, state }) { assert.equal(this.state?.revision ?? 0, expectedRevision); this.state = { ...structuredClone(state), revision: expectedRevision + 1 }; return this.state.revision; } };
    const queue = await QQStore.open({ storage, assistant, moderate: () => ({ blocked: false }) });
    const x = await setup({ assistant, request: async (path, body) => {
      try {
        if (path === '/v1/poll') { const result = await queue.poll(body); return { job: result.job ? { ...result.job, platform: 'qq' } : null }; }
        const match = /^\/v1\/jobs\/([^/]+)\/(started|result|error)$/.exec(path);
        if (match) return await queue[match[2]](match[1], body);
      } catch (error) { return { status: error.status || 500, error: error.message }; }
    } });
    await queue.bind({ chatId: 'QUEUE_AUDIT_GROUP', browserId: 'browser-one', tabId: 7, conversationUrl: x.tab.url });
    const first = await queue.ingest({ messageId: 'first-message', chatId: 'QUEUE_AUDIT_GROUP', text: 'First question', createdAt: Date.now() });
    const next = await queue.ingest({ messageId: 'next-message', chatId: 'QUEUE_AUDIT_GROUP', text: 'Second question', createdAt: Date.now() });
    const leased = (await x.send({ type: 'bridge:poll' })).data.job;
    assert.equal(leased.id, first.jobId);
    await x.send({ type: 'bridge:started', jobId: leased.id });
    const failed = await x.send({ type: 'bridge:result', jobId: leased.id, text: '字'.repeat(10000) });
    assert.equal(failed.data.failed, true); assert.match(failed.data.error, /5 条/);
    assert.equal(storage.state.jobs.find(job => job.id === first.jobId).state, 'failed');
    assert.equal((await x.send({ type: 'bridge:poll' })).data.job.id, next.jobId);
    assert.equal(x.calls.filter(call => call.path.endsWith('/started')).length, 1);
  }
});
test('failed started acknowledgement never permits webpage submission or retry', async () => {
  const x = await setup({ request: path => path.endsWith('/started') ? { status: 409, body: { error: '已经启动' } } : undefined });
  await x.send({ type: 'bridge:poll' });
  assert.equal((await x.send({ type: 'bridge:started', jobId: 'job-1' })).ok, false);
  assert.equal((await x.send({ type: 'bridge:started', jobId: 'job-1' })).ok, false);
  assert.equal(x.calls.filter(c => c.path.endsWith('/started')).length, 1);
});

test('incomplete or missing success acknowledgement cannot start a prompt or discard final output', async () => {
  let x = await setup({ request: path => path.endsWith('/started') ? { malformed: true } : undefined });
  await x.send({ type: 'bridge:poll' });
  assert.equal((await x.send({ type: 'bridge:started', jobId: 'job-1' })).ok, false);
  assert.equal(x.calls.filter(c => c.path.endsWith('/started')).length, 1);
  for (const response of [{ malformed: true }, { body: {} }]) {
    x = await setup({ request: path => path.endsWith('/result') ? response : undefined });
    await x.send({ type: 'bridge:poll' }); await x.send({ type: 'bridge:started', jobId: 'job-1' });
    const result = await x.send({ type: 'bridge:result', jobId: 'job-1', text: 'Keep this final answer' });
    assert.equal(result.data.pending, true); assert.equal(x.store['bot.bridge.job.7'].text, 'Keep this final answer');
  }
});


test('home-origin content can poll, start and return its job after SPA navigation into a conversation', async () => {
  const x = await setup();
  const initialDocument = { ...x.sender, url: 'https://chatgpt.com/', origin: 'https://chatgpt.com', tab: { id: 7, url: 'https://chatgpt.com/' } };
  const polled = await x.send({ type: 'bridge:poll' }, initialDocument);
  assert.equal(polled.ok, true); assert.equal(polled.data.job.id, 'job-1');
  assert.deepEqual(x.calls.find(call => call.path === '/v1/poll').body, { assistant: 'chatgpt', platform: 'qq', browserId: 'browser-one', tabId: 7, conversationUrl: url, capabilities: [] });
  assert.equal((await x.send({ type: 'bridge:started', jobId: 'job-1' }, initialDocument)).ok, true);
  assert.equal((await x.send({ type: 'bridge:result', jobId: 'job-1', text: 'SPA final answer' }, initialDocument)).ok, true);
  assert.equal(x.store['bot.bridge.job.7'], undefined);
});

test('conversation A to B SPA navigation uses live B identity, but cannot operate an existing A job', async () => {
  const other = 'https://chatgpt.com/c/conversation-b';
  let x = await setup({ request: (path, body) => path === '/v1/poll' ? { job: { id: 'job-b', platform: 'qq', leaseToken: 'lease-b', prompt: 'New conversation', conversationUrl: body.conversationUrl, timeoutMs: 600000 } } : undefined });
  x.tab.url = other; // sender.url remains A, as Chrome can report after SPA navigation.
  const pollB = await x.send({ type: 'bridge:poll', conversationUrl: other });
  assert.equal(pollB.ok, true); assert.equal(pollB.data.job.conversationUrl, other);
  assert.equal(x.calls.find(call => call.path === '/v1/poll').body.conversationUrl, other);
  assert.equal((await x.send({ type: 'bridge:started', jobId: 'job-b', conversationUrl: other })).ok, true);

  x = await setup(); await x.send({ type: 'bridge:poll' });
  x.tab.url = other;
  for (const type of ['bridge:poll', 'bridge:started', 'bridge:result']) {
    const response = await x.send({ type, jobId: 'job-1', conversationUrl: other, text: 'Wrong conversation answer' });
    assert.equal(response.ok, false);
  }
  assert.equal(x.store['bot.bridge.job.7'].state, 'leased');
  assert.equal(x.calls.filter(call => call.path !== '/v1/status').length, 1);
});

test('SPA support still rejects foreign senders, opaque or inconsistent origins, credentials, ports and iframes', async () => {
  const x = await setup();
  const invalidSenders = [
    { ...x.sender, url: 'https://evil.test/c/abcdefgh' },
    { ...x.sender, url: 'https://chatgpt.com.evil.test/c/abcdefgh' },
    { ...x.sender, url: 'http://chatgpt.com/' },
    { ...x.sender, url: 'https://user:password@chatgpt.com/' },
    { ...x.sender, url: 'https://chatgpt.com:444/' },
    { ...x.sender, origin: 'https://evil.test' },
    { ...x.sender, origin: 'null' },
    { ...x.sender, frameId: 3 },
    { ...x.sender, id: 'other-extension' },
    { ...x.sender, tab: { id: -1 } },
    { ...x.sender, tab: { id: '7' } },
  ];
  for (const sender of invalidSenders) assert.equal((await x.send({ type: 'bridge:poll' }, sender)).ok, false);
  assert.equal(x.calls.length, 0);
});

test('live foreign tabs and spoofed claimed conversation URLs cannot request work', async () => {
  const x = await setup();
  assert.equal((await x.send({ type: 'bridge:poll', conversationUrl: 'https://chatgpt.com/c/spoofed-target' })).ok, false);
  assert.equal((await x.send({ type: 'bridge:poll', conversationUrl: url + '?spoof=1' })).ok, false);
  for (const current of ['https://evil.test/c/abcdefgh', 'https://chatgpt.com:444/c/abcdefgh', 'https://user:password@chatgpt.com/c/abcdefgh', 'https://chatgpt.com/']) {
    x.tab.url = current;
    assert.equal((await x.send({ type: 'bridge:poll' })).ok, false);
  }
  assert.equal(x.calls.length, 0);
});

test('bridge error remains tied to the original job/session and a real ChatGPT tab across SPA navigation', async () => {
  const x = await setup(); await x.send({ type: 'bridge:poll' });
  const homeSender = { ...x.sender, url: 'https://chatgpt.com/', origin: 'https://chatgpt.com' };
  const other = 'https://chatgpt.com/c/conversation-b';
  x.tab.url = 'https://evil.test/';
  assert.equal((await x.send({ type: 'bridge:error', jobId: 'job-1', error: 'forged' }, homeSender)).ok, false);
  assert.equal(x.store['bot.bridge.job.7'].state, 'leased');
  x.tab.url = other;
  await x.send({ type: 'bridge:error', jobId: 'job-1', sessionId: 'different_session_123', error: 'forged' }, homeSender);
  await x.send({ type: 'bridge:error', jobId: 'other-job', error: 'forged' }, homeSender);
  assert.equal((await x.send({ type: 'bridge:error', jobId: 'job-1', conversationUrl: other, error: 'wrong original URL' }, homeSender)).ok, false);
  assert.equal((await x.send({ type: 'bridge:error', jobId: 'job-1', error: 'forged' }, { ...homeSender, frameId: 1 })).ok, false);
  assert.equal((await x.send({ type: 'bridge:error', jobId: 'job-1', error: 'forged' }, { ...homeSender, url: 'https://evil.test/' })).ok, false);
  assert.equal(x.calls.filter(call => call.path.endsWith('/error')).length, 0);
  const cancelled = await x.send({ type: 'bridge:error', jobId: 'job-1', error: 'SPA route changed' }, homeSender);
  assert.equal(cancelled.ok, true); assert.equal(x.store['bot.bridge.job.7'], undefined);
  const errorCall = x.calls.find(call => call.path.endsWith('/error'));
  assert.equal(errorCall.body.conversationUrl, url); assert.equal(errorCall.body.tabId, 7); assert.equal(errorCall.body.leaseToken, 'lease-secret');
});

const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const imageBase64 = pngBytes.toString('base64');
const imageId = createHash('sha256').update(pngBytes).digest('hex');
const imageMessage = { type: 'bridge:image', jobId: 'job-1', index: 0, mimeType: 'image/png', base64: imageBase64 };

test('image upload is authorized only for a started job and persists identifiers without image bytes', async () => {
  const x = await setup({ request: path => path.endsWith('/image') ? { ok: true, imageId } : undefined });
  await x.send({ type: 'bridge:poll' });
  assert.equal((await x.send(imageMessage)).ok, false);
  await x.send({ type: 'bridge:started', jobId: 'job-1' });
  assert.equal((await x.send(imageMessage, { ...x.sender, frameId: 1 })).ok, false);
  assert.equal((await x.send({ ...imageMessage, sessionId: 'another_session_123' })).ok, false);
  assert.deepEqual((await x.send(imageMessage)).data, { ok: true, imageId });
  assert.equal(x.store['bot.bridge.job.7'].uploadedImages[0].imageId, imageId);
  assert.doesNotMatch(JSON.stringify(x.store), new RegExp(imageBase64));
  const uploaded = x.calls.find(call => call.path.endsWith('/image'));
  assert.equal(uploaded.body.leaseToken, 'lease-secret');
  assert.equal(uploaded.body.base64, imageBase64);
  await x.send(imageMessage);
  assert.equal(x.calls.filter(call => call.path.endsWith('/image')).length, 1);
  const changed = Buffer.concat([pngBytes, Buffer.from([5])]).toString('base64');
  assert.equal((await x.send({ ...imageMessage, base64: changed })).ok, false);
  assert.equal((await x.send({ ...imageMessage, index: 4 })).ok, false);
  assert.equal((await x.send({ type: 'bridge:result', jobId: 'job-1', text: '', images: ['0'.repeat(64)] })).ok, false);
  assert.equal((await x.send({ type: 'bridge:result', jobId: 'job-1', text: '', images: [imageId] })).ok, true);
  assert.deepEqual(x.calls.find(call => call.path.endsWith('/result')).body.images, [imageId]);
});

test('image result retry survives a worker restart without persisting or retransmitting image bytes', async () => {
  let failing = true;
  const request = path => {
    if (path.endsWith('/image')) return { ok: true, imageId };
    if (path.endsWith('/result') && failing) throw new TypeError('synthetic offline');
  };
  let x = await setup({ request });
  await x.send({ type: 'bridge:poll' }); await x.send({ type: 'bridge:started', jobId: 'job-1' }); await x.send(imageMessage);
  const result = await x.send({ type: 'bridge:result', jobId: 'job-1', text: 'Picture caption', images: [imageId] });
  assert.equal(result.data.pending, true);
  assert.deepEqual(x.store['bot.bridge.job.7'].images, [imageId]);
  x = await setup({ store: x.store, request });
  failing = false; await x.alarm();
  assert.equal(x.store['bot.bridge.job.7'], undefined);
  assert.equal(x.calls.filter(call => call.path.endsWith('/image')).length, 0);
  const deliveries = x.calls.filter(call => call.path.endsWith('/result'));
  assert.ok(deliveries.length);
  assert.ok(deliveries.every(call => call.body.text === 'Picture caption' && call.body.images[0] === imageId && !('base64' in call.body)));
});

test('invalid image data or an incorrect upload receipt cannot be accepted as a final image', async () => {
  const x = await setup({ request: path => path.endsWith('/image') ? { ok: true, imageId: '0'.repeat(64) } : undefined });
  await x.send({ type: 'bridge:poll' }); await x.send({ type: 'bridge:started', jobId: 'job-1' });
  assert.equal((await x.send({ ...imageMessage, mimeType: 'image/svg+xml' })).ok, false);
  assert.equal((await x.send({ ...imageMessage, index: 1 })).ok, false);
  assert.equal((await x.send(imageMessage)).ok, false);
  assert.equal(x.store['bot.bridge.job.7'].uploadedImages, undefined);
  assert.equal((await x.send({ type: 'bridge:result', jobId: 'job-1', text: '', images: [imageId] })).ok, false);
});

const inputMeta = { id: imageId, mimeType: 'image/png', name: 'qq-picture.png', bytes: pngBytes.length };
const inputMessage = { type: 'bridge:input-image', jobId: 'job-1', imageId };
const inputPollMessage = { type: 'bridge:poll', capabilities: ['image-input-v1'] };
const inputPoll = images => ({ job: { id: 'job-1', platform: 'qq', leaseToken: 'lease-secret', prompt: 'Describe this image', conversationUrl: url, timeoutMs: 600000, images } });
const inputResponse = { ok: true, imageId, mimeType: 'image/png', name: inputMeta.name, base64: imageBase64 };

test('input pictures are fetched per job with authenticated identity and never persisted as binary', async () => {
  const request = path => path === '/v1/poll' ? inputPoll([{ ...inputMeta, base64: imageBase64, sourceUrl: 'private-remote-url' }]) : path.endsWith('/input-image') ? inputResponse : undefined;
  let x = await setup({ request });
  const polled = await x.send(inputPollMessage);
  assert.deepEqual(polled.data.job.images, [inputMeta]);
  assert.deepEqual(x.store['bot.bridge.job.7'].inputImages, [inputMeta]);
  for (const invalid of [{ ...inputMessage, imageId: '0'.repeat(64) }, { ...inputMessage, jobId: 'other-job' }, { ...inputMessage, sessionId: 'other_session_12345' }]) assert.equal((await x.send(invalid)).ok, false);
  assert.equal((await x.send(inputMessage, { ...x.sender, frameId: 1 })).ok, false);
  assert.equal(x.calls.filter(call => call.path.endsWith('/input-image')).length, 0);
  assert.deepEqual((await x.send(inputMessage)).data, { imageId, mimeType: inputMeta.mimeType, name: inputMeta.name, base64: imageBase64 });
  assert.deepEqual(x.calls.find(call => call.path.endsWith('/input-image')).body, { assistant: 'chatgpt', platform: 'qq', leaseToken: 'lease-secret', browserId: 'browser-one', tabId: 7, conversationUrl: url, imageId });
  assert.doesNotMatch(JSON.stringify(x.store), new RegExp(imageBase64 + '|private-remote-url'));
  x = await setup({ store: x.store, request });
  await x.send({ type: 'bridge:started', jobId: 'job-1' });
  assert.equal((await x.send(inputMessage)).ok, true);
  x.store['bot.bridge.job.7'].expiresAt = Date.now() - 1;
  assert.equal((await x.send(inputMessage)).ok, false);
  assert.equal(x.calls.filter(call => call.path.endsWith('/input-image')).length, 1);
});

test('input image replies must match the declared name, MIME, byte size and hash', async () => {
  for (const patch of [
    { imageId: '0'.repeat(64) }, { name: 'different.png' }, { mimeType: 'image/jpeg' },
    { base64: Buffer.concat([pngBytes, Buffer.from([99])]).toString('base64') },
    { base64: Buffer.from([...pngBytes.subarray(0, -1), 99]).toString('base64') },
    { base64: 'not valid base64' },
  ]) {
    const x = await setup({ request: path => path === '/v1/poll' ? inputPoll([inputMeta]) : path.endsWith('/input-image') ? { ...inputResponse, ...patch } : undefined });
    await x.send(inputPollMessage);
    assert.equal((await x.send(inputMessage)).ok, false);
    assert.doesNotMatch(JSON.stringify(x.store), /base64/);
  }
});

test('invalid input metadata cannot be leased or stored by the extension', async () => {
  for (const images of [[inputMeta, inputMeta], [{ ...inputMeta, bytes: 10000001 }], [{ ...inputMeta, name: '../private.png' }], [{ ...inputMeta, mimeType: 'image/svg+xml' }]]) {
    const x = await setup({ request: path => path === '/v1/poll' ? inputPoll(images) : undefined });
    assert.equal((await x.send(inputPollMessage)).ok, false);
    assert.equal(x.store['bot.bridge.job.7'], undefined);
    assert.equal(x.calls.filter(call => call.path !== '/v1/status').length, 1);
  }
});

test('mixed extension versions advertise image input only when the current content script supports it', async () => {
  for (const capabilities of [undefined, 'image-input-v1', [], ['unknown-v2']]) {
    const x = await setup();
    assert.equal((await x.send({ type: 'bridge:poll', capabilities })).ok, true);
    assert.deepEqual(x.calls.find(call => call.path === '/v1/poll').body.capabilities, []);
  }
  let x = await setup();
  assert.equal((await x.send({ ...inputPollMessage, capabilities: ['image-input-v1', 'unknown-v2'] })).ok, true);
  assert.deepEqual(x.calls.find(call => call.path === '/v1/poll').body.capabilities, ['image-input-v1']);
  // A mismatched/older server response still cannot hand images to a text-only page script.
  x = await setup({ request: path => path === '/v1/poll' ? inputPoll([inputMeta]) : undefined });
  const rejected = await x.send({ type: 'bridge:poll' });
  assert.equal(rejected.ok, false); assert.match(rejected.error, /刷新|重新加载/);
  assert.equal(x.store['bot.bridge.job.7'], undefined);
});

test('offscreen startup is shared by concurrent IPC and sends only extension messages', async () => {
  let openHost;
  const opening = new Promise(resolve => { openHost = resolve; });
  const x = await setup({ createHost: () => opening });
  assert.equal(x.hostCreates.length, 1);
  const status = x.send({ platform: 'qq', type: 'options:status' }, x.optionsSender);
  const words = x.send({ platform: 'qq', type: 'options:moderation' }, x.optionsSender);
  await tick(); await tick();
  assert.equal(x.hostCreates.length, 1);
  assert.equal(x.calls.length, 0);
  openHost();
  assert.equal((await status).ok, true);
  assert.equal((await words).ok, true);
  assert.equal(x.hostCreates[0].url, 'offscreen.html');
  assert.deepEqual(x.hostCreates[0].reasons, ['WORKERS']);
  assert.ok(x.hostCreates[0].justification);
  assert.deepEqual(x.contextChecks[0], { contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: ['chrome-extension://extension-id/offscreen.html'] });
  assert.ok(x.calls.every(call => call.message.target === 'bridge-host'));
  assert.deepEqual(x.fetchCalls, []);
  assert.deepEqual(x.alarms, [{ name: 'bot-bridge-maintenance', options: { periodInMinutes: 0.5 } }]);
  const source = await readFile(new URL('../extension/worker.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /fetch\s*\(|DEFAULT_SERVER|serverUrl|127\.0\.0\.1|localhost/);
});

test('existing offscreen document survives worker restarts and is recreated after closure', async () => {
  const x = await setup({ contextPresent: true });
  assert.equal(x.hostCreates.length, 0);
  await x.startup();
  assert.equal(x.hostCreates.length, 0);
  x.setHostPresent(false);
  await x.alarm();
  assert.equal(x.hostCreates.length, 1);
  await x.startup(); await x.alarm();
  assert.equal(x.hostCreates.length, 1);
  assert.ok(x.calls.every(call => call.path === '/v1/status'));
});

test('startup removes unsupported local transport keys while preserving browser identity and active leases', async () => {
  const job = { id: 'old-job', platform: 'qq', browserId: 'stable-browser', leaseToken: 'old-lease', tabId: 7, conversationUrl: url, sessionId, state: 'started', expiresAt: Date.now() + 600000 };
  const x = await setup({ store: { browserId: 'stable-browser', server: 'http://127.0.0.1:3210', token: 'old-pairing-secret', 'bot.bridge.job.7': structuredClone(job) } });
  assert.equal(x.store.server, undefined);
  assert.equal(x.store.token, undefined);
  assert.equal(x.store.browserId, 'stable-browser');
  assert.deepEqual(x.store['bot.bridge.job.7'], job);
  assert.deepEqual((await x.send({ platform: 'qq', type: 'options:settings' }, x.optionsSender)).data, { browserId: 'stable-browser', extensionOnly: true });
  assert.equal((await x.send({ type: 'bridge:poll' })).data.busy, true);
  assert.equal((await x.send({ type: 'bridge:started', jobId: 'old-job' })).ok, false);
  assert.equal(x.calls.length, 0);
  const fresh = await setup({ store: {} });
  const identity = fresh.store.browserId;
  assert.match(identity, /^[a-f0-9-]{36}$/);
  assert.equal((await fresh.send({ platform: 'qq', type: 'options:settings' }, fresh.optionsSender)).data.browserId, identity);
});

test('all configuration and notice operations reject content scripts and foreign options senders', async () => {
  const x = await setup({ store: { browserId: 'browser-one', 'bot.bridge.notice.qq.7': { tabId: 7, at: 42, error: 'preserve me' } } });
  for (const type of [
    'options:settings', 'options:status', 'options:config', 'options:tabs', 'options:bind', 'options:unbind',
    'options:clear-history', 'options:moderation', 'options:save-words', 'options:import', 'options:clear-notices', 'options:save', 'options:reply-style', 'options:cancel-job',
  ]) {
    const message = { platform: 'qq', type, jobId: cancellableJobId, appId: '123456789', appSecret: 'fixture-secret', words: ['replacement'], config: {}, chatId: 'GROUP_FIXTURE', tabId: 7 };
    assert.equal((await x.send(message)).ok, false, type);
    assert.equal((await x.send(message, { ...x.optionsSender, id: 'foreign-extension' })).ok, false, type);
    assert.equal((await x.send(message, { ...x.optionsSender, url: x.optionsSender.url + '?forged' })).ok, false, type);
  }
  assert.equal(x.calls.length, 0);
  assert.equal(x.store['bot.bridge.notice.qq.7'].error, 'preserve me');
  assert.equal((await x.send({ platform: 'qq', type: 'options:save', server: 'https://example.invalid', token: 'secret' }, x.optionsSender)).ok, false);
  assert.equal(x.store.server, undefined);
  assert.equal(x.store.token, undefined);
});

test('trusted settings route configuration and moderation; legacy imports are rejected through the host', async () => {
  const x = await setup();
  assert.deepEqual((await x.send({ platform: 'qq', type: 'options:moderation' }, x.optionsSender)).data, { valid: true, words: ['色情', 'porn'] });
  assert.equal((await x.send({ platform: 'qq', type: 'options:save-words', words: ['new phrase'] }, x.optionsSender)).ok, true);
  assert.equal((await x.send({ platform: 'qq', type: 'options:config', appId: ' 123456789 ', appSecret: ' fixture-secret ' }, x.optionsSender)).ok, true);
  const config = { format: 'qq-chatgpt-extension-migration-v1', appId: '123456789', appSecret: 'migration-secret', groups: [{ chatId: 'GROUP_EXAMPLE' }], seen: { previous: 123 } };
  assert.equal((await x.send({ platform: 'qq', type: 'options:import', config }, x.optionsSender)).ok, false);
  assert.equal((await x.send({ platform: 'qq', type: 'options:bind', chatId: ' GROUP_FIXTURE ', tabId: 7 }, x.optionsSender)).ok, true);
  assert.equal((await x.send({ platform: 'qq', type: 'options:unbind', chatId: 'GROUP_FIXTURE' }, x.optionsSender)).ok, true);
  assert.deepEqual(x.calls.filter(call => call.path !== '/v1/status').map(({ path, body }) => ({ path, body })), [
    { path: '/v1/moderation', body: { assistant: 'chatgpt', platform: 'qq' } },
    { path: '/v1/moderation', body: { assistant: 'chatgpt', platform: 'qq', words: ['new phrase'] } },
    { path: '/v1/config', body: { assistant: 'chatgpt', platform: 'qq', appId: '123456789', appSecret: 'fixture-secret' } },
    { path: '/v1/bind', body: { assistant: 'chatgpt', platform: 'qq', chatId: 'GROUP_FIXTURE', conversationUrl: url, browserId: 'browser-one', tabId: 7 } },
    { path: '/v1/unbind', body: { assistant: 'chatgpt', platform: 'qq', chatId: 'GROUP_FIXTURE' } },
  ]);
  assert.doesNotMatch(JSON.stringify(x.store), /fixture-secret|migration-secret/);
});

test('settings cancel a job only in the requested assistant and active platform, including a disabled profile', async () => {
  for (const assistant of ASSISTANTS) {
    for (const platform of ['qq', 'feishu']) {
      const x = await setup({ assistant });
      if (platform === 'feishu') await x.send({ type: 'options:platform', assistant, platform }, x.optionsSender);
      await x.send({ type: 'options:assistant', assistant, enabled: false }, x.optionsSender);
      const reply = await x.send({ type: 'options:cancel-job', assistant, platform, jobId: cancellableJobId, tabId: 99, leaseToken: 'forged' }, x.optionsSender);
      assert.deepEqual(reply, { ok: true, data: { ok: true } });
      assert.deepEqual(x.calls.filter(call => call.path.endsWith('/cancel')).map(({ path, body }) => ({ path, body })), [
        { path: `/v1/jobs/${cancellableJobId}/cancel`, body: { assistant, platform } },
      ]);
      assert.equal(x.calls.filter(call => call.path.endsWith('/error')).length, 0);
    }
  }
});

test('cancellation rejects malformed task IDs, stale platform selections and page cancellation messages', async () => {
  const x = await setup({ platform: 'feishu' });
  for (const jobId of [undefined, null, 123, '', 'job-1', cancellableJobId.toUpperCase(), ` ${cancellableJobId}`, '-'.repeat(36), `${cancellableJobId}/../cancel`]) {
    assert.equal((await x.send({ type: 'options:cancel-job', assistant: 'chatgpt', platform: 'feishu', jobId }, x.optionsSender)).ok, false);
  }
  assert.equal(x.calls.length, 0);
  for (const platform of [undefined, null, 'other', 'qq']) {
    assert.equal((await x.send({ type: 'options:cancel-job', assistant: 'chatgpt', platform, jobId: cancellableJobId }, x.optionsSender)).ok, false);
  }
  assert.equal((await x.send({ type: 'bridge:cancel-job', jobId: cancellableJobId })).ok, false);
  assert.equal(x.calls.filter(call => call.path !== '/v1/status').length, 0);
});

test('cancellation propagates a leased-task conflict and rejects malformed host acknowledgements without clearing local work', async () => {
  for (const response of [
    { status: 409, error: '任务已开始，无法取消' },
    { body: {} }, { body: { ok: false } }, { body: { ok: 'true' } }, { envelope: { ok: true } },
  ]) {
    const x = await setup({ request: path => {
      if (path.endsWith('/cancel')) return response;
      if (path === '/v1/poll') return { job: { ...inputPoll([]).job, id: cancellableJobId } };
    } });
    await x.send({ type: 'bridge:poll' });
    const original = structuredClone(x.store['bot.bridge.job.7']);
    const reply = await x.send({ type: 'options:cancel-job', assistant: 'chatgpt', platform: 'qq', jobId: cancellableJobId }, x.optionsSender);
    assert.equal(reply.ok, false);
    if (response.status === 409) assert.match(reply.error, /任务已开始，无法取消/);
    assert.deepEqual(x.store['bot.bridge.job.7'], original);
    assert.equal(x.calls.filter(call => call.path.endsWith('/cancel')).length, 1);
    assert.equal(x.calls.filter(call => call.path.endsWith('/error')).length, 0);
  }
});

test('cancellation waits for its assistant platform switch and rejects the stale selection afterward', async () => {
  let releaseSwitch;
  const x = await setup({ request: path => path === '/v1/platform' ? new Promise(resolve => { releaseSwitch = () => resolve(undefined); }) : undefined });
  const switching = x.send({ type: 'options:platform', assistant: 'chatgpt', platform: 'feishu' }, x.optionsSender);
  while (!releaseSwitch) await tick();
  const pending = x.send({ type: 'options:cancel-job', assistant: 'chatgpt', platform: 'qq', jobId: cancellableJobId }, x.optionsSender);
  assert.equal((await x.send({ type: 'options:cancel-job', assistant: 'claude', platform: 'qq', jobId: cancellableJobId }, x.optionsSender)).ok, true);
  assert.deepEqual(x.calls.filter(call => call.path.endsWith('/cancel')).map(call => call.body.assistant), ['claude']);
  releaseSwitch(); assert.equal((await switching).ok, true);
  assert.equal((await pending).ok, false);
  assert.deepEqual(x.calls.filter(call => call.path.endsWith('/cancel')).map(call => call.body.assistant), ['claude']);
});

test('QQ rejects Feishu card and migration settings even from the trusted page', async () => {
 const x = await setup();
 for (const replyStyle of ['separate','card','other',null,{},undefined]) assert.equal((await x.send({platform:'qq',type:'options:reply-style',replyStyle},x.optionsSender)).ok,false);
 assert.equal(x.calls.filter(call => call.path !== '/v1/status').length,0);
});

test('status sorts historical notices newest first and clearing notices preserves tasks and delivery', async () => {
  const store = { browserId: 'browser-one', 'bot.bridge.notice.qq.invalid': null, 'bridge.delivery.7': { text: 'pending delivery' } };
  for (let i = 0; i < 24; i++) store['bot.bridge.notice.qq.' + i] = { tabId: i, at: (24 - i) * 100, error: 'historical ' + i };
  store['bot.bridge.job.7'] = { id: 'old-job', platform: 'qq', tabId: 7, conversationUrl: url, sessionId, state: 'started', expiresAt: Date.now() + 600000 };
  const x = await setup({ store });
  const originalJob = structuredClone(x.store['bot.bridge.job.7']);
  const status = await x.send({ platform: 'qq', type: 'options:status' }, x.optionsSender);
  assert.equal(status.ok, true);
  assert.equal(status.data.localNotices.length, 20);
  assert.deepEqual(status.data.localNotices.map(notice => notice.at), Array.from({ length: 20 }, (_, i) => (24 - i) * 100));
  assert.deepEqual((await x.send({ platform: 'qq', type: 'options:clear-notices' }, x.optionsSender)).data, { ok: true });
  assert.equal(Object.keys(x.store).some(key => key.startsWith('bot.bridge.notice.qq.')), false);
  assert.deepEqual(x.store['bot.bridge.job.7'], originalJob);
  assert.deepEqual(x.store['bridge.delivery.7'], { text: 'pending delivery' });
  assert.equal(x.store.browserId, 'browser-one');
  assert.equal(x.calls.length, 2);
});

test('the service worker never answers messages addressed to bridge-host', async () => {
  const x = await setup();
  let answered = false;
  const keepOpen = x.chrome.runtime.onMessage.listeners[0]({ target: 'bridge-host', route: '/v1/config', type: 'options:config' }, x.sender, () => { answered = true; });
  assert.equal(keepOpen, false);
  await tick();
  assert.equal(answered, false);
  assert.equal(x.calls.length, 0);
});

test('malformed engine response envelopes never discard a durable final answer', async () => {
  for (const envelope of [
    undefined, null, [], true, { ok: 'true', data: { ok: true } }, { ok: true },
    { ok: true, data: null }, { ok: true, data: [] }, { ok: true, data: { ok: true }, status: 409 },
    { ok: false, status: 409 }, { ok: false, status: '409', error: 'invalid status' },
    { ok: false, status: 409, error: {} }, { ok: false, status: 200, error: 'invalid status' },
    { ok: false, status: 700, error: 'invalid status' },
  ]) {
    const x = await setup({ request: path => path.endsWith('/result') ? { envelope } : undefined });
    await x.send({ type: 'bridge:poll' }); await x.send({ type: 'bridge:started', jobId: 'job-1' });
    const result = await x.send({ type: 'bridge:result', jobId: 'job-1', text: 'Keep this answer' });
    assert.equal(result.data.pending, true);
    assert.equal(x.store['bot.bridge.job.7'].state, 'result-pending');
    assert.equal(x.store['bot.bridge.job.7'].text, 'Keep this answer');
    assert.equal(x.store['bot.bridge.notice.qq.7'], undefined);
  }
});

test('malformed polling and read responses fail closed before work is leased', async () => {
  for (const body of [{}, { job: undefined }, { job: false }, { job: [] }, { job: 'not a job' }, inputPoll([])]) {
    if (body.job && typeof body.job === 'object' && !Array.isArray(body.job)) body.job.leaseToken = '';
    const x = await setup({ request: path => path === '/v1/poll' ? { body } : undefined });
    assert.equal((await x.send({ type: 'bridge:poll' })).ok, false);
    assert.equal(x.store['bot.bridge.job.7'], undefined);
  }
  for (const [type, body] of [['options:status', {}], ['options:moderation', { words: [], valid: 'yes' }], ['options:moderation', { words: [42], valid: true }]]) {
    const x = await setup({ request: () => ({ body }) });
    assert.equal((await x.send({ type, platform: 'qq' }, x.optionsSender)).ok, false);
  }
});

test('host startup failure is retryable without sending configuration or clearing jobs', async () => {
  let unavailable = true;
  const x = await setup({ createHost: () => { if (unavailable) throw new Error('synthetic creation failure'); } });
  assert.equal((await x.send({ platform: 'qq', type: 'options:config', appId: '123456789', appSecret: 'fixture-secret' }, x.optionsSender)).ok, false);
  assert.equal(x.calls.length, 0);
  unavailable = false;
  assert.equal((await x.send({ platform: 'qq', type: 'options:status' }, x.optionsSender)).ok, true);
  assert.equal(x.hostCreates.length, 3);
  assert.equal(x.calls[0].path, '/v1/status');
});

test('25-second start timeout rejects submission and ignores a late successful acknowledgement', { timeout: 10000 }, async t => {
  const digestEntered = Promise.withResolvers();
  const releaseDigest = Promise.withResolvers();
  const hostRequestReceived = Promise.withResolvers();
  let acknowledge;
  const x = await setup({ request: path => path.endsWith('/started') ? new Promise(resolve => {
    acknowledge = resolve; hostRequestReceived.resolve();
  }) : undefined });
  const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'digest', async (...args) => {
    digestEntered.resolve();
    await releaseDigest.promise;
    return nativeDigest(...args);
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await x.send({ type: 'bridge:poll' });
  let finished = false;
  const starting = x.send({ type: 'bridge:started', jobId: 'job-1' }).then(result => { finished = true; return result; });
  const endedBeforeHost = starting.then(() => { throw new Error('Start request finished before the host received /started'); });
  await Promise.race([digestEntered.promise, endedBeforeHost]);
  // WebCrypto finishes outside the JS microtask queue. Two event-loop turns
  // never prove hashing has finished or the host timeout has started.
  await tick(); await tick();
  assert.equal(x.calls.filter(call => call.path.endsWith('/started')).length, 0);
  assert.equal(finished, false);
  releaseDigest.resolve();
  await Promise.race([hostRequestReceived.promise, endedBeforeHost]);
  assert.equal(x.calls.filter(call => call.path.endsWith('/started')).length, 1);
  t.mock.timers.tick(24999); await tick();
  assert.equal(finished, false);
  t.mock.timers.tick(1);
  assert.equal((await starting).ok, false);
  assert.equal(x.store['bot.bridge.job.7'], undefined);
  acknowledge({ ok: true }); await tick();
  assert.equal((await x.send({ type: 'bridge:started', jobId: 'job-1' })).ok, false);
  assert.equal(x.calls.filter(call => call.path.endsWith('/started')).length, 1);
});

test('25-second result timeout preserves the answer for delivery-only retry after a late receipt', async t => {
  let acknowledge;
  let delayed = true;
  const x = await setup({ request: path => path.endsWith('/result') && delayed ? new Promise(resolve => { acknowledge = resolve; }) : undefined });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await x.send({ type: 'bridge:poll' }); await x.send({ type: 'bridge:started', jobId: 'job-1' });
  const delivering = x.send({ type: 'bridge:result', jobId: 'job-1', text: 'Survive a slow host' });
  await tick(); await tick();
  t.mock.timers.tick(25000);
  assert.equal((await delivering).data.pending, true);
  assert.equal(x.store['bot.bridge.job.7'].text, 'Survive a slow host');
  acknowledge({ ok: true }); await tick();
  assert.equal(x.store['bot.bridge.job.7'].state, 'result-pending');
  delayed = false; await x.alarm();
  assert.equal(x.store['bot.bridge.job.7'], undefined);
  assert.equal(x.calls.filter(call => call.path.endsWith('/started')).length, 1);
  assert.equal(x.calls.filter(call => call.path.endsWith('/result')).length, 2);
});

test('page timing diagnostics are bounded, copied without secrets and preserved with pending results',async()=>{
 let offline=true;const x=await setup({request:path=>{if(path.endsWith('/result')&&offline)throw Error('offline');}});
 await x.send({type:'bridge:poll'});await x.send({type:'bridge:started',jobId:'job-1'});
 const timing={confirmationMs:800,imagePreparationMs:100,background:true,token:'private-extra'};
 await x.send({type:'bridge:result',jobId:'job-1',text:'answer',timing});
 const expected={confirmationMs:800,imagePreparationMs:100,background:true};
 assert.deepEqual(x.store['bot.bridge.job.7'].timing,expected);assert.doesNotMatch(JSON.stringify(x.store),/private-extra/);
 offline=false;await x.alarm();assert.deepEqual(x.calls.filter(c=>c.path.endsWith('/result')).at(-1).body.timing,expected);
});

test('host-selected platform owns every job operation despite forged content platform fields', async () => {
  for (const platform of ['qq', 'feishu']) {
    const forged = platform === 'qq' ? 'feishu' : 'qq';
    const x = await setup({ platform, request: path => {
      if (path === '/v1/poll') return { job: { ...inputPoll([inputMeta]).job, platform } };
      if (path.endsWith('/input-image')) return inputResponse;
      if (path.endsWith('/image')) return { ok: true, imageId };
    } });
    const leased = await x.send({ ...inputPollMessage, platform: forged });
    assert.equal(leased.data.job.platform, platform);
    assert.equal(x.store['bot.bridge.job.7'].platform, platform);
    assert.equal((await x.send({ ...inputMessage, platform: forged })).ok, true);
    assert.equal((await x.send({ type: 'bridge:started', jobId: 'job-1', platform: forged })).ok, true);
    assert.equal((await x.send({ ...imageMessage, platform: forged })).ok, true);
    assert.equal((await x.send({ type: 'bridge:result', jobId: 'job-1', platform: forged, text: 'final', images: [imageId] })).ok, true);
    assert.ok(x.calls.filter(call => call.path !== '/v1/status').every(call => call.body.platform === platform));
    assert.equal(x.store['bot.bridge.job.7'], undefined);

    const cancelled = await setup({ platform });
    await cancelled.send({ type: 'bridge:poll', platform: forged });
    await cancelled.send({ type: 'bridge:error', platform: forged, jobId: 'job-1', error: 'cancelled' });
    assert.equal(cancelled.calls.find(call => call.path.endsWith('/error')).body.platform, platform);
    assert.equal(cancelled.store[`bot.bridge.notice.${platform}.7`].platform, platform);
  }
});

test('missing, invalid or mismatched host job platforms cannot be leased', async () => {
  for (const platform of [undefined, null, 'other', 'feishu']) {
    const x = await setup({ request: path => path === '/v1/poll' ? { job: { ...inputPoll([]).job, platform } } : undefined });
    const reply = await x.send({ type: 'bridge:poll', platform: 'qq' });
    assert.equal(reply.ok, false); assert.equal(x.store['bot.bridge.job.7'], undefined);
  }
});

test('platform-aware pending results survive worker restart and retry only on their original platform', async () => {
  let unavailable = true;
  const request = path => { if (path.endsWith('/result') && unavailable) throw Error('offline'); };
  let x = await setup({ platform: 'feishu', request });
  await x.send({ type: 'bridge:poll' }); await x.send({ type: 'bridge:started', jobId: 'job-1' });
  await x.send({ type: 'bridge:result', jobId: 'job-1', platform: 'qq', text: 'Feishu only' });
  assert.equal(x.store['bot.bridge.job.7'].platform, 'feishu');
  x = await setup({ platform: 'feishu', store: x.store, request });
  unavailable = false; await x.alarm();
  const calls = x.calls.filter(call => call.path.endsWith('/result'));
  assert.ok(calls.length > 0); assert.ok(calls.every(call => call.body.platform === 'feishu'));
  assert.equal(x.store['bot.bridge.job.7'], undefined);
});

test('settings require an explicit active platform and reject stale platform mutations', async () => {
  const x = await setup({ platform: 'feishu' });
  for (const type of ['options:moderation', 'options:save-words', 'options:reply-style', 'options:config', 'options:bind', 'options:unbind']) {
    for (const platform of [undefined, null, 'other', 'qq']) {
      const reply = await x.send({ type, platform, appId: 'cli_fixture', appSecret: 'secret', words: ['term'], replyStyle: 'card', chatId: 'oc_fixture', tabId: 7 }, x.optionsSender);
      assert.equal(reply.ok, false, `${type}:${platform}`);
    }
  }
  assert.equal(x.calls.filter(call => call.path !== '/v1/status').length, 0);
  assert.equal((await x.send({ type: 'options:reply-style', platform: 'feishu', replyStyle: 'card' }, x.optionsSender)).ok, true);
  assert.deepEqual(x.calls.at(-1).body, { assistant: 'chatgpt', platform: 'feishu', replyStyle: 'card' });
  assert.equal((await x.send({ type: 'options:import', platform: 'feishu', config: {} }, x.optionsSender)).ok, false);
});

test('platform switch refuses every outstanding local job including pending result and error', async () => {
  const x = await setup();
  assert.equal((await x.send({ type: 'options:platform', platform: 'feishu' })).ok, false);
  for (const state of ['leased', 'starting', 'started', 'error-pending', 'result-pending']) {
    x.store['bot.bridge.job.7'] = { id: 'job-1', platform: 'qq', tabId: 7, state, expiresAt: Date.now() + 10000 };
    const reply = await x.send({ type: 'options:platform', platform: 'feishu' }, x.optionsSender);
    assert.equal(reply.ok, false, state); assert.match(reply.error, /待处理任务/);
    assert.equal(x.store['bot.bridge.job.7'].state, state);
  }
  assert.equal(x.calls.filter(call => call.path === '/v1/platform').length, 0);
  delete x.store['bot.bridge.job.7'];
  assert.deepEqual((await x.send({ type: 'options:platform', platform: 'feishu' }, x.optionsSender)).data, { ok: true, platform: 'feishu' });
  assert.equal((await x.send({ type: 'options:status' }, x.optionsSender)).data.platform, 'feishu');
});

test('a platform switch cannot pass a poll while its lease is awaiting durable local storage', async () => {
  let releasePoll;
  const x = await setup({ request: path => path === '/v1/poll' ? new Promise(resolve => { releasePoll = resolve; }) : undefined });
  const polling = x.send({ type: 'bridge:poll' });
  while (!releasePoll) await tick();
  let switched = false;
  const switching = x.send({ type: 'options:platform', platform: 'feishu' }, x.optionsSender).then(reply => { switched = true; return reply; });
  await tick(); assert.equal(switched, false);
  assert.equal(x.calls.filter(call => call.path === '/v1/platform').length, 0);
  releasePoll(inputPoll([]));
  assert.equal((await polling).ok, true);
  assert.equal((await switching).ok, false);
  assert.equal(x.store['bot.bridge.job.7'].platform, 'qq');
  assert.equal(x.calls.filter(call => call.path === '/v1/platform').length, 0);
});

test('a poll queued behind a platform switch leases only from the newly active platform', async () => {
  let releaseSwitch;
  const x = await setup({ request: path => path === '/v1/platform' ? new Promise(resolve => { releaseSwitch = () => resolve(undefined); }) : undefined });
  const switching = x.send({ type: 'options:platform', platform: 'feishu' }, x.optionsSender);
  while (!releaseSwitch) await tick();
  const polling = x.send({ type: 'bridge:poll', platform: 'qq' });
  await tick(); assert.equal(x.calls.filter(call => call.path === '/v1/poll').length, 0);
  releaseSwitch(); assert.equal((await switching).ok, true);
  assert.equal((await polling).data.job.platform, 'feishu');
  assert.equal(x.calls.find(call => call.path === '/v1/poll').body.platform, 'feishu');
  assert.equal(x.store['bot.bridge.job.7'].platform, 'feishu');
});

test('notices are visible and cleared only for the active platform', async () => {
  const store = {
    browserId: 'browser-one',
    'bot.bridge.notice.qq.7': { platform: 'qq', tabId: 7, at: 10, error: 'QQ notice' },
    'bot.bridge.notice.feishu.7': { platform: 'feishu', tabId: 7, at: 20, error: 'Feishu notice' },
  };
  const x = await setup({ store });
  assert.deepEqual((await x.send({ type: 'options:status' }, x.optionsSender)).data.localNotices.map(n => n.error), ['QQ notice']);
  assert.equal((await x.send({ type: 'options:clear-notices', platform: 'feishu' }, x.optionsSender)).ok, false);
  assert.ok(x.store['bot.bridge.notice.qq.7']); assert.ok(x.store['bot.bridge.notice.feishu.7']);
  assert.equal((await x.send({ type: 'options:clear-notices' }, x.optionsSender)).ok, true);
  assert.equal(x.store['bot.bridge.notice.qq.7'], undefined); assert.ok(x.store['bot.bridge.notice.feishu.7']);
  await x.send({ type: 'options:platform', platform: 'feishu' }, x.optionsSender);
  assert.deepEqual((await x.send({ type: 'options:status' }, x.optionsSender)).data.localNotices.map(n => n.error), ['Feishu notice']);
});

const wakeStatus = (platform = 'qq', { groups, jobs } = {}) => ({
  configured: true, appId: 'fixture', platform, connection: { state: 'connected' }, delivery: [],
  groups: groups ?? [{ chatId: 'queued-group', binding: { browserId: 'browser-one', tabId: 7, conversationUrl: url } }],
  jobs: jobs ?? [{ id: 'queued-job', chatId: 'queued-group', state: 'queued' }],
});
const wakeSender = x => ({ id: x.chrome.runtime.id, url: x.chrome.runtime.getURL('offscreen.html') });
function notifyWork(x, message = { type: 'bridge:work-available' }, sender = wakeSender(x)) {
  const responses = [];
  const keepOpen = x.chrome.runtime.onMessage.listeners[0](message, sender, value => responses.push(value));
  return { keepOpen, responses };
}
async function flushWakes() {
  await new Promise(resolve => setTimeout(resolve, 0));
  for (let i = 0; i < 12; i++) await tick();
}

test('only a payload-free work notification from the exact offscreen document can wake a bound page', async () => {
  const x = await setup({ request: path => path === '/v1/status' ? wakeStatus() : undefined });
  const source = wakeSender(x);
  for (const sender of [x.sender, x.optionsSender, { ...source, id: 'another-extension' }, { ...source, url: source.url + '?extra' }, { id: source.id }, { ...source, tab: { id: 7 } }, { ...source, tab: null }]) {
    assert.deepEqual(notifyWork(x, undefined, sender), { keepOpen: false, responses: [] });
  }
  for (const message of [{ type: 'bridge:work-available', prompt: 'private' }, { type: 'bridge:work-available', platform: 'feishu' }, { type: 'bridge:work-available', target: 'bridge-host' }]) {
    assert.deepEqual(notifyWork(x, message), { keepOpen: false, responses: [] });
  }
  await flushWakes(); assert.equal(x.calls.length, 0); assert.deepEqual(x.tabMessages, []);
  assert.deepEqual(notifyWork(x), { keepOpen: false, responses: [{ ok: true }] });
  await flushWakes();
  assert.deepEqual(x.tabMessages, [{ tabId: 7, message: { type: 'bridge:wake' }, options: { frameId: 0 } }]);
  assert.deepEqual(x.calls.map(call => call.path), ASSISTANTS.map(() => '/v1/status'));
  assert.equal(x.store['bot.bridge.job.7'], undefined, 'a wake must not lease or persist a task');
});

test('work wakeups target only active queued groups owned by this browser and still on the bound conversation', async () => {
  const groups = [
    { chatId: 'queued-group', binding: { browserId: 'browser-one', tabId: 7, conversationUrl: url } },
    { chatId: 'duplicate-group', binding: { browserId: 'browser-one', tabId: 7, conversationUrl: url } },
    { chatId: 'other-browser', binding: { browserId: 'another-browser', tabId: 8, conversationUrl: url } },
    { chatId: 'navigated', binding: { browserId: 'browser-one', tabId: 9, conversationUrl: url } },
    { chatId: 'closed', binding: { browserId: 'browser-one', tabId: 10, conversationUrl: url } },
    { chatId: 'running', binding: { browserId: 'browser-one', tabId: 11, conversationUrl: url } },
    { chatId: 'unbound' },
  ];
  const jobs = groups.map(group => ({ id: group.chatId, chatId: group.chatId, state: group.chatId === 'running' ? 'running' : 'queued' }));
  for (const platform of ['qq', 'feishu']) {
    const x = await setup({ platform, request: path => path === '/v1/status' ? wakeStatus(platform, { groups, jobs }) : undefined });
    x.otherTabs.set(8, { id: 8, url }); x.otherTabs.set(9, { id: 9, url: 'https://evil.test/' }); x.otherTabs.set(11, { id: 11, url });
    notifyWork(x); await flushWakes();
    assert.deepEqual(x.tabMessages.map(message => message.tabId), [7]);
    assert.deepEqual(x.tabMessages[0].message, { type: 'bridge:wake' });
    assert.ok(x.calls.every(call => call.path === '/v1/status'));
    assert.equal(x.store['bot.bridge.job.7'], undefined);
  }
});

test('work notification bursts coalesce while an arrival during dispatch requests one follow-up pass', async () => {
  let release; let statusReads = 0;
  const x = await setup({ request: (path, body) => {
    if (path !== '/v1/status' || body.assistant !== 'chatgpt') return;
    statusReads++;
    if (statusReads === 1) return new Promise(resolve => { release = () => resolve(wakeStatus()); });
    return wakeStatus();
  } });
  for (let i = 0; i < 30; i++) notifyWork(x);
  await flushWakes(); assert.equal(statusReads, 1); assert.deepEqual(x.tabMessages, []);
  for (let i = 0; i < 30; i++) notifyWork(x);
  release(); await flushWakes(); await flushWakes();
  assert.equal(statusReads, 2); assert.equal(x.tabMessages.length, 2);
  assert.ok(x.calls.every(call => call.path === '/v1/status'));
});

test('failed page wake does not change a queued job or prevent a later wake', async () => {
  let unavailable = true;
  const x = await setup({ request: path => path === '/v1/status' ? wakeStatus() : undefined, sendTabMessage: () => { if (unavailable) throw Error('no receiver'); } });
  notifyWork(x); await flushWakes();
  assert.equal(x.tabMessages.length, 1); assert.equal(x.store['bot.bridge.job.7'], undefined);
  unavailable = false; notifyWork(x); await flushWakes();
  assert.equal(x.tabMessages.length, 2);
  assert.ok(x.calls.every(call => call.path === '/v1/status'));
});

test('startup wakes an existing queue and a maintenance alarm recovers a missed wake without a new work event', async () => {
  let unavailable = true;
  const x = await setup({
    initialStatus: () => wakeStatus(),
    request: path => path === '/v1/status' ? wakeStatus() : undefined,
    sendTabMessage: () => { if (unavailable) throw Error('page still loading'); },
  });
  assert.equal(x.startupCalls.length, ASSISTANTS.length);
  assert.equal(x.tabMessages.length, 1);
  unavailable = false;
  await x.alarm(); await flushWakes();
  assert.equal(x.tabMessages.length, 2);
  await x.startup(); await flushWakes();
  assert.equal(x.tabMessages.length, 3);
  assert.equal(x.store['bot.bridge.job.7'], undefined);
  assert.ok(x.calls.every(call => call.path === '/v1/status'));
});

test('page load and thaw lifecycle events wake queued bindings without changing tabs or leasing work', async () => {
  const x = await setup({ request: path => path === '/v1/status' ? wakeStatus() : undefined });
  for (const change of [{ status: 'loading' }, { title: 'new title' }, { frozen: true }, { discarded: true }]) x.chrome.tabs.onUpdated.listeners[0](7, change);
  await flushWakes(); assert.equal(x.tabMessages.length, 0);
  for (const change of [{ status: 'complete' }, { frozen: false }, { discarded: false }]) {
    x.chrome.tabs.onUpdated.listeners[0](7, change);
    await flushWakes();
  }
  assert.equal(x.tabMessages.length, 3);
  assert.ok(x.tabMessages.every(({ tabId, message, options }) => tabId === 7 && message.type === 'bridge:wake' && options.frameId === 0));
  assert.ok(x.calls.every(call => call.path === '/v1/status'));
  assert.equal(x.store['bot.bridge.job.7'], undefined);
  x.tab.url = 'https://chatgpt.com/c/different-conversation';
  x.chrome.tabs.onUpdated.listeners[0](7, { status: 'complete' });
  await flushWakes(); assert.equal(x.tabMessages.length, 3);
});

test('maintenance wakes leased and started jobs without replaying a submission even when the backend has no queued groups', async () => {
  const x = await setup();
  await x.send({ type: 'bridge:poll' });
  await x.alarm(); await flushWakes();
  assert.deepEqual(x.tabMessages, [{ tabId: 7, message: { type: 'bridge:wake' }, options: { frameId: 0 } }]);
  assert.equal(x.calls.filter(call => call.path === '/v1/poll').length, 1);
  assert.equal(x.store['bot.bridge.job.7'].state, 'leased');
  await x.send({ type: 'bridge:started', jobId: 'job-1' });
  await x.alarm(); await flushWakes();
  assert.equal(x.tabMessages.length, 2);
  assert.equal(x.calls.filter(call => call.path.endsWith('/started')).length, 1);
});

test('maintenance never wakes a mismatched or pre-upgrade local lease', async () => {
  for (const modify of [
    x => { x.store['bot.bridge.job.7'].browserId = 'another-browser'; },
    x => { x.store['bot.bridge.job.7'].tabId = 8; },
    x => { delete x.store['bot.bridge.job.7'].prompt; },
    x => { x.tab.url = 'https://chatgpt.com/c/different-conversation'; },
  ]) {
    const x = await setup(); await x.send({ type: 'bridge:poll' });
    modify(x);
    await x.alarm(); await flushWakes();
    assert.equal(x.tabMessages.length, 0);
    assert.equal(x.calls.filter(call => call.path === '/v1/poll').length, 1);
  }
});

test('queued-page recovery does not wait for an unrelated pending result delivery', async () => {
  let releaseDelivery;
  const x = await setup({ request: path => path === '/v1/status' ? wakeStatus() : path.endsWith('/result') ? new Promise(resolve => { releaseDelivery = resolve; }) : undefined });
  x.store['bot.bridge.job.8'] = { id: 'slow-result', assistant: 'chatgpt', platform: 'qq', browserId: 'browser-one', tabId: 8, conversationUrl: url, leaseToken: 'result-secret', sessionId, state: 'result-pending', text: 'Final reply', expiresAt: Date.now() + 600000 };
  await x.alarm(); await flushWakes();
  assert.equal(typeof releaseDelivery, 'function');
  assert.equal(x.tabMessages.length, 1);
  assert.equal(x.tabMessages[0].tabId, 7);
  assert.equal(x.store['bot.bridge.job.8'].state, 'result-pending');
  releaseDelivery({ ok: true }); await tick(); await tick();
});

test('binding a queued group wakes the confirmed bound page after a successful host acknowledgement', async () => {
  const x = await setup({ request: path => path === '/v1/status' ? wakeStatus() : undefined });
  assert.equal((await x.send({ type: 'options:bind', platform: 'qq', chatId: 'queued-group', tabId: 7 }, x.optionsSender)).ok, true);
  await flushWakes();
  assert.deepEqual(x.tabMessages, [{ tabId: 7, message: { type: 'bridge:wake' }, options: { frameId: 0 } }]);
  assert.equal(x.calls.filter(call => call.path === '/v1/poll').length, 0);
});

test('an unanswered page wake cannot hold later wake batches open', async () => {
  const x = await setup({ request: path => path === '/v1/status' ? wakeStatus() : undefined, sendTabMessage: () => new Promise(() => {}) });
  notifyWork(x); await flushWakes(); assert.equal(x.tabMessages.length, 1);
  notifyWork(x); await flushWakes(); assert.equal(x.tabMessages.length, 2);
  assert.equal(x.calls.filter(call => call.path === '/v1/status').length, ASSISTANTS.length * 2);
});

test('a queued group outside the recent history still receives an event wake', async () => {
  const state = { ...wakeStatus('qq', { jobs: [{ id: 'recent', chatId: 'another-group', state: 'completed' }] }), queuedChatIds: ['queued-group'] };
  const x = await setup({ request: path => path === '/v1/status' ? state : undefined });
  notifyWork(x); await flushWakes();
  assert.deepEqual(x.tabMessages.map(message => message.tabId), [7]);
  assert.equal(x.store['bot.bridge.job.7'], undefined);
});

test('Claude page identity comes from trusted live origin, never page-supplied assistant', async () => {
  const x = await setup({ assistant: 'claude' });
  const polled = await x.send({ type: 'bridge:poll', assistant: 'chatgpt' });
  assert.equal(polled.ok, true); assert.equal(polled.data.job.assistant, 'claude');
  assert.equal(x.calls.find(c => c.path === '/v1/poll').body.assistant, 'claude');
  assert.equal((await x.send({ type: 'bridge:started', jobId: 'job-1', assistant: 'chatgpt' })).ok, true);
  assert.equal((await x.send({ type: 'bridge:result', jobId: 'job-1', text: 'Claude answer', assistant: 'chatgpt' })).ok, true);
  assert.equal(x.calls.find(c => c.path.endsWith('/result')).body.assistant, 'claude');
  assert.equal(x.store['bot.bridge.job.7'], undefined);
});

test('provider mismatch, forged host owner, and Claude lookalike origins cannot acquire a lease', async () => {
  let x = await setup({ assistant: 'claude', request: (path, body) => path === '/v1/poll' ? {job:{...inputPoll([]).job, assistant:'chatgpt', conversationUrl:body.conversationUrl}} : undefined });
  assert.equal((await x.send({type:'bridge:poll'})).ok, false); assert.equal(x.store['bot.bridge.job.7'], undefined);
  x = await setup({assistant:'claude'});
  for (const url of ['https://claude.ai.evil.test/chat/abcdefgh','https://evil@claude.ai/chat/abcdefgh','http://claude.ai/chat/abcdefgh','https://claude.ai:444/chat/abcdefgh']) {
    assert.equal((await x.send({type:'bridge:poll'}, {...x.sender,url})).ok,false);
  }
  const gptSender={...x.sender,url:'https://chatgpt.com/',origin:'https://chatgpt.com'};
  assert.equal((await x.send({type:'bridge:poll'},gptSender)).ok,false);
  assert.equal(x.calls.length,0);
});

test('disabled assistant pages cannot poll; toggling one profile does not disable the other', async () => {
  const x = await setup({assistant:'claude'});
  assert.equal((await x.send({type:'options:assistant',assistant:'claude',enabled:false},x.optionsSender)).ok,true);
  assert.deepEqual((await x.send({type:'bridge:poll'})).data,{job:null});
  assert.equal(x.calls.filter(c=>c.path==='/v1/poll').length,0);
  const gpt=await x.send({type:'options:status',assistant:'chatgpt'},x.optionsSender);
  assert.equal(gpt.data.enabled,true);
});

test('local running tasks block only their own assistant switch and disable operations', async () => {
  const x=await setup(); await x.send({type:'bridge:poll'});
  assert.equal((await x.send({type:'options:assistant',assistant:'chatgpt',enabled:false},x.optionsSender)).ok,false);
  assert.equal((await x.send({type:'options:platform',assistant:'claude',platform:'feishu'},x.optionsSender)).ok,true);
  assert.equal((await x.send({type:'options:assistant',assistant:'claude',enabled:true},x.optionsSender)).ok,true);
  assert.equal(x.store['bot.bridge.job.7'].assistant,'chatgpt');
});

test('one delayed GPT lease does not block Claude or Gemini leases in other tabs', async () => {
  let release;
  const claudeUrl='https://claude.ai/chat/parallel-fixture';
  const geminiUrl='https://gemini.google.com/u/1/app/parallel-fixture';
  const x=await setup({request:(path,body)=> {
    if(path==='/v1/status'&&body.assistant!=='chatgpt')return {...wakeStatus(),enabled:true,groups:[],jobs:[]};
    if(path==='/v1/poll'&&body.assistant==='chatgpt')return new Promise(resolve=>{release=()=>resolve(inputPoll([]));});
  }});
  x.otherTabs.set(8,{id:8,url:claudeUrl});
  x.otherTabs.set(9,{id:9,url:geminiUrl});
  const pending=x.send({type:'bridge:poll'});
  while(!release)await tick();
  const sender={...x.sender,url:claudeUrl,origin:'https://claude.ai',tab:{id:8,url:claudeUrl}};
  const result=await x.send({type:'bridge:poll',conversationUrl:claudeUrl},sender);
  assert.equal(result.ok,true);assert.equal(result.data.job.assistant,'claude');
  const geminiSender={...x.sender,url:geminiUrl,origin:'https://gemini.google.com',tab:{id:9,url:geminiUrl}};
  const geminiResult=await x.send({type:'bridge:poll',conversationUrl:geminiUrl},geminiSender);
  assert.equal(geminiResult.ok,true);assert.equal(geminiResult.data.job.assistant,'gemini');
  release();assert.equal((await pending).data.job.assistant,'chatgpt');
});

test('wake notifications independently target the bound pages of all four assistants', async () => {
  const urls={chatgpt:url,claude:'https://claude.ai/chat/parallel-fixture',gemini:'https://gemini.google.com/u/1/app/parallel-fixture',qwen:'https://chat.qwen.ai/c/parallel-fixture'};
  const x=await setup({request:(path,body)=>path==='/v1/status'?{
    ...wakeStatus(),enabled:true,groups:[{chatId:'queued-group',binding:{browserId:'browser-one',tabId:7+ASSISTANTS.indexOf(body.assistant),conversationUrl:urls[body.assistant]}}]
  }:undefined});
  x.otherTabs.set(8,{id:8,url:urls.claude});x.otherTabs.set(9,{id:9,url:urls.gemini});x.otherTabs.set(10,{id:10,url:urls.qwen});
  notifyWork(x);await flushWakes();
  assert.deepEqual(x.tabMessages.map(m=>m.tabId).sort((a,b)=>a-b),[7,8,9,10]);
  assert.ok(x.tabMessages.every(m=>JSON.stringify(m.message)==='{"type":"bridge:wake"}'));
});

test('settings bind and tab lists reject other provider conversations and notices remain separate', async () => {
  const x=await setup({store:{browserId:'browser-one','bot.bridge.notice.qq.7':{error:'GPT only'},'bot.bridge.notice.claude.qq.7':{error:'Claude only'}}});
  const claudeUrl='https://claude.ai/chat/parallel-fixture';x.otherTabs.set(8,{id:8,url:claudeUrl});
  assert.equal((await x.send({type:'options:bind',assistant:'claude',platform:'qq',chatId:'group',tabId:7},x.optionsSender)).ok,false);
  assert.deepEqual((await x.send({type:'options:tabs',assistant:'claude'},x.optionsSender)).data.tabs.map(t=>t.tabId),[8]);
  assert.equal((await x.send({type:'options:bind',assistant:'claude',platform:'qq',chatId:'group',tabId:8,conversationUrl:claudeUrl},x.optionsSender)).ok,true);
  assert.equal(x.calls.find(c=>c.path==='/v1/bind').body.assistant,'claude');
  await x.send({type:'options:clear-notices',assistant:'claude',platform:'qq'},x.optionsSender);
  assert.ok(x.store['bot.bridge.notice.qq.7']);assert.equal(x.store['bot.bridge.notice.claude.qq.7'],undefined);
});

test('pre-upgrade durable GPT result is retried under GPT identity only', async () => {
  const job={id:'old-job',platform:'qq',leaseToken:'old-lease',browserId:'browser-one',tabId:7,conversationUrl:url,sessionId,state:'result-pending',text:'preserved answer',expiresAt:Date.now()+60000};
  const x=await setup({store:{browserId:'browser-one','bot.bridge.job.7':job}});
  const delivered=x.calls.find(c=>c.path.endsWith('/result'));
  assert.equal(delivered.body.assistant,'chatgpt');assert.equal(delivered.body.text,'preserved answer');
  assert.equal(x.store['bot.bridge.job.7'],undefined);
});

test('Gemini origin owns its lease, start and result even if the page claims another assistant', async () => {
  const x = await setup({ assistant: 'gemini' });
  const polled = await x.send({ type: 'bridge:poll', assistant: 'claude' });
  assert.equal(polled.ok, true); assert.equal(polled.data.job.assistant, 'gemini');
  assert.equal(x.calls.find(c => c.path === '/v1/poll').body.assistant, 'gemini');
  assert.equal((await x.send({ type: 'bridge:started', jobId: 'job-1', assistant: 'chatgpt' })).ok, true);
  assert.equal((await x.send({ type: 'bridge:result', jobId: 'job-1', text: 'Gemini answer', assistant: 'claude' })).ok, true);
  assert.equal(x.calls.find(c => c.path.endsWith('/result')).body.assistant, 'gemini');
  assert.equal(x.store['bot.bridge.job.7'], undefined);
});

test('Gemini rejects forged provider leases, untrusted origins and other assistants on the same tab', async () => {
  let x = await setup({ assistant: 'gemini', request: (path, body) => path === '/v1/poll' ? { job: { ...inputPoll([]).job, assistant: 'claude', conversationUrl: body.conversationUrl } } : undefined });
  assert.equal((await x.send({ type: 'bridge:poll' })).ok, false); assert.equal(x.store['bot.bridge.job.7'], undefined);
  x = await setup({ assistant: 'gemini' });
  for (const url of ['https://gemini.google.com.evil.test/app/abcdefgh', 'https://user@gemini.google.com/app/abcdefgh', 'http://gemini.google.com/app/abcdefgh', 'https://gemini.google.com:444/app/abcdefgh', 'https://claude.ai/chat/abcdefgh', 'https://chatgpt.com/c/abcdefgh']) {
    assert.equal((await x.send({ type: 'bridge:poll' }, { ...x.sender, url })).ok, false);
  }
  assert.equal((await x.send({ type: 'bridge:poll' }, { ...x.sender, origin: 'https://claude.ai' })).ok, false);
  assert.equal(x.calls.length, 0);
});

test('Gemini settings expose only existing Gemini tabs and retain separate notices and switches', async () => {
  const x = await setup({ store: { browserId: 'browser-one', 'bot.bridge.notice.qq.7': { error: 'GPT only' }, 'bot.bridge.notice.claude.qq.8': { error: 'Claude only' }, 'bot.bridge.notice.gemini.qq.9': { error: 'Gemini only' } } });
  const geminiUrl = 'https://gemini.google.com/u/2/app/fixture-conversation';
  x.otherTabs.set(8, { id: 8, url: 'https://claude.ai/chat/fixture-conversation' });
  x.otherTabs.set(9, { id: 9, url: geminiUrl });
  x.otherTabs.set(10, { id: 10, url: 'https://gemini.google.com/app' });
  x.otherTabs.set(11, { id: 11, url: 'https://gemini.google.com/share/fixture-conversation' });
  const tabs = await x.send({ type: 'options:tabs', assistant: 'gemini' }, x.optionsSender);
  assert.deepEqual(tabs.data.tabs, [{ tabId: 9, title: 'Gemini 对话', conversationUrl: geminiUrl }]);
  for (const tabId of [7, 8, 10, 11]) assert.equal((await x.send({ type: 'options:bind', assistant: 'gemini', platform: 'qq', chatId: 'group', tabId, conversationUrl: geminiUrl }, x.optionsSender)).ok, false);
  assert.equal((await x.send({ type: 'options:bind', assistant: 'gemini', platform: 'qq', chatId: 'group', tabId: 9, conversationUrl: geminiUrl }, x.optionsSender)).ok, true);
  assert.equal(x.calls.find(c => c.path === '/v1/bind').body.assistant, 'gemini');
  const status = await x.send({ type: 'options:status', assistant: 'gemini' }, x.optionsSender);
  assert.deepEqual(status.data.localNotices.map(n => n.error), ['Gemini only']);
  assert.equal(status.data.enabled, false);
  await x.send({ type: 'options:clear-notices', assistant: 'gemini', platform: 'qq' }, x.optionsSender);
  assert.ok(x.store['bot.bridge.notice.qq.7']); assert.ok(x.store['bot.bridge.notice.claude.qq.8']); assert.equal(x.store['bot.bridge.notice.gemini.qq.9'], undefined);
  await x.send({ type: 'options:assistant', assistant: 'gemini', enabled: true }, x.optionsSender);
  assert.equal((await x.send({ type: 'options:status', assistant: 'chatgpt' }, x.optionsSender)).data.enabled, true);
  assert.equal((await x.send({ type: 'options:status', assistant: 'claude' }, x.optionsSender)).data.enabled, false);
});

test('Gemini recovers only its same-session unstarted lease without extending it or replaying started work', async () => {
  const x = await setup({ assistant: 'gemini' });
  const original = await x.send({ type: 'bridge:poll' });
  const leased = structuredClone(x.store['bot.bridge.job.7']);
  const replay = await x.send({ type: 'bridge:poll' });
  assert.equal(replay.data.job.id, original.data.job.id);
  assert.equal(replay.data.job.assistant, 'gemini'); assert.equal(replay.data.job.prompt, 'Hello');
  assert.equal(x.store['bot.bridge.job.7'].expiresAt, leased.expiresAt);
  assert.equal(x.calls.filter(c => c.path === '/v1/poll').length, 1);
  x.tabMessages.length = 0; await x.alarm(); await flushWakes();
  assert.deepEqual(x.tabMessages.map(m => m.tabId), [7]);
  await x.send({ type: 'bridge:started', jobId: 'job-1' });
  assert.equal(x.store['bot.bridge.job.7'].prompt, undefined);
  assert.deepEqual((await x.send({ type: 'bridge:poll' })).data, { job: null, busy: true });
  assert.equal(x.calls.filter(c => c.path === '/v1/poll').length, 1);
});

test('Gemini cannot inherit a pre-upgrade lease without an explicit assistant identity', async () => {
  const geminiUrl = 'https://gemini.google.com/app/fixture-conversation';
  const job = { id: 'old-job', platform: 'qq', leaseToken: 'old-lease', browserId: 'browser-one', tabId: 7, conversationUrl: geminiUrl, sessionId, state: 'leased', prompt: 'do not replay', expiresAt: Date.now() + 60000 };
  const x = await setup({ assistant: 'gemini', store: { browserId: 'browser-one', 'bot.bridge.job.7': job } });
  x.tab.url = geminiUrl;
  assert.equal((await x.send({ type: 'bridge:poll', conversationUrl: geminiUrl })).ok, false);
  assert.equal(x.calls.some(c => c.path === '/v1/poll' || c.path.endsWith('/started')), false);
  assert.equal(x.store['bot.bridge.job.7'].assistant, undefined);
});


test('history clearing authorizes the settings page and routes only the explicit assistant and active platform', async () => {
  const x = await setup({ assistant: 'gemini', platform: 'feishu', request: async path => path === '/v1/history/clear' ? { ok: true, count: 3 } : undefined });
  assert.equal((await x.send({ type: 'options:clear-history', assistant: 'gemini', platform: 'feishu' })).ok, false);
  assert.equal((await x.send({ type: 'options:clear-history', assistant: 'gemini', platform: 'qq' }, x.optionsSender)).ok, false);
  assert.deepEqual((await x.send({ type: 'options:clear-history', assistant: 'gemini', platform: 'feishu' }, x.optionsSender)).data, { ok: true, count: 3 });
  assert.deepEqual(x.calls.filter(call => call.path === '/v1/history/clear').map(call => call.body), [{ assistant: 'gemini', platform: 'feishu' }]);
  assert.equal(x.tabMessages.length, 0);
});

function dualStatus(selected = 'qq') {
  const platforms = Object.fromEntries(['qq', 'feishu'].map((platform, i) => [platform, {
    enabled: true, running: true, configured: true, connection: { state: 'connected' },
    groups: [{ chatId: platform + '-group', binding: { browserId: 'browser-one', tabId: 7 + i, conversationUrl: i ? url + '-feishu' : url } }],
    queuedChatIds: [platform + '-group'],
  }]));
  return { configured: true, appId: 'fixture', platform: selected, channelEnabled: true, running: true,
    connection: { state: 'connected' }, groups: platforms[selected].groups, jobs: [], delivery: [], platforms };
}
async function dualFixture(extra = {}) {
  const state = dualStatus();
  const x = await setup({ dual: true, request: (path, body) => {
    const result = extra.request?.(path, body, state);
    if (result !== undefined) return result;
    if (path === '/v1/status') return { ...state, platform: body.platform || state.platform, groups: state.platforms[body.platform || state.platform].groups };
  }, ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'request')) });
  const feishuTab = { id: 8, url: url + '-feishu', title: 'Feishu dedicated conversation' }; x.otherTabs.set(8, feishuTab);
  return { ...x, state, feishuTab, feishuSender: { ...x.sender, url: feishuTab.url, tab: feishuTab } };
}

test('dual channels route each page by its real binding and retain origin after configuration selection', async () => {
  const x = await dualFixture();
  const qq = await x.send({ type: 'bridge:poll', platform: 'feishu' });
  const feishu = await x.send({ type: 'bridge:poll', platform: 'qq', conversationUrl: x.feishuTab.url }, x.feishuSender);
  assert.equal(qq.ok, true); assert.equal(qq.data.job.platform, 'qq');
  assert.equal(feishu.ok, true); assert.equal(feishu.data.job.platform, 'feishu');
  assert.deepEqual(x.calls.filter(c => c.path === '/v1/poll').map(c => [c.body.platform, c.body.tabId]), [['qq', 7], ['feishu', 8]]);
  const changed = await x.send({ type: 'options:platform', assistant: 'chatgpt', platform: 'feishu' }, x.optionsSender);
  assert.equal(changed.ok, true);
  x.state.platform = 'feishu';
  for (const [sender, conversationUrl] of [[x.sender, url], [x.feishuSender, x.feishuTab.url]]) {
    assert.equal((await x.send({ type: 'bridge:started', jobId: 'job-1', conversationUrl }, sender)).ok, true);
    assert.equal((await x.send({ type: 'bridge:result', jobId: 'job-1', conversationUrl, text: 'answer' }, sender)).ok, true);
  }
  assert.deepEqual(x.calls.filter(c => c.path.endsWith('/result')).map(c => c.body.platform), ['qq', 'feishu']);
});

test('dual wake hints reach queued bindings in both channels but skip disabled channels', async () => {
  const x = await dualFixture(); await x.alarm(); await flushWakes();
  assert.deepEqual([...new Set(x.tabMessages.map(m => m.tabId))].sort(), [7, 8]);
  x.tabMessages.length = 0; x.state.platforms.qq.enabled = false;
  await x.alarm(); await flushWakes();
  assert.deepEqual([...new Set(x.tabMessages.map(m => m.tabId))], [8]);
});

test('unbound, disabled and ambiguous pages cannot claim a job from the selected channel', async () => {
  for (const scenario of ['unbound', 'disabled', 'ambiguous']) {
    const x = await dualFixture();
    if (scenario === 'unbound') x.state.platforms.qq.groups = [];
    if (scenario === 'disabled') x.state.platforms.qq.enabled = false;
    if (scenario === 'ambiguous') x.state.platforms.feishu.groups = x.state.platforms.qq.groups;
    const result = await x.send({ type: 'bridge:poll', platform: 'qq' });
    if (scenario === 'ambiguous') { assert.equal(result.ok, false); assert.match(result.error, /多个通道/); }
    else assert.equal(result.data.job, null);
    assert.equal(x.calls.some(c => c.path === '/v1/poll'), false);
  }
});

test('channel disable checks only its own durable jobs; master disable checks both', async () => {
  const x = await dualFixture(); await x.send({ type: 'bridge:poll' });
  const change = (type, platform, enabled) => x.send({ type, platform, enabled, assistant: 'chatgpt' }, x.optionsSender);
  assert.equal((await change('options:channel', 'qq', false)).ok, false);
  assert.equal((await change('options:channel', 'feishu', false)).ok, true);
  assert.equal((await change('options:assistant', 'qq', false)).ok, false);
  assert.equal((await change('options:platform', 'feishu')).ok, true);
  assert.equal(x.store['bot.bridge.job.7'].platform, 'qq');
});

test('channel changes are options-only, validate inputs and reject incomplete acknowledgements', async () => {
  const x = await dualFixture({ request: path => path === '/v1/channel' ? { ok: true, platform: 'qq' } : undefined });
  for (const message of [
    { type: 'options:channel', assistant: 'chatgpt', platform: 'qq', enabled: false },
    { type: 'options:channel', assistant: 'chatgpt', platform: 'bad', enabled: false },
    { type: 'options:channel', assistant: 'chatgpt', platform: 'qq', enabled: 'false' },
  ]) {
    assert.equal((await x.send(message)).ok, false);
    assert.equal((await x.send(message, x.optionsSender)).ok, false);
  }
  assert.equal(x.calls.filter(c => c.path === '/v1/channel').length, 1);
});

test('settings and historical notices can be read and cleared on the nonselected channel', async () => {
  const x = await dualFixture();
  x.store['bot.bridge.notice.qq.7'] = { tabId: 7, error: 'QQ notice' };
  x.store['bot.bridge.notice.feishu.8'] = { tabId: 8, error: 'Feishu notice' };
  const result = await x.send({ type: 'options:status', assistant: 'chatgpt', platform: 'feishu' }, x.optionsSender);
  assert.equal(result.ok, true); assert.equal(result.data.platform, 'feishu');
  assert.equal(result.data.localNotices.length, 1); assert.equal(result.data.localNotices[0].error, 'Feishu notice');
  assert.equal((await x.send({ type: 'options:clear-notices', assistant: 'chatgpt', platform: 'feishu' }, x.optionsSender)).ok, true);
  assert.ok(x.store['bot.bridge.notice.qq.7']); assert.equal(x.store['bot.bridge.notice.feishu.8'], undefined);
});

test('Qwen origin owns its lease, start and result even if the page claims another assistant', async () => {
  const x = await setup({ assistant: 'qwen' });
  const polled = await x.send({ type: 'bridge:poll', assistant: 'claude' });
  assert.equal(polled.ok, true); assert.equal(polled.data.job.assistant, 'qwen');
  assert.equal(x.calls.find(c => c.path === '/v1/poll').body.assistant, 'qwen');
  assert.equal((await x.send({ type: 'bridge:started', jobId: 'job-1', assistant: 'chatgpt' })).ok, true);
  assert.equal((await x.send({ type: 'bridge:result', jobId: 'job-1', text: 'Qwen answer', assistant: 'claude' })).ok, true);
  assert.equal(x.calls.find(c => c.path.endsWith('/result')).body.assistant, 'qwen');
  assert.equal(x.store['bot.bridge.job.7'], undefined);
});

test('Qwen rejects forged provider leases, untrusted origins and other assistants on the same tab', async () => {
  let x = await setup({ assistant: 'qwen', request: (path, body) => path === '/v1/poll' ? { job: { ...inputPoll([]).job, assistant: 'claude', conversationUrl: body.conversationUrl } } : undefined });
  assert.equal((await x.send({ type: 'bridge:poll' })).ok, false); assert.equal(x.store['bot.bridge.job.7'], undefined);
  x = await setup({ assistant: 'qwen' });
  for (const url of ['https://chat.qwen.ai.evil.test/c/abcdefgh', 'https://user@chat.qwen.ai/c/abcdefgh', 'http://chat.qwen.ai/c/abcdefgh', 'https://chat.qwen.ai:444/c/abcdefgh', 'https://claude.ai/chat/abcdefgh', 'https://chatgpt.com/c/abcdefgh']) {
    assert.equal((await x.send({ type: 'bridge:poll' }, { ...x.sender, url })).ok, false);
  }
  assert.equal((await x.send({ type: 'bridge:poll' }, { ...x.sender, origin: 'https://claude.ai' })).ok, false);
  assert.equal(x.calls.length, 0);
});


const idleDiagnostics = { pageAgeMs: 700000, bridgeIdleMs: 650000, visibility: 'hidden', phase: 'idle-refresh' };
const idlePrepare = { type: 'bridge:idle-prepare', jobId: 'job-1', lastUserKey: 'message:previous-user', diagnostics: idleDiagnostics };
test('idle GPT refresh keeps the same unstarted lease, images and deadline across one new page session', async()=>{
  const x=await setup();await x.send({type:'bridge:poll'});const original=structuredClone(x.store['bot.bridge.job.7']);
  assert.equal((await x.send(idlePrepare)).ok,true);
  assert.equal((await x.send({type:'bridge:challenge-resume'})).data.job,null,'old document cannot resume itself');
  assert.equal((await x.send({type:'bridge:started',jobId:'job-1'})).ok,false);
  const nextSession='new_page_session_1234';const resumed=await x.send({type:'bridge:challenge-resume',sessionId:nextSession});
  assert.equal(resumed.ok,true);assert.equal(resumed.data.job.id,original.id);assert.equal(resumed.data.job.prompt,original.prompt);
  assert.deepEqual(resumed.data.job.idleRefresh,{idleMs:650000,lastUserKey:'message:previous-user'});
  assert.equal(x.store['bot.bridge.job.7'].expiresAt,original.expiresAt);assert.equal(x.store['bot.bridge.job.7'].leaseToken,original.leaseToken);
  assert.equal((await x.send({...idlePrepare,sessionId:nextSession})).ok,false,'never refresh same task again');
  assert.equal((await x.send({type:'bridge:started',jobId:'job-1',sessionId:nextSession})).ok,true);
  assert.equal((await x.send({type:'bridge:result',jobId:'job-1',sessionId:nextSession,text:'Success'})).ok,true);
  assert.equal(x.calls.filter(c=>c.path==='/v1/poll').length,1);
  assert.equal(x.calls.filter(c=>c.path.endsWith('/started')).length,1);
});
test('idle refresh refuses other providers, insufficient idle time, started jobs and expired jobs',async()=>{
  for(const assistant of ['claude','gemini','qwen']){const x=await setup({assistant});await x.send({type:'bridge:poll'});assert.equal((await x.send(idlePrepare)).ok,false);}
  for(const scenario of ['short','started','expired','bad-key']){const x=await setup();await x.send({type:'bridge:poll'});const m=structuredClone(idlePrepare);if(scenario==='short')m.diagnostics.bridgeIdleMs=1;if(scenario==='started')await x.send({type:'bridge:started',jobId:'job-1'});if(scenario==='expired')x.store['bot.bridge.job.7'].expiresAt=Date.now();if(scenario==='bad-key')m.lastUserKey={prompt:'private'};assert.equal((await x.send(m)).ok,false,scenario);}
});
test('a second reload after idle recovery cannot authorize submission in another document',async()=>{
  const x=await setup();await x.send({type:'bridge:poll'});await x.send(idlePrepare);
  await x.send({type:'bridge:challenge-resume',sessionId:'new_page_session_1234'});
  const again=await x.send({type:'bridge:challenge-resume',sessionId:'other_page_session_1234'});
  assert.equal(again.data.job,null);assert.equal(x.store['bot.bridge.job.7'],undefined);assert.equal(x.calls.some(c=>c.path.endsWith('/started')),false);
});
test('page diagnostics are bounded local fields, never forwarded to the robot host',async()=>{
  const x=await setup();await x.send({type:'bridge:poll'});
  await x.send({type:'bridge:error',jobId:'job-1',error:'cloudflare_challenge',diagnostics:{...idleDiagnostics,phase:'answer',prompt:'secret message',token:'private token'}});
  assert.deepEqual(x.store['bot.bridge.notice.qq.7'].diagnostics,{...idleDiagnostics,phase:'answer'});
  assert.equal(Object.hasOwn(x.calls.find(c=>c.path.endsWith('/error')).body,'diagnostics'),false);
  assert.doesNotMatch(JSON.stringify(x.store),/secret message|private token/);
});

test('idle recovery retains image metadata but exposes no lease credentials and expires without submitting',async()=>{
  const x=await setup({request:path=>path==='/v1/poll'?inputPoll([inputMeta]):undefined});
  await x.send({type:'bridge:poll',capabilities:['image-input-v1']});await x.send(idlePrepare);
  const r=await x.send({type:'bridge:challenge-resume',sessionId:'new_document_session'});
  assert.deepEqual(r.data.job.images,[inputMeta]);assert.doesNotMatch(JSON.stringify(r.data.job),/lease-secret|browser-one/);
  const y=await setup();await y.send({type:'bridge:poll'});await y.send(idlePrepare);y.store['bot.bridge.job.7'].expiresAt=Date.now()-1;
  assert.equal((await y.send({type:'bridge:challenge-resume',sessionId:'new_document_session'})).data.job,null);
  assert.equal(y.store['bot.bridge.job.7'],undefined);assert.equal(y.calls.some(c=>c.path.endsWith('/started')),false);
});

test('started tasks receive load and thaw wake hints without new host submissions or foreground activation', async () => {
  const x = await setup(); await x.send({ type: 'bridge:poll' }); await x.send({ type: 'bridge:started', jobId: 'job-1' });
  const originalCalls = x.calls.length;
  for (const change of [{ status: 'complete' }, { frozen: false }, { discarded: false }]) {
    x.chrome.tabs.onUpdated.listeners[0](7, change); await flushWakes();
  }
  assert.deepEqual(x.tabMessages.map(item => item.tabId), [7, 7, 7]);
  assert.ok(x.tabMessages.every(item => item.message.type === 'bridge:wake'));
  assert.ok(x.calls.slice(originalCalls).every(call => call.path === '/v1/status'));
  assert.ok(x.tabUpdates.every(update => !Object.hasOwn(update.properties, 'active')));
});

test('one-second page wake pulse only scans live local jobs and stops when work ends or expires', async t => {
  const x = await setup();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await x.send({ type: 'bridge:poll' }); await x.send({ type: 'bridge:started', jobId: 'job-1' });
    const originalCalls = x.calls.length;
    for (let i = 0; i < 3; i++) { t.mock.timers.tick(1000); for (let j = 0; j < 6; j++) await tick(); }
    assert.equal(x.tabMessages.length, 3);
    assert.equal(x.calls.length, originalCalls, 'pulse never calls host status or submit');
    assert.ok(x.tabUpdates.every(update => !Object.hasOwn(update.properties, 'active')));
    await x.send({ type: 'bridge:error', jobId: 'job-1', error: 'Stopped' });
    t.mock.timers.tick(1000); for (let j = 0; j < 6; j++) await tick();
    t.mock.timers.tick(600000); await tick();
    assert.equal(x.tabMessages.length, 3, 'the empty pulse loop does not persist');
    await x.send({ type: 'bridge:poll' });
    x.store['bot.bridge.job.7'].expiresAt = Date.now() - 1;
    t.mock.timers.tick(1000); for (let j = 0; j < 6; j++) await tick();
    t.mock.timers.tick(600000); await tick();
    assert.equal(x.tabMessages.length, 3, 'expired tasks cannot keep the pulse alive');
  } finally { activeWorker.stopPageWakePulse(); }
});

test('leasing protects the bound tab from discarding without activating it, and completion restores its previous setting', async () => {
  for (const assistant of ASSISTANTS) {
    const x = await setup({ assistant });
    const result = await x.send({ type: 'bridge:poll' });
    assert.equal(result.ok, true);
    assert.equal(Object.hasOwn(result.data.job, 'foregroundRequired'), false);
    assert.equal(x.tab.active, false);
    assert.equal(x.tab.autoDiscardable, false);
    assert.deepEqual(x.tabUpdates, [{ tabId: 7, properties: { autoDiscardable: false } }]);
    await x.send({ type: 'bridge:started', jobId: 'job-1' });
    assert.equal(x.tab.autoDiscardable, false, 'protection remains while the answer generates');
    await x.send({ type: 'bridge:result', jobId: 'job-1', text: 'Done', images: [] });
    assert.equal(x.tab.autoDiscardable, true);
    assert.equal(x.store['bot.bridge.tab-protection.7'], undefined);
    assert.ok(x.tabUpdates.every(update => !Object.hasOwn(update.properties, 'active')));
  }
});

test('error, expiry, navigation and tab close release discard protection; a pre-existing false value is never changed', async () => {
  for (const termination of ['error', 'expiry', 'navigation', 'closed']) {
    const x = await setup(); await x.send({ type: 'bridge:poll' });
    assert.equal(x.tab.autoDiscardable, false);
    if (termination === 'error') await x.send({ type: 'bridge:error', jobId: 'job-1', error: 'Stopped' });
    else if (termination === 'expiry') { x.store['bot.bridge.job.7'].expiresAt = Date.now() - 1; await x.alarm(); }
    else if (termination === 'closed') { x.chrome.tabs.onRemoved.listeners[0](7); for (let i = 0; i < 12; i++) await tick(); }
    else {
      x.tab.url = 'https://chatgpt.com/c/another-conversation';
      x.chrome.tabs.onUpdated.listeners[0](7, { url: x.tab.url });
      for (let i = 0; i < 12; i++) await tick();
    }
    assert.equal(x.store['bot.bridge.job.7'], undefined, termination);
    assert.equal(x.store['bot.bridge.tab-protection.7'], undefined, termination);
    if (termination !== 'closed') assert.equal(x.tab.autoDiscardable, true, termination);
    assert.ok(x.tabUpdates.every(update => !Object.hasOwn(update.properties, 'active')));
  }
  const x = await setup(); x.tab.autoDiscardable = false;
  await x.send({ type: 'bridge:poll' }); await x.send({ type: 'bridge:error', jobId: 'job-1', error: 'Stopped' });
  assert.equal(x.tab.autoDiscardable, false);
  assert.deepEqual(x.tabUpdates, []);
});

test('failed discard restoration remains durable across worker restart and retries after the completed job is gone', async () => {
  const x = await setup(); await x.send({ type: 'bridge:poll' });
  const update = x.chrome.tabs.update;
  x.chrome.tabs.update = (id, options) => options.autoDiscardable === true ? Promise.reject(Error('temporary failure')) : update(id, options);
  await x.send({ type: 'bridge:error', jobId: 'job-1', error: 'Stopped' });
  assert.equal(x.store['bot.bridge.job.7'], undefined);
  assert.ok(x.store['bot.bridge.tab-protection.7']);
  const y = await setup({ store: x.store });
  assert.equal(y.store['bot.bridge.tab-protection.7'], undefined);
  assert.deepEqual(y.tabUpdates, [{ tabId: 7, properties: { autoDiscardable: true } }]);
});

test('a failed discard-protection API call does not break a lease or enable automatic foreground switching', async () => {
  const x = await setup(); x.chrome.tabs.update = async () => { throw Error('temporary failure'); };
  const result = await x.send({ type: 'bridge:poll' });
  assert.equal(result.ok, true); assert.equal(result.data.job.id, 'job-1');
  assert.equal(x.tab.active, false);
  assert.equal((await x.send({ type: 'bridge:foreground', jobId: 'job-1' })).ok, false);
  assert.equal((await x.send({ type: 'bridge:foreground-release', jobId: 'job-1' })).ok, false);
  assert.equal((await x.send({ type: 'bridge:started', jobId: 'job-1' })).ok, true);
});

test('page wake pulses skip foreign browser identities and changed live URLs without keeping a loop alive', async t => {
  const x = await setup();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await x.send({ type: 'bridge:poll' });
    x.store['bot.bridge.job.7'].browserId = 'another-browser';
    t.mock.timers.tick(1000); for (let j = 0; j < 6; j++) await tick();
    t.mock.timers.tick(600000); await tick();
    assert.deepEqual(x.tabMessages, []);
    x.store['bot.bridge.job.7'].browserId = 'browser-one';
    await x.send({ type: 'bridge:started', jobId: 'job-1' });
    x.tab.url = 'https://chatgpt.com/c/another-conversation';
    t.mock.timers.tick(1000); for (let j = 0; j < 6; j++) await tick();
    t.mock.timers.tick(600000); await tick();
    assert.deepEqual(x.tabMessages, []);
    assert.ok(x.tabUpdates.every(update => !Object.hasOwn(update.properties, 'active')));
  } finally { activeWorker.stopPageWakePulse(); }
});

test('a new live job arriving during the final empty pulse schedules another wake', async t => {
  const x = await setup(); t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await x.send({ type: 'bridge:poll' });
    await x.send({ type: 'bridge:error', jobId: 'job-1', error: 'Finished first task' });
    let releaseScan; let held = false;
    const get = x.chrome.storage.local.get;
    x.chrome.storage.local.get = async keys => {
      const snapshot = await get(keys);
      if (keys === null && !held) { held = true; await new Promise(resolve => { releaseScan = resolve; }); }
      return snapshot;
    };
    t.mock.timers.tick(1000); for (let i = 0; i < 6; i++) await tick();
    assert.equal(held, true);
    await x.send({ type: 'bridge:poll' }); await x.send({ type: 'bridge:started', jobId: 'job-1' });
    releaseScan(); for (let i = 0; i < 6; i++) await tick();
    t.mock.timers.tick(1000); for (let i = 0; i < 6; i++) await tick();
    assert.equal(x.tabMessages.length, 1, 'replacement task receives the next pulse without waiting for the maintenance alarm');
  } finally { activeWorker.stopPageWakePulse(); }
});

test('maintenance retries temporary discard protection failures at most three times for a live job', async () => {
  for (const recover of [true, false]) {
    const x = await setup(); const update = x.chrome.tabs.update; let attempts = 0;
    x.chrome.tabs.update = async (id, properties) => {
      if (properties.autoDiscardable === false) { attempts++; if (!recover || attempts === 1) throw Error('temporary failure'); }
      return update(id, properties);
    };
    await x.send({ type: 'bridge:poll' }); await x.send({ type: 'bridge:started', jobId: 'job-1' });
    for (let i = 0; i < 5; i++) await x.alarm();
    assert.equal(attempts, recover ? 2 : 3);
    assert.equal(x.tab.autoDiscardable, !recover);
    assert.equal(x.store['bot.bridge.job.7'].state, 'started');
    assert.ok(x.tabUpdates.every(update => !Object.hasOwn(update.properties, 'active')));
  }
});

test('stale discard records never change tabs belonging to another browser, URL or unverifiable legacy record', async () => {
  for (const change of [
    protection => { protection.browserId = 'another-browser'; },
    protection => { protection.conversationUrl = 'https://chatgpt.com/c/other-conversation'; },
    protection => { delete protection.assistant; delete protection.conversationUrl; },
  ]) {
    const protection = { tabId: 7, browserId: 'browser-one', assistant: 'chatgpt', conversationUrl: url, autoDiscardable: true };
    change(protection);
    const x = await setup({ store: { browserId: 'browser-one', 'bot.bridge.tab-protection.7': protection } });
    assert.deepEqual(x.tabUpdates, []);
    assert.equal(x.store['bot.bridge.tab-protection.7'], undefined, 'unverifiable ownership is retired without changing the tab');
  }
});

test('closed tabs cannot block durable result delivery or error reporting when the removal event was missed', async () => {
  for (const state of ['result-pending', 'error-pending']) {
    const x = await setup(); await x.send({ type: 'bridge:poll' }); await x.send({ type: 'bridge:started', jobId: 'job-1' });
    Object.assign(x.store['bot.bridge.job.7'], state === 'result-pending'
      ? { state, text: 'Completed before tab closed', images: [] }
      : { state, error: 'Stopped before tab closed' });
    x.chrome.tabs.get = async () => { throw Error('No tab with id: 7.'); };
    await x.alarm();
    assert.equal(x.store['bot.bridge.job.7'], undefined, state);
    assert.equal(x.store['bot.bridge.tab-protection.7'], undefined, state);
    assert.ok(x.calls.some(call => call.path === `/v1/jobs/job-1/${state === 'result-pending' ? 'result' : 'error'}`), state);
  }
});

test('transient protection reads preserve restoration records without blocking completion or failure', async () => {
  for (const operation of ['result', 'error']) {
    const x = await setup(); await x.send({ type: 'bridge:poll' }); await x.send({ type: 'bridge:started', jobId: 'job-1' });
    const get = x.chrome.storage.local.get;
    x.chrome.storage.local.get = keys => keys === 'bot.bridge.tab-protection.7' ? Promise.reject(Error('temporary storage failure')) : get(keys);
    const reply = await x.send(operation === 'result'
      ? { type: 'bridge:result', jobId: 'job-1', text: 'Done', images: [] }
      : { type: 'bridge:error', jobId: 'job-1', error: 'Stopped' });
    assert.equal(reply.ok, true, operation);
    assert.equal(x.store['bot.bridge.job.7'], undefined, operation);
    assert.ok(x.store['bot.bridge.tab-protection.7'], operation);
    x.chrome.storage.local.get = get;
    const getTab = x.chrome.tabs.get;
    x.chrome.tabs.get = async () => { throw Error('temporary tabs service failure'); };
    await x.alarm(); assert.ok(x.store['bot.bridge.tab-protection.7'], operation);
    x.chrome.tabs.get = getTab;
    await x.alarm();
    assert.equal(x.store['bot.bridge.tab-protection.7'], undefined, operation);
    assert.equal(x.tab.autoDiscardable, true, operation);
  }
});

const observationSample = { elapsedMs: 1000, gapMs: 1000, wakeAgeMs: 0, bodyChars: 10, bodyCount: 1, footerCount: 1,
  hidden: true, generating: false, complete: true, candidate: true };
for (const platform of ['qq', 'feishu']) {
  test(`Qwen ${platform} observations remain local, bounded and clear independently of jobs and other channels`, async () => {
    const x = await setup({ assistant: 'qwen', platform });
    await x.send({ type: 'bridge:poll' }); await x.send({ type: 'bridge:started', jobId: 'job-1' });
    const savedJob = structuredClone(x.store['bot.bridge.job.7']); const before = x.calls.length;
    const samples = [{ ...observationSample, text: 'private answer', secret: 'private credential' }];
    assert.equal((await x.send({ type: 'bridge:qwen-observation', jobId: 'job-1', samples })).ok, true);
    assert.equal(x.calls.length, before, 'observations must not reach bot APIs');
    assert.deepEqual(x.store['bot.bridge.job.7'], savedJob, 'no deadline or state changes');
    const key = 'bot.bridge.observation.qwen.' + platform;
    assert.deepEqual(x.store[key].samples, [observationSample]);
    assert.equal(x.tabUpdates.some(update => update.properties.active), false);
    const state = await x.send({ type: 'options:status', assistant: 'qwen', platform }, x.optionsSender);
    assert.deepEqual(state.data.backgroundObservation.samples, [observationSample]);
    const otherKey = 'bot.bridge.observation.qwen.' + (platform === 'qq' ? 'feishu' : 'qq');
    x.store[otherKey] = { samples: [observationSample] };
    assert.equal((await x.send({ type: 'options:clear-notices', assistant: 'qwen', platform }, x.optionsSender)).ok, true);
    assert.equal(x.store[key], undefined); assert.ok(x.store[otherKey]);
    assert.deepEqual(x.store['bot.bridge.job.7'], savedJob);
  });
}

test('Qwen observation rejects stale, unstarted, expired or malformed task reports', async () => {
  const x = await setup({ assistant: 'qwen' });
  const message = { type: 'bridge:qwen-observation', jobId: 'job-1', samples: [observationSample] };
  await x.send({ type: 'bridge:poll' });
  assert.equal((await x.send(message)).ok, false);
  await x.send({ type: 'bridge:started', jobId: 'job-1' });
  for (const changes of [{ jobId: 'other' }, { sessionId: 'another_session_12345' },
    { conversationUrl: 'https://chat.qwen.ai/c/other' }, { samples: [] }, { samples: [{ ...observationSample, bodyChars: 'answer' }] }]) {
    assert.equal((await x.send({ ...message, ...changes })).ok, false);
  }
  x.store['bot.bridge.job.7'].expiresAt = Date.now() - 1;
  assert.equal((await x.send(message)).ok, false);
  assert.equal(x.store['bot.bridge.observation.qwen.qq'], undefined);
});

test('other assistant tasks cannot write Qwen observations', async () => {
  const x = await setup();
  await x.send({ type: 'bridge:poll' }); await x.send({ type: 'bridge:started', jobId: 'job-1' });
  assert.equal((await x.send({ type: 'bridge:qwen-observation', jobId: 'job-1', samples: [observationSample] })).ok, false);
  assert.equal(x.store['bot.bridge.observation.qwen.qq'], undefined);
});

for (const badDiagnostics of [false, true]) {
  test(`Qwen result records worker receipt separately from readiness; malformed metadata=${badDiagnostics}`, async () => {
    const x = await setup({ assistant: 'qwen' });
    await x.send({ type: 'bridge:poll' }); await x.send({ type: 'bridge:started', jobId: 'job-1' });
    const observation = [{ ...observationSample, focused: false, phase: 'delivery', text: 'PRIVATE DIAGNOSTIC' }];
    const result = await x.send({ type: 'bridge:result', jobId: 'job-1', text: 'Final answer', images: [], observation: badDiagnostics ? 'invalid' : observation });
    assert.equal(result.ok, true); assert.equal(x.store['bot.bridge.job.7'], undefined);
    const record = x.store['bot.bridge.observation.qwen.qq'];
    if (badDiagnostics) assert.equal(record, undefined);
    else {
      assert.ok(Number.isSafeInteger(record.receivedAt)); assert.equal(record.samples.at(-1).phase, 'delivery');
      assert.doesNotMatch(JSON.stringify(record), /PRIVATE DIAGNOSTIC|Final answer/);
      const status = await x.send({ type: 'options:status', assistant: 'qwen', platform: 'qq' }, x.optionsSender);
      assert.equal(status.data.backgroundObservation.receivedAt, record.receivedAt);
    }
    const delivery = x.calls.find(call => call.path.endsWith('/result'));
    assert.equal(delivery.body.text, 'Final answer'); assert.equal(delivery.body.observation, undefined);
  });
}

test('Qwen diagnostic storage failure cannot reject an otherwise valid final answer', async () => {
  const x = await setup({ assistant: 'qwen' });
  await x.send({ type: 'bridge:poll' }); await x.send({ type: 'bridge:started', jobId: 'job-1' });
  const originalSet = x.chrome.storage.local.set;
  x.chrome.storage.local.set = async values => {
    if (Object.keys(values).some(key => key.startsWith('bot.bridge.observation.'))) throw new Error('Diagnostic storage failure');
    return originalSet(values);
  };
  const result = await x.send({ type: 'bridge:result', jobId: 'job-1', text: 'Final answer', images: [], observation: [observationSample] });
  assert.equal(result.ok, true); assert.equal(result.data.pending, undefined);
  assert.equal(x.calls.filter(call => call.path.endsWith('/result')).length, 1);
});
