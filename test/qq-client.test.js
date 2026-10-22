import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserQQAdapter, validateWebSocketEndpoint, QQ_GROUP_INTENT, QQ_IMAGE_UPLOAD_LIMIT } from '../extension/qq-client.js';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const event = (id = 'message_2', sequence = 2) => ({ op: 0, s: sequence, t: 'GROUP_AT_MESSAGE_CREATE', d: { id, group_openid: 'group_1', author: { member_openid: 'user_1' }, content: 'hello', timestamp: '2026-10-16T12:00:00+08:00' } });
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1]);

function harness({ onMessage = async () => {}, fetchHook, expires = '7200', timeout = 20000 } = {}) {
  let time = 0; let nextTimer = 0;
  const timers = new Map(); const calls = []; const states = []; const sockets = [];
  const schedule = (callback, delay) => { const id = ++nextTimer; timers.set(id, { at: time + delay, callback }); return id; };
  class Socket {
    constructor(url) { this.url = url; this.readyState = 0; this.listeners = new Map(); this.sent = []; sockets.push(this); }
    addEventListener(type, fn) { const items = this.listeners.get(type) ?? []; items.push(fn); this.listeners.set(type, items); }
    emit(type, data = {}) { for (const fn of this.listeners.get(type) ?? []) fn(data); }
    open() { this.readyState = 1; this.emit('open'); }
    message(payload) { this.emit('message', { data: JSON.stringify(payload) }); }
    send(value) { if (this.readyState !== 1) throw Error('not open'); this.sent.push(JSON.parse(value)); }
    close(code = 1000) { if (this.readyState === 3) return; this.readyState = 3; this.emit('close', { code }); }
  }
  const adapter = createBrowserQQAdapter({ appId: '12345', appSecret: 'secret-do-not-leak', onMessage, onState: state => states.push(state) }, {
    WebSocket: Socket, now: () => time, setTimeout: schedule, clearTimeout: id => timers.delete(id), random: () => 0, requestTimeoutMs: timeout,
    fetch: async (url, options) => {
      const call = { url, ...options, data: options.body ? JSON.parse(options.body) : undefined }; calls.push(call);
      const custom = await fetchHook?.(call, calls); if (custom !== undefined) return custom;
      if (url.endsWith('/app/getAppAccessToken')) return json({ access_token: 'token-do-not-leak', expires_in: expires });
      if (url.endsWith('/gateway/bot')) return json({ url: 'wss://api.bot.qq.com/websocket/', shards: 1, session_start_limit: { remaining: 100 } });
      if (url.endsWith('/files')) return json({ file_info: 'opaque_file_info', ttl: 300 });
      if (url.endsWith('/messages')) return json({ id: 'ROBOT1.0_reply' });
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    },
  });
  async function tick(ms) {
    const end = time + ms;
    for (let count = 0; count < 1000; count++) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      time = next[1].at; timers.delete(next[0]); next[1].callback(); await flush();
    }
    time = end; await flush();
  }
  async function start(interval = 45000) {
    const task = adapter.start(); await flush();
    const ws = sockets.at(-1); assert.ok(ws); ws.open(); ws.message({ op: 10, d: { heartbeat_interval: interval } });
    ws.message({ op: 0, s: 1, t: 'READY', d: { session_id: 'session_1' } }); await task; return ws;
  }
  return { adapter, start, tick, calls, states, sockets, timers };
}

test('official endpoint allowlist rejects lookalikes, credentials, paths and redirects', () => {
  assert.equal(validateWebSocketEndpoint('wss://api.bot.qq.com/websocket/'), 'wss://api.bot.qq.com/websocket/');
  assert.equal(validateWebSocketEndpoint('wss://api.sgroup.qq.com/websocket'), 'wss://api.sgroup.qq.com/websocket');
  for (const endpoint of ['ws://api.bot.qq.com/websocket', 'wss://api.bot.qq.com.evil.test/websocket', 'wss://evil.api.bot.qq.com/websocket', 'wss://api.bot.qq.com:444/websocket', 'wss://secret@api.bot.qq.com/websocket', 'wss://api.bot.qq.com/elsewhere', 'wss://api.bot.qq.com/websocket?token=secret']) assert.throws(() => validateWebSocketEndpoint(endpoint), error => error.retryable === false);
});

