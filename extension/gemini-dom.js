import { normalizeText } from './shared.js';
import { imagesVisuallyMatch } from './image-equivalence.js';
// Text reading, byte validation and native draft deletion are shared. Gemini
// owns its input events, selectors, turn ownership and completion signals.
import {
  PageSafetyError, visible, composerText, markdownText, clearComposerDraft,
  validateInputImages, decodeImagePayload, MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES,
} from './dom.js';
export { PageSafetyError, visible, composerText, markdownText, validateInputImages, MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES };

const COMPOSER = 'input-area-v2 rich-textarea .ql-editor[contenteditable="true"][role="textbox"]';
const SEND = '[data-test-id="send-button-container"] gem-icon-button.send-button.submit > button';
const STOP = '[data-test-id="send-button-container"] gem-icon-button.send-button.stop > button';
const ROW = 'div.conversation-container.message-actions-hover-boundary';
const PENDING = 'pending-request.conversation-container[scrollanchor]';
const HISTORY = 'infinite-scroller[data-test-id="chat-history-container"]';
const USER = 'user-query';
const ASSISTANT = 'model-response';
const BODY = 'message-content > .markdown.markdown-main-panel';
const GENERATED = '.attachment-container.generated-images response-element > generated-image';
const REASONING = 'thinking-overlay, model-thoughts, thoughts-container, details, [data-channel="analysis"], [aria-hidden="true"]';
const ATTACHMENT = '.file-preview-container > gem-media-attachment.gem-attachment.gem-attachment-tile';
const ATTACHMENT_REMOVE = 'gem-icon-button.gem-attachment-close-button > button';
const isReasoning = node => Boolean(node.closest(REASONING));
const pastedImages = new WeakMap();
function assertNoDialog(doc) {
  if ([...doc.querySelectorAll('mat-dialog-container, [role="dialog"], [aria-modal="true"]')].some(visible)) throw new PageSafetyError('Gemini 有待处理的对话框，请先在网页处理图片条款、登录或其他提示');
}

