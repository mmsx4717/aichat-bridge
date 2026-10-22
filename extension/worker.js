import { ASSISTANTS, ASSISTANT_NAMES, ASSISTANT_ORIGINS, conversationUrl, assistantId, assistantForUrl, safeError, isOptionsSender, validSession, resultTiming, normalizeText, validChallengeCheckpoint, pageDiagnostics } from './shared.js';
import { decodeImagePayload, validateInputImages, MAX_IMAGES, MAX_TOTAL_IMAGE_BYTES } from './dom.js';
import { sanitizeObservation } from './background-observation.js';
const JOB_PREFIX = 'bot.bridge.job.';
const NOTICE_PREFIX = 'bot.bridge.notice.';
const TAB_PROTECTION_PREFIX = 'bot.bridge.tab-protection.';
const HOST_TIMEOUT_MS = 25_000;
const locks = new Map();
let creatingHost;
const platformTails = new Map();
let wakeTimer; let wakeRunning = false; let wakePending = false;
let pageWakeTimer;
let pageWakeGeneration = 0;
let pageWakePending = false;
const protectedTabs = new Map();
function validPlatform(value) { return value === 'qq' || value === 'feishu'; }
function platformLocked(assistant, fn) {
  const pending = (platformTails.get(assistant) || Promise.resolve()).then(fn);
  platformTails.set(assistant, pending.catch(() => {}));
  return pending;
}
function noticePrefix(platform, assistant = 'chatgpt') {
  assistantId(assistant);
  if (!validPlatform(platform)) throw new Error('聊天平台无效');
  return NOTICE_PREFIX + (assistant === 'chatgpt' ? '' : assistant + '.') + platform + '.';
}
function noticeKey(job) { return noticePrefix(job.platform, job.assistant) + job.tabId; }
const ready = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const settings = await chrome.storage.local.get(['browserId']);
  if (!settings.browserId) await chrome.storage.local.set({ browserId: crypto.randomUUID() });
  // Keep the browser identity and durable jobs across service-worker restarts. An old lease
  // must be resolved or failed, never silently removed and submitted again.
  // Unsupported local-transport settings must never reach the page or a request.
  await chrome.storage.local.remove(['server', 'token']);
  await chrome.alarms.create('bot-bridge-maintenance', { periodInMinutes: 0.5 });
})();
async function config() { await ready; return chrome.storage.local.get(['browserId']); }
async function ensureHost() {
  await ready;
  if (!creatingHost) {
    creatingHost = (async () => {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL('offscreen.html')],
      });
      if (contexts.length) return;
      await chrome.offscreen.createDocument({
        url: 'offscreen.html', reasons: ['WORKERS'],
        justification: '在专用 Worker 中维持所选聊天平台连接并处理桥接任务',
      });
    })();
  }
  const pending = creatingHost;
  try { await pending; }
  finally { if (creatingHost === pending) creatingHost = undefined; }
}
class HostError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}
function hostError(message, status = 502) { return new HostError(message, status); }
async function api(path, body) {
  if (!/^\/v1\/(?:status|assistant|platform|channel|config|moderation|history\/clear|bind|unbind|poll|jobs\/[A-Za-z0-9_-]+\/(?:started|input-image|image|result|error|cancel))$/.test(path)) throw new Error('不允许的扩展请求');
  assistantId(body?.assistant);
  if (!['/v1/status', '/v1/assistant'].includes(path) && !validPlatform(body?.platform)) throw new Error('聊天平台无效');
  let timer;
  let timedOut = false;
  try {
    const response = await Promise.race([
      (async () => {
        await ensureHost();
        if (timedOut) throw hostError('扩展后台响应超时，已保留任务状态', 503);
        return chrome.runtime.sendMessage({ target: 'bridge-host', route: path, body });
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(hostError('扩展后台响应超时，已保留任务状态', 503)); }, HOST_TIMEOUT_MS); }),
    ]);
    if (!response || typeof response !== 'object' || Array.isArray(response) || typeof response.ok !== 'boolean') throw hostError('扩展后台确认不完整，已保留待处理状态');
    if (!response.ok) {
      if (!Number.isInteger(response.status) || response.status < 400 || response.status > 599 || typeof response.error !== 'string' || !response.error.trim()) throw hostError('扩展后台错误确认不完整，已保留待处理状态');
      throw hostError(response.error, response.status);
    }
    if (response.status !== undefined && (!Number.isInteger(response.status) || response.status < 200 || response.status > 299)) throw hostError('扩展后台确认状态无效，已保留待处理状态');
    const data = response.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw hostError('扩展后台返回格式无效');
    if (path === '/v1/poll') {
      if (!Object.hasOwn(data, 'job') || (data.job !== null && (typeof data.job !== 'object' || Array.isArray(data.job)))) throw hostError('扩展后台任务确认不完整');
    } else if (path === '/v1/status') {
      if (data.assistant !== body.assistant || typeof data.enabled !== 'boolean' || typeof data.configured !== 'boolean' || !validPlatform(data.platform) || !data.connection || typeof data.connection.state !== 'string' || !Array.isArray(data.groups) || !Array.isArray(data.jobs) || !Array.isArray(data.delivery)) throw hostError('扩展后台状态确认不完整');
    } else if (path === '/v1/moderation' && !Object.hasOwn(body, 'words')) {
      if (typeof data.valid !== 'boolean' || !Array.isArray(data.words) || data.words.some(word => typeof word !== 'string')) throw hostError('扩展后台词表确认不完整');
    } else if (data.ok !== true) throw hostError('扩展后台没有返回有效确认，已停止操作');
    if (path === '/v1/assistant' && (data.assistant !== body.assistant || data.enabled !== body.enabled)) throw hostError('扩展后台连接开关确认不完整');
    if (path === '/v1/platform' && data.platform !== body.platform) throw hostError('扩展后台平台切换确认不完整');
    if (path === '/v1/channel' && (data.platform !== body.platform || data.enabled !== body.enabled)) throw hostError('扩展后台通道开关确认不完整');
    return data;
  } catch (error) {
    if (error instanceof HostError) throw error;
    throw hostError('扩展后台暂时不可用，请重试或重新加载扩展', 503);
  } finally { clearTimeout(timer); }
}
function locked(tabId, fn) {
  const previous = locks.get(tabId) || Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  locks.set(tabId, next);
  next.finally(() => { if (locks.get(tabId) === next) locks.delete(tabId); }).catch(() => {});
  return next;
}
function key(tabId) { return JOB_PREFIX + tabId; }
async function getJob(tabId) {
  const job = (await chrome.storage.local.get(key(tabId)))[key(tabId)];
  // Pre-0.5 durable leases belong only to ChatGPT, never infer another provider.
  if (job && job.assistant === undefined && conversationUrl(job.conversationUrl)) job.assistant = 'chatgpt';
  if (job) assistantId(job.assistant);
  return job;
}
async function putJob(job) { await chrome.storage.local.set({ [key(job.tabId)]: job }); if (livePageJob(job)) schedulePageWakePulse(); }
async function dropJob(tabId) { await chrome.storage.local.remove(key(tabId)); }
export function stopPageWakePulse() { pageWakeGeneration++; clearTimeout(pageWakeTimer); pageWakeTimer = undefined; pageWakePending = false; }
function schedulePageWakePulse() {
  // A lease can arrive after an in-flight pass took an empty storage snapshot.
  // Remember that request even while the current loop still owns its timer.
  pageWakePending = true;
  if (pageWakeTimer !== undefined) return;
  const generation = pageWakeGeneration;
  pageWakeTimer = setTimeout(async () => {
    // Keep the marker set until this pass settles so job updates cannot create
    // concurrent pulse loops. No status RPCs or model submissions occur here.
    let pending = false; pageWakePending = false;
    try {
      const all = await chrome.storage.local.get(null);
      const jobs = Object.entries(all).filter(([k, job]) => k.startsWith(JOB_PREFIX) && livePageJob(job) && job.browserId === all.browserId);
      const results = await Promise.allSettled(jobs.map(([, job]) => wakeBoundTab(job.tabId, job.conversationUrl, job.assistant)));
      pending = results.some(result => result.status === 'fulfilled' && result.value === true);
    } catch { /* A failed pass is retried by the durable maintenance alarm. */ }
    finally { if (generation === pageWakeGeneration) { pageWakeTimer = undefined; if (pending || pageWakePending) schedulePageWakePulse(); } }
  }, 1000);
  // Node-based worker harnesses must not be kept alive by a Chrome-only hint.
  pageWakeTimer?.unref?.();
}
function livePageJob(job) {
  return recoverableLease(job) || (['starting', 'started'].includes(job?.state) && Number.isFinite(job.expiresAt) && job.expiresAt > Date.now());
}
async function protectTabForJob(job, tab) {
  if (tab.id !== job.tabId || conversationUrl(tab.url, job.assistant) !== job.conversationUrl) return;
  const protectionKey = TAB_PROTECTION_PREFIX + tab.id;
  let protection = (await chrome.storage.local.get(protectionKey))[protectionKey];
  if (protection && (protection.tabId !== tab.id || protection.browserId !== job.browserId || protection.assistant !== job.assistant ||
      protection.conversationUrl !== job.conversationUrl || protection.autoDiscardable !== true)) {
    await chrome.storage.local.remove(protectionKey); protectedTabs.delete(tab.id); protection = null;
  }
  if (tab.autoDiscardable !== true) {
    if (tab.autoDiscardable === false && protection?.token) protectedTabs.set(tab.id, protection.token);
    return;
  }
  protection ||= { tabId: tab.id, browserId: job.browserId, assistant: job.assistant, conversationUrl: job.conversationUrl, autoDiscardable: true, token: crypto.randomUUID() };
  if (protection.jobId !== job.id) { protection.jobId = job.id; protection.attempts = 0; }
  // A transient tabs API failure must not leave the whole task unprotected,
  // but persistent failures should not generate an unbounded maintenance loop.
  if ((protection.attempts || 0) >= 3) return;
  protection.attempts = (protection.attempts || 0) + 1;
  await chrome.storage.local.set({ [protectionKey]: protection });
  await chrome.tabs.update(tab.id, { autoDiscardable: false });
  protectedTabs.set(tab.id, protection.token);
}
async function restoreTabProtection(tabId) {
  const protectionKey = TAB_PROTECTION_PREFIX + tabId;
  const protection = (await chrome.storage.local.get(protectionKey))[protectionKey];
  if (!protection) return;
  const cfg = await config();
  const valid = protection.tabId === tabId && protection.autoDiscardable === true && protection.browserId === cfg.browserId &&
    ASSISTANTS.includes(protection.assistant) && conversationUrl(protection.conversationUrl, protection.assistant) === protection.conversationUrl;
  if (!valid) { await chrome.storage.local.remove(protectionKey); protectedTabs.delete(tabId); return; }
  let tab;
  try { tab = await chrome.tabs.get(tabId); }
  catch (error) {
    // A closed tab may outlive its onRemoved event in durable storage. Only a
    // definite missing-tab response retires ownership; transient API failures
    // retain the record so the maintenance alarm can restore it later.
    if (/^(?:No tab(?: with id:\s*-?\d+\.?)?|Invalid tab ID:\s*-?\d+\.?)$/i.test(String(error?.message || ''))) {
      await chrome.storage.local.remove(protectionKey); protectedTabs.delete(tabId);
    }
    return;
  }
  const knownTab = protection.token && protectedTabs.get(tabId) === protection.token;
  // Across worker restarts, only the same browser and exact conversation can
  // prove ownership. In this worker, a successful protection also permits
  // restoring the tab immediately after an observed navigation.
  if (tab.id !== tabId || (!knownTab && conversationUrl(tab.url, protection.assistant) !== protection.conversationUrl)) {
    await chrome.storage.local.remove(protectionKey); protectedTabs.delete(tabId); return;
  }
  try { await chrome.tabs.update(tabId, { autoDiscardable: true }); }
  catch { return; } // Retain the durable record for the maintenance retry.
  await chrome.storage.local.remove(protectionKey);
  protectedTabs.delete(tabId);
}
async function releasePageResources(job) {
  // Tab protection is best-effort cleanup, never a prerequisite for reporting
  // the task's durable result/error to the bot transport.
  try { await restoreTabProtection(job.tabId); } catch { /* Maintenance retries the retained record. */ }
}
function identity(job) { return { assistant: job.assistant, platform: job.platform, leaseToken: job.leaseToken, browserId: job.browserId, tabId: job.tabId, conversationUrl: job.conversationUrl }; }
function terminal(error) { return Number(error.status) >= 400 && Number(error.status) < 500 && ![408, 429].includes(Number(error.status)); }
async function notice(job, error) { await chrome.storage.local.set({ [noticeKey(job)]: { assistant: job.assistant, platform: job.platform, error: safeError(error), at: Date.now(), tabId: job.tabId, ...(job.diagnostics ? { diagnostics: job.diagnostics } : {}), ...(job.idleRefresh ? { idleRefreshMs: job.idleRefresh.idleMs, idleRefreshResumed: job.idleRefresh.phase === 'resumed' } : {}) } }); }
async function failJob(job, error) {
  job.state = 'error-pending'; job.error = safeError(error); delete job.prompt; delete job.text; delete job.images;
  delete job.challengeRecovery; delete job.promptDigest;
  await putJob(job);
  await releasePageResources(job);
  try { await api(`/v1/jobs/${job.id}/error`, { ...identity(job), error: job.error }); }
  catch (failure) { if (!terminal(failure)) throw failure; }
  await notice(job, job.error);
  await dropJob(job.tabId);
}
async function deliver(job) {
  try {
    await api(`/v1/jobs/${job.id}/result`, { ...identity(job), text: job.text, images: job.images || [], ...(job.timing ? { timing: job.timing } : {}) });
    await dropJob(job.tabId); return { ok: true };
  } catch (error) {
    if (!terminal(error)) throw error;
    const reason = '最终回复未回传：' + safeError(error);
    // A rejected result can leave the host's job running (for example when
    // QQ's reply-part limit is exceeded). End that original job before
    // releasing the tab; otherwise it blocks later questions until expiry.
    // failJob persists error-pending so only cleanup is retried after an outage.
    await failJob(job, reason);
    return { ok: true, failed: true, error: reason };
  }
}
function validateContentSender(sender) {
  if (sender.id !== chrome.runtime.id || !sender.tab || sender.frameId !== 0 || !Number.isInteger(sender.tab.id) || sender.tab.id < 0) throw new Error('拒绝非页面主框架请求');
  const assistant = assistantForUrl(sender.url);
  if (!assistant || (sender.origin !== undefined && sender.origin !== new URL(sender.url).origin)) throw new Error('拒绝非 ChatGPT / Claude / Gemini / Qwen 页面来源请求');
  return assistant;
}
async function liveAssistantTab(sender) {
  const assistant = validateContentSender(sender);
  const tab = await chrome.tabs.get(sender.tab.id);
  if (tab.id !== sender.tab.id || assistantForUrl(tab.url) !== assistant) throw new Error('当前标签页已离开原 AI 网页，已阻止操作');
  return { tab, assistant };
}
async function currentTab(sender, claimedUrl) {
  const { tab, assistant } = await liveAssistantTab(sender);
  const url = conversationUrl(tab.url, assistant);
  // The sender origin authenticates the provider; the live tab supplies SPA identity.
  if (!url || url !== claimedUrl) throw new Error('当前网页已切换，或不是已存在的 AI 对话');
  return { tab, url, assistant };
}
function recoverableLease(job) {
  return job?.state === 'leased' && Number.isFinite(job.expiresAt) && job.expiresAt > Date.now() &&
    typeof job.prompt === 'string' && Boolean(job.prompt.trim()) && job.prompt.length <= 12000;
}
async function promptDigest(prompt) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalizeText(prompt)));
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
}
function pageJob(job) {
  // Re-offering an unstarted lease is safe only in its original page session.
  // Never expose the durable lease identity or extend its original deadline.
  return { id: job.id, assistant: job.assistant, platform: job.platform, prompt: job.prompt,
    conversationUrl: job.conversationUrl, timeoutMs: Math.max(1, job.expiresAt - Date.now()), images: validateInputImages(job.inputImages), ...(job.idleRefresh ? { idleRefresh: { idleMs: job.idleRefresh.idleMs, lastUserKey: job.idleRefresh.lastUserKey } } : {}) };
}
async function content(message, sender) {
  if (!validSession(message.sessionId)) throw new Error('页面会话标识无效');
  const senderAssistant = validateContentSender(sender);
  return locked(sender.tab.id, async () => {
    const existing = await getJob(sender.tab.id);
    if (existing && existing.assistant !== senderAssistant) throw new Error('当前网页与任务的 AI 连接不匹配');
    if (message.type === 'bridge:error') {
      await liveAssistantTab(sender);
      if (!existing || existing.id !== message.jobId || existing.sessionId !== message.sessionId || existing.state === 'result-pending') return { ok: true };
      if (message.conversationUrl !== existing.conversationUrl) throw new Error('错误报告与原任务对话不匹配');
      if (existing.assistant === 'chatgpt') { const diagnostics = pageDiagnostics(message.diagnostics); if (diagnostics) existing.diagnostics = diagnostics; }
      await failJob(existing, message.error || '网页任务中止'); return { ok: true };
    }
    const { tab, url, assistant } = await currentTab(sender, message.conversationUrl);
    if (existing && existing.conversationUrl !== url) throw new Error('任务与当前页面不匹配，已阻止操作');
    if (message.type === 'bridge:challenge-resume') {
      if (assistant !== 'chatgpt') throw new Error('仅 ChatGPT 支持验证错误恢复');
      if (existing?.idleRefresh && existing.state === 'leased') {
        const cfg = await config();
        if (!recoverableLease(existing) || existing.browserId !== cfg.browserId || existing.tabId !== tab.id) {
          await failJob(existing, '发送前刷新任务已过期或身份不符，已停止'); return { job: null };
        }
        if (existing.idleRefresh.phase === 'reload-pending' && existing.sessionId === message.sessionId) return { job: null };
        if (existing.idleRefresh.phase !== 'reload-pending' && existing.sessionId !== message.sessionId) {
          await failJob(existing, '发送前刷新已经恢复，不能再次重新加载并提交'); return { job: null };
        }
        existing.sessionId = message.sessionId; existing.idleRefresh.phase = 'resumed';
        await putJob(existing); return { job: pageJob(existing) };
      }
      if (!existing?.challengeRecovery || existing.state !== 'started') return { job: null };
      const recovery = existing.challengeRecovery;
      const cfg = await config();
      if (existing.expiresAt <= Date.now() || existing.browserId !== cfg.browserId || existing.tabId !== tab.id || !validChallengeCheckpoint(recovery.checkpoint)) {
        await failJob(existing, '验证恢复任务已过期或身份不符，已停止'); return { job: null };
      }
      if (recovery.phase === 'reload-pending' && existing.sessionId === message.sessionId) return { job: null };
      if (recovery.phase !== 'reload-pending' && (existing.sessionId !== message.sessionId || recovery.retryIssued)) {
        await failJob(existing, '验证恢复已执行，不能再次刷新或重试；请在网页处理'); return { job: null };
      }
      existing.sessionId = message.sessionId; recovery.phase = 'resumed';
      await putJob(existing);
      return { job: { id: existing.id, assistant, platform: existing.platform, conversationUrl: url,
        timeoutMs: existing.expiresAt - Date.now(), recovery: recovery.checkpoint, ...(existing.diagnostics ? { recoveryBridgeIdleMs: existing.diagnostics.bridgeIdleMs } : {}) } };
    }
    if (message.type === 'bridge:poll') {
      if (existing) {
        if (existing.state === 'result-pending') { await deliver(existing); return { job: null }; }
        if (existing.state === 'error-pending') { await failJob(existing, existing.error); return { job: null }; }
        if (existing.sessionId !== message.sessionId) await failJob(existing, 'AI 页面重新加载，任务已中止；不会重新提问');
        else if (existing.expiresAt <= Date.now()) await failJob(existing, '等待 AI 回复超时');
        else if (recoverableLease(existing)) {
          const cfg = await config();
          if (existing.browserId !== cfg.browserId || existing.tabId !== tab.id) throw new Error('待恢复任务与当前浏览器或标签页不匹配');
          if (existing.expiresAt <= Date.now()) {
            await failJob(existing, '等待 AI 回复超时');
            return { job: null, busy: true };
          }
          await protectTabForJob(existing, tab).catch(() => {});
          const job = pageJob(existing);
          if (job.images.length && (!Array.isArray(message.capabilities) || !message.capabilities.includes('image-input-v1'))) throw new Error('当前网页扩展不支持输入图片，请手动刷新对应 AI 网页');
          return { job };
        }
        return { job: null, busy: true };
      }
      // Switching and acquiring a new lease share one short lock. Once stored,
      // a job occupies this tab globally until its original platform resolves it.
      return platformLocked(assistant, async () => {
        const state = await api('/v1/status', { assistant });
        if (!state.enabled) return { job: null };
        const cfg = await config();
        let platform = state.platform;
        if (hasChannelRouting(state)) {
          const candidates = Object.entries(state.platforms).filter(([id, channel]) => validPlatform(id) && channel.enabled &&
            channel.groups.some(group => group.binding?.browserId === cfg.browserId && group.binding.tabId === tab.id && conversationUrl(group.binding.conversationUrl, assistant) === url));
          if (candidates.length > 1) throw new Error('同一网页绑定了多个通道，请修复绑定后重试');
          if (!candidates.length) return { job: null };
          platform = candidates[0][0];
        }
        const capabilities = Array.isArray(message.capabilities) && message.capabilities.includes('image-input-v1') ? ['image-input-v1'] : [];
        const response = await api('/v1/poll', { assistant, platform, browserId: cfg.browserId, tabId: tab.id, conversationUrl: url, capabilities });
        if (!response.job) {
          const noticeId = noticePrefix(platform, assistant) + tab.id;
          const n = (await chrome.storage.local.get(noticeId))[noticeId];
          return { job: null, notice: n?.error };
        }
        const j = response.job;
        if (j.assistant !== assistant || j.platform !== platform || !validPlatform(j.platform) || typeof j.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(j.id) || typeof j.leaseToken !== 'string' || !j.leaseToken || typeof j.prompt !== 'string' || !j.prompt.trim() || j.prompt.length > 12000 || j.conversationUrl !== url) throw new Error('扩展后台返回的任务不符合当前平台或对话');
        const inputImages = validateInputImages(j.images);
        if (inputImages.length && !capabilities.includes('image-input-v1')) throw new Error('当前网页扩展不支持输入图片，请手动刷新对应 AI 网页');
        const timeoutMs = Math.max(1000, Math.min(Number(j.timeoutMs) || 600000, 600000));
        const job = { id: j.id, assistant, platform: j.platform, leaseToken: j.leaseToken, browserId: cfg.browserId, tabId: tab.id, conversationUrl: url, sessionId: message.sessionId, state: 'leased', prompt: j.prompt, inputImages, expiresAt: Date.now() + timeoutMs };
        await putJob(job);
        await protectTabForJob(job, tab).catch(() => {});
        await chrome.storage.local.remove(noticeKey(job));
        // Page receives neither application credentials nor browser/lease identity.
        return { job: pageJob(job) };
      });
    }
    if (!existing || existing.id !== message.jobId || existing.sessionId !== message.sessionId || existing.conversationUrl !== url) throw new Error('任务与当前页面不匹配，已阻止操作');
    if (message.type === 'bridge:qwen-observation') {
      if (assistant !== 'qwen' || existing.state !== 'started' || existing.expiresAt <= Date.now()) throw new Error('后台观察不属于当前执行中的 Qwen 任务');
      const samples = sanitizeObservation(message.samples);
      if (!samples) throw new Error('后台观察数据无效');
      // One latest record per channel, local only; never included in bot API data.
      await chrome.storage.local.set({ ['bot.bridge.observation.qwen.' + existing.platform]: {
        at: Date.now(), tabId: tab.id, jobId: existing.id, samples,
      } });
      return { ok: true };
    }
    if (message.type === 'bridge:idle-prepare') {
      const diagnostics = pageDiagnostics(message.diagnostics);
      if (assistant !== 'chatgpt' || existing.state !== 'leased' || existing.idleRefresh || existing.expiresAt - Date.now() < 10000 ||
        !diagnostics || diagnostics.phase !== 'idle-refresh' || diagnostics.bridgeIdleMs < 600000 ||
        !(message.lastUserKey === null || (typeof message.lastUserKey === 'string' && message.lastUserKey.length > 0 && message.lastUserKey.length <= 2048))) throw new Error('不能执行发送前刷新，任务可能已启动、刷新过或即将过期');
      existing.idleRefresh = { phase: 'reload-pending', idleMs: diagnostics.bridgeIdleMs, lastUserKey: message.lastUserKey };
      existing.diagnostics = diagnostics;
      await putJob(existing); return { ok: true };
    }
    if (message.type === 'bridge:challenge-prepare') {
      if (assistant !== 'chatgpt' || existing.state !== 'started' || existing.expiresAt - Date.now() < 10000 || existing.challengeRecovery || Object.keys(existing.uploadedImages || {}).length) throw new Error('本任务不能再次自动刷新；请在网页处理');
      if (!validChallengeCheckpoint(message.checkpoint) || await promptDigest(message.checkpoint.prompt) !== existing.promptDigest) throw new Error('验证恢复消息与原任务不一致');
      const { userKey, prompt, imageSources } = message.checkpoint;
      const diagnostics = pageDiagnostics(message.diagnostics); if (diagnostics) existing.diagnostics = diagnostics;
      existing.challengeRecovery = { phase: 'reload-pending', checkpoint: { userKey, prompt, imageSources }, retryIssued: false };
      await putJob(existing); return { ok: true };
    }
    if (message.type === 'bridge:challenge-retry') {
      const recovery = existing.challengeRecovery;
      if (assistant !== 'chatgpt' || existing.state !== 'started' || existing.expiresAt <= Date.now() || recovery?.phase !== 'resumed' || recovery.retryIssued) throw new Error('验证恢复已执行或任务已过期，不会重复重试');
      recovery.retryIssued = true; await putJob(existing); return { ok: true };
    }
    if (message.type === 'bridge:input-image') {
      if (!['leased', 'started'].includes(existing.state) || existing.expiresAt <= Date.now()) throw new Error('任务已结束或过期，不能读取输入图片');
      const expected = existing.inputImages?.find(image => image.id === message.imageId);
      if (!expected) throw new Error('输入图片不属于当前任务');
      const result = await api(`/v1/jobs/${existing.id}/input-image`, { ...identity(existing), imageId: expected.id });
      if (result.imageId !== expected.id || result.mimeType !== expected.mimeType || result.name !== expected.name) throw new Error('输入图片返回信息与任务不一致');
      const bytes = decodeImagePayload(result.mimeType, result.base64);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const actualId = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
      if (actualId !== expected.id || bytes.length !== expected.bytes) throw new Error('输入图片内容校验失败');
      await currentTab(sender, message.conversationUrl);
      if (existing.expiresAt <= Date.now()) throw new Error('任务已过期，不能读取输入图片');
      // Binary is returned directly and is never copied into durable Chrome storage.
      return { imageId: expected.id, mimeType: expected.mimeType, name: expected.name, base64: result.base64 };
    }
    if (message.type === 'bridge:started') {
      if (existing.state !== 'leased' || existing.expiresAt <= Date.now() || existing.idleRefresh?.phase === 'reload-pending') throw new Error('任务已经启动或过期；不会重复提问');
      existing.promptDigest = await promptDigest(existing.prompt);
      existing.state = 'starting'; delete existing.prompt; await putJob(existing);
      try {
        await api(`/v1/jobs/${existing.id}/started`, identity(existing));
        existing.state = 'started'; await putJob(existing); return { ok: true };
      } catch (error) {
        await failJob(existing, '网页发送前确认失败，本次没有点击发送').catch(() => {});
        throw error;
      }
    }
    if (message.type === 'bridge:image') {
      if (existing.state !== 'started' || existing.expiresAt <= Date.now()) throw new Error('任务尚未启动或已过期，不能上传图片');
      if (!Number.isInteger(message.index) || message.index < 0 || message.index >= MAX_IMAGES) throw new Error('图片序号无效，最多支持 4 张图片');
      const bytes = decodeImagePayload(message.mimeType, message.base64);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const imageId = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
      const uploaded = existing.uploadedImages || {};
      const previous = uploaded[message.index];
      if (previous) {
        if (previous.imageId !== imageId || previous.mimeType !== message.mimeType) throw new Error('拒绝更改同一序号已经上传的图片');
        return { ok: true, imageId };
      }
      if (message.index !== Object.keys(uploaded).length) throw new Error('请按顺序上传本次回复的图片');
      if (Object.values(uploaded).reduce((sum, image) => sum + image.byteLength, 0) + bytes.length > MAX_TOTAL_IMAGE_BYTES) throw new Error('本次回复图片合计超过 30 MB');
      const result = await api(`/v1/jobs/${existing.id}/image`, { ...identity(existing), index: message.index, mimeType: message.mimeType, base64: message.base64 });
      if (result.imageId !== imageId) throw new Error('扩展后台返回的图片确认不完整，已停止回传');
      existing.uploadedImages = { ...uploaded, [message.index]: { imageId, mimeType: message.mimeType, byteLength: bytes.length } };
      await putJob(existing);
      return { ok: true, imageId };
    }
    if (message.type === 'bridge:result') {
      if (!['started', 'result-pending'].includes(existing.state)) throw new Error('任务尚未成功启动');
      const images = message.images ?? [];
      const expected = Object.values(existing.uploadedImages || {}).map(image => image.imageId);
      if (!Array.isArray(images) || images.length > MAX_IMAGES || images.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) || JSON.stringify(images) !== JSON.stringify(expected)) throw new Error('最终回复的图片与本任务已上传图片不一致');
      if (typeof message.text !== 'string' || (!message.text.trim() && !images.length) || message.text.length > 120000) throw new Error('回复内容为空或过长');
      if (existing.state === 'result-pending' && (existing.text !== message.text || JSON.stringify(existing.images || []) !== JSON.stringify(images))) throw new Error('拒绝更改已提交的最终回复');
      existing.state = 'result-pending'; existing.text = message.text; existing.images = images;
      delete existing.challengeRecovery; delete existing.promptDigest;
      if (!existing.timing) { const timing = resultTiming(message.timing); if (timing) existing.timing = timing; }
      await putJob(existing);
      if (assistant === 'qwen') {
        const samples = sanitizeObservation(message.observation);
        if (samples) {
          const receivedAt = Date.now();
          await chrome.storage.local.set({ ['bot.bridge.observation.qwen.' + existing.platform]: {
            at: receivedAt, receivedAt, tabId: tab.id, jobId: existing.id, samples,
          } }).catch(() => {}); // Observation failure never blocks answer delivery.
        }
      }
      await releasePageResources(existing);
      try { return await deliver(existing); }
      catch {
        // A permanent rejection may still need durable host cleanup. Report
        // that failure rather than presenting it as a pending answer delivery.
        if (existing.state === 'error-pending') return { ok: true, failed: true, error: existing.error };
        return { ok: true, pending: true }; // Durable alarm retries only delivery, never the prompt.
      }
    }
    throw new Error('不允许的页面操作');
  });
}
async function activePlatform(claimed, assistant) {
  if (!validPlatform(claimed)) throw new Error('请选择有效的聊天平台');
  const state = await api('/v1/status', { assistant });
  if (!hasChannelRouting(state) && state.platform !== claimed) throw new Error('聊天平台已切换，请刷新设置后重试');
  return claimed;
}
function hasChannelRouting(state) {
  return ['qq', 'feishu'].every(id => typeof state.platforms?.[id]?.enabled === 'boolean' && Array.isArray(state.platforms[id].groups));
}
async function wakeAssistantTabs(assistant, cfg) {
  const state = await api('/v1/status', { assistant });
  if (!state.enabled) return;
  const bindings = new Map();
  const channels = hasChannelRouting(state) ? Object.values(state.platforms).filter(channel => channel.enabled) : [state];
  for (const channel of channels) {
    const queuedGroups = new Set(Array.isArray(channel.queuedChatIds) ? channel.queuedChatIds : (channel.jobs || []).filter(job => job?.state === 'queued').map(job => job.chatId));
    for (const group of channel.groups) {
      const binding = group?.binding;
      if (!queuedGroups.has(group?.chatId) || binding?.browserId !== cfg.browserId || !Number.isInteger(binding.tabId) || binding.tabId < 0) continue;
      const url = conversationUrl(binding.conversationUrl, assistant);
      if (url) bindings.set(binding.tabId, url);
    }
  }
  await Promise.allSettled([...bindings].map(async ([tabId, url]) => {
    await wakeBoundTab(tabId, url, assistant);
  }));
}
async function wakeBoundTab(tabId, url, assistant) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.id !== tabId || conversationUrl(tab.url, assistant) !== url) return false;
  // A suspended receiver may never acknowledge. A hint must not block recovery.
  chrome.tabs.sendMessage(tabId, { type: 'bridge:wake' }, { frameId: 0 }).catch(() => {});
  return true;
}
async function wakeQueuedTabs() {
  const cfg = await config();
  await Promise.allSettled(ASSISTANTS.map(assistant => wakeAssistantTabs(assistant, cfg)));
}
function scheduleWorkWake() {
  wakePending = true;
  if (wakeTimer !== undefined || wakeRunning) return;
  wakeTimer = setTimeout(async () => {
    wakeTimer = undefined; wakeRunning = true; wakePending = false;
    try { await wakeQueuedTabs(); } catch { /* Fallback polling retains all work. */ }
    finally {
      wakeRunning = false;
      if (wakePending) scheduleWorkWake();
    }
  }, 0);
}
async function options(message) {
  if (message.type === 'options:settings') {
    const cfg = await config();
    return { browserId: cfg.browserId, extensionOnly: true };
  }
  // Old open settings tabs default only to the original GPT profile.
  const assistant = assistantId(message.assistant ?? 'chatgpt');
  if (message.type === 'options:cancel-job') {
    if (typeof message.jobId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(message.jobId)) throw new Error('任务标识无效，请刷新任务列表');
    return platformLocked(assistant, async () => {
      const platform = await activePlatform(message.platform, assistant);
      // The store atomically rejects cancellation once the page has leased it.
      // Never remove a worker lease or interrupt a prompt already on the page.
      const result = await api(`/v1/jobs/${message.jobId}/cancel`, { assistant, platform });
      scheduleWorkWake();
      return result;
    });
  }
  if (message.type === 'options:clear-history') {
    return platformLocked(assistant, async () => {
      const platform = await activePlatform(message.platform, assistant);
      return api('/v1/history/clear', { assistant, platform });
    });
  }
  if (message.type === 'options:clear-notices') {
    return platformLocked(assistant, async () => {
      const platform = message.platform === undefined ? (await api('/v1/status', { assistant })).platform : await activePlatform(message.platform, assistant);
      const all = await chrome.storage.local.get(null);
      await chrome.storage.local.remove(Object.keys(all).filter(k => k.startsWith(noticePrefix(platform, assistant))));
      if (assistant === 'qwen') await chrome.storage.local.remove('bot.bridge.observation.qwen.' + platform);
      return { ok: true };
    });
  }
  if (message.type === 'options:status') {
    if (message.platform !== undefined && !validPlatform(message.platform)) throw new Error('请选择有效的聊天平台');
    const state = await api('/v1/status', { assistant, ...(message.platform ? { platform: message.platform } : {}) });
    if (message.platform && hasChannelRouting(state) && state.platform !== message.platform) throw new Error('后台返回的平台配置不匹配');
    const all = await chrome.storage.local.get(null);
    state.localNotices = Object.entries(all).filter(([k]) => k.startsWith(noticePrefix(state.platform, assistant))).map(([, v]) => v)
      .filter(notice => notice && typeof notice.error === 'string')
      .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0)).slice(0, 20);
    if (assistant === 'qwen') {
      const record = all['bot.bridge.observation.qwen.' + state.platform];
      const samples = sanitizeObservation(record?.samples);
      if (samples) state.backgroundObservation = { at: record.at, tabId: record.tabId, samples,
        ...(Number.isSafeInteger(record.receivedAt) ? { receivedAt: record.receivedAt } : {}) };
    }
    return state;
  }
  if (message.type === 'options:tabs') {
    const tabs = await chrome.tabs.query({ url: ASSISTANT_ORIGINS[assistant] + '/*' });
    return { tabs: tabs.filter(t => conversationUrl(t.url, assistant)).map(t => ({ tabId: t.id, title: t.title || `${ASSISTANT_NAMES[assistant]} 对话`, conversationUrl: conversationUrl(t.url, assistant) })) };
  }
  if (['options:platform', 'options:assistant', 'options:channel'].includes(message.type)) {
    if (message.type !== 'options:assistant' && !validPlatform(message.platform)) throw new Error('请选择有效的聊天平台');
    if (message.type !== 'options:platform' && typeof message.enabled !== 'boolean') throw new Error('连接开关无效');
    return platformLocked(assistant, async () => {
      const current = await api('/v1/status', { assistant });
      if (message.type === 'options:platform' && current.platform === message.platform) return { ok: true, platform: current.platform };
      if (message.type === 'options:assistant' && current.enabled === message.enabled) return { ok: true, assistant, enabled: current.enabled };
      const dual = hasChannelRouting(current);
      if (message.type === 'options:channel' && !dual) throw new Error('扩展后台尚未更新，请重新加载扩展');
      if (message.type === 'options:channel' && current.platforms[message.platform].enabled === message.enabled) return { ok: true, platform: message.platform, enabled: message.enabled };
      const all = await chrome.storage.local.get(null);
      const needsIdle = message.type === 'options:platform' ? !dual : !message.enabled;
      if (needsIdle && Object.entries(all).some(([k, job]) => k.startsWith(JOB_PREFIX) && (job.assistant ?? 'chatgpt') === assistant &&
        (message.type !== 'options:channel' || job.platform === message.platform))) throw new Error('此 AI 通道仍有待处理任务或回复，请完成后再关闭');
      const result = message.type === 'options:platform'
        ? await api('/v1/platform', { assistant, platform: message.platform })
        : message.type === 'options:channel' ? await api('/v1/channel', { assistant, platform: message.platform, enabled: message.enabled })
          : await api('/v1/assistant', { assistant, enabled: message.enabled });
      scheduleWorkWake();
      return result;
    });
  }
  if (!['options:moderation', 'options:save-words', 'options:reply-style', 'options:config', 'options:bind', 'options:unbind'].includes(message.type)) throw new Error('不允许的设置操作');
  const platform = await activePlatform(message.platform, assistant);
  if (message.type === 'options:moderation') return api('/v1/moderation', { assistant, platform });
  if (message.type === 'options:save-words') return api('/v1/moderation', { assistant, platform, words: message.words });
  if (message.type === 'options:reply-style') {
    if (platform !== 'feishu' || !['separate', 'card'].includes(message.replyStyle)) throw new Error('当前平台不支持此回复样式');
    return api('/v1/config', { assistant, platform, replyStyle: message.replyStyle });
  }
  if (message.type === 'options:config') {
    if (typeof message.appId !== 'string' || typeof message.appSecret !== 'string') throw new Error('应用配置格式无效');
    return api('/v1/config', { assistant, platform, appId: message.appId.trim(), appSecret: message.appSecret.trim() });
  }
  if (message.type === 'options:bind') {
    if (!Number.isInteger(message.tabId) || typeof message.chatId !== 'string' || !message.chatId.trim()) throw new Error('请选择群和已有对话');
    const tab = await chrome.tabs.get(message.tabId);
    const url = conversationUrl(tab.url, assistant);
    if (!url || url !== message.conversationUrl) throw new Error('所选标签页已变化或不属于此 AI，请刷新列表');
    const cfg = await config();
    const result = await api('/v1/bind', { assistant, platform, chatId: message.chatId.trim(), conversationUrl: url, browserId: cfg.browserId, tabId: tab.id });
    scheduleWorkWake();
    return result;
  }
  return api('/v1/unbind', { assistant, platform, chatId: String(message.chatId || '') });
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // The offscreen document alone answers host IPC. Competing responses here
  // could turn an engine acknowledgement into an unrelated validation error.
  if (message?.target === 'bridge-host') return false;
  if (message?.type === 'bridge:work-available') {
    if (!Array.isArray(message) && Object.keys(message).length === 1 && sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('offscreen.html') && sender.tab === undefined) {
      scheduleWorkWake(); respond({ ok: true });
    }
    return false;
  }
  (async () => {
    await ready;
    if (!message || typeof message.type !== 'string') throw new Error('消息格式无效');
    if (message.type.startsWith('options:')) {
      if (!isOptionsSender(sender, chrome.runtime.id, chrome.runtime.getURL('options.html'))) throw new Error('只允许扩展设置页修改配置');
      return options(message);
    }
    if (!['bridge:poll', 'bridge:started', 'bridge:input-image', 'bridge:image', 'bridge:result', 'bridge:error', 'bridge:challenge-prepare', 'bridge:challenge-resume', 'bridge:challenge-retry', 'bridge:idle-prepare', 'bridge:qwen-observation'].includes(message.type)) throw new Error('不允许的页面操作');
    return content(message, sender);
  })().then(data => respond({ ok: true, data }), error => respond({ ok: false, error: safeError(error) }));
  return true;
});
async function maintenance() {
  await ready;
  await ensureHost();
  // A lost work notification must not leave the page waiting for a refresh.
  scheduleWorkWake();
  const all = await chrome.storage.local.get(null);
  const browserId = all.browserId;
  await Promise.allSettled(Object.entries(all).filter(([k]) => k.startsWith(JOB_PREFIX)).map(([, initial]) => locked(initial.tabId, async () => {
    const job = await getJob(initial.tabId); if (!job) return;
    if (livePageJob(job) && job.browserId === browserId && Number.isInteger(job.tabId) && job.tabId >= 0 && conversationUrl(job.conversationUrl, job.assistant) === job.conversationUrl) {
      // Leased and executing jobs are absent from queuedChatIds. A wake only
      // rechecks the page's current wait; it never submits another question.
      await protectTabForJob(job, await chrome.tabs.get(job.tabId)).catch(() => {});
      await wakeBoundTab(job.tabId, job.conversationUrl, job.assistant);
      schedulePageWakePulse();
    }
    if (job.state === 'result-pending') { await releasePageResources(job); return deliver(job); }
    if (job.state === 'error-pending') return failJob(job, job.error);
    if (job.expiresAt <= Date.now()) return failJob(job, '等待 AI 回复超时；未重复提交网页');
  })));
  await Promise.allSettled(Object.entries(all).filter(([k]) => k.startsWith(TAB_PROTECTION_PREFIX)).map(([, protection]) => locked(protection.tabId, async () => {
    const job = await getJob(protection.tabId);
    if (!livePageJob(job)) await restoreTabProtection(protection.tabId);
  })));
}
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'bot-bridge-maintenance') maintenance().catch(() => {}); });
chrome.tabs.onRemoved.addListener(tabId => { locked(tabId, async () => { protectedTabs.delete(tabId); await chrome.storage.local.remove(TAB_PROTECTION_PREFIX + tabId); const job = await getJob(tabId); if (job && job.state !== 'result-pending') await failJob(job, '绑定的 AI 标签页已关闭'); }).catch(() => {}); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  const resumed = change.status === 'complete' || change.frozen === false || change.discarded === false;
  if (resumed) scheduleWorkWake();
  if (!change.url && !resumed) return;
  locked(tabId, async () => {
    const job = await getJob(tabId);
    if (change.url && job && job.state !== 'result-pending' && conversationUrl(change.url, job.assistant) !== job.conversationUrl) await failJob(job, '绑定标签页切换了对话，任务中止');
    else if (resumed && livePageJob(job) && job.browserId === (await config()).browserId) {
      await wakeBoundTab(tabId, job.conversationUrl, job.assistant); schedulePageWakePulse();
    }
  }).catch(() => {});
});
chrome.action.onClicked.addListener(() => { chrome.runtime.openOptionsPage(); });
chrome.runtime.onInstalled.addListener(() => { ready.then(() => chrome.runtime.openOptionsPage()).catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { maintenance().catch(() => {}); });
maintenance().catch(() => {});