test('auth, gateway and Identify use current official endpoints and complete only at READY', async () => {
  const h = harness(); const ws = await h.start();
  assert.equal(h.calls[0].url, 'https://api.bot.qq.com/app/getAppAccessToken');
  assert.deepEqual(h.calls[0].data, { appId: '12345', clientSecret: 'secret-do-not-leak' });
  assert.equal(h.calls[1].url, 'https://api.bot.qq.com/gateway/bot');
  assert.equal(h.calls[1].headers.Authorization, 'QQBot token-do-not-leak');
  assert.equal(ws.sent[0].op, 2); assert.equal(ws.sent[0].d.intents, QQ_GROUP_INTENT); assert.deepEqual(ws.sent[0].d.shard, [0, 1]);
  assert.deepEqual(h.states.map(value => value.state), ['connecting', 'connected']);
  for (const call of h.calls) { assert.equal(call.redirect, 'error'); assert.equal(call.credentials, 'omit'); }
  h.adapter.stop();
});

test('heartbeat checkpoint advances only after durable ingestion and ACK keeps the link alive', async () => {
  const pending = deferred(); const seen = [];
  const h = harness({ onMessage: async message => { seen.push(message); await pending.promise; } });
  const ws = await h.start(1000); ws.message(event()); await flush(); assert.equal(seen.length, 1);
  await h.tick(1000); assert.deepEqual(ws.sent.at(-1), { op: 1, d: 1 });
  ws.message({ op: 11 }); pending.resolve(); await flush();
  await h.tick(1000); assert.deepEqual(ws.sent.at(-1), { op: 1, d: 2 }); assert.equal(ws.readyState, 1);
  h.adapter.stop();
});

test('failed persistence reconnects and resumes the last accepted sequence', async () => {
  const h = harness({ onMessage: async () => { throw Error('secret-do-not-leak'); } });
  const ws = await h.start(); ws.message(event()); await flush(); assert.equal(ws.readyState, 3);
  await h.tick(1000); const resumed = h.sockets.at(-1); assert.notEqual(resumed, ws);
  resumed.open(); resumed.message({ op: 10, d: { heartbeat_interval: 45000 } });
  assert.deepEqual(resumed.sent[0], { op: 6, d: { token: 'QQBot token-do-not-leak', session_id: 'session_1', seq: 1 } });
  resumed.message({ op: 0, s: 1, t: 'RESUMED', d: {} }); await flush();
  assert.ok(!JSON.stringify(h.states).includes('secret-do-not-leak')); h.adapter.stop();
});

test('later queued events cannot skip a failed durable event while socket closure is pending', async () => {
  const pending = deferred(); const seen = [];
  const h = harness({ onMessage: async message => { seen.push(message.messageId); if (message.messageId === 'first') await pending.promise; } });
  const ws = await h.start();
  const originalClose = ws.close.bind(ws); ws.close = () => {}; // native close event may arrive later
  ws.message(event('first', 2)); ws.message(event('second', 3)); await flush();
  pending.reject(Error('disk failed')); await flush(); assert.deepEqual(seen, ['first']);
  originalClose(); await h.tick(1000); const resumed = h.sockets.at(-1); resumed.open(); resumed.message({ op: 10, d: { heartbeat_interval: 45000 } });
  assert.equal(resumed.sent[0].d.seq, 1); h.adapter.stop();
});

test('missing heartbeat ACK reconnects; invalid session resets to Identify', async () => {
  const h = harness(); const ws = await h.start(1000); await h.tick(2000); assert.equal(ws.readyState, 3);
  await h.tick(1000); const ws2 = h.sockets.at(-1); ws2.open(); ws2.message({ op: 10, d: { heartbeat_interval: 1000 } });
  ws2.message({ op: 9, d: false }); await flush(); await h.tick(2000);
  const ws3 = h.sockets.at(-1); assert.notEqual(ws3, ws2); ws3.open(); ws3.message({ op: 10, d: { heartbeat_interval: 1000 } });
  assert.equal(ws3.sent[0].op, 2); h.adapter.stop();
});

