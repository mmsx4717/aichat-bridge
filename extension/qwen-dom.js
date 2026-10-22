import { normalizeText, conversationUrl } from './shared.js';
export { createObservationRecorder } from './background-observation.js';
import {
  PageSafetyError, visible, composerText, markdownText as sharedMarkdown,
  validateInputImages, decodeImagePayload, MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES,
} from './dom.js';
export { PageSafetyError, visible, composerText, validateInputImages, MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES };

// Observed on the international chat.qwen.ai UI. Keep input, public answer,
// action footer and attachment boundaries separate from sidebars and editors.
const COMPOSER = 'textarea.message-input-textarea';
const SCOPE = '.message-input-container';
const SEND = '.message-input-right-button-send button.send-button';
const ROW = '.qwen-chat-message-select-turn';
const USER = '.qwen-chat-message-user .chat-user-message-container[data-msg-id]';
const ASSISTANT = '.qwen-chat-message-assistant .chat-response-message[id^="chat-response-message-"]';
const BODY = '.response-message-content.phase-answer > .custom-qwen-markdown > .qwen-markdown';
const FOOTER = '.response-message-footer .qwen-chat-package-comp-new-action-control[data-msg-id][data-chat-id]';
const ATTACHMENT = '.message-input-column-file > .file-card-list > .vision-item-container';
const uploads = new WeakMap();
const enabled = node => visible(node) && !node.disabled && !node.matches(':disabled') && node.getAttribute('aria-disabled') !== 'true' && !node.closest('[inert], [aria-disabled="true"]');
function chatId(doc) { return conversationUrl(doc.location.href, 'qwen')?.split('/').at(-1); }
function assertNoDialog(doc) {
  if ([...doc.querySelectorAll('[role="dialog"], [aria-modal="true"], #challenge-running, #challenge-stage, iframe[src*="challenges.cloudflare.com"]')].some(visible)) throw new PageSafetyError('Qwen 有待处理的登录、验证或对话框，请先在网页处理');
}
export function composerScope(input) { return input?.closest(SCOPE) || null; }
export function composer(doc) {
  const inputs = [...doc.querySelectorAll(COMPOSER)].filter(visible);
  if (!inputs.length) throw new PageSafetyError('暂未找到 Qwen 输入框，等待网页加载');
  if (inputs.length > 1) throw new PageSafetyError('检测到多个可见的 Qwen 输入框，暂不自动操作');
  const input = inputs[0], scope = composerScope(input);
  if (!scope || scope.querySelectorAll(COMPOSER).length !== 1 || scope.querySelector(`${USER}, ${ASSISTANT}`)) throw new PageSafetyError('Qwen 输入区结构已变化，已停止自动操作');
  if (!enabled(input) || input.readOnly) throw new PageSafetyError('Qwen 输入框当前不可用');
  return input;
}
export function composerInteraction(target, input) {
  return Boolean(target?.closest && (target.closest(COMPOSER) || (input && composerScope(input)?.contains(target)) || target.closest(SEND)));
}
function hasSendIcon(button) {
  // Chromium parses SVG xlink:href in the XLink namespace. An escaped colon
  // attribute selector does not match it, even though it can pass in JSDOM.
  return [...button.querySelectorAll('use')].some(icon =>
    (icon.getAttribute('href') || icon.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || icon.getAttribute('xlink:href')) === '#qwpcicon-sendChat');
}
function sendControl(doc) {
  const inputs = [...doc.querySelectorAll(COMPOSER)].filter(visible);
  if (inputs.length !== 1) return null;
  const buttons = [...composerScope(inputs[0])?.querySelectorAll(SEND) || []].filter(visible);
  // During generation Qwen reuses its send area. Require the actual send icon,
  // not merely the absence of a stop button or a stable response string.
  return buttons.length === 1 && hasSendIcon(buttons[0]) ? buttons[0] : null;
}
export function generating(doc) {
  const scope = [...doc.querySelectorAll(SCOPE)].find(visible);
  return Boolean(scope && [...scope.querySelectorAll('.message-input-right-button-send button')].filter(visible).some(button =>
    /stop|停止|中止/i.test(button.getAttribute('aria-label') || button.className) || !hasSendIcon(button) && button.matches('.send-button')));
}
export function turns(doc, role) {
  const selector = role === 'user' ? USER : ASSISTANT;
  return [...doc.querySelectorAll('#chat-message-container ' + selector)].filter(node => (role === 'user' || visible(node)) && !node.parentElement?.closest(selector));
}
function rowOf(message) {
  const row = message?.closest(ROW);
  if (!row || row.querySelectorAll(USER).length !== 1 || row.querySelectorAll(ASSISTANT).length > 1) return null;
  return row;
}
function key(message) {
  const id = message.matches(USER) ? message.getAttribute('data-msg-id') : message.id.slice('chat-response-message-'.length);
  return `${message.matches(USER) ? 'user' : 'assistant'}:${id}`;
}
function unique(message) {
  const role = message.matches(USER) ? 'user' : 'assistant';
  return turns(message.ownerDocument, role).filter(node => key(node) === key(message)).length === 1;
}
function userText(message, { pending = false } = {}) {
  const bodies = message.querySelectorAll('.chat-user-message > .chunked-text-renderer-root');
  // Qwen mounts the durable row before its chunked prompt renderer. Only the
  // initial confirmation may wait; final answer ownership remains strict.
  if (pending && bodies.length === 0) return null;
  if (bodies.length !== 1) throw new PageSafetyError('Qwen 用户消息结构已变化，已停止转发');
  // Chromium may return empty innerText for an unrendered subtree (for
  // example content-visibility), even when this plain prompt is in the DOM.
  // Read only the verified prompt root structurally, keeping P/BR boundaries
  // and exact matching. Never substitute the entire row or an answer's text.
  return normalizeText(composerText(bodies[0].cloneNode(true)));
}
function publicBodies(message) {
  return [...message.querySelectorAll(BODY)].filter(node => visible(node) && node.closest(ASSISTANT) === message);
}
// Response actions are read-only completion markers. Qwen can hide them with
// visibility:hidden until the message is hovered; that does not remove their
// identity or completion meaning. Never use this predicate to click a control
// or to read hidden answer text. Explicitly concealed templates stay excluded.
function completionMarkerPresent(node, message) {
  if (!node || !message?.contains(node) || !visible(message) || message.closest('[inert]')) return false;
  for (let current = node; current && current !== message; current = current.parentElement) {
    if (current.hidden || current.getAttribute('aria-hidden') === 'true' || current.hasAttribute('inert') ||
        current.ownerDocument.defaultView.getComputedStyle(current).display === 'none') return false;
  }
  return true;
}
function completionActionEnabled(button, message) {
  return completionMarkerPresent(button, message) && !button.disabled && !button.matches(':disabled') &&
    !button.closest('[inert], [aria-disabled="true"]');
}
function completed(message) {
  if (!rowOf(message) || !unique(message) || !publicBodies(message).length || generating(message.ownerDocument) || !sendControl(message.ownerDocument)) return false;
  if ([...message.querySelectorAll('[role="alert"], [aria-busy="true"]')].some(visible)) return false;
  const footers = [...message.querySelectorAll(FOOTER)].filter(node => completionMarkerPresent(node, message) && node.closest(ASSISTANT) === message);
  if (footers.length !== 1 || footers[0].getAttribute('data-msg-id') !== message.id.slice('chat-response-message-'.length) || footers[0].getAttribute('data-chat-id') !== chatId(message.ownerDocument)) return false;
  return ['copy', 'regenerate'].every(action => [...footers[0].querySelectorAll(`button.qwen-chat-package-comp-new-action-control-container-${action}`)].filter(button => completionActionEnabled(button, message)).length === 1);
}
export function snapshot(doc) {
  const users = turns(doc, 'user');
  return { users: new Set(users.map(key)), lastUserKey: users.length ? key(users.at(-1)) : null, assistants: new Set(turns(doc, 'assistant').map(key)), imageSources: new Set([...doc.querySelectorAll('img')].map(image => image.currentSrc || image.src).filter(Boolean)) };
}
export function newUsers(doc, baseline) {
  let users = turns(doc, 'user');
  if (baseline.users.size) {
    const anchors = users.filter(node => key(node) === baseline.lastUserKey);
    if (anchors.length !== 1) throw new PageSafetyError('原有 Qwen 用户消息基准已消失或重复，无法确认新消息范围');
    users = users.slice(users.indexOf(anchors[0]) + 1);
  }
  return users.filter(node => !baseline.users.has(key(node)));
}
function submissionState(doc, baseline, prompt) {
  const users = newUsers(doc, baseline);
  if (users.length > 1) throw new PageSafetyError('检测到其他新消息，已停止转发，避免混淆回复');
  if (!users.length) return null;
  const user = users[0], row = rowOf(user);
  if (!user.getAttribute('data-msg-id')?.trim() || !row || !unique(user) || user.getAttribute('data-chat-id') !== chatId(doc)) throw new PageSafetyError('Qwen 新消息归属无法确认，已停止转发');
  const expected = normalizeText(prompt), currentKey = key(user), observed = baseline.submissionUser;
  if (observed && observed.prompt !== expected) throw new PageSafetyError('待确认的 Qwen 网页消息已被替换，已停止转发');
  const confirmed = baseline.submittedText !== undefined;
  const actual = userText(user, { pending: !confirmed });
  if (confirmed && (actual !== baseline.submittedText || expected !== baseline.submittedText)) throw new PageSafetyError('已确认的 Qwen 网页消息内容被替换，已停止转发');
  if (actual !== null && actual !== expected && !expected.startsWith(actual)) throw new PageSafetyError('新增网页消息与本次群消息不同，已停止转发');
  // Qwen replaces an optimistic user ID with its server ID after sending.
  // Permit one transition only inside the same live turn row, with the same
  // user node or a detached/replaced child. Text and unique-conversation
  // checks above still apply; changing the row and ID together is ambiguous.
  if (observed && observed.key !== currentKey) {
    if (observed.identityChanges || observed.row !== row || !observed.row.isConnected ||
        (observed.node !== user && observed.node.isConnected)) throw new PageSafetyError('待确认的 Qwen 网页消息已被替换，已停止转发');
    observed.key = currentKey; observed.identityChanges++;
  }
  baseline.submissionUser ||= { key: currentKey, prompt: expected, identityChanges: 0, confirmedNodes: new WeakSet() };
  baseline.submissionUser.node = user; baseline.submissionUser.row = row;
  return { user, expected, pending: actual === null || actual !== expected };
}
export function findSubmittedUser(doc, baseline, prompt) {
  const state = submissionState(doc, baseline, prompt);
  if (!state || state.pending) return null;
  baseline.submissionUser.confirmedNodes.add(state.user);
  baseline.submittedText = state.expected; return state.user;
}
export function submittedUserPending(doc, baseline, prompt) {
  // An identified, unique user row can outlive the 20-second missing-message
  // window while its prompt is still absent/partial. content.js keeps the
  // original job deadline; this predicate never confirms a prompt or answer.
  return submissionState(doc, baseline, prompt)?.pending === true;
}
export function submissionWaitReason(doc, baseline, prompt) {
  const users = newUsers(doc, baseline);
  if (!users.length) return 'Qwen 尚未出现可识别的新提问';
  if (users.length !== 1) return 'Qwen 出现多个新提问';
  const actual = userText(users[0], { pending: true });
  if (actual === null) return 'Qwen 提问正文尚未挂载';
  // Diagnostics contain only lengths and fixed labels, no prompt text or IDs.
  return `Qwen 提问正文尚未完整（已识别 ${actual.length}/${normalizeText(prompt).length} 字符）`;
}
export function hasAttachments(input) {
  const scope = composerScope(input); if (!scope) return true;
  return [...scope.querySelectorAll('input[type="file"]')].some(field => field.files?.length) ||
    [...scope.querySelectorAll('.file-card-list > *, img, [role="progressbar"], [aria-busy="true"]')].some(visible);
}
export function assertReady(doc) {
  assertNoDialog(doc);
  if (generating(doc)) throw new PageSafetyError('该对话正在生成回复，请等待完成');
  const lastUser = turns(doc, 'user').at(-1), lastAnswer = turns(doc, 'assistant').at(-1);
  if (lastUser && (!rowOf(lastUser) || !lastAnswer || rowOf(lastUser) !== rowOf(lastAnswer) || !completed(lastAnswer))) throw new PageSafetyError('上一条 Qwen 网页提问尚未明确完成，请先在网页处理');
  const input = composer(doc);
  if (hasAttachments(input)) throw new PageSafetyError('输入区存在附件或正在上传，本次不会发送');
  if (normalizeText(composerText(input))) throw new PageSafetyError('输入框有草稿，本次不会覆盖草稿');
  return input;
}
export function sendButton(doc, input) {
  if (composer(doc) !== input) throw new PageSafetyError('Qwen 输入框已被替换，已停止发送');
  const button = sendControl(doc); return enabled(button) ? button : null;
}
function fileInput(input) {
  const fields = composerScope(input)?.querySelectorAll('input[type="file"]');
  const field = fields?.[0];
  if (fields?.length !== 1 || !field.matches('#filesUpload[multiple]') || field.disabled || field.matches(':disabled') || field.closest('[inert], [aria-disabled="true"]')) throw new PageSafetyError('Qwen 文件上传入口不可用或不唯一，已停止上传');
  return field;
}
export function attachInputImage(doc, input, payload, name) {
  if (composer(doc) !== input || !/^[A-Za-z0-9._-]{1,150}$/.test(name)) throw new PageSafetyError('无法确认 Qwen 图片输入目标');
  const records = uploads.get(input) || new Map();
  if (records.has(name) || normalizeText(composerText(input)) || !inputAttachmentState(input, [...records.keys()]).ready) throw new PageSafetyError('Qwen 输入区存在未确认附件或草稿，已停止上传');
  const win = doc.defaultView, bytes = decodeImagePayload(payload.mimeType, payload.base64);
  if (typeof win.DataTransfer !== 'function') throw new PageSafetyError('当前浏览器不支持图片文件输入');
  const scope = composerScope(input), field = fileInput(input), transfer = new win.DataTransfer();
  const file = new win.File([bytes], name, { type: payload.mimeType }); transfer.items.add(file);
  records.set(name, { file, scope, card: null, src: null, beforeCards: new Set(scope.querySelectorAll(ATTACHMENT)), beforeSources: new Set([...scope.querySelectorAll('img')].map(x => x.currentSrc || x.src)) }); uploads.set(input, records);
  field.files = transfer.files;
  if (field.files?.length !== 1 || field.files[0] !== file) throw new PageSafetyError('Qwen 文件选择发生变化，已停止上传');
  // Qwen consumes the file input's change event and clears the FileList.
  field.dispatchEvent(new win.Event('change', { bubbles: true }));
}
export function refreshComposer(doc, input) {
  if (input.isConnected) return input;
  const records = uploads.get(input); const originalScope = records?.values().next().value?.scope;
  if (!records?.size || !originalScope?.isConnected) return input;
  const current = composer(doc);
  if (composerScope(current) !== originalScope || normalizeText(composerText(current))) throw new PageSafetyError('Qwen 上传后输入区被替换或出现草稿，已停止发送');
  // Only a layout replacement within the same owned composer during upload
  // can inherit the attachment ledger. Never recover an arbitrary new editor.
  uploads.set(current, records); uploads.delete(input); return current;
}
export function inputAttachmentState(input, names) {
  assertNoDialog(input.ownerDocument);
  const scope = composerScope(input), records = uploads.get(input);
  if (!scope || new Set(names).size !== names.length || [...records?.keys() || []].some(name => !names.includes(name))) throw new PageSafetyError('无法确认本次 Qwen 图片附件');
  if (!names.length) return { ready: !hasAttachments(input) };
  if ([...scope.querySelectorAll('[role="alert"]')].some(visible)) throw new PageSafetyError('Qwen 报告图片上传失败，已停止发送');
  if ([...scope.querySelectorAll('[role="progressbar"], [aria-busy="true"], .ant-spin-spinning')].some(visible)) return { ready: false, reason: 'uploading' };
  const cards = [...scope.querySelectorAll(ATTACHMENT)].filter(visible);
  if (!cards.length) return { ready: false, reason: 'no-attachment' };
  if (cards.length !== names.length || [...scope.querySelectorAll('.file-card-list > *, img')].filter(visible).some(node => !cards.some(card => node === card || card.contains(node)))) return { ready: false, reason: 'name-mismatch' };
  const matched = new Set();
  for (const name of names) {
    const record = records?.get(name); if (!record || record.scope !== scope) return { ready: false, reason: 'name-mismatch' };
    if (record.card && !scope.contains(record.card)) throw new PageSafetyError('本次 Qwen 图片附件被移除，已停止发送');
    const matches = cards.filter(card => !record.beforeCards.has(card) && card.querySelector('img.vision-item-image')?.getAttribute('alt') === name);
    if (matches.length !== 1 || matched.has(matches[0])) return { ready: false, reason: 'name-mismatch' };
    const card = matches[0], images = card.querySelectorAll('img'); const image = images[0]; matched.add(card);
    if (images.length !== 1 || !visible(image) || card.querySelectorAll('button.close-button').length !== 1) return { ready: false, reason: 'name-mismatch' };
    const src = image.currentSrc || image.src;
    if (record.card && (record.card !== card || record.src !== src)) throw new PageSafetyError('本次 Qwen 图片附件被替换，已停止发送');
    let source; try { source = new URL(src); } catch {}
    // A loaded remote object with the exact task filename proves the native
    // upload reached Qwen storage. A local blob preview alone is not enough.
    if (source?.origin !== 'https://qwen-webui-prod.oss-accelerate.aliyuncs.com') return { ready: false, reason: 'uploading' };
    let path; try { path = decodeURIComponent(source.pathname); } catch { return { ready: false, reason: 'name-mismatch' }; }
    if (!path.endsWith('_' + name) || record.beforeSources.has(src)) return { ready: false, reason: 'name-mismatch' };
    if (!image.complete || !image.naturalWidth || !image.naturalHeight) return { ready: false, reason: 'uploading' };
    record.card = card; record.src = src;
  }
  const field = fileInput(input);
  if ([...(field.files || [])].some(file => ![...records.values()].some(record => record.file === file))) throw new PageSafetyError('Qwen 文件选择包含本次任务之外的附件');
  return { ready: matched.size === names.length };
}
export function releaseInputImages(input) { uploads.delete(input); }