export function composerScope(input) { return input?.closest('input-area-v2') || null; }
export function composer(doc) {
  const inputs = [...doc.querySelectorAll(COMPOSER)].filter(visible);
  if (!inputs.length) throw new PageSafetyError('暂未找到 Gemini 输入框，等待网页加载');
  if (inputs.length > 1) throw new PageSafetyError('检测到多个可见的 Gemini 输入框，暂不自动操作');
  const input = inputs[0]; const scope = composerScope(input);
  if (!scope || scope.querySelectorAll(COMPOSER).length !== 1 || scope.querySelector(`${ROW}, ${USER}, ${ASSISTANT}`) || !input.closest('fieldset.input-area-fieldset')) throw new PageSafetyError('Gemini 输入区结构已变化，已停止自动操作');
  if (input.getAttribute('aria-disabled') === 'true' || input.closest('[inert]')) throw new PageSafetyError('Gemini 输入框当前不可用');
  return input;
}
export function composerInteraction(target, input) {
  return Boolean(target?.closest && (target.closest(COMPOSER) || (input && composerScope(input)?.contains(target)) || target.closest(SEND)));
}
export function generating(doc) {
  return [...doc.querySelectorAll(`${STOP}, ${BODY}[aria-busy="true"]`)].some(visible);
}
export function turns(doc, role) {
  const selector = role === 'user' ? USER : ASSISTANT;
  return [...doc.querySelectorAll(selector)].filter(node => (role === 'user' || visible(node)) && !node.parentElement?.closest(selector));
}
function messageRow(message) {
  const row = message?.closest(ROW);
  if (!row || row.querySelectorAll(USER).length !== 1 || row.querySelectorAll(ASSISTANT).length > 1) return null;
  if (row.id && [...row.ownerDocument.querySelectorAll(ROW)].filter(candidate => candidate.id === row.id).length !== 1) return null;
  return row;
}
function turnKey(message) {
  const row = messageRow(message);
  return row?.id ? `${message.matches(USER) ? 'user' : 'assistant'}:${row.id}` : message;
}
function publicBodies(message) {
  return [...message.querySelectorAll(BODY)].filter(node => visible(node) && !isReasoning(node) && node.closest(ASSISTANT) === message);
}
function enabled(button) {
  return visible(button) && !button.disabled && !button.matches(':disabled') && !button.closest('[inert], [aria-disabled="true"]');
}
function completionControlPresent(node, scope) {
  if (!node || !scope?.contains(node) || !visible(scope) || isReasoning(node)) return false;
  // Native response/download actions can use visibility:hidden while their
  // message is not hovered. We only read these controls as completion markers;
  // they are never clicked. Keep the message/body visible, and still reject
  // explicitly concealed templates, detached actions and disabled controls.
  for (let current = node; current && current !== scope; current = current.parentElement) {
    if (current.hidden || current.getAttribute('aria-hidden') === 'true' || current.hasAttribute('inert') ||
        current.ownerDocument.defaultView.getComputedStyle(current).display === 'none') return false;
  }
  return true;
}
function completionControlEnabled(button, scope) {
  return completionControlPresent(button, scope) && !button.disabled && !button.matches(':disabled') && !button.closest('[inert], [aria-disabled="true"]');
}
function generatedImages(body) {
  const all = [...body.querySelectorAll('generated-image')].filter(node => visible(node) && !isReasoning(node));
  const wrappers = [...body.querySelectorAll(GENERATED)].filter(node => visible(node) && !isReasoning(node));
  if (all.length !== wrappers.length) return null;
  const result = [];
  for (const wrapper of wrappers) {
    const singles = wrapper.querySelectorAll('single-image.generated-image');
    if (singles.length !== 1) return null;
    const images = singles[0].querySelectorAll(':scope > .image-container > .overlay-container > button.image-button > img.image.loaded');
    const downloads = singles[0].querySelectorAll(':scope > .image-container > .overlay-container > .generated-image-controls > download-generated-image-button > [data-test-id="download-generated-image-button"] > button');
    if (images.length !== 1 || !visible(images[0]) || downloads.length !== 1 || !completionControlEnabled(downloads[0], wrapper) || wrapper.querySelectorAll('img').length !== 1) return null;
    result.push(images[0]);
  }
  return result;
}
function completedMessage(message) {
  const row = messageRow(message); const bodies = publicBodies(message);
  if (!row?.id || bodies.length !== 1 || bodies[0].getAttribute('aria-busy') !== 'false') return false;
  if ([...message.querySelectorAll('[role="alert"]')].some(visible)) return false;
  // The complete footer is also a read-only marker, not a control to click.
  // Apply the same hover-visibility rule as the response actions below.
  const footers = [...message.querySelectorAll('.response-footer.complete')].filter(node => completionControlPresent(node, message) && node.closest(ASSISTANT) === message && !bodies[0].contains(node));
  const actions = [...message.querySelectorAll('message-actions')].filter(node => completionControlPresent(node, message) && node.closest(ASSISTANT) === message && !bodies[0].contains(node));
  if (footers.length !== 1 || actions.length !== 1 || !(bodies[0].compareDocumentPosition(actions[0]) & 4)) return false;
  const retries = [...actions[0].querySelectorAll('regenerate-button [data-test-id="regenerate-button"] button')].filter(button => completionControlEnabled(button, message));
  if (retries.length !== 1) return false;
  // Text responses have a response copy action. Image-only Gemini responses
  // omit it; their complete footer + retry action + loaded image/download
  // structure is a separate observed completion path. Overlay/code copy alone
  // is never a completion signal.
  const copies = [...actions[0].querySelectorAll('copy-button button')].filter(button => completionControlEnabled(button, message));
  if (copies.length === 1) return true;
  if (copies.length) return false;
  const images = generatedImages(bodies[0]);
  return Boolean(images?.length && images.every(image => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0));
}
function userText(message) {
  const bodies = [...message.querySelectorAll('user-query-content .query-text')].filter(node => !node.parentElement?.closest('.query-text'));
  if (bodies.length !== 1) throw new PageSafetyError('Gemini 用户消息结构已变化，已停止转发');
  const copy = bodies[0].cloneNode(true);
  for (const node of copy.querySelectorAll('.cdk-visually-hidden, .screen-reader-user-query-label, [aria-hidden="true"]')) node.remove();
  return normalizeText(composerText(copy));
}
export function hasAttachments(input) {
  const scope = composerScope(input); if (!scope) return true;
  if ([...scope.querySelectorAll('input[type="file"]')].some(field => field.files?.length)) return true;
  return [...scope.querySelectorAll(`img, gem-media-attachment, ${ATTACHMENT_REMOVE}, [role="progressbar"], [aria-busy="true"], button[aria-label*="Remove"], button[aria-label*="移除"], button[aria-label*="删除"], button[aria-label*="刪除"]`)].some(visible);
}
function clipboardCard(card) {
  if (!card?.matches(ATTACHMENT) || !visible(card)) return null;
  const chips = card.querySelectorAll('mat-basic-chip'); const images = card.querySelectorAll('img');
  // The close control is hover-only presentation and may be unmounted. It is
  // never clicked or used as attachment identity; the card, image and verified
  // source establish ownership independently of that control's visibility.
  // Gemini now renders alt="" (previously "attachment"). Accessibility text
  // does not identify an upload; the native structure and registered image
  // bytes below do, including after a preview has been re-encoded.
  if (chips.length !== 1 || images.length !== 1 || !visible(images[0]) || !chips[0].contains(images[0]) || !images[0].matches('img.gem-attachment-style-img')) return null;
  return { image: images[0], src: images[0].currentSrc || images[0].src };
}
function assertClipboardIdentity(record, scope) {
  if (record.error) throw record.error;
  if (!record.card) return;
  const current = clipboardCard(record.card);
  if (!scope.contains(record.card) || !current || current.src !== record.src) throw new PageSafetyError('本次 Gemini 图片附件被替换或移除，已停止发送');
}
async function verifyClipboardBytes(input, record) {
  let reader; let timer; const expected = record.bytes;
  const deadline = Date.now() + 15000;
  const checkActive = () => {
    // A background tab can delay timeout callbacks. A late decoder/read must
    // still fail even when it wins the event-loop race against that callback.
    if (Date.now() >= deadline) throw new PageSafetyError('核对 Gemini 粘贴图片内容超时，已停止发送');
    if (record.controller.signal.aborted) throw new PageSafetyError('已停止核对 Gemini 粘贴图片内容');
  };
  let onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(new PageSafetyError('已停止核对 Gemini 粘贴图片内容'));
    record.controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
    reject(new PageSafetyError('核对 Gemini 粘贴图片内容超时，已停止发送'));
    record.controller.abort(); reader?.cancel().catch(() => {});
  }, 15000); });
  try {
    await Promise.race([timeout, cancelled, (async () => {
      const win = input.ownerDocument.defaultView;
      if (typeof win.fetch !== 'function') throw new PageSafetyError('当前浏览器无法核对 Gemini 粘贴图片内容，已停止发送');
      const response = await win.fetch(record.src, { signal: record.controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' });
      checkActive();
      if (!response.ok || !response.body?.getReader) throw new PageSafetyError('无法读取本次 Gemini 粘贴图片内容，已停止发送');
      // Re-encoding can change both the format and byte length of the local
      // preview. Bound the read by our image limit, not the original file size.
      if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) throw new PageSafetyError('Gemini 图片预览超过 10 MB，已停止发送');
      reader = response.body.getReader(); let size = 0; const chunks = [];
      while (true) {
        checkActive();
        const { done, value } = await reader.read(); checkActive(); if (done) break;
        size += value.byteLength;
        if (size > MAX_IMAGE_BYTES) throw new PageSafetyError('Gemini 图片预览超过 10 MB，已停止发送');
        chunks.push(value);
      }
      checkActive();
      const actual = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { actual.set(chunk, offset); offset += chunk.byteLength; }
      const byteIdentical = actual.length === expected.length && actual.every((byte, index) => byte === expected[index]);
      if (!byteIdentical) {
        let sameImage;
        try { sameImage = await imagesVisuallyMatch(win, expected, actual, record.controller.signal); }
        catch { checkActive(); throw new PageSafetyError('无法核对 Gemini 转码后的图片预览，已停止发送；请检查网页附件是否正常'); }
        checkActive();
        if (!sameImage) throw new PageSafetyError('Gemini 图片预览内容与原图不同，已停止发送；请检查是否出现了其他图片');
      }
      checkActive();
      assertClipboardIdentity(record, composerScope(input));
    })()]);
  } finally {
    clearTimeout(timer); record.controller.signal.removeEventListener('abort', onAbort);
    record.controller.abort(); reader?.cancel().catch(() => {});
  }
}
export function inputAttachmentState(input, names) {
  assertNoDialog(input.ownerDocument);
  const scope = composerScope(input);
  if (!scope || new Set(names).size !== names.length) throw new PageSafetyError('无法确认本次 Gemini 图片附件');
  const records = pastedImages.get(input);
  if (records && [...records.keys()].some(name => !names.includes(name))) throw new PageSafetyError('本次 Gemini 图片附件列表发生变化，已停止发送');
  for (const record of records?.values() || []) assertClipboardIdentity(record, scope);
  if (!names.length) return { ready: !hasAttachments(input) };
  if ([...scope.querySelectorAll('[role="alert"]')].some(visible)) throw new PageSafetyError('Gemini 报告图片上传失败，已停止发送');
  if ([...scope.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].some(visible)) return { ready: false, reason: 'uploading' };
  const cards = [...scope.querySelectorAll(ATTACHMENT)].filter(visible);
  if (!cards.length) return { ready: false, reason: 'no-attachment' };
  if (cards.length !== names.length || names.some(name => !records?.has(name))) return { ready: false, reason: 'name-mismatch' };
  // No native selection or extra image outside the individually verified cards
  // may hitchhike on this submission, including an unknown attachment layout.
  if ([...scope.querySelectorAll('img, gem-media-attachment')].filter(visible).some(node => !cards.some(card => card === node || card.contains(node)))) return { ready: false, reason: 'name-mismatch' };
  if ([...scope.querySelectorAll('input[type="file"]')].some(field => [...(field.files || [])].some(file => !names.includes(file.name)))) return { ready: false, reason: 'name-mismatch' };
  for (const name of names) {
    const record = records.get(name);
    if (record.state === 'verifying') return { ready: false, reason: 'verifying' };
    if (record.state === 'verified') {
      const current = clipboardCard(record.card);
      if (!current.image.complete || !current.image.naturalWidth || !current.image.naturalHeight) return { ready: false, reason: 'uploading' };
      continue;
    }
    const candidates = cards.filter(card => !record.beforeCards.has(card) && ![...records.values()].some(other => other !== record && other.card === card));
    if (candidates.length !== 1) return { ready: false, reason: 'name-mismatch' };
    const current = clipboardCard(candidates[0]); if (!current) return { ready: false, reason: 'name-mismatch' };
    let source; try { source = new URL(current.src); } catch {}
    if (source?.protocol !== 'blob:' || source.origin !== 'https://gemini.google.com' || record.beforeSources.has(current.src)) throw new PageSafetyError('无法确认本次 Gemini 粘贴图片的本地来源，已停止发送');
    if (!current.image.complete || !current.image.naturalWidth || !current.image.naturalHeight) return { ready: false, reason: 'uploading' };
    record.card = candidates[0]; record.src = current.src; record.state = 'verifying'; record.controller = new AbortController();
    void verifyClipboardBytes(input, record).then(() => {
      if (record.active) { record.state = 'verified'; record.bytes = null; }
    }, error => {
      if (record.active) record.error = error instanceof PageSafetyError ? error : new PageSafetyError('无法核对本次 Gemini 粘贴图片内容，已停止发送');
    });
    return { ready: false, reason: 'verifying' };
  }
  return { ready: true };
}
export function pasteInputImage(doc, input, { mimeType, base64 }, name) {
  if (composer(doc) !== input || typeof name !== 'string' || !/^[A-Za-z0-9._-]{1,150}$/.test(name)) throw new PageSafetyError('无法确认 Gemini 图片输入目标');
  const bytes = decodeImagePayload(mimeType, base64); const win = doc.defaultView;
  if (typeof win.DataTransfer !== 'function' || typeof win.ClipboardEvent !== 'function') throw new PageSafetyError('当前浏览器不支持正常图片粘贴，已停止发送');
  const transfer = new win.DataTransfer(); transfer.items.add(new win.File([bytes], name, { type: mimeType }));
  let records = pastedImages.get(input);
  if (!records) { records = new Map(); pastedImages.set(input, records); }
  if (records.has(name)) throw new PageSafetyError('本次 Gemini 图片附件名称重复，已停止发送');
  const scope = composerScope(input);
  records.set(name, { bytes, active: true, state: 'pending', beforeCards: new Set(scope.querySelectorAll(ATTACHMENT)), beforeSources: new Set([...scope.querySelectorAll('img')].map(image => image.currentSrc || image.src)) });
  input.focus(); input.dispatchEvent(new win.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
}
export function releaseInputImages(input) {
  const records = pastedImages.get(input); if (!records) return;
  for (const record of records.values()) { record.active = false; record.controller?.abort(); record.bytes = null; }
  pastedImages.delete(input);
}
export function assertReady(doc, { allowDraft = false } = {}) {
  assertNoDialog(doc);
  if ([...doc.querySelectorAll('#challenge-running, #challenge-stage, iframe[src*="challenges.cloudflare.com"], iframe[src*="recaptcha"]')].some(visible)) throw new PageSafetyError('网页正在验证，请先手动完成验证');
  if (generating(doc)) throw new PageSafetyError('该对话正在生成回复，请等待完成');
  const lastUser = turns(doc, 'user').at(-1); const lastAssistant = turns(doc, 'assistant').at(-1);
  if (lastUser && (!lastAssistant || messageRow(lastUser) !== messageRow(lastAssistant) || !(lastUser.compareDocumentPosition(lastAssistant) & 4) || !completedMessage(lastAssistant))) throw new PageSafetyError('上一条 Gemini 网页提问尚未明确完成，请先在网页处理');
  const input = composer(doc);
  if (!allowDraft && hasAttachments(input)) throw new PageSafetyError('输入区存在附件或正在上传，本次不会发送');
  if (!allowDraft && normalizeText(composerText(input))) throw new PageSafetyError('输入框有草稿，本次不会覆盖草稿');
  return input;
}
export function clearDraft(doc, input, clicked = new WeakSet()) {
  if (composer(doc) !== input) throw new PageSafetyError('清理前 Gemini 输入框已变化');
  const scope = composerScope(input);
  clearComposerDraft(doc, input, scope, [...scope.querySelectorAll(ATTACHMENT_REMOVE)], clicked);
  releaseInputImages(input);
}
export function sendButton(doc, input) {
  if (composer(doc) !== input) throw new PageSafetyError('Gemini 输入框已被替换，已停止发送');
  const buttons = [...composerScope(input).querySelectorAll(SEND)].filter(enabled);
  return buttons.length === 1 ? buttons[0] : null;
}
export function snapshot(doc) {
  const users = turns(doc, 'user');
  return { users: new Set(users.map(turnKey)), lastUserKey: users.length ? turnKey(users.at(-1)) : null, assistants: new Set(turns(doc, 'assistant').map(turnKey)), imageSources: new Set([...doc.querySelectorAll('img')].map(image => image.currentSrc || image.src).filter(Boolean)) };
}
export function newUsers(doc, baseline) {
  let users = turns(doc, 'user');
  if (baseline.users.size) {
    const anchor = users.findIndex(node => turnKey(node) === baseline.lastUserKey);
    if (anchor < 0) throw new PageSafetyError('原有 Gemini 用户消息基准已消失，无法确认新消息范围，已停止转发');
    users = users.slice(anchor + 1);
  }
  return users.filter(node => !baseline.users.has(turnKey(node)));
}
function newSubmittedUser(doc, baseline) {
  const users = newUsers(doc, baseline);
  if (users.length > 1) throw new PageSafetyError('检测到其他新消息，已停止转发，避免混淆回复');
  return users[0] || null;
}
function pendingUserShell(user, baseline, prompt) {
  const pending = user.parentElement;
  // Gemini first renders this separate, id-less component, then replaces it
  // with a durable DIV turn. Recognizing the shell only permits the ordinary
  // confirmation window; its loading animations do not establish ownership.
  if (!pending?.matches(PENDING) || pending.hasAttribute('id')) return null;
  const history = pending.closest(HISTORY);
  if (!history || pending.parentElement?.closest(`${ROW}, pending-request`) ||
      history.querySelectorAll(PENDING).length !== 1 || pending.querySelectorAll(USER).length !== 1 ||
      pending.querySelectorAll(':scope > user-query').length !== 1 ||
      pending.querySelector(`${ROW}, ${ASSISTANT}, pending-request, message-actions, ${BODY}`)) return null;
  if ([...pending.querySelectorAll('[role="alert"]')].some(visible)) throw new PageSafetyError('Gemini 网页回复失败，请在网页处理；本次不会重新提问');
  if (baseline.users.size) {
    const anchor = turns(user.ownerDocument, 'user').find(message => turnKey(message) === baseline.lastUserKey);
    if (!anchor || anchor.closest(HISTORY) !== history) return null;
  }
  const text = normalizeText(prompt);
  const previous = baseline.pendingSubmission;
  if (previous && (previous.pending !== pending || previous.user !== user || previous.history !== history || previous.text !== text)) throw new PageSafetyError('Gemini 待处理消息被替换，无法确认仍属于本次提问，已停止转发');
  // Remember even an incomplete shell so replacing it cannot silently turn
  // an unverified placeholder into a different submission.
  baseline.pendingSubmission ||= { pending, user, history, text };
  return baseline.pendingSubmission;
}
function matchingPendingUser(user, baseline, prompt, shell = pendingUserShell(user, baseline, prompt)) {
  if (!shell) return false;
  const bodies = [...user.querySelectorAll('user-query-content .query-text')];
  if (bodies.length > 1) throw new PageSafetyError('Gemini 用户消息结构已变化，已停止转发');
  if (!bodies.length) return false;
  const text = userText(user);
  if (!text) return false;
  if (text !== shell.text) throw new PageSafetyError('新增网页消息与本次群消息不同，已停止转发');
  // Only an exact visible prompt in the same known shell may extend the wait
  // to the task deadline. Missing/empty/hidden text keeps the original limit.
  return visible(shell.pending) && visible(user) && visible(bodies[0]);
}
export function submittedUserPending(doc, baseline, prompt) {
  const user = newSubmittedUser(doc, baseline);
  return Boolean(user && matchingPendingUser(user, baseline, prompt));
}
export function findSubmittedUser(doc, baseline, prompt) {
  const user = newSubmittedUser(doc, baseline);
  if (!user) return null;
  const row = messageRow(user);
  if (!row) {
    const shell = pendingUserShell(user, baseline, prompt);
    if (shell) { matchingPendingUser(user, baseline, prompt, shell); return null; }
    throw new PageSafetyError('Gemini 新消息结构已变化，已停止转发');
  }
  const text = userText(user);
  // A durable turn can receive its text after mounting. Keep waiting within
  // the existing confirmation deadline, without treating this shell as ours.
  if (!text) return null;
  if (text !== normalizeText(prompt)) throw new PageSafetyError('新增网页消息与本次群消息不同，已停止转发');
  if (baseline.pendingSubmission && row.closest(HISTORY) !== baseline.pendingSubmission.history) throw new PageSafetyError('Gemini 待处理消息所属对话区域已变化，已停止转发');
  // Gemini creates a pending user container before assigning its durable turn
  // id. Wait for that identity instead of attributing a later response by index.
  if (!row.id) return null;
  baseline.submittedText = normalizeText(prompt);
  baseline.submittedKey = turnKey(user);
  return user;
}
export function answerImageSource(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'blob:' && url.origin === 'https://gemini.google.com') return url.href;
    if (url.protocol === 'https:' && url.hostname === 'gemini.google.com' && !url.port && !url.username && !url.password) return url.href;
  } catch {}
  throw new PageSafetyError('本次 Gemini 回复图片的来源不受支持，未读取或转发图片');
}
export async function readAnswerImage(image, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const source = answerImageSource(image.src); const controller = new AbortController();
  let reader; let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
    controller.abort(); reader?.cancel().catch(() => {});
    reject(new PageSafetyError('读取本次 Gemini 回复图片超时，请在网页查看'));
  }, timeoutMs); });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await fetchImpl(source, { signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' });
      if (!response.ok || !response.body?.getReader) throw new PageSafetyError('无法读取本次 Gemini 回复图片，请在网页确认图片可以打开');
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
    throw new PageSafetyError('无法读取本次 Gemini 回复图片，可能是图片访问受限或连接中断；未转发空图片');
  } finally { clearTimeout(timer); controller.abort(); reader?.cancel().catch(() => {}); }
}
function answerImages(body, baseline) {
  if ([...body.querySelectorAll('canvas')].some(node => visible(node) && !isReasoning(node))) throw new PageSafetyError('本次 Gemini 回复包含无法直接读取的画布，请在网页查看');
  const generated = generatedImages(body);
  if (generated === null) throw new PageSafetyError('Gemini 生成图片结构已变化，已停止转发不完整图片');
  const images = []; const seen = new Set(); const externalSources = new Set();
  for (const image of body.querySelectorAll('img')) {
    if (!visible(image) || isReasoning(image) || (!generated.includes(image) && image.closest('button, mat-icon, [role="button"], .avatar'))) continue;
    const source = image.currentSrc || image.src;
    if (seen.has(source) || baseline.imageSources?.has(source)) continue;
    let src;
    try { src = answerImageSource(source); }
    catch (error) {
      // External search illustrations must not stall a complete text answer.
      // Generated output still fails if its actual source is unsupported.
      let external; try { external = new URL(source); } catch {}
      if (generated.includes(image) || !external || !['https:', 'http:'].includes(external.protocol) || external.hostname === 'gemini.google.com' || external.port || external.username || external.password) throw error;
      externalSources.add(external.href); continue;
    }
    if (!image.complete) return null;
    if (!image.naturalWidth || !image.naturalHeight) throw new PageSafetyError('本次 Gemini 回复图片尚未正常加载，未转发空图片');
    seen.add(source);
    images.push({ src, width: image.naturalWidth, height: image.naturalHeight });
    if (images.length > MAX_IMAGES) throw new PageSafetyError('本次回复超过 4 张图片，请在网页查看完整结果');
  }
  return { images, externalSources };
}
export function finalCandidate(doc, baseline, user) {
  const users = newUsers(doc, baseline);
  if (users.length !== 1 || turnKey(users[0]) !== baseline.submittedKey || turnKey(user) !== baseline.submittedKey || userText(users[0]) !== baseline.submittedText) throw new PageSafetyError('对话出现其他消息或内容被替换，停止转发');
  user = users[0]; const row = messageRow(user);
  const following = turns(doc, 'assistant').filter(message => !baseline.assistants.has(turnKey(message)) && Boolean(user.compareDocumentPosition(message) & 4) && !isReasoning(message));
  if (following.some(message => [...message.querySelectorAll('[role="alert"]')].some(visible))) throw new PageSafetyError('Gemini 网页回复失败，请在网页处理；本次不会重新提问');
  if (generating(doc) || following.length !== 1 || messageRow(following[0]) !== row || !completedMessage(following[0])) return null;
  const message = following[0]; const body = publicBodies(message)[0];
  const media = answerImages(body, baseline); if (media === null) return null;
  const clone = body.cloneNode(true);
  const originals = [...body.querySelectorAll('*')]; const copies = [...clone.querySelectorAll('*')];
  originals.forEach((node, index) => { if (!visible(node) || isReasoning(node)) copies[index].remove(); });
  for (const block of clone.querySelectorAll('code-block')) {
    const codes = block.querySelectorAll('pre > code[data-test-id="code-content"]');
    const labels = block.querySelectorAll('.code-block-decoration.header-formatted > span');
    if (codes.length !== 1 || labels.length !== 1 || block.querySelectorAll('pre').length !== 1) throw new PageSafetyError('Gemini 代码块结构已变化，已停止转发不完整代码');
    const language = normalizeText(labels[0].textContent).toLowerCase();
    if (/^[a-z0-9_+#.-]{1,40}$/.test(language)) codes[0].classList.add(`language-${language}`);
    block.replaceWith(codes[0].parentElement);
  }
  let text = markdownText(clone);
  if (media.externalSources.size) text += `${text ? '\n\n' : ''}提示：本次回复有 ${media.externalSources.size} 张外部来源图片未转发，请在 Gemini 网页查看。`;
  return text || media.images.length ? { message, text, images: media.images } : null;
}

// Restore Gemini's 0.6.0–0.7.3 editor notification independently from ChatGPT.
// This event does not prove submission; content.js still validates the full
// draft, waits for the send button, clicks once and confirms the submitted turn.
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
    if (typeof doc.execCommand !== 'function' || !doc.execCommand('insertText', false, prompt)) throw new PageSafetyError('浏览器未接受正常文本输入，已停止发送');
    input.dispatchEvent(new doc.defaultView.InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
  }
  if (normalizeText(composerText(input)) !== normalizeText(prompt)) throw new PageSafetyError('网页输入内容与任务不同，已停止发送');
}