test('socket failure revokes readiness and timers before a delayed native close', async () => {
  const h = harness(); const ws = await h.start(1000);
  let closeCalls = 0;
  ws.close = () => { closeCalls++; ws.readyState = 2; };
  ws.emit('error'); await flush();
  await assert.rejects(h.adapter.reply({ chatId: 'group_1', messageId: 'original', text: 'hello', msgSeq: 1 }), error => error.code === 'not_ready');
  assert.equal(h.calls.filter(call => call.url.endsWith('/messages')).length, 0);
  assert.equal(h.states.at(-1).state, 'reconnecting');
  await h.tick(1000);
  assert.equal(closeCalls, 1); assert.equal(h.sockets.length, 2);
  const next = h.sockets.at(-1); next.open(); next.message({ op: 10, d: { heartbeat_interval: 45000 } });
  next.message({ op: 0, s: 1, t: 'RESUMED', d: {} }); await flush();
  ws.emit('error'); ws.emit('close', { code: 1006 }); await h.tick(1000);
  assert.equal(closeCalls, 1); assert.equal(h.sockets.length, 2);
  assert.equal(h.states.at(-1).state, 'connected'); h.adapter.stop();
});

test('fatal close arriving after an error cancels the pending reconnect', async () => {
  for (const delayed of [false, true]) {
    const h = harness(); const task = h.adapter.start(); const rejected = assert.rejects(task, /长连接建立失败/); await flush();
    const ws = h.sockets[0]; ws.close = () => { ws.readyState = 2; };
    ws.emit('error'); if (delayed) await rejected;
    ws.readyState = 3; ws.emit('close', { code: 4004 }); await rejected;
    await h.tick(65000);
    assert.equal(h.sockets.length, 1); assert.equal(h.states.at(-1).state, 'error');
    h.adapter.stop(); await h.start(); assert.equal(h.states.at(-1).state, 'connected'); h.adapter.stop();
  }
});

test('failed handshake leaves no stale timeout or control frames on its replacement', async () => {
  const h = harness({ timeout: 5000 }); const task = h.adapter.start();
  const rejected = assert.rejects(task, /长连接建立失败/); await flush();
  const ws = h.sockets[0]; let closes = 0; ws.close = () => { closes++; ws.readyState = 2; };
  ws.emit('error'); await rejected;
  ws.message({ op: 9, d: false }); ws.message({ op: 10, d: { heartbeat_interval: 1000 } });
  await h.tick(1000);
  const next = h.sockets.at(-1); next.open(); next.message({ op: 10, d: { heartbeat_interval: 45000 } });
  next.message({ op: 0, s: 1, t: 'READY', d: { session_id: 'replacement' } }); await flush();
  await h.tick(6000);
  assert.equal(closes, 1); assert.equal(h.sockets.length, 2);
  assert.equal(h.states.at(-1).state, 'connected'); h.adapter.stop();
});

test('fatal permissions do not enter an automatic reconnect loop', async () => {
  for (const code of [4001, 4002, 4012, 4014, 4914, 4915]) {
    const h = harness(); const ws = await h.start(); ws.close(code); await h.tick(65000);
    assert.equal(h.sockets.length, 1); assert.equal(h.states.at(-1).state, 'error'); h.adapter.stop();
  }
});

test('official close codes distinguish new Identify from recoverable Resume', async () => {
  for (const [code, opcode] of [[4006, 2], [4007, 2], [4009, 6], [4900, 2], [4913, 2]]) {
    const h = harness(); const ws = await h.start(); ws.message(event()); await flush(); ws.close(code); await h.tick(1000);
    const next = h.sockets.at(-1); next.open(); next.message({ op: 10, d: { heartbeat_interval: 45000 } });
    assert.equal(next.sent[0].op, opcode); if (opcode === 6) assert.equal(next.sent[0].d.seq, 2); h.adapter.stop();
  }
});