function codeText(block) {
  const body = block.querySelector('.qwen-markdown-code-body');
  const editors = body?.querySelectorAll('.monaco-editor[role="code"]');
  const fail = () => new PageSafetyError('Qwen 代码未完整展开或结构已变化，已停止转发不完整代码；请在网页展开代码');
  if (!body || !visible(body) || editors?.length !== 1 || block.querySelector('[aria-expanded="false"]')) throw fail();
  const editor = editors[0], views = editor.querySelectorAll('.view-lines'), view = views[0];
  const lines = view ? [...view.children] : [];
  const numbers = [...editor.querySelectorAll('.margin-view-overlays .line-numbers')];
  const totalHeight = Number.parseFloat(view?.style.height);
  if (views.length !== 1 || !lines.length || numbers.length !== lines.length || !Number.isFinite(totalHeight) || totalHeight <= 0) throw fail();
  let offset = 0;
  for (const [index, line] of lines.entries()) {
    const top = Number.parseFloat(line.style.top), height = Number.parseFloat(line.style.height);
    if (!line.matches('.view-line') || !Number.isFinite(top) || !Number.isFinite(height) || height <= 0 || Math.abs(top - offset) > 0.5 || numbers[index].textContent.trim() !== String(index + 1) || line.querySelector('.mtkoverflow, .view-zone')) throw fail();
    offset += height;
  }
  // Do not return only Monaco's currently virtualized viewport.
  const scrollbars = [...editor.querySelectorAll('.scrollbar.vertical')];
  if (Math.abs(offset - totalHeight) > 0.5 || !scrollbars.length || scrollbars.some(bar => !bar.classList.contains('invisible') && Number.parseFloat(bar.querySelector('.slider')?.style.height) < Number.parseFloat(bar.style.height))) throw fail();
  const language = block.querySelector('.qwen-markdown-code-header > div')?.textContent.trim() || '';
  return { text: lines.map(line => line.textContent.replace(/\u00a0/g, ' ')).join('\n'), language };
}
export function markdownText(body) {
  const clone = body.cloneNode(true), originals = [...body.querySelectorAll('*')], copies = [...clone.querySelectorAll('*')];
  const replacements = [...body.querySelectorAll('pre.qwen-markdown-code')].map(block => ({ node: copies[originals.indexOf(block)], ...codeText(block) }));
  originals.forEach((node, index) => { if (!visible(node) && !node.closest('pre.qwen-markdown-code')) copies[index].remove(); });
  for (const { node, text, language } of replacements) {
    const code = clone.ownerDocument.createElement('code'); code.textContent = text;
    if (/^[a-zA-Z0-9_+#.-]{1,40}$/.test(language)) code.className = 'language-' + language.toLowerCase();
    node.replaceChildren(code);
  }
  // Qwen paragraphs use DIV, whereas the shared renderer suppresses generic
  // code toolbar wrappers. Give genuine prose its semantic paragraph boundary.
  for (const node of clone.querySelectorAll('.qwen-markdown-paragraph')) {
    const p = clone.ownerDocument.createElement('p'); p.append(...node.childNodes); node.replaceWith(p);
  }
  return sharedMarkdown(clone);
}
export function answerImageSource(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'blob:' && url.origin === 'https://chat.qwen.ai') return url.href;
    if (url.protocol === 'https:' && ['chat.qwen.ai', 'qwen-webui-prod.oss-accelerate.aliyuncs.com'].includes(url.hostname) && !url.port && !url.username && !url.password) return url.href;
  } catch {}
  throw new PageSafetyError('本次 Qwen 回复图片的来源不受支持，未读取或转发图片');
}
export function finalCandidate(doc, baseline, previousUser) {
  // The previous node is mutable: its data-msg-id may already have changed.
  // Use the recorded identity and the same checked transition rule instead
  // of comparing the current ID with another reference to that same node.
  if (baseline.submittedText === undefined || !baseline.submissionUser?.confirmedNodes.has(previousUser)) throw new PageSafetyError('对话出现其他消息或内容被替换，停止转发');
  const state = submissionState(doc, baseline, baseline.submittedText);
  if (!state || state.pending) throw new PageSafetyError('对话出现其他消息或内容被替换，停止转发');
  const user = state.user, row = rowOf(user);
  if (!row) throw new PageSafetyError('Qwen 本轮消息结构发生变化，已停止转发');
  const following = turns(doc, 'assistant').filter(message => !baseline.assistants.has(key(message)) && (user.compareDocumentPosition(message) & 4));
  if (following.some(message => [...message.querySelectorAll('[role="alert"]')].some(visible))) throw new PageSafetyError('Qwen 网页回复失败，请在网页处理；本次不会重新提问');
  if (following.length !== 1 || rowOf(following[0]) !== row || !completed(following[0])) return null;
  const message = following[0], bodies = publicBodies(message), images = [], seen = new Set(); let skippedImages = 0;
  for (const body of bodies) {
    if ([...body.querySelectorAll('canvas')].some(node => visible(node) && !node.closest('pre.qwen-markdown-code'))) throw new PageSafetyError('Qwen 回复包含无法读取的画布，请在网页查看');
    for (const image of body.querySelectorAll('img')) {
      if (!visible(image)) continue;
      const source = image.currentSrc || image.src;
      if (seen.has(source) || baseline.imageSources.has(source)) continue; seen.add(source);
      let src; try { src = answerImageSource(source); } catch { skippedImages++; continue; }
      if (!image.complete) return null;
      if (!image.naturalWidth || !image.naturalHeight) throw new PageSafetyError('Qwen 回复图片未正常加载');
      images.push({ src, width: image.naturalWidth, height: image.naturalHeight });
      if (images.length > MAX_IMAGES) throw new PageSafetyError('本次回复超过 4 张图片，请在网页查看完整结果');
    }
  }
  let text = bodies.map(markdownText).filter(Boolean).join('\n\n');
  if (skippedImages) text += `${text ? '\n\n' : ''}（${skippedImages} 张外部来源配图未转发，请在 Qwen 网页查看。）`;
  return text || images.length ? { message, text, images, skippedImages } : null;
}

