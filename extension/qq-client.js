import { normalizeMessage, validateAttachmentUrl } from './qq-message.js';
export { normalizeMessage } from './qq-message.js';

const ORIGIN = 'https://api.bot.qq.com';
const WSS_HOSTS = new Set(['api.bot.qq.com', 'api.sgroup.qq.com', 'wss.api.sgroup.qq.com']);
export const QQ_IMAGE_UPLOAD_LIMIT = 4_900_000;
export const QQ_IMAGE_DOWNLOAD_LIMIT = 10_000_000;
export const QQ_GROUP_INTENT = 1 << 25;
const encoder = new TextEncoder();
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const messageIdentifier = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\s\x00-\x20\x7f]/u.test(value);

export class QQTransportError extends Error {
  constructor(message, { retryable = true, code = 'qq_transport', ambiguous = false } = {}) {
    super(message); this.name = 'QQTransportError'; this.retryable = retryable; this.code = code;
    if (ambiguous) this.ambiguous = true;
  }
}
const invalid = message => new QQTransportError(message, { retryable: false, code: 'invalid_input' });
const ambiguous = () => new QQTransportError('QQ 消息发送结果无法确认，请人工检查原群消息，勿重复发送', { retryable: false, code: 'ambiguous', ambiguous: true });
function failure(code, status) {
  if (code === 40054005) return ambiguous();
  if ([304103, 304027, 40034005, 40034026, 40034128].includes(code)) return new QQTransportError('QQ 被动回复已过期或回复次数已用完', { retryable: false, code: 'reply_expired' });
  if ([100007, 100016, 10004, 11241, 11243, 11251, 11261].includes(code) || status === 401) {
    const error = new QQTransportError('QQ 应用鉴权失败，请核对 App ID 与 App Secret', { retryable: false, code: 'authentication' });
    error.tokenRejected = status === 401 || code === 11243; return error;
  }
  if ([100001, 20028, 40034100, 1100100, 1100308].includes(code) || status === 429) return new QQTransportError('QQ 接口请求过于频繁，请稍后重试', { code: 'rate_limit' });
  if ([40034101, 40034105, 40054002, 40054003, 850018, 11253, 11254, 11255, 11264, 11265, 304036, 40034127].includes(code) || status === 403) return new QQTransportError('QQ 机器人权限不足、已被禁言或不在目标群中', { retryable: false, code: 'permission' });
  if ([850019, 850031, 304080, 40093002].includes(code) || status === 413) return new QQTransportError('QQ 拒绝图片，请检查格式、大小和上传额度', { retryable: false, code: 'invalid_image' });
  if ([850026, 850027, 40093001, 40034004, 50055001, 50055006, 11242, 11252, 11263].includes(code)) return new QQTransportError('QQ 服务暂时不可用，请稍后重试', { code: 'server_error' });
  return new QQTransportError('QQ 接口拒绝请求，请检查消息内容、机器人权限和应用配置', { retryable: !code && status >= 500, code: 'api_error' });
}

export function validateWebSocketEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw invalid('QQ 长连接地址无效'); }
  if (url.protocol !== 'wss:' || !WSS_HOSTS.has(url.hostname) || url.username || url.password || url.port || url.search || url.hash || !/^\/websocket\/?$/.test(url.pathname)) throw invalid('QQ 长连接地址不属于允许的官方接口');
  return url.href;
}

export function validateImage(buffer, declaredType, limit = QQ_IMAGE_DOWNLOAD_LIMIT) {
  if (buffer instanceof ArrayBuffer) buffer = new Uint8Array(buffer);
  if (!(buffer instanceof Uint8Array) || !buffer.length || buffer.length > limit) throw invalid('图片为空或超过允许大小');
  const bytes = new Uint8Array(buffer);
  const match = values => values.every((value, index) => bytes[index] === value);
  const mimeType = match([137, 80, 78, 71, 13, 10, 26, 10]) ? 'image/png' : match([255, 216, 255]) ? 'image/jpeg' :
    match([82, 73, 70, 70]) && [87, 69, 66, 80].every((value, index) => bytes[index + 8] === value) ? 'image/webp' : null;
  if (!mimeType || (declaredType !== undefined && declaredType !== mimeType)) throw invalid('图片内容与格式不一致，仅支持 PNG、JPEG、WebP');
  return { buffer: bytes, mimeType, bytes: bytes.length };
}
function base64(bytes) {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(text);
}