test('multi-shard gateway requirement fails explicitly before opening an incomplete connection', async () => {
  const h = harness({ fetchHook: call => call.url.endsWith('/gateway/bot') ? json({ url: 'wss://api.bot.qq.com/websocket', shards: 2 }) : undefined });
  await assert.rejects(h.adapter.start(), error => error.code === 'sharding_unsupported' && error.retryable === false);
  assert.equal(h.sockets.length, 0); h.adapter.stop();
});

test('stop aborts in-flight startup and revokes late responses without exposing credentials', async () => {
  const pending = deferred(); const h = harness({ fetchHook: call => call.url.endsWith('/app/getAppAccessToken') ? pending.promise : undefined });
  const task = h.adapter.start(); const rejection = assert.rejects(task, error => error.code === 'stopped'); await flush();
  h.adapter.stop(); assert.equal(h.calls[0].signal.aborted, true);
  pending.resolve(json({ access_token: 'late-secret', expires_in: 7200 })); await rejection; await h.tick(100000);
  assert.equal(h.sockets.length, 0); assert.equal(h.calls.length, 1);
  assert.ok(!JSON.stringify(h.states).includes('late-secret'));
});

test('handshake and HTTP timeout fail safely and use bounded reconnect backoff', async () => {
  const h = harness({ timeout: 1000 }); const task = h.adapter.start(); const rejection = assert.rejects(task, /握手超时/); await flush();
  await h.tick(1000); await rejection; assert.equal(h.sockets.length, 1);
  await h.tick(999); assert.equal(h.sockets.length, 1); await h.tick(1); assert.equal(h.sockets.length, 2); h.adapter.stop();
  const slow = harness({ timeout: 1000, fetchHook: call => call.url.endsWith('/app/getAppAccessToken') ? new Promise((resolve, reject) => call.signal.addEventListener('abort', () => reject(Error('request secret-do-not-leak')))) : undefined });
  const slowTask = slow.adapter.start(); const slowRejection = assert.rejects(slowTask, error => !error.message.includes('secret-do-not-leak')); await flush();
  await slow.tick(1000); await slowRejection; assert.equal(slow.calls[0].signal.aborted, true); slow.adapter.stop();
});

test('token refresh accepts string expiry and refreshes near expiry', async () => {
  const h = harness({ expires: '10' }); await h.start();
  await h.tick(8999); assert.equal(h.calls.filter(call => call.url.endsWith('/app/getAppAccessToken')).length, 1);
  await h.tick(1); assert.equal(h.calls.filter(call => call.url.endsWith('/app/getAppAccessToken')).length, 2); h.adapter.stop();
});

test('transient background token refresh failure schedules a bounded retry', async () => {
  let tokens = 0;
  const h = harness({ expires: '10', fetchHook: call => call.url.endsWith('/app/getAppAccessToken') && ++tokens === 2 ? json({ code: 100001 }, 429) : undefined }); await h.start();
  await h.tick(9000); assert.equal(tokens, 2); await h.tick(14999); assert.equal(tokens, 2); await h.tick(1); assert.equal(tokens, 3); h.adapter.stop();
});

test('token API failure under HTTP 200 is sanitized and terminal', async () => {
  const h = harness({ fetchHook: call => call.url.endsWith('/app/getAppAccessToken') ? json({ code: 100016, message: 'secret-do-not-leak token' }) : undefined });
  await assert.rejects(h.adapter.start(), error => error.code === 'authentication' && error.retryable === false && !error.message.includes('secret-do-not-leak'));
  await h.tick(100000); assert.equal(h.calls.length, 1); h.adapter.stop();
});