// This lease drives only the Qwen MAIN-world frame adapter. State replies are
// untrusted metadata and can never authorize a prompt or a final answer.
export function beginBackgroundRendering(doc, timeoutMs) {
  const win = doc.defaultView, token = win.crypto.randomUUID();
  let state = {}, stopped = false;
  const send = action => doc.dispatchEvent(new win.CustomEvent('aichat:qwen:frame-control', { detail: { action, token, timeoutMs } }));
  const receive = event => {
    const data = event.detail;
    if (data?.token !== token || !Number.isSafeInteger(data.pending) || data.pending < 0 || data.pending > 512 ||
        !Number.isSafeInteger(data.resumed) || data.resumed < 0 || data.resumed > 3600000) return;
    state = { framePending: data.pending, frameResumed: data.resumed };
  };
  doc.addEventListener('aichat:qwen:frame-state', receive);
  send('start');
  return {
    wake() { if (!stopped) send('pulse'); },
    stats() { return { ...state }; },
    stop() { if (stopped) return; stopped = true; doc.removeEventListener('aichat:qwen:frame-state', receive); send('stop'); },
  };
}

// Diagnostic only: these counters never authorize completion or submission.
export function backgroundObservation(doc, baseline, user) {
  const current = baseline?.submissionUser?.node || user;
  const row = current?.isConnected ? rowOf(current) : null;
  const matches = row ? [...row.querySelectorAll(ASSISTANT)].filter(message => !baseline.assistants.has(key(message))) : [];
  const message = matches.length === 1 ? matches[0] : null;
  const bodies = message ? [...message.querySelectorAll(BODY)] : [];
  return {
    hidden: doc.visibilityState !== 'visible', focused: doc.hasFocus(), generating: generating(doc),
    complete: Boolean(message && completed(message)),
    bodyChars: Math.min(3600000, bodies.reduce((sum, body) => sum + body.textContent.length, 0)),
    bodyCount: Math.min(3600000, bodies.length), footerCount: Math.min(3600000, message?.querySelectorAll(FOOTER).length || 0),
  };
}

