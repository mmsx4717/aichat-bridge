import { normalizeText } from './shared.js';
// Shared helpers read text, validate image bytes and clear native editor state.
// Claude owns its composer, attachment, turn and completion selectors.
import {
  PageSafetyError, visible, composerText, markdownText, clearComposerDraft,
  validateInputImages, decodeImagePayload, MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES,
} from './dom.js';
export { PageSafetyError, visible, composerText, markdownText, validateInputImages, MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES };

// These structural selectors were checked read-only against Claude's web UI.
// Do not fall back to arbitrary textboxes, submit buttons, or whole-page prose.
const COMPOSER = '[data-testid="chat-input"][contenteditable="true"]';
const SEND = 'button[data-testid="chat-input-send"]';
const USER = '[data-testid="user-message"]';
const ASSISTANT = '[data-testid="assistant-message"]';
const ROW = '[data-testid="transcript-row"]';
const REASONING = 'details, [data-testid="TurnStatus"], [data-cds="TurnStatus"], [data-testid*="thinking"], [data-testid*="reasoning"], [data-channel="analysis"], [aria-hidden="true"]';
const PREVIEW = '[data-testid*="attachment"], [data-testid*="file-thumbnail"], [data-testid*="file-chip"], [data-testid*="upload-preview"], [data-cds="Attachment"], [data-cds="FilePreview"]';
const REMOVE = 'button[aria-label*="Remove attachment"], button[aria-label*="Remove file"], button[aria-label*="移除附件"], button[aria-label*="移除文件"], button[aria-label*="删除文件"], button[data-testid="remove-attachment"]';
const CLIPBOARD_CARD = '[data-cds="MessageAttachmentsImage"][data-testid="file-thumbnail"][data-cds-attachment]';
const pastedImages = new WeakMap();
const isReasoning = node => Boolean(node.closest(REASONING));