test('plain text and markdown posts preserve owner-assigned msg_seq and separate content fields', async () => {
  const h = harness(); await h.start();
  await h.adapter.reply({ chatId: 'group_1', messageId: 'ROBOT1.0_original', text: 'text', msgSeq: 1 });
  await h.adapter.replyPost({ chatId: 'group_1', messageId: 'ROBOT1.0_original', post: '**bold**', msgSeq: 2 });
  const sent = h.calls.filter(call => call.url.endsWith('/messages'));
  assert.deepEqual(sent.map(call => call.data), [{ msg_id: 'ROBOT1.0_original', msg_seq: 1, msg_type: 0, content: 'text' }, { msg_id: 'ROBOT1.0_original', msg_seq: 2, msg_type: 2, markdown: { content: '**bold**' } }]);
  await assert.rejects(h.adapter.reply({ chatId: 'group_1', messageId: 'original', text: 'bad seq', msgSeq: 6 }), error => error.retryable === false);
  h.adapter.stop();
});

test('definitive token rejection refreshes once and retries with the same msg_seq', async () => {
  let sends = 0;
  const h = harness({ fetchHook: call => call.url.endsWith('/messages') && sends++ === 0 ? json({ err_code: 11243 }, 401) : undefined }); await h.start();
  await h.adapter.reply({ chatId: 'group_1', messageId: 'original', text: 'hi', msgSeq: 3 });
  assert.equal(h.calls.filter(call => call.url.endsWith('/app/getAppAccessToken')).length, 2);
  assert.deepEqual(h.calls.filter(call => call.url.endsWith('/messages')).map(call => call.data.msg_seq), [3, 3]); h.adapter.stop();
});

test('token refresh crossing the reply deadline prevents the second mutation fetch', async () => {
  let tokens = 0; const refresh = deferred();
  const h = harness({ fetchHook: call => {
    if (call.url.endsWith('/app/getAppAccessToken') && ++tokens === 2) return refresh.promise;
    if (call.url.endsWith('/messages')) return json({ err_code: 11243 }, 401);
  } }); await h.start();
  const sending = h.adapter.replyPost({ chatId: 'group_1', messageId: 'original', post: 'answer', msgSeq: 1, expiresAt: 500 });
  const rejected = assert.rejects(sending, error => error.code === 'reply_expired' && error.retryable === false);
  await flush(); assert.equal(tokens, 2); await h.tick(501); refresh.resolve(json({ access_token: 'fresh-token', expires_in: 7200 })); await rejected;
  assert.equal(h.calls.filter(call => call.url.endsWith('/messages')).length, 1);
  await assert.rejects(h.adapter.uploadImage({ chatId: 'group_1', buffer: png, mimeType: 'image/png', expiresAt: 500 }), error => error.code === 'reply_expired');
  assert.equal(h.calls.filter(call => call.url.endsWith('/files')).length, 0); h.adapter.stop();
});

test('duplicate msg_seq is ambiguous, never treated as success or retried with a new sequence', async () => {
  const h = harness({ fetchHook: call => call.url.endsWith('/messages') ? json({ err_code: 40054005, message: 'duplicate' }, 400) : undefined }); await h.start();
  await assert.rejects(h.adapter.reply({ chatId: 'group_1', messageId: 'original', text: 'hi', msgSeq: 2 }), error => error.code === 'ambiguous' && error.ambiguous && error.retryable === false);
  assert.equal(h.calls.filter(call => call.url.endsWith('/messages')).length, 1); h.adapter.stop();
});

test('network uncertainty and incomplete mutation responses need attention rather than silent retries', async () => {
  for (const response of [() => { throw Error('raw secret-do-not-leak'); }, () => json({})]) {
    const h = harness({ fetchHook: call => call.url.endsWith('/messages') ? response() : undefined }); await h.start();
    await assert.rejects(h.adapter.reply({ chatId: 'group_1', messageId: 'original', text: 'hi', msgSeq: 1 }), error => error.code === 'ambiguous' && error.retryable === false && !error.message.includes('secret-do-not-leak'));
    assert.equal(h.calls.filter(call => call.url.endsWith('/messages')).length, 1); h.adapter.stop();
  }
});