/** Browser-only transport. The owner must durably ingest each onMessage before resolving it. */
export function createBrowserQQAdapter({ appId, appSecret, onMessage, onState = () => {} }, dependencies = {}) {
  if (!/^\d{1,30}$/.test(appId ?? '') || typeof appSecret !== 'string' || !appSecret.trim() || appSecret.length > 512 || typeof onMessage !== 'function') throw invalid('请填写有效的 QQ 应用配置');
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const Socket = dependencies.WebSocket ?? globalThis.WebSocket;
  const cryptoImpl = dependencies.crypto ?? globalThis.crypto;
  const now = dependencies.now ?? Date.now;
  const schedule = dependencies.setTimeout ?? globalThis.setTimeout;
  const cancel = dependencies.clearTimeout ?? globalThis.clearTimeout;
  const random = dependencies.random ?? Math.random;
  const timeoutMs = dependencies.requestTimeoutMs ?? 20000;
  const requests = new Set();
  let active = false; let epoch = 0; let socket; let ready = false; let starting;
  let token; let tokenTask; let tokenTimer; let heartbeatTimer; let reconnectTimer; let handshakeTimer;
  let attempts = 0; let awaitingAck = false; let sessionId; let sequence = null; let reconnectBlocked = false;
  let incoming = Promise.resolve(); let outbound = Promise.resolve();
  function current(generation) { if (!active || generation !== epoch) throw new QQTransportError('QQ 连接已停止', { retryable: false, code: 'stopped' }); }
  function connected(generation) { current(generation); if (!ready) throw new QQTransportError('QQ 尚未完成连接', { code: 'not_ready' }); }
  function beforeDeadline(expiresAt) {
    if (expiresAt === undefined) return;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) throw invalid('QQ 回复截止时间无效');
    if (now() >= expiresAt) throw new QQTransportError('QQ 被动回复已过期，不再上传或发送', { retryable: false, code: 'reply_expired' });
  }
  function clean(error) { return error instanceof QQTransportError ? error : new QQTransportError('QQ 连接或接口请求失败，请检查网络和应用配置'); }
  function report(state, error) { try { onState({ state, ...(error ? { error: clean(error).message } : {}) }); } catch {} }
  function isCurrent(ws, generation) { return active && generation === epoch && ws === socket; }
  function closeSocket(ws) { try { if (ws && ws.readyState < 2) ws.close(); } catch {} }
  function clearConnectionTimers() { cancel(heartbeatTimer); cancel(handshakeTimer); heartbeatTimer = handshakeTimer = undefined; awaitingAck = false; }
  async function readBounded(response, limit) {
    if (Number(response.headers.get('content-length')) > limit) throw invalid('QQ 响应超过允许大小');
    const reader = response.body?.getReader();
    if (!reader) throw new QQTransportError('QQ 响应为空');
    const chunks = []; let size = 0;
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > limit) throw invalid('QQ 响应超过允许大小'); chunks.push(value); }
      const output = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
      return output;
    } finally { reader.cancel().catch(() => {}); }
  }
  async function request(url, { generation, method = 'GET', data, accessToken, image = false, mutation = false, expiresAt } = {}) {
    current(generation);
    if (mutation) connected(generation);
    beforeDeadline(expiresAt);
    if (!image) {
      const parsed = new URL(url);
      if (parsed.origin !== ORIGIN || parsed.search || parsed.hash || !(/^\/(?:app\/getAppAccessToken|gateway\/bot)$/.test(parsed.pathname) || /^\/v2\/groups\/[A-Za-z0-9_-]{1,256}\/(?:messages|files)$/.test(parsed.pathname))) throw invalid('不允许的 QQ 接口');
    }
    const controller = new AbortController(); requests.add(controller);
    const timer = schedule(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { method, headers: { ...(accessToken ? { Authorization: `QQBot ${accessToken}` } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data), signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
      const raw = await readBounded(response, image ? QQ_IMAGE_DOWNLOAD_LIMIT : 2 * 1024 * 1024);
      current(generation);
      if (controller.signal.aborted) throw mutation ? ambiguous() : new QQTransportError('QQ 请求超时');
      if (image) {
        if (!response.ok) throw new QQTransportError('QQ 图片下载失败', { retryable: response.status >= 500 || response.status === 429, code: 'image_download' });
        const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
        if (type && type !== 'application/octet-stream' && !type.startsWith('image/')) throw invalid('QQ 返回的资源不是图片');
        return validateImage(raw, type.startsWith('image/') ? type : undefined);
      }
      let result;
      try { result = JSON.parse(new TextDecoder().decode(raw)); } catch { throw mutation ? ambiguous() : new QQTransportError('QQ 接口确认不完整'); }
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw mutation ? ambiguous() : new QQTransportError('QQ 接口确认不完整');
      const code = Number(result.err_code ?? result.code ?? 0);
      if (!Number.isSafeInteger(code) || code < 0) throw mutation ? ambiguous() : new QQTransportError('QQ 接口确认不完整');
      if (!response.ok || code) throw failure(code, response.status);
      return result;
    } catch (error) {
      current(generation);
      if (error instanceof QQTransportError) throw error;
      throw mutation ? ambiguous() : clean(error);
    } finally { cancel(timer); requests.delete(controller); }
  }
  function scheduleTokenRefresh(generation, delay) {
    cancel(tokenTimer);
    tokenTimer = schedule(() => {
      tokenTimer = undefined;
      if (!active || generation !== epoch) return;
      access(generation).catch(error => {
        if (!active || generation !== epoch) return;
        report(ready ? 'connected' : 'reconnecting', error);
        if (error.retryable !== false) scheduleTokenRefresh(generation, 15000);
      });
    }, delay);
  }
  async function access(generation) {
    current(generation);
    if (token && token.refreshAt > now()) return token.value;
    if (!tokenTask) {
      const task = (async () => {
        const result = await request(`${ORIGIN}/app/getAppAccessToken`, { generation, method: 'POST', data: { appId, clientSecret: appSecret } });
        const expires = Number(result.expires_in);
        if (typeof result.access_token !== 'string' || !result.access_token || result.access_token.length > 8192 || /[\r\n]/.test(result.access_token) || !Number.isFinite(expires) || expires <= 0) throw new QQTransportError('QQ 应用令牌确认不完整');
        current(generation);
        const refreshMs = Math.max(1000, (expires - Math.min(45, expires / 10)) * 1000);
        token = { value: result.access_token, refreshAt: now() + refreshMs };
        scheduleTokenRefresh(generation, refreshMs);
        return token.value;
      })();
      tokenTask = task;
      task.finally(() => { if (tokenTask === task) tokenTask = null; }).catch(() => {});
    }
    return tokenTask;
  }
  async function authenticated(path, options) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const accessToken = await access(options.generation);
      try { return await request(ORIGIN + path, { ...options, accessToken }); }
      catch (error) { if (!attempt && error.tokenRejected) { token = null; continue; } throw error; }
    }
  }
  function send(ws, generation, payload) {
    if (!isCurrent(ws, generation) || ws.readyState !== 1) throw new QQTransportError('QQ 长连接已断开');
    ws.send(JSON.stringify(payload));
  }
  function reconnect(generation, error) {
    if (!active || generation !== epoch) return;
    if (error?.retryable === false) {
      reconnectBlocked = true; cancel(reconnectTimer); reconnectTimer = undefined;
      report('error', error); return;
    }
    if (reconnectBlocked || reconnectTimer !== undefined) return;
    report('reconnecting', error ?? new QQTransportError('QQ 长连接已断开，正在自动重连'));
    const delay = Math.min(60000, 1000 * 2 ** Math.min(attempts++, 6)) + Math.floor(random() * 1000);
    reconnectTimer = schedule(() => { reconnectTimer = undefined; connect(generation).catch(next => reconnect(generation, clean(next))); }, delay);
  }
  function heartbeat(ws, generation, interval) {
    if (!isCurrent(ws, generation)) return;
    if (awaitingAck) { closeSocket(ws); return; }
    try { awaitingAck = true; send(ws, generation, { op: 1, d: sequence }); }
    catch { closeSocket(ws); return; }
    heartbeatTimer = schedule(() => heartbeat(ws, generation, interval), interval);
  }
  async function connect(generation) {
    current(generation);
    const result = await authenticated('/gateway/bot', { generation });
    const endpoint = validateWebSocketEndpoint(result.url);
    if (result.shards !== undefined && result.shards !== 1) throw new QQTransportError('QQ 网关要求多分片连接，当前扩展仅支持单分片机器人', { retryable: false, code: 'sharding_unsupported' });
    if (result.session_start_limit?.remaining === 0 && !sessionId) throw new QQTransportError('QQ 长连接登录额度暂时耗尽', { retryable: false, code: 'session_limit' });
    const accessToken = await access(generation); current(generation);
    await new Promise((resolve, reject) => {
      const ws = new Socket(endpoint); socket = ws; ready = false;
      let settled = false; let hello = false; let failureCause; let accepting = true;
      const settle = error => { if (settled) return; settled = true; error ? reject(error) : resolve(); };
      const fail = error => {
        if (!isCurrent(ws, generation) || !accepting) return;
        // Native close may arrive later. Revoke this connection immediately;
        // its timers and queued events must not outlive a replacement socket.
        accepting = false; ready = false; clearConnectionTimers(); failureCause = clean(error);
        closeSocket(ws); settle(failureCause); reconnect(generation, failureCause);
      };
      handshakeTimer = schedule(() => fail(new QQTransportError('QQ 长连接握手超时')), timeoutMs);
      ws.addEventListener('message', event => {
        if (!isCurrent(ws, generation) || !accepting) return;
        let payload;
        try {
          if (typeof event.data !== 'string' || event.data.length > 2 * 1024 * 1024) throw invalid('QQ 长连接数据无效');
          payload = JSON.parse(event.data);
          if (!payload || typeof payload !== 'object' || !Number.isInteger(payload.op)) throw invalid('QQ 长连接数据无效');
          if (payload.op === 10) {
            if (hello) throw invalid('QQ 重复发送握手数据');
            hello = true;
            const interval = payload.d?.heartbeat_interval;
            if (!Number.isFinite(interval) || interval < 1000 || interval > 300000) throw invalid('QQ 心跳周期无效');
            send(ws, generation, sessionId ? { op: 6, d: { token: `QQBot ${accessToken}`, session_id: sessionId, seq: sequence } } : { op: 2, d: { token: `QQBot ${accessToken}`, intents: QQ_GROUP_INTENT, shard: [0, 1], properties: { $os: 'browser', $browser: 'qq-chatgpt-bridge', $device: 'Chrome Extension' } } });
            heartbeatTimer = schedule(() => heartbeat(ws, generation, interval), interval);
            return;
          }
          if (payload.op === 11) { awaitingAck = false; return; }
          if (payload.op === 1) { send(ws, generation, { op: 1, d: sequence }); return; }
          if (payload.op === 7) { closeSocket(ws); return; }
          if (payload.op === 9) { sessionId = undefined; sequence = null; fail(new QQTransportError('QQ 登录会话失效，正在重新连接')); return; }
          if (payload.op !== 0) return;
          if (!hello || !Number.isSafeInteger(payload.s) || payload.s < 0 || typeof payload.t !== 'string') throw invalid('QQ 事件数据无效');
        } catch (error) { fail(error); return; }
        // Control frames stay responsive while disk ingestion is pending. Only
        // ordered, durably accepted dispatches advance the RESUME checkpoint.
        incoming = incoming.then(async () => {
          if (!isCurrent(ws, generation) || !accepting || ws.readyState !== 1) return;
          if (payload.t === 'READY') {
            if (typeof payload.d?.session_id !== 'string' || !payload.d.session_id || payload.d.session_id.length > 256) throw invalid('QQ 会话标识无效');
            sessionId = payload.d.session_id;
          } else if (payload.t !== 'RESUMED') {
            if (!sessionId) throw invalid('QQ 尚未建立事件会话');
            const message = normalizeMessage(payload);
            if (message) await onMessage(message);
          }
          if (!isCurrent(ws, generation) || !accepting || ws.readyState !== 1) return;
          sequence = sequence === null ? payload.s : Math.max(sequence, payload.s);
          if (payload.t === 'READY' || payload.t === 'RESUMED') {
            cancel(handshakeTimer); handshakeTimer = undefined; ready = true; attempts = 0; report('connected'); settle();
          }
        }).catch(error => {
          if (!isCurrent(ws, generation)) return;
          // Do not acknowledge failed persistence by advancing sequence.
          fail(error instanceof QQTransportError ? error : new QQTransportError('QQ 事件未完成持久化，将通过重新连接重试'));
        });
      });
      ws.addEventListener('error', () => fail(new QQTransportError('QQ 长连接建立失败')));
      ws.addEventListener('close', event => {
        accepting = false;
        if (!isCurrent(ws, generation)) { settle(new QQTransportError('QQ 连接已停止', { retryable: false, code: 'stopped' })); return; }
        socket = undefined; ready = false; clearConnectionTimers();
        if ([4006, 4007].includes(event.code) || event.code >= 4900 && event.code <= 4913) { sessionId = undefined; sequence = null; }
        if ([4001, 4002, 4004, 4010, 4011, 4012, 4013, 4014, 4914, 4915].includes(event.code)) failureCause = new QQTransportError('QQ 拒绝长连接，请检查机器人状态、事件权限和连接配置', { retryable: false, code: 'authentication' });
        const error = failureCause ?? new QQTransportError('QQ 长连接已断开，正在自动重连');
        settle(error); reconnect(generation, error);
      });
    });
  }
  function start() {
    if (active) return starting ?? Promise.resolve();
    active = true; reconnectBlocked = false; const generation = ++epoch; report('connecting');
    const task = connect(generation).catch(error => { reconnect(generation, clean(error)); throw clean(error); });
    starting = task; task.finally(() => { if (starting === task) starting = null; }).catch(() => {});
    return task;
  }
  function stop() {
    active = false; epoch++; ready = false; token = tokenTask = starting = undefined;
    sessionId = undefined; sequence = null; attempts = 0;
    for (const controller of requests) controller.abort(); requests.clear();
    cancel(tokenTimer); cancel(reconnectTimer); tokenTimer = reconnectTimer = undefined; clearConnectionTimers();
    const ws = socket; socket = undefined; closeSocket(ws); incoming = Promise.resolve(); outbound = Promise.resolve(); report('stopped');
  }
  function queue(work) {
    const generation = epoch;
    const task = outbound.then(() => { connected(generation); return work(generation); });
    outbound = task.catch(() => {}); return task;
  }
  function replyData({ chatId, messageId, msgSeq, expiresAt }) {
    if (!identifier(chatId) || !messageIdentifier(messageId) || !Number.isInteger(msgSeq) || msgSeq < 1 || msgSeq > 5) throw invalid('QQ 群消息标识或回复序号无效');
    beforeDeadline(expiresAt);
    return { path: `/v2/groups/${chatId}/messages`, body: { msg_id: messageId, msg_seq: msgSeq }, expiresAt };
  }
  function sendMessage(input, extra) {
    let target;
    try { target = replyData(input); } catch (error) { return Promise.reject(error); }
    const body = { ...target.body, ...extra };
    return queue(async generation => {
      beforeDeadline(target.expiresAt);
      const result = await authenticated(target.path, { generation, method: 'POST', data: body, mutation: true, expiresAt: target.expiresAt });
      if (!messageIdentifier(result.id)) throw ambiguous();
      return { messageId: result.id, msgSeq: body.msg_seq };
    });
  }
  function reply(input) {
    if (typeof input?.text !== 'string' || !input.text.trim() || encoder.encode(input.text).length > 12000) return Promise.reject(invalid('QQ 回复文本为空或过长'));
    return sendMessage(input, { msg_type: 0, content: input.text });
  }
  function replyPost(input) {
    if (typeof input?.post !== 'string' || !input.post.trim() || encoder.encode(input.post).length > 12000) return Promise.reject(invalid('QQ Markdown 回复为空或过长'));
    return sendMessage(input, { msg_type: 2, markdown: { content: input.post } });
  }
  function replyImage(input) {
    if (typeof input?.imageKey !== 'string' || !input.imageKey || input.imageKey.length > 100000 || /[\x00-\x1f\x7f]/.test(input.imageKey)) return Promise.reject(invalid('QQ 图片资源标识无效'));
    return sendMessage(input, { msg_type: 7, media: { file_info: input.imageKey } });
  }
  function uploadImage({ chatId, buffer, mimeType, expiresAt } = {}) {
    let image;
    try { if (!identifier(chatId)) throw invalid('QQ 群标识无效'); beforeDeadline(expiresAt); image = validateImage(buffer, mimeType, QQ_IMAGE_UPLOAD_LIMIT); }
    catch (error) { return Promise.reject(error); }
    return queue(async generation => {
      const digest = await cryptoImpl.subtle.digest('SHA-256', image.buffer); connected(generation);
      const name = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      const suffix = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[image.mimeType];
      const result = await authenticated(`/v2/groups/${chatId}/files`, { generation, method: 'POST', expiresAt, data: { file_type: 1, file_name: `${name}.${suffix}`, file_data: base64(image.buffer), srv_send_msg: false } });
      if (typeof result.file_info !== 'string' || !result.file_info || result.file_info.length > 100000 || /[\x00-\x1f\x7f]/.test(result.file_info)) throw new QQTransportError('QQ 图片上传确认不完整');
      return { imageKey: result.file_info, ...(Number.isFinite(result.ttl) ? { ttl: result.ttl } : {}) };
    });
  }
  async function downloadImage({ imageKey } = {}) {
    const generation = epoch; connected(generation);
    let url;
    try { url = validateAttachmentUrl(imageKey); } catch { throw invalid('QQ 图片下载地址无效'); }
    if (!url) throw invalid('QQ 图片下载地址无效');
    return request(url, { generation, image: true });
  }
  return { start, stop, reply, replyPost, replyImage, uploadImage, downloadImage };
}