export function composerScope(input) { return input?.closest('[data-cds="ChatComposer"]') || null; }
function attachmentScope(input) {
  const scope = composerScope(input); if (!scope) return null;
  // Claude keeps the native file input and attachment UI beside ChatComposer.
  // Widen only to its observed composer fieldset, never to an arbitrary form or
  // page ancestor that could include files from a conversation or another editor.
  const fieldset = scope.closest('fieldset[data-perf-region="composer"][data-cds-dock-group]');
  if (!fieldset) return scope;
  if (fieldset.querySelectorAll('[data-cds="ChatComposer"]').length !== 1 || fieldset.querySelectorAll(COMPOSER).length !== 1 || fieldset.querySelector(`${ROW}, ${USER}, ${ASSISTANT}`)) return null;
  return fieldset;
}
function nativeFileInput(input) {
  const scope = attachmentScope(input);
  if (!scope?.matches('fieldset[data-perf-region="composer"][data-cds-dock-group]')) throw new PageSafetyError('未找到已确认的 Claude 文件上传区域，已停止上传');
  const fields = [...scope.querySelectorAll('input[type="file"]')];
  const field = fields[0];
  // The native picker is intentionally hidden. Its exact composer boundary,
  // identity and enabled state, rather than visual display, identify it.
  if (fields.length !== 1 || !field.matches('[data-testid="file-upload"][multiple]') ||
      !['chat-input-file-upload-bottom', 'chat-input-file-upload-onpage'].includes(field.id) ||
      field.closest('fieldset[data-perf-region="composer"][data-cds-dock-group]') !== scope ||
      !field.isConnected || field.disabled || field.matches(':disabled') || field.closest('[inert], [aria-disabled="true"]')) throw new PageSafetyError('Claude 文件上传入口不可用或不唯一，已停止上传');
  return field;
}
function assertNativeSelection(input, records) {
  const registered = [...(records?.values() || [])].filter(record => record.fileInput);
  if (!registered.length) return;
  const field = nativeFileInput(input);
  if (registered.some(record => record.fileInput !== field)) throw new PageSafetyError('Claude 文件上传入口已被替换，已停止发送');
  if ([...(field.files || [])].some(file => !registered.some(record => record.file === file))) throw new PageSafetyError('Claude 文件选择包含不属于本次任务的文件，已停止发送');
}
export function composer(doc) {
  const inputs = [...doc.querySelectorAll(COMPOSER)].filter(visible);
  if (!inputs.length) throw new PageSafetyError('暂未找到 Claude 输入框，等待网页加载');
  if (inputs.length > 1) throw new PageSafetyError('检测到多个可见的 Claude 输入框，暂不自动操作');
  const input = inputs[0]; const scope = composerScope(input);
  if (!scope || scope.querySelectorAll(COMPOSER).length !== 1 || scope.querySelector(`${USER}, ${ASSISTANT}`) || !attachmentScope(input)) throw new PageSafetyError('Claude 输入区结构已变化，已停止自动操作');
  if (input.getAttribute('aria-disabled') === 'true' || input.closest('[inert]')) throw new PageSafetyError('Claude 输入框当前不可用');
  return input;
}
export function composerInteraction(target, input) {
  return Boolean(target?.closest && (target.closest(COMPOSER) || (input && attachmentScope(input)?.contains(target)) || target.closest(SEND)));
}
export function generating(doc) {
  return [...doc.querySelectorAll('button[data-testid="chat-input-stop"], button[data-testid="stop-button"], button[aria-label="Stop response"], button[aria-label="Stop generating"], button[aria-label="停止响应"], button[aria-label="停止生成"], [data-testid="assistant-message"][data-is-streaming="true"], [data-testid="transcript-row"][data-perf-row-streaming="true"], [data-testid="assistant-message"] [aria-busy="true"]')].some(visible);
}
export function turns(doc, role) {
  const selector = role === 'user' ? USER : ASSISTANT;
  // Even a hidden extra user turn invalidates ownership. Assistant output must
  // itself be visible before it can become a candidate.
  return [...doc.querySelectorAll(selector)].filter(node => (role === 'user' || visible(node)) && !node.parentElement?.closest(selector));
}
function messageRow(message) {
  const row = message.closest(ROW);
  if (!row || row.querySelectorAll(`${USER}, ${ASSISTANT}`).length !== 1) return null;
  return row;
}
function turnKey(message) {
  const row = messageRow(message);
  const id = message.getAttribute('data-message-id') || row?.getAttribute('data-message-id');
  // Transcript indices change when older messages load; they are not identities.
  return id ? `${message.matches(USER) ? 'user' : 'assistant'}:${id}` : message;
}
function userText(message) {
  // Background/content-visibility rendering may leave innerText empty even
  // though this verified prompt root already contains the full message. Read
  // its structural text with paragraph/BR boundaries, as the Qwen adapter does.
  // Keep exact matching; never substitute transcript or assistant text.
  return normalizeText(composerText(message.cloneNode(true)));
}
function publicBodies(message) {
  // Current transcript-engine prose no longer carries data-perf-reply-text.
  // Keep both observed layouts scoped to the answer, outside thinking/actions.
  return [...message.querySelectorAll('[data-perf-reply-text].standard-markdown, [data-transcript-engine-root] > [data-cds="Prose"] > .standard-markdown')].filter(node =>
    visible(node) && !isReasoning(node) && node.closest(ASSISTANT) === message &&
    !node.closest('[data-testid="message-actions"]') &&
    !node.parentElement?.closest('[data-perf-reply-text], .standard-markdown, pre, code'));
}
function completedMessage(message) {
  const row = messageRow(message);
  if (!row || message.getAttribute('data-is-streaming') !== 'false' || row.getAttribute('data-perf-row-streaming') === 'true') return false;
  if ([...message.querySelectorAll('[role="alert"], [data-testid="error-message"]')].some(visible)) return false;
  const bars = [...row.querySelectorAll('[data-testid="message-actions"][role="toolbar"]')].filter(bar =>
    visible(bar) && bar.closest(ROW) === row && !isReasoning(bar) &&
    !bar.closest('[data-cds="Prose"], .standard-markdown, pre, code'));
  if (bars.length !== 1) return false;
  const bar = bars[0], nested = message.contains(bar);
  if (nested) {
    const bodies = publicBodies(message);
    // The current MessageActions toolbar lives inside AssistantMessage, after
    // its public prose. A toolbar embedded in answer/code text is not trusted.
    if (!message.matches('[data-cds="AssistantMessage"]') || !bar.matches('[data-cds="MessageActions"]') ||
        bar.closest(ASSISTANT) !== message || bodies.length !== 1 ||
        !(bodies[0].compareDocumentPosition(bar) & 4)) return false;
  } else if (bar.closest(ASSISTANT) || !(message.compareDocumentPosition(bar) & 4)) return false;
  // A code-block copy control is never a completion signal. Require both
  // response actions in the same row and explicit stopped-stream state.
  const buttons = [...bar.querySelectorAll('button')].filter(button =>
    button.closest('[data-testid="message-actions"][role="toolbar"]') === bar && !isReasoning(button) &&
    !button.closest('[data-cds="Prose"], .standard-markdown, pre, code'));
  const copies = buttons.filter(button => button.getAttribute('data-testid') === 'action-bar-copy' ||
    (nested && button.parentElement === bar && button.matches('[data-cds="Button"]:not([data-testid])') &&
      ['复制', 'Copy'].includes(button.getAttribute('aria-label'))));
  const retries = buttons.filter(button => button.getAttribute('data-testid') === 'action-bar-retry');
  return copies.length === 1 && retries.length === 1 && enabled(copies[0]) && enabled(retries[0]);
}
function enabled(button) {
  // .disabled alone misses the browser's inherited disabled fieldset state.
  return visible(button) && !button.disabled && !button.matches(':disabled') && !button.closest('[inert], [aria-disabled="true"]');
}
function removableButtons(scope, names = []) {
  return [...scope.querySelectorAll('button')].filter(button => visible(button) && (button.matches(REMOVE) || /^(?:Remove(?:\s|$)|移除|删除)/i.test(button.getAttribute('aria-label') || '') || names.some(name => {
    const label = button.getAttribute('aria-label');
    return [`Remove ${name}`, `Remove “${name}”`, `Remove "${name}"`, `移除“${name}”`, `移除"${name}"`, `删除 ${name}`].includes(label);
  })));
}
export function hasAttachments(input) {
  const scope = attachmentScope(input); if (!scope) return true;
  if ([...scope.querySelectorAll('input[type="file"]')].some(field => field.files?.length)) return true;
  if (removableButtons(scope).length) return true;
  return [...scope.querySelectorAll(`img, ${PREVIEW}, [role="progressbar"], [aria-busy="true"]`)].some(node => visible(node) && (node.tagName === 'IMG' || node.matches('[role="progressbar"], [aria-busy="true"]') || node.childElementCount || normalizeText(node.textContent)));
}
export function assertReady(doc, { allowDraft = false } = {}) {
  if ([...doc.querySelectorAll('#challenge-running, #challenge-stage, iframe[src*="challenges.cloudflare.com"]')].some(visible)) throw new PageSafetyError('网页正在验证，请先手动完成验证');
  if (generating(doc)) throw new PageSafetyError('该对话正在生成回复，请等待完成');
  const lastUser = turns(doc, 'user').at(-1); const lastAssistant = turns(doc, 'assistant').at(-1);
  if (lastUser && (!messageRow(lastUser) || !lastAssistant || !(lastUser.compareDocumentPosition(lastAssistant) & 4) || !completedMessage(lastAssistant))) throw new PageSafetyError('上一条 Claude 网页提问尚未明确完成，请先在网页处理');
  const input = composer(doc);
  if (!allowDraft && hasAttachments(input)) throw new PageSafetyError('输入区存在附件或正在上传，本次不会发送');
  if (!allowDraft && normalizeText(composerText(input))) throw new PageSafetyError('输入框有草稿，本次不会覆盖草稿');
  return input;
}
export function clearDraft(doc, input, clicked = new WeakSet()) {
  if (composer(doc) !== input) throw new PageSafetyError('清理前 Claude 输入框已变化');
  const scope = attachmentScope(input);
  clearComposerDraft(doc, input, scope, [...scope.querySelectorAll(`${REMOVE}, button[data-cds-attachment-remove]`)], clicked);
  releaseInputImages(input);
}
export function sendButton(doc, input) {
  if (composer(doc) !== input) throw new PageSafetyError('Claude 输入框已被替换，已停止发送');
  const buttons = [...composerScope(input).querySelectorAll(SEND)].filter(visible);
  if (buttons.length !== 1 || !enabled(buttons[0])) return null;
  return buttons[0];
}
export function snapshot(doc) {
  const users = turns(doc, 'user');
  return { users: new Set(users.map(turnKey)), lastUserKey: users.length ? turnKey(users.at(-1)) : null, assistants: new Set(turns(doc, 'assistant').map(turnKey)), imageSources: new Set([...doc.querySelectorAll('img')].map(image => image.currentSrc || image.src).filter(Boolean)) };
}
export function newUsers(doc, baseline) {
  let users = turns(doc, 'user');
  if (baseline.users.size) {
    const anchor = users.findIndex(node => turnKey(node) === baseline.lastUserKey);
    if (anchor < 0) throw new PageSafetyError('原有 Claude 用户消息基准已消失，无法确认新消息范围，已停止转发');
    users = users.slice(anchor + 1);
  }
  return users.filter(node => !baseline.users.has(turnKey(node)));
}
export function findSubmittedUser(doc, baseline, prompt) {
  const users = newUsers(doc, baseline);
  if (users.length > 1) throw new PageSafetyError('检测到其他新消息，已停止转发，避免混淆回复');
  if (!users.length) return null;
  if (!messageRow(users[0])) throw new PageSafetyError('Claude 新消息结构已变化，已停止转发');
  const text = userText(users[0]);
  // The row may mount before its prompt. An empty shell does not establish
  // ownership; let the existing bounded confirmation window wait for the text.
  if (!text) return null;
  if (text !== normalizeText(prompt)) throw new PageSafetyError('新增网页消息与本次群消息不同，已停止转发');
  baseline.submittedText = normalizeText(prompt);
  return users[0];
}