export async function readAnswerImage(image, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const source = answerImageSource(image.src); const controller = new AbortController();
  let reader; let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
    controller.abort(); reader?.cancel().catch(() => {});
    reject(new PageSafetyError('读取本次 Qwen 回复图片超时，请在网页查看'));
  }, timeoutMs); });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await fetchImpl(source, { signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' });
      if (!response.ok || !response.body?.getReader) throw new PageSafetyError('无法读取本次 Qwen 回复图片，请在网页确认图片可以打开');
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
    throw new PageSafetyError('无法读取本次 Qwen 回复图片，可能是图片访问受限或连接中断；未转发空图片');
  } finally { clearTimeout(timer); controller.abort(); reader?.cancel().catch(() => {}); }
}

// Qwen owns its native textarea update. Contenteditable event changes in
// ChatGPT, Claude or Gemini must never change this path.
export function insertPrompt(doc, input, prompt) {
  if (!input.isConnected || input.disabled || input.matches(':disabled') || input.closest('[inert], [aria-disabled="true"]') || input.readOnly) throw new PageSafetyError('网页输入框当前不可用，已停止写入');
  if (input.tagName !== 'TEXTAREA') throw new PageSafetyError('Qwen 输入框结构已变化，已停止写入');
  if (normalizeText(composerText(input))) throw new PageSafetyError('检测到新草稿，已停止写入');
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(doc.defaultView.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(input, prompt);
  input.dispatchEvent(new doc.defaultView.InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
  if (normalizeText(composerText(input)) !== normalizeText(prompt)) throw new PageSafetyError('网页输入内容与任务不同，已停止发送');
}
