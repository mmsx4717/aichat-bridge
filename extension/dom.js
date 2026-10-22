import { normalizeText } from './shared.js';
const COMPOSER = '#prompt-textarea, [data-composer-markdown][contenteditable="true"][role="textbox"]';
const SEND = 'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="发送提示"], button[aria-label="发送消息"], button[type="submit"][aria-label="发送"], button[type="submit"][aria-label="Send"]';
export class PageSafetyError extends Error { constructor(message) { super(message); this.name = 'PageSafetyError'; } }
function unavailableControl(node) { return Boolean(node.disabled || node.matches(':disabled') || node.closest('[inert], [aria-disabled="true"]')); }
// Only finalCandidate's synchronous scan owns this cache. Never retain styles
// across polling rounds, where CSS, hidden state or completion can change.
let scanStyles = null;
export function visible(node, options) {
  if (!node || (!node.isConnected && options?.allowDetached !== true)) return false;
  for (let el = node; el && el.nodeType === 1; el = el.parentElement) {
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
    let style = scanStyles?.get(el);
    if (!style) {
      const computed = el.ownerDocument.defaultView.getComputedStyle(el);
      style = { display: computed.display, visibility: computed.visibility };
      scanStyles?.set(el, style);
    }
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}
export function composer(doc) {
  const nodes = [...doc.querySelectorAll(COMPOSER)].filter(visible);
  if (!nodes.length) throw new PageSafetyError('暂未找到 ChatGPT 输入框，等待网页加载');
  if (nodes.length > 1) throw new PageSafetyError('检测到多个可见的 ChatGPT 输入框，暂不自动操作');
  const input = nodes[0];
  if (input.tagName !== 'TEXTAREA' && input.getAttribute('contenteditable') !== 'true') throw new PageSafetyError('网页输入框结构已变化，已停止自动操作');
  if (unavailableControl(input) || input.readOnly) throw new PageSafetyError('ChatGPT 输入框当前不可用');
  return input;
}
function editableText(node) {
  // Chromium's innerText falls back to raw textContent on detached clones,
  // losing paragraph/BR boundaries. Provider adapters use such sanitized
  // clones to exclude attachment controls from the submitted prompt.
  if (node.isConnected && typeof node.innerText === 'string') return node.innerText;
  const walk = item => {
    if (item.nodeType === 3) return item.textContent;
    if (item.nodeType !== 1) return '';
    if (item.tagName === 'BR') return '\n';
    const text = [...item.childNodes].map(walk).join('');
    return ['P', 'DIV', 'LI', 'BLOCKQUOTE'].includes(item.tagName) ? text + '\n' : text;
  };
  return walk(node).replace(/\n+$/, '');
}
export function composerText(input) { return input.tagName === 'TEXTAREA' ? input.value : editableText(input); }
function modernState(turn) {
  const states = [...turn.querySelectorAll('[data-talvt-turn-state]')].filter(n => n.closest('[data-turn-key]') === turn);
  if (turn.matches('[data-talvt-turn-state]')) states.unshift(turn);
  return states.length === 1 ? states[0].getAttribute('data-talvt-turn-state') : null;
}
export function generating(doc) {
  if ([...doc.querySelectorAll('[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label="Stop generating"], button[aria-label="停止生成"], button[aria-label="停止流式传输"], [data-is-streaming="true"]')].some(visible)) return true;
  return [...doc.querySelectorAll('[data-turn-key]')].filter(visible).some(turn => {
    const state = modernState(turn);
    return state && !['complete', 'cancelled', 'canceled', 'failed', 'error', 'interrupted'].includes(state);
  });
}
export function composerScope(input) { return input.closest('[data-composer-body]') || input.closest('form') || input.closest('[data-type="unified-composer"]') || input.parentElement?.parentElement; }
export function composerInteraction(target, input) {
  return Boolean(target?.closest && (target.closest(COMPOSER) || (input && composerScope(input)?.contains(target)) || target.closest(SEND)));
}
export function hasAttachments(input) {
  const scope = composerScope(input); if (!scope) return true;
  if ([...scope.querySelectorAll('input[type="file"]')].some(n => n.files?.length)) return true;
  if ([...scope.querySelectorAll('[data-composer-attachments]')].some(n => visible(n) && (n.childElementCount || normalizeText(n.textContent)))) return true;
  return [...scope.querySelectorAll('img, [data-testid*="attachment-preview"], [data-testid*="file-chip"], [data-testid*="upload-preview"], [data-testid*="file-thumbnail"], [data-testid="file-upload"], [role="progressbar"], button[aria-label*="Remove file"], button[aria-label*="Remove attachment"], button[aria-label*="移除附件"], button[aria-label*="删除文件"], button[aria-label*="移除文件"]')].some(visible);
}
export function pageChallengeActive(doc) {
  return [...doc.querySelectorAll('#challenge-running, #challenge-stage, iframe[src*="challenges.cloudflare.com"]')].some(visible);
}
function modelUnavailable(doc) {
  // Check a visible composer control, never an answer mentioning this error.
  const inputs = [...doc.querySelectorAll(COMPOSER)].filter(visible);
  if (inputs.length !== 1) return false;
  const scope = composerScope(inputs[0]);
  return [...scope?.querySelectorAll('button, [role="button"], [role="combobox"]') || []].some(control => visible(control) &&
    [control.textContent, control.getAttribute('aria-label')].some(text => /^(?:无法加载\s*ChatGPT\s*模型|Unable to load ChatGPT models?)$/i.test(normalizeText(text))));
}
function assertModelAvailable(doc) {
  if (modelUnavailable(doc)) throw new PageSafetyError('ChatGPT 模型尚未加载，暂不提交；请等网页模型选择恢复后再试');
}
function challengeFailure(doc, user) {
  if (!user) return null;
  const turn = user.closest('[data-turn-key]');
  const scope = turn || doc.querySelector('main') || doc.body;
  if (!scope) return null;
  const excludedContent = '[data-message-author-role="user"], [data-chatgpt-search-unit-key$=":user"], pre, code, [data-code-block], .cm-content';
  const eligible = node => visible(node) && !isReasoning(node) && !node.closest(excludedContent) &&
    !node.contains(user) && Boolean(user.compareDocumentPosition(node) & 4) &&
    (!turn || node.closest('[data-turn-key]') === turn);
  const errorText = node => {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1 || !visible(node) || node.matches('button, [role="button"], script, style, svg')) return '';
    return [...node.childNodes].map(errorText).join('');
  };
  const exactError = node => normalizeText(errorText(node)) === 'cloudflare_challenge';
  const renderedAnswer = '.markdown, [data-markdown-text-style="assistant-message"]';
  const isErrorPanel = node => eligible(node) && exactError(node) &&
    (node.hasAttribute('data-dil-render-failed') || (!node.closest(renderedAnswer) && !node.querySelector(renderedAnswer + ', pre, code, [data-code-block]')));
  // A literal word in model prose/code is not a verification failure. Match
  // only a compact error surface or the error next to a real retry control.
  // This screenshot-derived fallback does not depend on unobserved CSS names.
  let failed = [...scope.querySelectorAll('[data-dil-render-failed], [role="alert"], [role="status"]')].some(isErrorPanel);
  const retryButtons = [];
  for (const button of scope.querySelectorAll('button, [role="button"]')) {
    if (!eligible(button) || !/^(?:重试|retry|try again)$/i.test(normalizeText(button.getAttribute('aria-label') || button.textContent))) continue;
    for (let panel = button.parentElement, depth = 0; panel && panel !== scope && depth < 4; panel = panel.parentElement, depth++) {
      if (isErrorPanel(panel)) { failed = true; retryButtons.push(button); break; }
    }
  }
  return failed ? { retryButtons } : null;
}
function assertNoChallenge(doc, user) {
  if (pageChallengeActive(doc)) throw new PageSafetyError('网页正在验证，请先手动完成验证');
  if (challengeFailure(doc, user)) throw Object.assign(new PageSafetyError('ChatGPT 返回 cloudflare_challenge（安全验证）；请在原网页处理验证或手动重试'), { code: 'CHATGPT_CLOUDFLARE_CHALLENGE' });
}
export function challengeCheckpoint(doc, baseline, user, prompt) {
  const current = findSubmittedUser(doc, baseline, prompt);
  if (!current || turnKey(current) !== turnKey(user) || !challengeFailure(doc, current)) throw new PageSafetyError('无法确认本次验证错误所属的消息，已停止自动恢复');
  const input = composer(doc);
  if (normalizeText(composerText(input)) || hasAttachments(input)) throw new PageSafetyError('输入区存在草稿或附件，已停止自动刷新');
  const userKey = turnKey(current);
  if (typeof userKey !== 'string' || !userKey.startsWith('message:')) throw new PageSafetyError('网页消息缺少稳定标识，无法安全自动刷新');
  return { userKey, prompt: normalizeText(prompt), imageSources: [...baseline.imageSources] };
}
export function restoreChallengeContext(doc, checkpoint) {
  const users = turns(doc, 'user');
  const matches = users.filter(node => turnKey(node) === checkpoint.userKey);
  if (!matches.length) return null;
  if (matches.length !== 1 || users.at(-1) !== matches[0]) throw new PageSafetyError('刷新后消息已变化，已停止自动重试');
  const text = userText(matches[0]);
  // Reload can mount the saved message identity before all of its text. Do
  // not restore ownership or retry until the entire original prompt matches.
  if (text !== checkpoint.prompt && checkpoint.prompt.startsWith(text)) return null;
  if (text !== checkpoint.prompt) throw new PageSafetyError('刷新后消息已变化，已停止自动重试');
  const user = matches[0];
  const baseline = snapshot(doc);
  baseline.users.delete(checkpoint.userKey);
  baseline.lastUserKey = users.length > 1 ? turnKey(users.at(-2)) : null;
  baseline.assistants = new Set(turns(doc, 'assistant').filter(node => Boolean(node.compareDocumentPosition(user) & 4)).map(turnKey));
  baseline.imageSources = new Set(checkpoint.imageSources);
  baseline.submittedUser = { key: checkpoint.userKey, prompt: checkpoint.prompt };
  return { user, baseline };
}
export function challengeRetryButton(doc, user) {
  if (pageChallengeActive(doc) || modelUnavailable(doc)) return null;
  const input = composer(doc);
  if (normalizeText(composerText(input)) || hasAttachments(input)) throw new PageSafetyError('输入区存在草稿或附件，已停止自动重试');
  const failure = challengeFailure(doc, user);
  if (!failure) return null;
  const buttons = failure.retryButtons.filter(button => !unavailableControl(button));
  return buttons.length === 1 ? buttons[0] : null;
}
export function assertReady(doc) {
  assertModelAvailable(doc);
  const lastUser = turns(doc, 'user').at(-1);
  assertNoChallenge(doc, lastUser);
  if (generating(doc)) throw new PageSafetyError('该对话正在生成回复，请等待完成');
  const lastAssistant = turns(doc, 'assistant').at(-1);
  if (lastUser && (!lastAssistant || !(lastUser.compareDocumentPosition(lastAssistant) & 4) || !sameModernTurn(lastUser, lastAssistant) || !completedMessage(lastAssistant))) throw new PageSafetyError('上一条网页提问尚未明确完成，请先在网页处理');
  const input = composer(doc);
  if (hasAttachments(input)) throw new PageSafetyError('输入区存在附件或正在上传，本次不会发送');
  if (normalizeText(composerText(input))) throw new PageSafetyError('输入框有草稿，本次不会覆盖草稿');
  return input;
}
export function turns(doc, role) {
  const selector = `[data-message-author-role="${role}"], [data-chatgpt-search-unit-key$=":${role}"]`;
  const marked = [...doc.querySelectorAll(selector)].filter(n => !n.parentElement?.closest(selector));
  if (role !== 'assistant') return marked;
  const nodes = [...new Set([...marked, ...generatedMessages(doc)])];
  // A marked assistant may already wrap the gallery. Keep one container in
  // that case, without merging unrelated nested message identities.
  return nodes.filter(node => !nodes.some(other => other !== node && other.contains(node) &&
    (marked.includes(other) || turnKey(other) === turnKey(node))))
    .sort((a, b) => a.compareDocumentPosition(b) & 4 ? -1 : 1);
}
function generatedMessages(root) {
  const messages = new Set();
  for (const gallery of root.querySelectorAll('[data-testid="generated-image-gallery"]')) {
    if (!visible(gallery) || isReasoning(gallery) || !gallery.querySelector('button[data-testid="generated-image-preview"] img')) continue;
    const message = gallery.closest('[data-chatgpt-search-message-ids]');
    const turn = gallery.closest('[data-turn-key]');
    if (!message || !turn || message.closest('[data-turn-key]') !== turn) continue;
    const ids = message.getAttribute('data-chatgpt-search-message-ids').trim().split(/\s+/).filter(Boolean);
    if (!ids.length) continue;
    let incompatibleRole = false;
    for (let node = gallery; node && node !== turn; node = node.parentElement) {
      const role = node.getAttribute('data-message-author-role');
      const unit = node.getAttribute('data-chatgpt-search-unit-key') || node.getAttribute('data-content-search-unit-key');
      if ((role && role !== 'assistant') || (unit && !unit.endsWith(':assistant'))) { incompatibleRole = true; break; }
    }
    if (incompatibleRole) continue;
    const users = turns(turn, 'user').filter(user => user.closest('[data-turn-key]') === turn);
    if (users.length !== 1 || message.contains(users[0]) || !(users[0].compareDocumentPosition(message) & 4)) continue;
    const userIds = (users[0].getAttribute('data-chatgpt-search-message-ids') || '').trim().split(/\s+/);
    if (ids.some(id => userIds.includes(id))) continue;
    messages.add(message);
  }
  return [...messages];
}
function turnKey(node) {
  const legacy = node.getAttribute('data-message-id');
  if (legacy) return 'message:' + legacy;
  const ids = node.getAttribute('data-chatgpt-search-message-ids');
  if (ids?.trim()) return 'message:' + [...new Set(ids.trim().split(/\s+/))].sort().join(' ');
  const selection = node.getAttribute('data-chatgpt-selection-message-id') || node.querySelector('[data-chatgpt-selection-message-id]')?.getAttribute('data-chatgpt-selection-message-id');
  if (selection) return 'message:' + selection;
  // A stable turn key is preferable to a fallback-turn-N search index.
  const turn = node.closest('[data-turn-key]');
  if (turn) return turn.getAttribute('data-turn-key') + ':' + (node.getAttribute('data-chatgpt-search-unit-key')?.split(':').slice(-2).join(':') || node.getAttribute('data-message-author-role'));
  return node;
}
export function snapshot(doc) {
  const users = turns(doc, 'user');
  return { users: new Set(users.map(turnKey)), lastUserKey: users.length ? turnKey(users.at(-1)) : null, assistants: new Set(turns(doc, 'assistant').map(turnKey)), imageSources: new Set([...doc.querySelectorAll('img')].map(image => image.currentSrc || image.src).filter(Boolean)) };
}
export function newUsers(doc, baseline) {
  const users = turns(doc, 'user');
  let following = users;
  if (baseline.users.size) {
    const anchor = users.findIndex(node => turnKey(node) === baseline.lastUserKey);
    if (anchor < 0) throw new PageSafetyError('原有用户消息基准已消失，无法确认新消息范围，已停止转发');
    // History may be lazily prepended after submission; only turns after this stable anchor are new.
    following = users.slice(anchor + 1);
  }
  return following.filter(node => !baseline.users.has(turnKey(node)));
}
function userText(node) {
  let body = null;
  // A selector list is in document order, not priority order. An attachment
  // label may share the generic whitespace class before the real bubble.
  const modern = node.matches('[data-chatgpt-search-unit-key$=":user"]');
  const selectors = ['[data-user-message-bubble="true"]', '[data-testid="user-message"]'];
  if (!modern) selectors.push('.whitespace-pre-wrap');
  for (const selector of selectors) {
    const matches = [...node.querySelectorAll(selector)];
    if (matches.length > 1) throw new PageSafetyError('网页用户消息正文不唯一，已停止转发');
    if (matches.length) { body = matches[0]; break; }
  }
  // A modern turn can expose action controls before the bubble mounts. Those
  // labels are not the prompt; wait for the observed message body instead.
  if (!body && modern) return '';
  // Read structure rather than connected innerText: a background renderer
  // may expose stale/empty painted text while its DOM paragraphs are complete.
  // Ignore visibility outside this body when checking identity. Read styles
  // from connected descendants (Chromium doesn't resolve styles on detached
  // clones); completion still checks the original conversation's visibility.
  const root = body || node;
  const styles = scanStyles || new WeakMap();
  const styleOf = item => {
    if (!styles.has(item)) {
      const style = item.ownerDocument.defaultView.getComputedStyle(item);
      styles.set(item, { display: style.display, visibility: style.visibility });
    }
    return styles.get(item);
  };
  const inheritedHidden = styleOf(root).visibility === 'hidden';
  const read = item => {
    if (item.nodeType === 3) return item.textContent;
    if (item.nodeType !== 1 || item.matches('button, [role="button"], script, style, svg, input, textarea')) return '';
    if (item !== root) {
      const style = styleOf(item);
      if (item.hidden || item.getAttribute('aria-hidden') === 'true' || style.display === 'none' ||
          (!inheritedHidden && style.visibility === 'hidden')) return '';
    }
    if (item.tagName === 'BR') return '\n';
    const text = [...item.childNodes].map(read).join('');
    // Rendered inline code drops its Markdown delimiters. Reconstruct only
    // single-backtick spans from CODE structure; never strip prompt syntax
    // or treat PRE/code-block content as an inline span.
    if (item.tagName === 'CODE' && !item.closest('pre, [data-code-block], .cm-content')) {
      if (!text || text.includes('`')) throw new PageSafetyError('无法严格还原网页用户消息的行内代码，已停止转发');
      return '`' + text + '`';
    }
    return ['P', 'DIV', 'LI', 'BLOCKQUOTE'].includes(item.tagName) ? text + '\n' : text;
  };
  return normalizeText(read(root));
}
function sameModernTurn(user, assistant) {
  const userTurn = user.closest('[data-turn-key]');
  const assistantTurn = assistant.closest('[data-turn-key]');
  return userTurn || assistantTurn ? userTurn === assistantTurn : true;
}
function completedMessage(message) {
  const available = button => visible(button) && !unavailableControl(button);
  const modern = message.closest('[data-turn-key]');
  if (modern) {
    if (modernState(modern) !== 'complete') return false;
    const labels = new Set(['复制', 'Copy']);
    if (generatedMessages(modern).length) { labels.add('复制图像'); labels.add('Copy image'); }
    const buttons = [...modern.querySelectorAll('.turn-action-controls button, [data-testid="turn-action-controls"] button')];
    return buttons.some(button => available(button) && labels.has(button.getAttribute('aria-label')) && button.closest('[data-turn-key]') === modern && Boolean(message.compareDocumentPosition(button) & 4));
  }
  const article = message.closest('article[data-testid^="conversation-turn-"], [data-testid^="conversation-turn-"]');
  return [...article?.querySelectorAll('[data-testid="copy-turn-action-button"]') || []].some(available);
}
export function findSubmittedUser(doc, baseline, prompt) {
  const users = newUsers(doc, baseline);
  if (users.length > 1) throw new PageSafetyError('检测到其他新消息，已停止转发，避免混淆回复');
  if (!users.length) return null;
  const text = userText(users[0]);
  const expected = normalizeText(prompt);
  // The new identity may mount with empty text or an initial chunk. Only an
  // unconfirmed strict prefix may wait within the original confirmation
  // deadline. It never claims the turn or authorizes its answer.
  if (!baseline.submittedUser && text !== expected && expected.startsWith(text)) return null;
  if (text !== expected) throw new PageSafetyError('新增网页消息与本次群消息不同，已停止转发');
  const key = turnKey(users[0]);
  if (baseline.submittedUser && (baseline.submittedUser.key !== key || baseline.submittedUser.prompt !== text)) throw new PageSafetyError('已确认的网页消息内容被替换，已停止转发');
  baseline.submittedUser = { key, prompt: text };
  return users[0];
}
export function submissionWaitReason(doc, baseline, prompt) {
  const users = newUsers(doc, baseline);
  if (!users.length) return 'ChatGPT 尚未出现可识别的新提问';
  if (users.length !== 1) return 'ChatGPT 出现多个新提问';
  // Fixed labels and lengths only; never expose group/chat text in diagnostics.
  return `ChatGPT 提问正文尚未完整（已识别 ${userText(users[0]).length}/${normalizeText(prompt).length} 字符）`;
}
const REASONING = 'details, [data-channel="analysis"], [data-message-channel="analysis"], [data-testid*="thought"], [data-testid*="reasoning"], [data-testid*="thinking"], [data-role="analysis"], [data-chatgpt-search-unit-key$=":analysis"], [data-content-search-unit-key$=":analysis"], [data-markdown-text-style="reasoning"], [aria-hidden="true"]';
function isReasoning(node) { return Boolean(node.closest(REASONING)); }
function safeLink(href) { try { const u = new URL(href); return ['https:', 'http:', 'mailto:'].includes(u.protocol) ? href : null; } catch { return null; } }
export function markdownText(root) {
  // Extraction also accepts detached fragments; their CSS-hidden descendants still stay excluded.
  const excluded = node => !visible(node, { allowDetached: true }) || node.matches('button, script, style, svg, textarea, input, [role="button"], [aria-hidden="true"], [hidden], [data-dil-render-failed]') || isReasoning(node);
  const codeBlockSelector = '[data-code-block="true"][data-markdown-copy="code-block"]';
  const codeBlocks = [];
  let codeMarker = '\u0000BRIDGE_CODE_';
  while (root.textContent.includes(codeMarker)) codeMarker += '_';
  const plainText = (node, brNewlines = true) => {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1 || excluded(node)) return '';
    if (node.tagName === 'BR') return brNewlines ? '\n' : '';
    return [...node.childNodes].map(child => plainText(child, brNewlines)).join('');
  };
  const fencedCode = (value, language = '') => {
    const body = value.replace(/\n$/, '');
    const label = language.trim().toLowerCase();
    const lang = /^[a-z0-9_+#.-]{1,40}$/.test(label) ? label : '';
    const longest = Math.max(0, ...(body.match(/`+/g) || []).map(x => x.length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    const marker = `${codeMarker}${codeBlocks.length}\u0000`;
    codeBlocks.push(`${fence}${lang}\n${body}\n${fence}`);
    return `\n\n${marker}\n\n`;
  };
  const renderedCodeBlock = node => {
    const ownVisible = child => child.closest(codeBlockSelector) === node && !excluded(child);
    const editors = [...node.querySelectorAll('[data-editor-search-surface="true"] > .cm-editor > .cm-scroller > .cm-content[role="textbox"][data-language]')].filter(ownVisible);
    const pres = [...node.querySelectorAll('pre')].filter(ownVisible);
    const sources = [...node.querySelectorAll('[data-code-block-source="true"]')].filter(ownVisible);
    const incomplete = () => new PageSafetyError('网页代码块未完整展开或结构已变化，已停止转发不完整代码');
    if (editors.length + pres.length + sources.length !== 1) throw incomplete();
    const header = [...node.children].find(child => child.matches('[data-markdown-copy="exclude"]') && !excluded(child));
    const languageLabel = header?.querySelector('.min-w-0.flex-1.truncate');
    const language = languageLabel ? plainText(languageLabel) : '';
    if (sources.length) {
      // Observed static renderer: one CODE body with nested syntax spans,
      // without PRE or a CodeMirror editor. Preserve its literal whitespace.
      const source = sources[0]; const code = source.firstElementChild;
      if (source.children.length !== 1 || code?.tagName !== 'CODE' || excluded(code) ||
          [...source.childNodes].some(child => child.nodeType === 3 && child.textContent.trim()) ||
          [...code.querySelectorAll('*')].some(child => !child.matches('span, br') || excluded(child) || child.matches('.cm-gap, [data-code-block]'))) throw incomplete();
      return fencedCode(plainText(code), (code.className || '').match(/language-([\w+-]+)/)?.[1] || language);
    }
    if (editors.length) {
      const content = editors[0];
      const lines = [...content.children];
      // The observed editor renders one complete logical line per direct DIV.
      // A viewport gap or any other child means some source may be absent.
      if (!lines.length || lines.some(line => !line.matches('div.cm-line') || excluded(line)) ||
          [...content.childNodes].some(child => child.nodeType === 3 && child.textContent.trim())) throw incomplete();
      // BR is the placeholder for an empty CodeMirror line; the join supplies
      // its one line break. Syntax spans must not add Markdown or whitespace.
      return fencedCode(lines.map(line => plainText(line, false)).join('\n'), content.getAttribute('data-language') || language);
    }
    const code = pres[0].querySelector('code') || pres[0];
    return fencedCode(plainText(code), (code.className || '').match(/language-([\w+-]+)/)?.[1] || language);
  };
  const renderedStats = node => {
    if (!node.matches('[data-d-component="box"][data-d-direction="col"][data-d-has-border]')) return null;
    const childrenOf = element => [...element.children].filter(child => !excluded(child));
    const hasLooseText = element => [...element.childNodes].some(child => child.nodeType === 3 && child.textContent.trim());
    const textOf = element => normalizeText(plainText(element));
    const children = childrenOf(node);
    const [header, primary] = children;
    if (hasLooseText(node) || !header?.matches('[data-d-component="row"][data-d-direction="row"][data-d-justify="between"]') ||
        !primary?.matches('h1[data-d-component="title"][data-d-tabular-nums="true"]')) return null;
    const headerParts = childrenOf(header);
    if (hasLooseText(header) || headerParts.length !== 2 || !headerParts[0].matches('p[data-d-component="text"]') ||
        !headerParts[1].matches('[data-d-component="badge"]')) return null;
    const label = textOf(headerParts[0]); const status = textOf(headerParts[1]); const value = textOf(primary);
    if (!label || !status || !value) return null;
    const gridIndex = children.findIndex(child => child.matches('[data-d-component="grid"]'));
    if (gridIndex < 2 || children.slice(2, gridIndex).some(child =>
      !child.matches('[data-d-component="box"][data-d-clip="true"][data-d-has-height]') || textOf(child))) return null;
    const grid = children[gridIndex]; const metrics = childrenOf(grid);
    if (hasLooseText(grid) || !metrics.length) return null;
    const lines = [`${label}：**${value}**（${status}）`];
    for (const metric of metrics) {
      if (!metric.matches('[data-d-component="grid-item"][data-d-direction="col"]') || hasLooseText(metric)) return null;
      const parts = childrenOf(metric);
      if (parts.length !== 2 || !parts[0].matches('span[data-d-component="caption"]') ||
          !parts[1].matches('h1[data-d-component="title"], h2[data-d-component="title"], p[data-d-component="text"]')) return null;
      const name = textOf(parts[0]); const amount = textOf(parts[1]);
      if (!name || !amount) return null;
      lines.push(`${name}：**${amount}**`);
    }
    const notes = [];
    for (const child of children.slice(gridIndex + 1)) {
      if (child.matches('[data-d-component="divider"]') && !textOf(child)) continue;
      if (!child.matches('p[data-d-component="text"][data-d-size="sm"]')) return null;
      notes.push(child);
    }
    // Compact only the observed label/value card. Unknown visible children
    // fall back to normal traversal rather than being silently discarded.
    const annotation = notes.map(note => walk(note).trim()).filter(Boolean).join('\n\n');
    return '\n\n' + lines.join('\n') + (annotation ? '\n\n' + annotation : '') + '\n\n';
  };
  const walk = node => {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1) return '';
    if (excluded(node)) return '';
    const tag = node.tagName;
    // These exact wrapper and editor markers were observed in the current
    // renderer. Read only the code body, excluding its language/control header.
    if (node.matches(codeBlockSelector)) return renderedCodeBlock(node);
    const statistics = renderedStats(node);
    if (statistics !== null) return statistics;
    if (tag === 'PRE') {
      const code = node.querySelector('code') || node;
      const lang = (code.className || '').match(/language-([\w+-]+)/)?.[1] || '';
      return fencedCode(plainText(code), lang);
    }
    if (tag === 'TABLE') {
      const rows = [...node.querySelectorAll('tr')].filter(row => visible(row, { allowDetached: true }) && row.closest('table') === node);
      const cells = rows.map(row => [...row.children].filter(cell => ['TH', 'TD'].includes(cell.tagName) && visible(cell, { allowDetached: true })));
      const width = Math.max(0, ...cells.map(row => row.length));
      if (!width) return '';
      const values = cells.map(row => row.map(cell => [...cell.childNodes].map(walk).join('').trim().replace(/\|/g, '\\|').replace(/\n+/g, '<br>')));
      const header = cells[0].some(cell => cell.tagName === 'TH') ? values.shift() : [];
      const line = row => '| ' + Array.from({ length: width }, (_, index) => row[index] || '').join(' | ') + ' |';
      const caption = node.querySelector(':scope > caption');
      return '\n\n' + (caption ? walk(caption).trim() + '\n\n' : '') + [line(header), line(Array(width).fill('---')), ...values.map(line)].join('\n') + '\n\n';
    }
    if (tag === 'BR') return '\n';
    if (tag === 'HR') return '\n\n---\n\n';
    // Code block wrappers contain language names and copy controls outside <pre>.
    if (tag === 'DIV' && !node.querySelector(codeBlockSelector) && node.querySelector('pre') && !node.querySelector('p, li, h1, h2, h3, table') && node.querySelectorAll('pre').length === 1) return walk(node.querySelector('pre'));
    let body = [...node.childNodes].map(walk).join('');
    if (tag === 'A') { const href = safeLink(node.getAttribute('href')); return href && normalizeText(body) ? `[${body}](${href})` : body; }
    if (tag === 'CODE') return '`' + body + '`';
    if (body && !['STRONG', 'B'].includes(tag) && node.matches('[data-d-default-strong]:not([data-d-default-strong="false"])')) body = `**${body}**`;
    if (tag === 'STRONG' || tag === 'B') return body ? `**${body}**` : '';
    if (tag === 'EM' || tag === 'I') return body ? `*${body}*` : '';
    if (/^H[1-6]$/.test(tag)) return '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + body + '\n\n';
    if (tag === 'LI') return '\n- ' + body.trim();
    if (tag === 'BLOCKQUOTE') return '\n\n' + body.trim().split('\n').map(x => '> ' + x).join('\n') + '\n\n';
    if (tag === 'TD' || tag === 'TH') return body.trim() + ' | ';
    if (tag === 'TR') return '\n| ' + body;
    if (['P', 'DIV', 'SECTION', 'UL', 'OL', 'TABLE'].includes(tag)) return '\n\n' + body + '\n\n';
    return body;
  };
  // Normalize prose separately so code keeps significant spaces and consecutive blank lines.
  let result = walk(root).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  codeBlocks.forEach((block, index) => { result = result.replace(`${codeMarker}${index}\u0000`, () => block); });
  return result;
}

export const MAX_IMAGE_BYTES = 10_000_000;
export const MAX_TOTAL_IMAGE_BYTES = 30_000_000;
export const MAX_IMAGES = 4;
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export function validateInputImages(value = []) {
  if (!Array.isArray(value) || value.length > MAX_IMAGES) throw new PageSafetyError('输入图片数量无效，最多支持 4 张图片');
  const ids = new Set(); let total = 0;
  const images = value.map(image => {
    if (!image || typeof image.id !== 'string' || !/^[a-f0-9]{64}$/.test(image.id) || ids.has(image.id) || !IMAGE_MIMES.has(image.mimeType) || !Number.isInteger(image.bytes) || image.bytes < 1 || image.bytes > MAX_IMAGE_BYTES || typeof image.name !== 'string' || !image.name.trim() || image.name.length > 180 || /[\x00-\x1f\x7f/\\]/.test(image.name)) throw new PageSafetyError('输入图片信息无效，已停止发送');
    ids.add(image.id); total += image.bytes;
    return { id: image.id, mimeType: image.mimeType, name: image.name, bytes: image.bytes };
  });
  if (total > MAX_TOTAL_IMAGE_BYTES) throw new PageSafetyError('输入图片合计超过 30 MB');
  return images;
}

const REMOVE_ATTACHMENT = 'button[aria-label*="Remove file"], button[aria-label*="Remove attachment"], button[aria-label*="移除附件"], button[aria-label*="删除文件"], button[aria-label*="移除文件"]';

// Only accept visibly named, removable attachments created by this run. Unknown preview
// layouts remain pending and eventually fail; they never enable a text-only submission.
export function inputAttachmentState(input, names) {
  const scope = composerScope(input);
  if (!scope || new Set(names).size !== names.length) throw new PageSafetyError('无法确认本次图片附件');
  if (!names.length) return { ready: !hasAttachments(input) };
  const regions = [...scope.querySelectorAll('[data-composer-attachments], [data-testid*="attachment-preview"], [data-testid*="file-chip"], [data-testid*="upload-preview"], [data-testid*="file-thumbnail"], [data-testid="file-upload"]')].filter(visible);
  if (!regions.length) return { ready: false };
  if (regions.some(region => [...region.querySelectorAll('[role="alert"]')].some(visible))) throw new PageSafetyError('网页报告图片上传失败，已停止发送');
  if ([...scope.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].some(visible)) return { ready: false };
  const markers = node => new Set([node, ...node.querySelectorAll('*')].filter(visible).flatMap(element => names.filter(name =>
    ['alt', 'title', 'aria-label'].some(attribute => element.getAttribute(attribute) === name) ||
    (!element.childElementCount && normalizeText(element.textContent) === name))));
  const namedRemoveLabels = new Set(names.flatMap(name => [`移除“${name}”`, `移除"${name}"`, `Remove “${name}”`, `Remove "${name}"`]));
  const removersIn = node => [...node.querySelectorAll('button')].filter(button => visible(button) && (button.matches(REMOVE_ATTACHMENT) || namedRemoveLabels.has(button.getAttribute('aria-label'))));
  const removers = removersIn(scope);
  if (removers.length !== names.length) return { ready: false };
  const matched = new Map(); const wrappers = [];
  for (const remover of removers) {
    let wrapper = remover.parentElement; let found = null;
    while (wrapper && wrapper !== scope) {
      const foundNames = markers(wrapper);
      if (foundNames.size === 1 && removersIn(wrapper).length === 1 && regions.some(region => region.contains(wrapper) || wrapper === region)) { found = [...foundNames][0]; break; }
      wrapper = wrapper.parentElement;
    }
    if (!found || matched.has(found)) return { ready: false };
    matched.set(found, wrapper); wrappers.push(wrapper);
  }
  if (matched.size !== names.length) return { ready: false };
  if (regions.some(region => [...region.children].filter(node => visible(node) && (node.childElementCount || normalizeText(node.textContent))).some(node => !wrappers.some(wrapper => wrapper.contains(node) || node.contains(wrapper))))) return { ready: false };
  // An extra preview, image or native-file selection must not hitchhike on this request.
  const previews = [...scope.querySelectorAll('img, .composer-attachment-surface[role="button"], [data-testid*="attachment-preview"], [data-testid*="file-chip"], [data-testid*="upload-preview"], [data-testid*="file-thumbnail"]')].filter(visible);
  if (previews.some(node => !wrappers.some(wrapper => wrapper.contains(node) || node.contains(wrapper)))) return { ready: false };
  for (const field of scope.querySelectorAll('input[type="file"]')) {
    if ([...(field.files || [])].some(file => !names.includes(file.name))) return { ready: false };
  }
  if (previews.some(node => node.tagName === 'IMG' && !node.closest('button') && (!node.complete || !node.naturalWidth || !node.naturalHeight))) return { ready: false };
  if (wrappers.some(wrapper => [...wrapper.querySelectorAll('img')].filter(node => visible(node) && !node.closest('button')).length > 1)) return { ready: false };
  return { ready: true };
}

export function pasteInputImage(doc, input, { mimeType, base64 }, name) {
  if (composer(doc) !== input || typeof name !== 'string' || !/^[A-Za-z0-9._-]{1,150}$/.test(name)) throw new PageSafetyError('无法确认图片输入目标');
  const bytes = decodeImagePayload(mimeType, base64);
  const win = doc.defaultView;
  if (typeof win.DataTransfer !== 'function' || typeof win.ClipboardEvent !== 'function') throw new PageSafetyError('当前浏览器不支持正常图片粘贴，已停止发送');
  const transfer = new win.DataTransfer();
  transfer.items.add(new win.File([bytes], name, { type: mimeType }));
  input.focus();
  input.dispatchEvent(new win.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
}

export function answerImageSource(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'blob:' && url.origin === 'https://chatgpt.com') return url.href;
    if (url.protocol === 'https:' && !url.port && !url.username && !url.password &&
      (url.hostname === 'chatgpt.com' || url.hostname.endsWith('.oaiusercontent.com'))) return url.href;
  } catch {}
  throw new PageSafetyError('本次回复图片的来源不受支持，未读取或转发图片');
}

function externalAnswerImageSource(value) {
  try {
    const url = new URL(value);
    if (['https:', 'http:'].includes(url.protocol) && !url.port && !url.username && !url.password &&
      url.hostname !== 'chatgpt.com' && !url.hostname.endsWith('.oaiusercontent.com')) return url.href;
  } catch {}
  return null;
}

function checkImageBytes(mimeType, bytes) {
  if (!IMAGE_MIMES.has(mimeType)) throw new PageSafetyError('图片格式不支持，仅支持 PNG、JPEG 和 WebP');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new PageSafetyError('单张图片为空或超过 10 MB，请在网页查看原图');
  const match = expected => expected.every((value, index) => bytes[index] === value);
  const valid = mimeType === 'image/png' ? match([137, 80, 78, 71, 13, 10, 26, 10]) :
    mimeType === 'image/jpeg' ? match([255, 216, 255]) :
      match([82, 73, 70, 70]) && [87, 69, 66, 80].every((value, index) => bytes[index + 8] === value);
  if (!valid) throw new PageSafetyError('图片内容与声明格式不一致，已停止转发');
}

export function decodeImagePayload(mimeType, base64) {
  if (typeof base64 !== 'string' || !base64 || base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new PageSafetyError('图片数据无效或超过 10 MB');
  let binary;
  try { binary = atob(base64); if (btoa(binary) !== base64) throw new Error(); }
  catch { throw new PageSafetyError('图片编码无效，已停止转发'); }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  checkImageBytes(mimeType, bytes);
  return bytes;
}

export async function readAnswerImage(image, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const source = answerImageSource(image.src);
  const controller = new AbortController();
  let reader; let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reader?.cancel().catch(() => {});
      reject(new PageSafetyError('读取本次回复图片超时，请在网页检查图片后重新提问'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await fetchImpl(source, { signal: controller.signal, credentials: new URL(source).origin === 'https://chatgpt.com' ? 'same-origin' : 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' });
      if (!response.ok || !response.body?.getReader) throw new PageSafetyError('无法读取本次回复图片，请在网页确认图片可以打开');
      const mimeType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!IMAGE_MIMES.has(mimeType)) throw new PageSafetyError('图片格式不支持，仅支持 PNG、JPEG 和 WebP');
      if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) throw new PageSafetyError('单张图片超过 10 MB，请在网页查看原图');
      reader = response.body.getReader();
      const chunks = []; let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_IMAGE_BYTES) throw new PageSafetyError('单张图片超过 10 MB，请在网页查看原图');
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      checkImageBytes(mimeType, bytes);
      let binary = '';
      for (let start = 0; start < bytes.length; start += 32768) binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
      return { mimeType, base64: btoa(binary), byteLength: bytes.length };
    })()]);
  } catch (error) {
    if (error instanceof PageSafetyError) throw error;
    throw new PageSafetyError('无法读取本次回复图片，可能是图片访问受限或连接中断；未转发空图片');
  } finally {
    clearTimeout(timer);
    controller.abort();
    reader?.cancel().catch(() => {});
  }
}

function answerImages(message, baseline) {
  if ([...message.querySelectorAll('canvas')].some(node => visible(node) && !isReasoning(node))) throw new PageSafetyError('本次回复包含无法直接读取的画布图片，请在网页查看');
  const images = []; const seen = new Set(); const externalSources = new Set();
  for (const image of message.querySelectorAll('img')) {
    // Citation favicons belong to source badges, not the assistant's image
    // output. Exclude this observed component before waiting for its load or
    // validating its external source; neither may block the answer text.
    if (!visible(image) || isReasoning(image) || image.closest('[data-d-component="favicon"], [data-testid="avatar"], [data-testid="icon"], .avatar, .turn-action-controls, [data-testid="turn-action-controls"]')) continue;
    const source = image.currentSrc || image.src;
    if (baseline.imageSources?.has(source)) continue;
    let src;
    try { src = answerImageSource(source); }
    catch (error) {
      // Web search illustrations are not downloadable through this bridge.
      // Their loading state must not hold an otherwise complete answer open.
      const external = externalAnswerImageSource(source);
      if (!external) throw error;
      externalSources.add(external);
      continue;
    }
    const width = image.naturalWidth; const height = image.naturalHeight;
    if (!image.complete) return null;
    if (!width || !height) throw new PageSafetyError('本次回复图片尚未正常加载，未转发空图片');
    if (seen.has(src)) continue;
    seen.add(src); images.push({ src, width, height });
    if (images.length > MAX_IMAGES) throw new PageSafetyError('本次回复超过 4 张图片，请在网页查看完整结果');
  }
  return { images, externalSources };
}

function composeFinalCandidate(candidates, images) {
  const text = candidates.map(candidate => candidate.text).filter(Boolean);
  const externalCount = new Set(candidates.flatMap(candidate => [...candidate.externalSources])).size;
  if (externalCount) text.push(`提示：本次回复有 ${externalCount} 张外部来源图片未转发，请在 ChatGPT 网页查看。`);
  return { message: candidates.at(-1).message, text: text.join('\n\n'), images };
}

export function finalCandidate(doc, baseline, user) {
  const previousStyles = scanStyles;
  scanStyles = new WeakMap();
  try { return scanFinalCandidate(doc, baseline, user); }
  finally { scanStyles = previousStyles; }
}

function scanFinalCandidate(doc, baseline, user) {
  const users = newUsers(doc, baseline);
  if (users.length !== 1 || turnKey(users[0]) !== turnKey(user)) throw new PageSafetyError('对话出现其他消息或内容被替换，停止转发');
  const submitted = baseline.submittedUser;
  // Keep the text matched at submission rather than rereading the mutable
  // reference as our baseline. A framework may replace that node with the
  // same ID; the current node must still contain the exact owned prompt.
  if (!submitted || submitted.key !== turnKey(users[0]) || userText(users[0]) !== submitted.prompt ||
      (user !== users[0] && user.isConnected && userText(user) !== submitted.prompt)) throw new PageSafetyError('已确认的网页消息内容被替换，已停止转发');
  user = users[0];
  assertNoChallenge(doc, user);
  const following = turns(doc, 'assistant').filter(n => !baseline.assistants.has(turnKey(n)) && Boolean(user.compareDocumentPosition(n) & 4) && sameModernTurn(user, n) && !isReasoning(n));
  // Scope failure detection to this submitted user turn, never to historical replies.
  if (following.some(message => [...message.querySelectorAll('[data-dil-render-failed]')].some(visible))) throw new PageSafetyError('网页回复加载失败，请在 ChatGPT 网页处理；本次不会重新提问');
  if (generating(doc)) return null;
  const candidates = [];
  for (const message of following) {
    if (!completedMessage(message)) continue;
    const selector = message.closest('[data-turn-key]') ? '[data-markdown-text-style="assistant-message"]' : '.markdown';
    const blocks = [...message.querySelectorAll(selector)].filter(n => visible(n) && !isReasoning(n) && !n.parentElement?.closest(selector));
    if (blocks.length > 1) continue;
    const media = answerImages(message, baseline);
    if (media === null) return null;
    const text = blocks.length ? markdownText(blocks[0]) : '';
    if (text || media.images.length || media.externalSources.size) candidates.push({ message, text, ...media });
  }
  if (candidates.length === 1) return composeFinalCandidate(candidates, candidates[0].images);
  // The observed image renderer emits a separate stable message container,
  // sometimes next to explicitly marked answer text in the same complete turn.
  // Normalize only that evidenced layout; ordinary multiple answers stay ambiguous.
  const modern = user.closest('[data-turn-key]');
  const galleries = modern ? generatedMessages(modern) : [];
  const hasGallery = candidate => galleries.some(message => candidate.message === message || candidate.message.contains(message));
  if (!modern || candidates.length < 2 || candidates.length !== following.length || !candidates.some(hasGallery) ||
      !candidates.every(candidate => candidate.message.closest('[data-turn-key]') === modern &&
        Boolean(candidate.message.getAttribute('data-chatgpt-search-message-ids')?.trim() || candidate.message.getAttribute('data-message-id')) &&
        (hasGallery(candidate) || (candidate.text && !candidate.images.length)))) return null;
  const images = [...new Map(candidates.flatMap(candidate => candidate.images).map(image => [image.src, image])).values()];
  if (images.length > MAX_IMAGES) throw new PageSafetyError('本次回复超过 4 张图片，请在网页查看完整结果');
  return composeFinalCandidate(candidates, images);
}
export function sendButton(doc, input) {
  assertModelAvailable(doc);
  if (!input.isConnected || unavailableControl(input) || input.readOnly) return null;
  const scope = composerScope(input);
  if (!scope) throw new PageSafetyError('无法确认输入框所属发送区');
  const buttons = [...scope.querySelectorAll(SEND)].filter(visible);
  if (buttons.length !== 1 || unavailableControl(buttons[0])) return null;
  return buttons[0];
}
export function insertPrompt(doc, input, prompt) {
  if (!input.isConnected || unavailableControl(input) || input.readOnly) throw new PageSafetyError('网页输入框当前不可用，已停止写入');
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