// Claude's attachment layout can change independently of its editor. Confirm
// exact names, one removal control per file and loaded images. Clipboard names
// rewritten by Claude require a separately registered, byte-identical blob;
// unrecognized or unacknowledged uploads never enable text-only fallback.
function namedAttachmentState(input, scope, names, originalNames) {
  const removers = removableButtons(scope, names);
  if (removers.length !== names.length) {
    const previews = [...scope.querySelectorAll(`img, ${PREVIEW}`)].filter(visible);
    const uploading = previews.some(node => node.tagName === 'IMG' && (!node.complete || !node.naturalWidth || !node.naturalHeight));
    return { ready: false, reason: uploading ? 'uploading' : previews.length || removers.length ? 'name-mismatch' : 'no-attachment' };
  }
  const matched = new Set(); const wrappers = [];
  for (const remover of removers) {
    let wrapper = remover.parentElement; let found;
    while (wrapper && wrapper !== scope && !wrapper.contains(input)) {
      const markers = new Set([wrapper, ...wrapper.querySelectorAll('*')].filter(visible).flatMap(node => names.filter(name =>
        ['alt', 'title', 'aria-label'].some(attribute => node.getAttribute(attribute) === name) || (!node.childElementCount && normalizeText(node.textContent) === name))));
      if (markers.size === 1 && removableButtons(wrapper, names).length === 1) { found = [...markers][0]; break; }
      wrapper = wrapper.parentElement;
    }
    if (!found || matched.has(found)) return { ready: false };
    matched.add(found); wrappers.push(wrapper);
  }
  const previews = [...scope.querySelectorAll(`img, ${PREVIEW}`)].filter(visible);
  if (previews.some(node => !wrappers.some(wrapper => wrapper.contains(node) || node.contains(wrapper)))) return { ready: false };
  // A shared previews region must contain only the individually matched files.
  if (previews.some(region => !wrappers.some(wrapper => wrapper.contains(region)) && [...region.children].filter(visible).some(node => !wrappers.some(wrapper => node.contains(wrapper) || wrapper.contains(node))))) return { ready: false };
  if ([...scope.querySelectorAll('input[type="file"]')].some(field => [...(field.files || [])].some(file => !names.includes(file.name) && !originalNames.includes(file.name)))) return { ready: false };
  if (previews.some(node => node.tagName === 'IMG' && (!node.complete || !node.naturalWidth || !node.naturalHeight))) return { ready: false, reason: 'uploading' };
  if (wrappers.some(wrapper => [...wrapper.querySelectorAll('img')].filter(visible).length > 1)) return { ready: false };
  return { ready: matched.size === names.length };
}
function clipboardCard(card, originalName) {
  if (!card?.matches(CLIPBOARD_CARD) || !visible(card)) return null;
  const links = card.querySelectorAll('[data-cds="CardLink"][role="button"]');
  const images = card.querySelectorAll('img'); const removers = card.querySelectorAll('button[data-cds-attachment-remove]');
  if (links.length !== 1 || images.length !== 1 || removers.length !== 1 || !links[0].contains(images[0]) || !visible(removers[0])) return null;
  const labels = [...links[0].querySelectorAll('.sr-only')].filter(node => visible(node) && !node.childElementCount);
  if (labels.length !== 1) return null;
  const name = normalizeText(labels[0].textContent);
  // Native clipboard paste can use timestamp_clipboard.png; synthetic paste
  // now also prefixes the exact registered File.name with a timestamp. Neither
  // filename alone proves ownership: both paths still require identical bytes.
  const prefixedName = name.match(/^\d{10,17}_(.+)$/)?.[1];
  if (!(/^\d{10,17}_clipboard\.(?:png|jpe?g|webp)$/i.test(name) || (originalName && prefixedName === originalName)) || ![`移除 ${name}`, `Remove ${name}`].includes(removers[0].getAttribute('aria-label'))) return null;
  return { name, image: images[0], src: images[0].currentSrc || images[0].src };
}
function assertClipboardIdentity(record, scope) {
  if (record.error) throw record.error;
  if (!record.card) return;
  const current = clipboardCard(record.card, record.originalName);
  if (!scope.contains(record.card) || !current || current.src !== record.src || current.name !== record.actualName) throw new PageSafetyError('本次 Claude 图片附件被替换或移除，已停止发送');
}
async function verifyClipboardBytes(input, record) {
  let reader; let timer;
  const expected = record.bytes;
  const deadline = Date.now() + 15000;
  const checkActive = () => {
    // Suspended/background tabs may resume the stream before the timer fires.
    if (Date.now() >= deadline) throw new PageSafetyError('核对 Claude 粘贴图片内容超时，已停止发送');
    if (record.controller.signal.aborted) throw new PageSafetyError('已停止核对 Claude 粘贴图片内容');
  };
  let onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(new PageSafetyError('已停止核对 Claude 粘贴图片内容'));
    record.controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
    reject(new PageSafetyError('核对 Claude 粘贴图片内容超时，已停止发送'));
    record.controller.abort(); reader?.cancel().catch(() => {});
  }, 15000); });
  try {
    await Promise.race([timeout, cancelled, (async () => {
      const fetchImpl = input.ownerDocument.defaultView.fetch;
      if (typeof fetchImpl !== 'function') throw new PageSafetyError('当前浏览器无法核对 Claude 粘贴图片内容，已停止发送');
      const response = await fetchImpl.call(input.ownerDocument.defaultView, record.src, { signal: record.controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' });
      checkActive();
      if (!response.ok || !response.body?.getReader) throw new PageSafetyError('无法读取本次 Claude 粘贴图片内容，已停止发送');
      if (Number(response.headers.get('content-length')) > expected.length) throw new PageSafetyError('Claude 粘贴图片内容与原图不同，网页可能转换了图片；已停止发送');
      reader = response.body.getReader(); let offset = 0;
      while (true) {
        checkActive();
        const { done, value } = await reader.read(); checkActive(); if (done) break;
        if (offset + value.byteLength > expected.length || value.some((byte, index) => byte !== expected[offset + index])) throw new PageSafetyError('Claude 粘贴图片内容与原图不同，网页可能转换了图片；已停止发送');
        offset += value.byteLength;
      }
      if (offset !== expected.length) throw new PageSafetyError('Claude 粘贴图片内容与原图不同，网页可能转换了图片；已停止发送');
      checkActive();
      assertClipboardIdentity(record, attachmentScope(input));
    })()]);
  } finally {
    clearTimeout(timer); record.controller.signal.removeEventListener('abort', onAbort);
    record.controller.abort(); reader?.cancel().catch(() => {});
  }
}
export function inputAttachmentState(input, names) {
  const scope = attachmentScope(input);
  if (!scope || new Set(names).size !== names.length) throw new PageSafetyError('无法确认本次 Claude 图片附件');
  const records = pastedImages.get(input);
  if (records && [...records.keys()].some(name => !names.includes(name))) throw new PageSafetyError('本次 Claude 图片附件列表发生变化，已停止发送');
  assertNativeSelection(input, records);
  for (const record of records?.values() || []) assertClipboardIdentity(record, scope);
  if (!names.length) return { ready: !hasAttachments(input) };
  if ([...scope.querySelectorAll('[role="alert"]')].some(visible)) throw new PageSafetyError('Claude 报告图片上传失败，已停止发送');
  if ([...scope.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].some(visible)) return { ready: false, reason: 'uploading' };
  const aliases = names.map(name => records?.get(name)?.state === 'verified' ? records.get(name).actualName : name);
  const state = namedAttachmentState(input, scope, aliases, names);
  if (state.ready) {
    for (const record of records?.values() || []) if (record.state === 'pending') { record.state = 'exact'; record.bytes = null; }
    return state;
  }
  for (const name of names) {
    const record = records?.get(name);
    if (!record || record.state === 'exact' || record.state === 'verified') continue;
    if (record.state === 'verifying') return { ready: false, reason: 'verifying' };
    const cards = [...scope.querySelectorAll(CLIPBOARD_CARD)].filter(card => visible(card) && !record.beforeCards.has(card));
    if (cards.length > 1) throw new PageSafetyError('粘贴期间出现多余的 Claude 图片附件，已停止发送');
    if (!cards.length) continue;
    const current = clipboardCard(cards[0], record.originalName); if (!current) continue;
    let source;
    try { source = new URL(current.src); } catch {}
    if (source?.protocol !== 'blob:' || source.origin !== 'https://claude.ai' || record.beforeSources.has(current.src)) throw new PageSafetyError('无法确认本次 Claude 粘贴图片的本地来源，已停止发送');
    if (!current.image.complete || !current.image.naturalWidth || !current.image.naturalHeight) return { ready: false, reason: 'uploading' };
    record.card = cards[0]; record.src = current.src; record.actualName = current.name; record.state = 'verifying';
    record.controller = new AbortController();
    void verifyClipboardBytes(input, record).then(() => {
      if (record.active) { record.state = 'verified'; record.bytes = null; }
    }, error => {
      if (record.active) record.error = error instanceof PageSafetyError ? error : new PageSafetyError('无法核对本次 Claude 粘贴图片内容，已停止发送');
    });
    return { ready: false, reason: 'verifying' };
  }
  return { ...state, reason: state.reason || 'name-mismatch' };
}
export function releaseInputImages(input) {
  const records = pastedImages.get(input); if (!records) return;
  for (const record of records.values()) { record.active = false; record.controller?.abort(); record.bytes = null; }
  pastedImages.delete(input);
}
function prepareInputImage(doc, input, { mimeType, base64 }, name) {
  if (composer(doc) !== input || typeof name !== 'string' || !/^[A-Za-z0-9._-]{1,150}$/.test(name)) throw new PageSafetyError('无法确认 Claude 图片输入目标');
  const bytes = decodeImagePayload(mimeType, base64); const win = doc.defaultView;
  if (typeof win.DataTransfer !== 'function') throw new PageSafetyError('当前浏览器不支持图片文件输入，已停止发送');
  const file = new win.File([bytes], name, { type: mimeType });
  const transfer = new win.DataTransfer(); transfer.items.add(file);
  if (pastedImages.get(input)?.has(name)) throw new PageSafetyError('本次 Claude 图片附件名称重复，已停止发送');
  return { bytes, file, transfer, scope: attachmentScope(input), win };
}
function registerInputImage(input, scope, name, bytes, selection = {}) {
  let records = pastedImages.get(input);
  if (!records) { records = new Map(); pastedImages.set(input, records); }
  records.set(name, { originalName: name, bytes, active: true, state: 'pending', beforeCards: new Set(scope.querySelectorAll(CLIPBOARD_CARD)), beforeSources: new Set([...scope.querySelectorAll('img')].map(image => image.currentSrc || image.src)), ...selection });
}
export function attachInputImage(doc, input, payload, name) {
  const { bytes, file, transfer, scope, win } = prepareInputImage(doc, input, payload, name);
  if (normalizeText(composerText(input))) throw new PageSafetyError('Claude 输入框有草稿，已停止上传图片');
  const field = nativeFileInput(input); const records = pastedImages.get(input);
  const previousNames = [...(records?.keys() || [])];
  if (!inputAttachmentState(input, previousNames).ready) throw new PageSafetyError('上传前发现未确认或不属于本次任务的 Claude 附件，已停止上传');
  if ([...(field.files || [])].some(selected => ![...(records?.values() || [])].some(record => record.fileInput === field && record.file === selected))) throw new PageSafetyError('Claude 文件选择包含不属于本次任务的文件，已停止上传');
  registerInputImage(input, scope, name, bytes, { fileInput: field, file });
  // Select only the next image: replaying already accepted files would append
  // duplicate attachments in the page's change handler. Never retry with paste.
  try { field.files = transfer.files; } catch { throw new PageSafetyError('无法设置 Claude 图片文件，已停止上传'); }
  if (composer(doc) !== input || nativeFileInput(input) !== field || field.files?.length !== 1 || field.files[0] !== file) throw new PageSafetyError('Claude 文件上传入口或文件选择已变化，已停止上传');
  field.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }));
  if (composer(doc) !== input || nativeFileInput(input) !== field) throw new PageSafetyError('Claude 文件上传入口已被替换，已停止上传');
  // An input handler may consume and clear this selection. Never restore it,
  // or forward a substituted/previous file to the subsequent change handler.
  if (field.files?.length && (field.files.length !== 1 || field.files[0] !== file)) throw new PageSafetyError('Claude 文件选择在上传期间发生变化，已停止上传');
  field.dispatchEvent(new win.Event('change', { bubbles: true }));
}
export function pasteInputImage(doc, input, payload, name) {
  const { bytes, transfer, scope, win } = prepareInputImage(doc, input, payload, name);
  if (typeof win.ClipboardEvent !== 'function') throw new PageSafetyError('当前浏览器不支持正常图片粘贴，已停止发送');
  registerInputImage(input, scope, name, bytes);
  input.focus(); input.dispatchEvent(new win.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
}

export function answerImageSource(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'blob:' && url.origin === 'https://claude.ai') return url.href;
    if (url.protocol === 'https:' && url.hostname === 'claude.ai' && !url.port && !url.username && !url.password) return url.href;
  } catch {}
  throw new PageSafetyError('本次 Claude 回复图片的来源不受支持，未读取或转发图片');
}
export async function readAnswerImage(image, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const source = answerImageSource(image.src); const controller = new AbortController();
  let reader; let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
    controller.abort(); reader?.cancel().catch(() => {});
    reject(new PageSafetyError('读取本次 Claude 回复图片超时，请在网页查看'));
  }, timeoutMs); });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await fetchImpl(source, { signal: controller.signal, credentials: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' });
      if (!response.ok || !response.body?.getReader) throw new PageSafetyError('无法读取本次 Claude 回复图片，请在网页确认图片可以打开');
      const mimeType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) throw new PageSafetyError('图片格式不支持，仅支持 PNG、JPEG 和 WebP');
      if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) throw new PageSafetyError('单张图片超过 10 MB，请在网页查看原图');
      reader = response.body.getReader(); const chunks = []; let size = 0;
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > MAX_IMAGE_BYTES) throw new PageSafetyError('单张图片超过 10 MB，请在网页查看原图');
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      let binary = '';
      for (let start = 0; start < bytes.length; start += 32768) binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
      const base64 = btoa(binary); decodeImagePayload(mimeType, base64);
      return { mimeType, base64, byteLength: bytes.length };
    })()]);
  } catch (error) {
    if (error instanceof PageSafetyError) throw error;
    throw new PageSafetyError('无法读取本次 Claude 回复图片，可能是图片访问受限或连接中断；未转发空图片');
  } finally { clearTimeout(timer); controller.abort(); reader?.cancel().catch(() => {}); }
}
function answerImages(message, baseline) {
  if ([...message.querySelectorAll('canvas')].some(node => visible(node) && !isReasoning(node))) throw new PageSafetyError('本次 Claude 回复包含无法直接读取的画布，请在网页查看');
  const images = []; const seen = new Set();
  for (const image of message.querySelectorAll('img')) {
    if (!visible(image) || isReasoning(image) || image.closest('[data-testid="avatar"], [data-testid="icon"], [data-testid="citation"], [data-testid="message-actions"], .avatar')) continue;
    if (!image.complete) return null;
    if (!image.naturalWidth || !image.naturalHeight) throw new PageSafetyError('本次 Claude 回复图片尚未正常加载，未转发空图片');
    const source = image.currentSrc || image.src;
    if (seen.has(source) || baseline.imageSources?.has(source)) continue;
    const src = answerImageSource(source); seen.add(source);
    images.push({ src, width: image.naturalWidth, height: image.naturalHeight });
    if (images.length > MAX_IMAGES) throw new PageSafetyError('本次回复超过 4 张图片，请在网页查看完整结果');
  }
  return images;
}
export function finalCandidate(doc, baseline, user) {
  const users = newUsers(doc, baseline);
  if (users.length !== 1 || turnKey(users[0]) !== turnKey(user) || userText(users[0]) !== baseline.submittedText) throw new PageSafetyError('对话出现其他消息或内容被替换，停止转发');
  user = users[0];
  const following = turns(doc, 'assistant').filter(message => !baseline.assistants.has(turnKey(message)) && Boolean(user.compareDocumentPosition(message) & 4) && !isReasoning(message));
  if (following.some(message => [...message.querySelectorAll('[role="alert"], [data-testid="error-message"]')].some(visible))) throw new PageSafetyError('Claude 网页回复失败，请在网页处理；本次不会重新提问');
  if (generating(doc) || following.length !== 1 || !completedMessage(following[0])) return null;
  const message = following[0];
  const blocks = publicBodies(message);
  if (blocks.length > 1) return null;
  const images = answerImages(message, baseline); if (images === null) return null;
  const clone = blocks[0]?.cloneNode(true);
  if (clone) {
    // Preserve the live tree's visibility before detaching. CSS selectors can
    // depend on ancestors outside the prose block and stop matching a clone.
    const originals = [...blocks[0].querySelectorAll('*')];
    const copies = [...clone.querySelectorAll('*')];
    originals.forEach((node, index) => { if (!visible(node) || isReasoning(node)) copies[index].remove(); });
  }
  const text = clone ? markdownText(clone) : '';
  return text || images.length ? { message, text, images } : null;
}