test('reply expiry is nonretryable, rate limits remain retryable and 201 errors are not success', async () => {
  for (const [code, status, retryable] of [[40034005, 400, false], [40034128, 400, false], [40034100, 429, true], [304023, 201, false]]) {
    const h = harness({ fetchHook: call => call.url.endsWith('/messages') ? json({ code }, status) : undefined }); await h.start();
    await assert.rejects(h.adapter.reply({ chatId: 'group_1', messageId: 'original', text: 'hi', msgSeq: 1 }), error => error.retryable === retryable); h.adapter.stop();
  }
});

test('image upload uses an immutable byte snapshot, safe filename and no immediate send', async () => {
  const h = harness(); await h.start(); const source = new Uint8Array(png);
  const uploading = h.adapter.uploadImage({ chatId: 'group_1', buffer: source, mimeType: 'image/png' }); source.fill(0);
  assert.deepEqual(await uploading, { imageKey: 'opaque_file_info', ttl: 300 });
  const upload = h.calls.find(call => call.url.endsWith('/files'));
  assert.equal(upload.data.file_data, Buffer.from(png).toString('base64')); assert.equal(upload.data.srv_send_msg, false);
  assert.match(upload.data.file_name, /^[a-f0-9]{64}\.png$/); assert.equal(upload.data.file_type, 1); assert.equal(upload.data.msg_seq, undefined);
  await h.adapter.replyImage({ chatId: 'group_1', messageId: 'original', imageKey: 'opaque_file_info', msgSeq: 4 });
  assert.deepEqual(h.calls.at(-1).data, { msg_id: 'original', msg_seq: 4, msg_type: 7, media: { file_info: 'opaque_file_info' } }); h.adapter.stop();
});

test('image size, magic bytes and untrusted download URLs fail before network activity', async () => {
  const h = harness(); await h.start(); const before = h.calls.length;
  const oversized = new Uint8Array(QQ_IMAGE_UPLOAD_LIMIT + 1); oversized.set(png);
  await assert.rejects(h.adapter.uploadImage({ chatId: 'group_1', buffer: oversized, mimeType: 'image/png' }));
  await assert.rejects(h.adapter.uploadImage({ chatId: 'group_1', buffer: png, mimeType: 'image/jpeg' }));
  for (const imageKey of ['https://example.com/x.png', 'http://multimedia.nt.qq.com.cn/x.png', 'https://multimedia.nt.qq.com.cn.evil.test/x.png']) await assert.rejects(h.adapter.downloadImage({ imageKey }));
  assert.equal(h.calls.length, before); h.adapter.stop();
});

test('QQ CDN download omits bot Authorization, cookies, referrer and redirects', async () => {
  const h = harness(); await h.start();
  const image = await h.adapter.downloadImage({ imageKey: 'https://multimedia.nt.qq.com.cn/download?appid=1&fileid=synthetic' });
  assert.equal(image.mimeType, 'image/png'); assert.deepEqual(image.buffer, png);
  const call = h.calls.at(-1); assert.equal(call.headers.Authorization, undefined); assert.equal(call.credentials, 'omit'); assert.equal(call.redirect, 'error'); assert.equal(call.referrerPolicy, 'no-referrer'); h.adapter.stop();
});

test('queued messages are revoked after stop and input snapshots cannot change destination or content', async () => {
  const pending = deferred(); let sent = 0;
  const h = harness({ fetchHook: call => call.url.endsWith('/messages') && sent++ === 0 ? pending.promise : undefined }); await h.start();
  const first = h.adapter.reply({ chatId: 'group_1', messageId: 'original', text: 'first', msgSeq: 1 }); const firstReject = assert.rejects(first, error => error.code === 'stopped');
  const input = { chatId: 'group_1', messageId: 'original', text: 'second', msgSeq: 2 };
  const second = h.adapter.reply(input); const secondReject = assert.rejects(second, error => error.code === 'stopped'); input.chatId = 'evil'; input.text = 'changed';
  await flush(); h.adapter.stop(); pending.resolve(json({ id: 'reply' })); await Promise.all([firstReject, secondReject]);
  assert.equal(h.calls.filter(call => call.url.endsWith('/messages')).length, 1);
});