// Claude owns its editor event policy; changing another provider must not alter it.
export function insertPrompt(doc, input, prompt) {
  if (!input.isConnected || Boolean(input.disabled || input.matches(':disabled') || input.closest('[inert], [aria-disabled="true"]')) || input.readOnly) throw new PageSafetyError('网页输入框当前不可用，已停止写入');
  if (normalizeText(composerText(input))) throw new PageSafetyError('检测到新草稿，已停止写入');
  input.focus();
  if (input.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(doc.defaultView.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, prompt);
    input.dispatchEvent(new doc.defaultView.InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
  } else {
    const range = doc.createRange(); range.selectNodeContents(input);
    const selection = doc.defaultView.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    // Chromium emits native input events while executing insertText (several
    // for multiline text). Do not append another full-prompt event afterward.
    let emittedInput = false;
    const observeInput = () => { emittedInput = true; };
    input.addEventListener('input', observeInput, true);
    try {
      if (typeof doc.execCommand !== 'function' || !doc.execCommand('insertText', false, prompt)) throw new PageSafetyError('浏览器未接受正常文本输入，已停止发送');
    } finally { input.removeEventListener('input', observeInput, true); }
    if (!emittedInput) input.dispatchEvent(new doc.defaultView.InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
  }
  if (normalizeText(composerText(input)) !== normalizeText(prompt)) throw new PageSafetyError('网页输入内容与任务不同，已停止发送');
}
