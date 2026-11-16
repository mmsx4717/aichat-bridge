import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import * as dom from '../extension/gemini-dom.js';

const fixture = await readFile(new URL('./fixtures/gemini-conversation.html', import.meta.url), 'utf8');
const clipboardAttachment = await readFile(new URL('./fixtures/gemini-clipboard-attachment.html', import.meta.url), 'utf8');
const generatedImage = await readFile(new URL('./fixtures/gemini-generated-image.html', import.meta.url), 'utf8');
const pendingRequest = await readFile(new URL('./fixtures/gemini-pending-request.html', import.meta.url), 'utf8');
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
function page() { return new JSDOM(fixture, { url: 'https://gemini.google.com/app/1111111111111111' }).window.document; }
function user(text = 'Question', id = '0000000000000002') { return `<div class="conversation-container message-actions-hover-boundary"${id ? ` id="${id}"` : ''}><user-query><user-query-content><h5 class="cdk-visually-hidden screen-reader-user-query-label">${text}</h5><div class="query-text"><p class="query-text-line">${text}</p></div></user-query-content></user-query></div>`; }
function answer(body = '<p>Final answer</p>', { busy = 'false', complete = true, actions = true } = {}) {
  return `<model-response><response-container><div class="response-content"><model-response-content><structured-content-container><thinking-overlay><div>PRIVATE THOUGHT</div></thinking-overlay><message-content><div class="markdown markdown-main-panel" aria-busy="${busy}">${body}</div></message-content></structured-content-container></model-response-content><div class="response-footer${complete ? ' complete' : ''}"></div></div></response-container>${actions ? '<response-container-footer><message-actions><copy-button><button>Copy</button></copy-button><regenerate-button><div data-test-id="regenerate-button"><button>Retry</button></div></regenerate-button></message-actions></response-container-footer>' : ''}</model-response>`;
}
function addUser(doc, html = user()) { doc.querySelector('main').insertAdjacentHTML('beforeend', html); return doc.querySelector('main').lastElementChild; }
function addAnswer(doc, html = answer()) { doc.querySelector('main').lastElementChild.insertAdjacentHTML('beforeend', html); return dom.turns(doc, 'assistant').at(-1); }
function submitted(doc) { const baseline = dom.snapshot(doc); addUser(doc); return { baseline, user: dom.findSubmittedUser(doc, baseline, 'Question') }; }
const candidate = (doc, state) => dom.finalCandidate(doc, state.baseline, state.user);
function loaded(image, state = {}) { Object.defineProperties(image, Object.fromEntries(Object.entries({ complete: true, naturalWidth: 640, naturalHeight: 480, ...state }).map(([key, value]) => [key, { configurable: true, value }]))); }

test('Gemini uses only the observed Quill editor and scoped native submit button', () => {
  const doc = page(); const input = dom.assertReady(doc);
  assert.equal(input.className, 'ql-editor'); assert.notEqual(input, doc.querySelector('.ql-clipboard'));
  doc.body.insertAdjacentHTML('beforeend', '<div data-test-id="send-button-container"><gem-icon-button class="send-button submit"><button>Unrelated</button></gem-icon-button></div>');
  assert.equal(dom.sendButton(doc, input).getAttribute('aria-label'), '傳送訊息');
  assert.equal(dom.composerInteraction(dom.sendButton(doc, input), input), true);
  input.textContent = 'Private draft'; assert.throws(() => dom.assertReady(doc), /草稿/);
  assert.throws(() => dom.insertPrompt(doc, input, 'overwrite'), /草稿/); assert.equal(input.textContent, 'Private draft');
});

test('Gemini distinguishes a temporarily absent editor from multiple visible editors without relaxing hidden-copy checks', () => {
  const doc = page(); const input = dom.composer(doc);
  input.hidden = true;
  assert.throws(() => dom.composer(doc), { name: 'PageSafetyError', message: '暂未找到 Gemini 输入框，等待网页加载' });
  input.hidden = false; const duplicate = input.cloneNode(true); input.after(duplicate);
  assert.throws(() => dom.composer(doc), { name: 'PageSafetyError', message: '检测到多个可见的 Gemini 输入框，暂不自动操作' });
  duplicate.hidden = true;
  assert.throws(() => dom.composer(doc), /输入区结构已变化/);
  duplicate.remove(); assert.equal(dom.composer(doc), input);
  doc.body.insertAdjacentHTML('beforeend', '<div id="challenge-running"></div>');
  assert.throws(() => dom.assertReady(doc), /网页正在验证，请先手动完成验证/);
});

test('Gemini refuses duplicate editors, invalid boundaries, blocked inputs and verification pages', () => {
  const changes = [
    doc => dom.composer(doc).insertAdjacentHTML('afterend', '<div class="ql-editor" contenteditable="true" role="textbox"></div>'),
    doc => doc.querySelector('fieldset').className = 'unknown',
    doc => dom.composer(doc).setAttribute('aria-disabled', 'true'),
    doc => doc.querySelector('input-area-v2').setAttribute('inert', ''),
    doc => doc.body.insertAdjacentHTML('beforeend', '<iframe src="https://example.com/recaptcha"></iframe>'),
    doc => doc.querySelector('input-area-v2').insertAdjacentHTML('beforeend', user('Unexpected', '0000000000000003')),
  ];
  for (const change of changes) { const doc = page(); change(doc); assert.throws(() => dom.assertReady(doc), { name: 'PageSafetyError' }); }
});

test('Gemini disabled parent submit control and stop control cannot submit another prompt', () => {
  const doc = page(); const input = dom.composer(doc); const control = dom.sendButton(doc, input).parentElement;
  control.setAttribute('aria-disabled', 'true'); assert.equal(dom.sendButton(doc, input), null);
  control.setAttribute('aria-disabled', 'false'); control.classList.replace('submit', 'stop');
  assert.equal(dom.generating(doc), true); assert.equal(dom.sendButton(doc, input), null);
  assert.throws(() => dom.assertReady(doc), /正在生成/);
});

test('Gemini inherited disabled fieldsets cannot authorize submit or completion controls', () => {
  const doc = page(); const input = dom.composer(doc); const button = dom.sendButton(doc, input);
  let clicks = 0; button.addEventListener('click', () => { clicks++; });
  const fieldset = button.closest('fieldset'); fieldset.disabled = true;
  assert.equal(button.disabled, false); assert.equal(button.matches(':disabled'), true);
  button.click(); assert.equal(clicks, 0); assert.equal(dom.sendButton(doc, input), null);
  fieldset.disabled = false;
  const state = submitted(doc); const message = addAnswer(doc); const controls = message.querySelector('message-actions');
  const disabledControls = doc.createElement('fieldset'); disabledControls.disabled = true;
  controls.before(disabledControls); disabledControls.append(controls);
  assert.equal(candidate(doc, state), null);
  disabledControls.disabled = false; assert.equal(candidate(doc, state).text, 'Final answer');
});

test('Gemini completion extracts only public output of the submitted shared turn', () => {
  const doc = page(); const state = submitted(doc);
  addAnswer(doc, answer('<h2>Answer</h2><p><strong>Done</strong> <a href="https://example.com">reference</a>.</p><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>'));
  const result = candidate(doc, state);
  assert.match(result.text, /## Answer/); assert.match(result.text, /\*\*Done\*\*/);
  assert.match(result.text, /\[reference\]\(https:\/\/example.com\)/); assert.match(result.text, /\| A \| B \|\n\| --- \| --- \|\n\| 1 \| 2 \|/);
  assert.doesNotMatch(result.text, /Earlier|PRIVATE|Copy|Retry/); assert.deepEqual(result.images, []);
});

test('Gemini response code uses its displayed language and preserves significant whitespace', () => {
  const doc = page(); const state = submitted(doc);
  addAnswer(doc, answer('<p>Example:</p><response-element><code-block><div class="code-block"><div class="formatted-code-block-internal-container"><div class="animated-opacity"><div class="code-block-decoration header-formatted"><span>Python</span><button>Download</button><button>Copy</button></div><pre><code role="text" data-test-id="code-content">if True:\n    print("hello")\n\n\n    print("world")\n</code></pre></div></div></div></code-block></response-element>'));
  assert.equal(candidate(doc, state).text, 'Example:\n\n```python\nif True:\n    print("hello")\n\n\n    print("world")\n```');
  doc.querySelector('main').lastElementChild.querySelector('[data-test-id="code-content"]').remove();
  assert.throws(() => candidate(doc, state), /代码块结构/);
});

test('Gemini excludes hidden and nested thought content using the live ancestor visibility', () => {
  const doc = page(); const state = submitted(doc);
  doc.head.insertAdjacentHTML('beforeend', '<style>model-response-content .private-helper { display: none; }</style>');
  addAnswer(doc, answer('<p>Public<span class="private-helper">PRIVATE HIDDEN</span></p><thinking-overlay>PRIVATE NESTED</thinking-overlay>'));
  assert.equal(candidate(doc, state).text, 'Public');
});

test('Gemini waits for a stable new turn id and does not compare duplicate accessibility labels', () => {
  const doc = page(); const baseline = dom.snapshot(doc); const row = addUser(doc, user('Question', ''));
  assert.equal(dom.findSubmittedUser(doc, baseline, 'Question'), null);
  row.id = '0000000000000002';
  const current = dom.findSubmittedUser(doc, baseline, 'Question'); assert.equal(current, row.querySelector('user-query'));
  addAnswer(doc); assert.equal(dom.finalCandidate(doc, baseline, current).text, 'Final answer');
});

test('Gemini durable empty user text waits for hydration without confirming or hiding mismatches', () => {
  const doc = page(); const baseline = dom.snapshot(doc); const row = addUser(doc, user(''));
  assert.equal(dom.findSubmittedUser(doc, baseline, 'Question'), null);
  assert.equal(baseline.submittedText, undefined); assert.equal(baseline.submittedKey, undefined);
  row.querySelector('.query-text').innerHTML = '<p>Question</p>';
  assert.equal(dom.findSubmittedUser(doc, baseline, 'Question'), row.querySelector('user-query'));
  row.querySelector('.query-text').textContent = 'Other';
  assert.throws(() => dom.findSubmittedUser(doc, baseline, 'Question'), /不同/);
});

function pendingPage() {
  const doc = page(); const main = doc.querySelector('main');
  const history = doc.createElement('infinite-scroller'); history.setAttribute('data-test-id', 'chat-history-container');
  history.append(...main.childNodes); main.append(history);
  return { doc, history, baseline: dom.snapshot(doc) };
}
function addPending(history) {
  history.insertAdjacentHTML('beforeend', pendingRequest);
  return history.querySelector('pending-request');
}
function replacePending(doc, pending, { text = 'Question', id = '0000000000000002' } = {}) {
  const holder = doc.createElement('div'); holder.innerHTML = user(text, id);
  const row = holder.firstElementChild; row.insertAdjacentHTML('beforeend', answer());
  pending.replaceWith(row); return row;
}

test('observed Gemini pending-request waits without gaining a durable answer identity, then confirms its replacement', () => {
  const { doc, history, baseline } = pendingPage(); const pending = addPending(history);
  assert.equal(dom.findSubmittedUser(doc, baseline, 'Question'), null);
  assert.equal(dom.submittedUserPending(doc, baseline, 'Question'), true);
  assert.equal(baseline.submittedKey, undefined);
  assert.throws(() => dom.finalCandidate(doc, baseline, pending.querySelector('user-query')), /其他消息|内容被替换/);
  // A pending user blocks the next lease even if the Stop control has not
  // appeared yet. Completion is not inferred from the previous answer.
  assert.equal(dom.generating(doc), false);
  assert.throws(() => dom.assertReady(doc), /尚未明确完成/);
  const row = replacePending(doc, pending);
  const current = dom.findSubmittedUser(doc, baseline, 'Question');
  assert.equal(current, row.querySelector('user-query'));
  assert.equal(dom.submittedUserPending(doc, baseline, 'Question'), false);
  assert.equal(dom.finalCandidate(doc, baseline, current).text, 'Final answer');
});

test('Gemini pending recognition never widens the durable DIV row selector or accepts unknown shells', () => {
  for (const change of [
    pending => { const replacement = pending.ownerDocument.createElement('div'); replacement.className = pending.className; replacement.setAttribute('scrollanchor', ''); replacement.innerHTML = pending.innerHTML; pending.replaceWith(replacement); },
    pending => pending.classList.remove('conversation-container'),
    pending => pending.removeAttribute('scrollanchor'),
    pending => pending.id = 'unexpected-id',
    pending => { const wrapper = pending.ownerDocument.createElement('div'); pending.firstElementChild.before(wrapper); wrapper.append(pending.querySelector('user-query')); },
    pending => pending.insertAdjacentHTML('beforeend', answer()),
    pending => pending.insertAdjacentHTML('beforeend', '<pending-request></pending-request>'),
    pending => pending.insertAdjacentHTML('beforeend', '<div class="conversation-container message-actions-hover-boundary"></div>'),
    pending => pending.parentElement.removeAttribute('data-test-id'),
  ]) {
    const { doc, history, baseline } = pendingPage(); const pending = addPending(history); change(pending);
    assert.equal(dom.submittedUserPending(doc, baseline, 'Question'), false);
    assert.throws(() => dom.findSubmittedUser(doc, baseline, 'Question'), /新消息结构已变化/);
  }
});

test('Gemini exact pending ownership does not depend on mounting or displaying loading indicators', () => {
  for (const change of [
    pending => pending.querySelector('thinking-dots-animation').remove(),
    pending => pending.querySelector('pending-response').remove(),
    pending => { for (const indicator of pending.querySelectorAll('thinking-dots-animation, pending-response')) indicator.remove(); },
    pending => { for (const indicator of pending.querySelectorAll('thinking-dots-animation, pending-response')) indicator.hidden = true; },
  ]) {
    const { doc, history, baseline } = pendingPage(); const pending = addPending(history); change(pending);
    assert.equal(dom.findSubmittedUser(doc, baseline, 'Question'), null);
    assert.equal(dom.submittedUserPending(doc, baseline, 'Question'), true);
    assert.equal(baseline.submittedKey, undefined);
    assert.throws(() => dom.finalCandidate(doc, baseline, pending.querySelector('user-query')), /其他消息|内容被替换/);
    const row = replacePending(doc, pending);
    const current = dom.findSubmittedUser(doc, baseline, 'Question');
    assert.equal(current, row.querySelector('user-query'));
    assert.equal(dom.finalCandidate(doc, baseline, current).text, 'Final answer');
  }
});

test('known Gemini loading shells wait without extended pending permission until exact visible text is ready', () => {
  for (const state of ['missing-text', 'missing-content', 'empty-text', 'hidden-text', 'hidden-user', 'hidden-shell']) {
    const { doc, history, baseline } = pendingPage(); const pending = addPending(history);
    for (const indicator of pending.querySelectorAll('thinking-dots-animation, pending-response')) indicator.remove();
    const currentUser = pending.querySelector('user-query');
    const body = pending.querySelector('.query-text'); const content = pending.querySelector('user-query-content');
    const originalParent = state === 'missing-content' ? content.parentElement : body.parentElement;
    if (state === 'missing-text') body.remove();
    if (state === 'missing-content') content.remove();
    if (state === 'empty-text') body.querySelector('.query-text-line').textContent = ' \n ';
    if (state === 'hidden-text') body.hidden = true;
    if (state === 'hidden-user') currentUser.hidden = true;
    if (state === 'hidden-shell') pending.hidden = true;
    assert.equal(dom.findSubmittedUser(doc, baseline, 'Question'), null, state);
    assert.equal(dom.submittedUserPending(doc, baseline, 'Question'), false, state);
    assert.equal(baseline.submittedKey, undefined, state);
    if (state === 'missing-text') originalParent.append(body);
    if (state === 'missing-content') originalParent.append(content);
    if (state === 'empty-text') body.querySelector('.query-text-line').textContent = 'Question';
    body.hidden = false; currentUser.hidden = false; pending.hidden = false;
    assert.equal(dom.findSubmittedUser(doc, baseline, 'Question'), null, state);
    assert.equal(dom.submittedUserPending(doc, baseline, 'Question'), true, state);
    const row = replacePending(doc, pending);
    const current = dom.findSubmittedUser(doc, baseline, 'Question');
    assert.equal(current, row.querySelector('user-query'), state);
    assert.equal(dom.finalCandidate(doc, baseline, current).text, 'Final answer', state);
  }
});

test('Gemini rejects multiple pending query text bodies and wrong nonempty text even while hidden', () => {
  for (const nested of [false, true]) {
    const { doc, history, baseline } = pendingPage(); const pending = addPending(history);
    const body = pending.querySelector('.query-text'); const duplicate = body.cloneNode(true); duplicate.hidden = true;
    if (nested) body.append(duplicate); else body.after(duplicate);
    assert.throws(() => dom.findSubmittedUser(doc, baseline, 'Question'), /用户消息结构已变化/);
    assert.throws(() => dom.submittedUserPending(doc, baseline, 'Question'), /用户消息结构已变化/);
  }
  const { doc, history, baseline } = pendingPage(); const pending = addPending(history);
  pending.querySelector('.query-text-line').textContent = 'Different question'; pending.hidden = true;
  assert.throws(() => dom.findSubmittedUser(doc, baseline, 'Question'), /本次群消息不同/);
  assert.throws(() => dom.submittedUserPending(doc, baseline, 'Question'), /本次群消息不同/);
});

test('Gemini pending message requires an exact prompt and one new user including hidden duplicates', () => {
  {
    const { doc, history, baseline } = pendingPage(); const pending = addPending(history);
    pending.querySelector('.query-text-line').textContent = 'Different question';
    assert.throws(() => dom.findSubmittedUser(doc, baseline, 'Question'), /本次群消息不同/);
    assert.throws(() => dom.submittedUserPending(doc, baseline, 'Question'), /本次群消息不同/);
  }
  for (const extra of [pendingRequest, user('Another user', '0000000000000003')]) {
    const { doc, history, baseline } = pendingPage(); addPending(history);
    history.insertAdjacentHTML('beforeend', extra); history.lastElementChild.hidden = true;
    assert.throws(() => dom.findSubmittedUser(doc, baseline, 'Question'), /其他新消息/);
    assert.throws(() => dom.submittedUserPending(doc, baseline, 'Question'), /其他新消息/);
  }
});

test('a verified Gemini pending request cannot be replaced with another pending request or user', () => {
  for (const replace of [pending => pending.replaceWith(pending.cloneNode(true)), pending => { const current = pending.querySelector('user-query'); current.replaceWith(current.cloneNode(true)); }]) {
    const { doc, history, baseline } = pendingPage(); const pending = addPending(history);
    assert.equal(dom.submittedUserPending(doc, baseline, 'Question'), true); replace(pending);
    assert.throws(() => dom.findSubmittedUser(doc, baseline, 'Question'), /待处理消息被替换/);
    assert.throws(() => dom.submittedUserPending(doc, baseline, 'Question'), /待处理消息被替换/);
  }
});

test('an incomplete Gemini loading shell retains identity before it can authorize an extended wait', () => {
  for (const replace of [pending => pending.replaceWith(pending.cloneNode(true)), pending => { const current = pending.querySelector('user-query'); current.replaceWith(current.cloneNode(true)); }]) {
    const { doc, history, baseline } = pendingPage(); const pending = addPending(history);
    pending.querySelector('.query-text').remove();
    assert.equal(dom.findSubmittedUser(doc, baseline, 'Question'), null);
    assert.equal(dom.submittedUserPending(doc, baseline, 'Question'), false); replace(pending);
    assert.throws(() => dom.findSubmittedUser(doc, baseline, 'Question'), /待处理消息被替换/);
    assert.throws(() => dom.submittedUserPending(doc, baseline, 'Question'), /待处理消息被替换/);
  }
});

test('disappeared Gemini pending rows revoke the pending signal and do not fabricate a confirmed message', () => {
  const { doc, history, baseline } = pendingPage(); const pending = addPending(history);
  assert.equal(dom.submittedUserPending(doc, baseline, 'Question'), true); pending.remove();
  assert.equal(dom.submittedUserPending(doc, baseline, 'Question'), false);
  assert.equal(dom.findSubmittedUser(doc, baseline, 'Question'), null);
  assert.equal(baseline.submittedKey, undefined);
});

test('Gemini pending webpage errors revoke permission to keep waiting', () => {
  const { doc, history, baseline } = pendingPage(); const pending = addPending(history);
  assert.equal(dom.submittedUserPending(doc, baseline, 'Question'), true);
  pending.querySelector('pending-response').insertAdjacentHTML('beforeend', '<div role="alert">Generation failed</div>');
  assert.throws(() => dom.findSubmittedUser(doc, baseline, 'Question'), /网页回复失败/);
  assert.throws(() => dom.submittedUserPending(doc, baseline, 'Question'), /网页回复失败/);
  pending.querySelector('[role="alert"]').hidden = true;
  assert.equal(dom.submittedUserPending(doc, baseline, 'Question'), true);
});

test('Gemini loading-shell alerts stop even before its prompt is mounted', () => {
  const { doc, history, baseline } = pendingPage(); const pending = addPending(history);
  pending.querySelector('.query-text').remove();
  pending.insertAdjacentHTML('beforeend', '<div role="alert">Generation failed</div>');
  assert.throws(() => dom.findSubmittedUser(doc, baseline, 'Question'), /网页回复失败/);
  assert.throws(() => dom.submittedUserPending(doc, baseline, 'Question'), /网页回复失败/);
});

test('Gemini pending rows must share the baseline history boundary, which cannot disappear', () => {
  {
    const { doc, history, baseline } = pendingPage(); const pending = addPending(history);
    const other = history.cloneNode(false); doc.querySelector('main').append(other); other.append(pending);
    assert.equal(dom.submittedUserPending(doc, baseline, 'Question'), false);
    assert.throws(() => dom.findSubmittedUser(doc, baseline, 'Question'), /新消息结构已变化/);
  }
  {
    const { doc, history, baseline } = pendingPage(); addPending(history);
    assert.equal(dom.submittedUserPending(doc, baseline, 'Question'), true);
    doc.getElementById('0000000000000001').remove();
    assert.throws(() => dom.findSubmittedUser(doc, baseline, 'Question'), /基准已消失/);
    assert.throws(() => dom.submittedUserPending(doc, baseline, 'Question'), /基准已消失/);
  }
});

test('pending-to-durable transition still rejects a changed prompt, another history or duplicate stable id', () => {
  for (const scenario of ['prompt', 'history', 'duplicate-id']) {
    const { doc, history, baseline } = pendingPage(); const pending = addPending(history);
    assert.equal(dom.submittedUserPending(doc, baseline, 'Question'), true);
    const row = replacePending(doc, pending, { text: scenario === 'prompt' ? 'Edited question' : 'Question', id: scenario === 'duplicate-id' ? '0000000000000001' : '0000000000000002' });
    if (scenario === 'history') { const other = history.cloneNode(false); doc.querySelector('main').append(other); other.append(row); }
    assert.throws(() => dom.findSubmittedUser(doc, baseline, 'Question'), scenario === 'prompt' ? /本次群消息不同/ : scenario === 'history' ? /对话区域已变化/ : /基准已消失/);
  }
});

test('Gemini needs nonbusy public output, complete footer and both scoped native response actions', () => {
  for (const change of [
    doc => doc.querySelector('main').lastElementChild.querySelector('.markdown').setAttribute('aria-busy', 'true'),
    doc => doc.querySelector('main').lastElementChild.querySelector('.markdown').removeAttribute('aria-busy'),
    doc => doc.querySelector('main').lastElementChild.querySelector('.response-footer').classList.remove('complete'),
    doc => doc.querySelector('main').lastElementChild.querySelector('regenerate-button').remove(),
    doc => doc.querySelector('main').lastElementChild.querySelector('copy-button button').disabled = true,
    doc => doc.querySelector('main').lastElementChild.querySelector('message-actions').hidden = true,
    doc => doc.querySelector('gem-icon-button').classList.replace('submit', 'stop'),
  ]) {
    const doc = page(); const state = submitted(doc); addAnswer(doc); change(doc); assert.equal(candidate(doc, state), null);
  }
  const doc = page(); const state = submitted(doc);
  addAnswer(doc, answer('<pre><code>Partial</code></pre><message-actions><copy-button><button>Copy</button></copy-button><regenerate-button><div data-test-id="regenerate-button"><button>Retry</button></div></regenerate-button></message-actions>', { actions: false }));
  assert.equal(candidate(doc, state), null);
});

test('Gemini completed background replies do not require hovering response controls', () => {
  for (const selector of ['response-container-footer', 'message-actions', 'copy-button button', 'regenerate-button button']) {
    const doc = page(); const state = submitted(doc); const message = addAnswer(doc);
    Object.defineProperties(doc, { hidden: { value: true }, visibilityState: { value: 'hidden' } });
    message.querySelector(selector).style.visibility = 'hidden';
    assert.equal(candidate(doc, state)?.text, 'Final answer', selector);
    assert.equal(dom.assertReady(doc), dom.composer(doc), selector);
  }
});

test('Gemini hover-independent completion still rejects concealed, disabled and duplicate controls', () => {
  for (const change of [
    message => { message.querySelector('message-actions').hidden = true; },
    message => { message.querySelector('message-actions').setAttribute('aria-hidden', 'true'); },
    message => { message.querySelector('message-actions').style.display = 'none'; },
    message => { message.querySelector('message-actions').setAttribute('inert', ''); },
    message => { message.querySelector('message-actions').setAttribute('aria-disabled', 'true'); },
    message => { message.querySelector('copy-button button').disabled = true; },
    message => { const actions = message.querySelector('message-actions'); actions.after(actions.cloneNode(true)); },
    message => { message.querySelector('.markdown').style.visibility = 'hidden'; },
    message => { message.style.visibility = 'hidden'; },
    message => { message.querySelector('.markdown').setAttribute('aria-busy', 'true'); },
    message => { message.querySelector('.response-footer').classList.remove('complete'); },
  ]) {
    const doc = page(); const state = submitted(doc); const message = addAnswer(doc);
    message.querySelector('message-actions').style.visibility = 'hidden'; change(message);
    assert.equal(candidate(doc, state), null);
  }
});

test('Gemini pending previous turn or webpage failure blocks leases and forwarding', () => {
  const doc = page(); const state = submitted(doc); assert.throws(() => dom.assertReady(doc), /尚未明确完成/);
  addAnswer(doc, answer('<p>Partial</p>', { complete: false })); assert.throws(() => dom.assertReady(doc), /尚未明确完成/);
  dom.turns(doc, 'assistant').at(-1).insertAdjacentHTML('beforeend', '<div role="alert">Failed</div>');
  assert.throws(() => candidate(doc, state), /网页回复失败/);
});

test('Gemini rejects prompt mismatches, subsequent edits and extra user turns', () => {
  const doc = page(); const baseline = dom.snapshot(doc); addUser(doc, user('Different'));
  assert.throws(() => dom.findSubmittedUser(doc, baseline, 'Question'), /不同/);
  const current = dom.findSubmittedUser(doc, baseline, 'Different'); addAnswer(doc);
  current.querySelector('.query-text').textContent = 'Edited';
  assert.throws(() => dom.finalCandidate(doc, baseline, current), /内容被替换/);
  addUser(doc, user('Human turn', '0000000000000003'));
  assert.throws(() => dom.findSubmittedUser(doc, baseline, 'Question'), /其他新消息/);
});

test('Gemini history prepending and stable rerenders retain ownership while lost anchors fail closed', () => {
  const doc = page(); const state = submitted(doc); addAnswer(doc);
  doc.querySelector('main').insertAdjacentHTML('afterbegin', user('Prepended history', '0000000000000000'));
  assert.equal(candidate(doc, state).text, 'Final answer');
  const currentRow = doc.querySelector('main').lastElementChild; currentRow.replaceWith(currentRow.cloneNode(true));
  assert.equal(candidate(doc, state).text, 'Final answer');
  doc.getElementById('0000000000000001').remove();
  assert.throws(() => candidate(doc, state), /基准已消失/);
});

test('Gemini refuses cross-turn, duplicate and ambiguous response ownership', () => {
  const doc = page(); const state = submitted(doc); const current = addAnswer(doc);
  doc.getElementById('0000000000000001').append(current); assert.throws(() => candidate(doc, state), /基准已消失/);
  doc.querySelector('main').lastElementChild.append(current);
  current.querySelector('message-content').insertAdjacentHTML('beforeend', '<div class="markdown markdown-main-panel" aria-busy="false">Second body</div>');
  assert.equal(candidate(doc, state), null);
  current.querySelector('message-content').lastElementChild.remove();
  doc.querySelector('main').append(doc.querySelector('main').lastElementChild.cloneNode(true));
  assert.throws(() => candidate(doc, state), /其他消息|内容被替换/);
});

function clipboardUpload(doc, { bytes = png, name = 'bridge-fixture-1.png', source = 'blob:https://gemini.google.com/00000000-0000-4000-8000-000000000001' } = {}) {
  const input = dom.composer(doc); const win = doc.defaultView;
  win.DataTransfer = class { constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; } };
  win.ClipboardEvent = class extends win.Event { constructor(type, options) { super(type, options); this.clipboardData = options.clipboardData; } };
  dom.pasteInputImage(doc, input, { mimeType: 'image/png', base64: bytes.toString('base64') }, name);
  dom.composerScope(input).insertAdjacentHTML('afterbegin', clipboardAttachment.replace('blob:https://gemini.google.com/00000000-0000-4000-8000-000000000001', source));
  const card = dom.composerScope(input).querySelector('gem-media-attachment'); loaded(card.querySelector('img'));
  return { input, card, source, name };
}
const settleClipboardRead = () => new Promise(resolve => setImmediate(resolve));

test('Gemini first-use image terms and other visible modal dialogs block automatic submission', () => {
  const doc = page(); const input = dom.composer(doc);
  doc.body.insertAdjacentHTML('beforeend', '<mat-dialog-container id="mat-mdc-dialog-0" role="dialog"><h2>根據圖像和檔案建立內容</h2><button>同意</button></mat-dialog-container>');
  assert.throws(() => dom.assertReady(doc), /待处理的对话框/);
  assert.throws(() => dom.inputAttachmentState(input, []), /待处理的对话框/);
  assert.equal(doc.querySelector('mat-dialog-container button').textContent, '同意');
  doc.querySelector('mat-dialog-container').hidden = true;
  assert.equal(dom.assertReady(doc), input);
});

test('Gemini unnamed clipboard previews authorize only registered byte-identical images', async () => {
  const doc = page(); const reads = [];
  doc.defaultView.fetch = async (source, options) => {
    reads.push(source); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    assert.equal(options.referrerPolicy, 'no-referrer'); return new Response(png);
  };
  const upload = clipboardUpload(doc);
  assert.equal(dom.hasAttachments(upload.input), true); assert.throws(() => dom.assertReady(doc), /附件/);
  assert.deepEqual(dom.inputAttachmentState(upload.input, [upload.name]), { ready: false, reason: 'verifying' });
  await settleClipboardRead(); assert.equal(dom.inputAttachmentState(upload.input, [upload.name]).ready, true);
  assert.deepEqual(reads, [upload.source]);
  dom.releaseInputImages(upload.input);
  assert.equal(dom.inputAttachmentState(upload.input, [upload.name]).ready, false);
  assert.equal(dom.inputAttachmentState(upload.input, []).ready, false);
});

test('Gemini preview alt text is presentation; registered image bytes establish ownership', async () => {
  for (const alt of ['', 'attachment', '附件', null]) {
    const doc = page(); let reads = 0;
    doc.defaultView.fetch = async () => { reads++; return new Response(png); };
    const upload = clipboardUpload(doc); const image = upload.card.querySelector('img');
    if (alt === null) image.removeAttribute('alt'); else image.alt = alt;
    assert.deepEqual(dom.inputAttachmentState(upload.input, [upload.name]), { ready: false, reason: 'verifying' });
    await settleClipboardRead();
    assert.equal(dom.inputAttachmentState(upload.input, [upload.name]).ready, true);
    image.alt = 'Updated accessibility label';
    assert.equal(dom.inputAttachmentState(upload.input, [upload.name]).ready, true);
    assert.equal(reads, 1, 'alt changes neither bypass nor repeat image verification');
    dom.releaseInputImages(upload.input);
    assert.equal(dom.inputAttachmentState(upload.input, [upload.name]).ready, false);
    doc.defaultView.close();
  }
});

test('Gemini hover-only close controls never prevent registered image verification or invalidate verified ownership', async () => {
  const changes = [
    card => { card.querySelector('button').style.visibility = 'hidden'; },
    card => { card.querySelector('button').style.display = 'none'; },
    card => { card.querySelector('button').hidden = true; },
    card => { card.querySelector('button').disabled = true; },
    card => { card.querySelector('gem-icon-button').style.visibility = 'hidden'; },
    card => { card.querySelector('gem-icon-button').style.display = 'none'; },
    card => card.querySelector('button').remove(),
    card => card.querySelector('gem-icon-button').remove(),
  ];
  for (const change of changes) for (const when of ['before-verification', 'after-verification']) {
    const doc = page(); let reads = 0; doc.defaultView.fetch = async () => { reads++; return new Response(png); };
    const upload = clipboardUpload(doc);
    if (when === 'before-verification') change(upload.card);
    assert.equal(dom.inputAttachmentState(upload.input, [upload.name]).reason, 'verifying', when);
    await settleClipboardRead();
    if (when === 'after-verification') change(upload.card);
    assert.equal(dom.inputAttachmentState(upload.input, [upload.name]).ready, true, when);
    assert.equal(reads, 1, 'the image still requires its registered bytes to be verified');
    dom.releaseInputImages(upload.input);
    assert.equal(dom.inputAttachmentState(upload.input, [upload.name]).ready, false, 'controls cannot replace a released image registration');
  }
});

test('Gemini still requires a visible card and image with one known image structure regardless of close controls', () => {
  for (const change of [
    card => { card.hidden = true; },
    card => { card.querySelector('img').hidden = true; },
    card => { card.querySelector('img').style.display = 'none'; },
    card => { card.querySelector('img').style.visibility = 'hidden'; },
    card => { const duplicate = card.querySelector('img').cloneNode(true); duplicate.hidden = true; card.append(duplicate); },
    card => card.append(card.querySelector('img').cloneNode(true)),
    card => card.append(card.querySelector('img')),
    card => card.querySelector('img').classList.remove('gem-attachment-style-img'),
  ]) {
    const doc = page(); let reads = 0; doc.defaultView.fetch = async () => { reads++; return new Response(png); };
    const upload = clipboardUpload(doc); upload.card.querySelector('gem-icon-button').remove(); change(upload.card);
    assert.equal(dom.inputAttachmentState(upload.input, [upload.name]).ready, false);
    assert.equal(reads, 0); dom.releaseInputImages(upload.input);
  }
});

test('Gemini can independently verify one through four sequential clipboard images', async () => {
  const doc = page(); const payloads = new Map(); const names = []; const reads = [];
  doc.defaultView.fetch = async source => { reads.push(source); return new Response(payloads.get(source)); };
  for (let index = 1; index <= 4; index++) {
    const source = `blob:https://gemini.google.com/00000000-0000-4000-8000-00000000000${index}`;
    const bytes = Buffer.from([...png, index]); payloads.set(source, bytes);
    const upload = clipboardUpload(doc, { source, bytes, name: `bridge-fixture-${index}.png` }); names.push(upload.name);
    assert.equal(dom.inputAttachmentState(upload.input, names).reason, 'verifying');
    await settleClipboardRead(); assert.equal(dom.inputAttachmentState(upload.input, names).ready, true);
  }
  assert.deepEqual(reads, [...payloads.keys()]);
  dom.releaseInputImages(dom.composer(doc));
});

test('Gemini rejects unsupported clipboard blob origins before reading any bytes', () => {
  for (const source of ['blob:https://claude.ai/file', 'https://gemini.google.com/file.png', 'https://example.com/file.png', 'data:image/png;base64,AA==']) {
    const doc = page(); let reads = 0; doc.defaultView.fetch = async () => { reads++; return new Response(png); };
    const upload = clipboardUpload(doc, { source });
    assert.throws(() => dom.inputAttachmentState(upload.input, [upload.name]), /本地来源/); assert.equal(reads, 0);
    dom.releaseInputImages(upload.input);
  }
});

test('Gemini rejects changed, truncated or unreadable clipboard bytes and retains an error', async () => {
  for (const fetchImpl of [async () => new Response(Buffer.from([...png, 99])), async () => new Response(png.subarray(0, -1)), async () => new Response(Buffer.from([...png.slice(0, -1), 99])), async () => { throw new Error('unreadable'); }]) {
    const doc = page(); doc.defaultView.fetch = fetchImpl; const upload = clipboardUpload(doc);
    assert.equal(dom.inputAttachmentState(upload.input, [upload.name]).reason, 'verifying');
    await settleClipboardRead(); assert.throws(() => dom.inputAttachmentState(upload.input, [upload.name]), /内容与原图不同|无法核对/);
    assert.throws(() => dom.inputAttachmentState(upload.input, [upload.name]), { name: 'PageSafetyError' });
    dom.releaseInputImages(upload.input);
  }
});

test('Gemini registered attachment identities cannot be replaced, removed or reused', async () => {
  for (const change of [upload => upload.card.remove(), upload => upload.card.querySelector('img').src = 'blob:https://gemini.google.com/replacement', upload => upload.card.replaceWith(upload.card.cloneNode(true)), upload => { upload.card.querySelector('img').hidden = true; }]) {
    const doc = page(); doc.defaultView.fetch = async () => new Response(png); const upload = clipboardUpload(doc);
    dom.inputAttachmentState(upload.input, [upload.name]); await settleClipboardRead();
    change(upload); assert.throws(() => dom.inputAttachmentState(upload.input, [upload.name]), /被替换或移除/);
    dom.releaseInputImages(upload.input);
  }
  const doc = page(); doc.defaultView.fetch = async () => new Response(png); const first = clipboardUpload(doc);
  dom.inputAttachmentState(first.input, [first.name]); await settleClipboardRead();
  const second = clipboardUpload(doc, { name: 'bridge-fixture-2.png', source: first.source });
  assert.throws(() => dom.inputAttachmentState(second.input, [first.name, second.name]), /本地来源/);
  dom.releaseInputImages(first.input);
});

test('Gemini waits on incomplete uploads and refuses extra, unknown or preexisting attachments', async () => {
  const doc = page(); doc.defaultView.fetch = async () => new Response(png); const upload = clipboardUpload(doc);
  loaded(upload.card.querySelector('img'), { complete: false }); assert.equal(dom.inputAttachmentState(upload.input, [upload.name]).reason, 'uploading');
  loaded(upload.card.querySelector('img'));
  upload.card.insertAdjacentHTML('beforeend', '<div role="progressbar"></div>');
  assert.equal(dom.inputAttachmentState(upload.input, [upload.name]).reason, 'uploading'); upload.card.lastElementChild.remove();
  dom.inputAttachmentState(upload.input, [upload.name]); await settleClipboardRead();
  dom.composerScope(upload.input).insertAdjacentHTML('beforeend', '<img src="blob:https://gemini.google.com/extra">');
  assert.equal(dom.inputAttachmentState(upload.input, [upload.name]).ready, false);
  dom.composerScope(upload.input).lastElementChild.remove();
  assert.equal(dom.inputAttachmentState(upload.input, [upload.name]).ready, true);
  dom.composerScope(upload.input).insertAdjacentHTML('beforeend', '<input type="file">');
  Object.defineProperty(dom.composerScope(upload.input).querySelector('input[type="file"]'), 'files', { value: [new doc.defaultView.File([png], 'human.png', { type: 'image/png' })] });
  assert.equal(dom.inputAttachmentState(upload.input, [upload.name]).ready, false);
  dom.releaseInputImages(upload.input);
  const fresh = page(); const input = dom.composer(fresh); dom.composerScope(input).insertAdjacentHTML('afterbegin', clipboardAttachment);
  loaded(dom.composerScope(input).querySelector('img'));
  assert.equal(dom.inputAttachmentState(input, ['bridge-fixture-1.png']).ready, false);
});

test('Gemini release aborts pending byte reads and cannot authorize a later submission', async () => {
  const doc = page(); let capturedSignal; let finish;
  doc.defaultView.fetch = async (_source, options) => { capturedSignal = options.signal; return new Promise(resolve => { finish = resolve; }); };
  const upload = clipboardUpload(doc); assert.equal(dom.inputAttachmentState(upload.input, [upload.name]).reason, 'verifying');
  dom.releaseInputImages(upload.input); assert.equal(capturedSignal.aborted, true);
  finish(new Response(png)); await settleClipboardRead();
  assert.equal(dom.inputAttachmentState(upload.input, [upload.name]).ready, false);
});

test('Gemini image verification rejects late fetch, stream or decoder results even when the timeout callback is delayed', async t => {
  for (const stage of ['fetch', 'stream', 'decoder']) await t.test(stage, async t => {
    const doc = page(); const win = doc.defaultView; let now = 1000; let finish; let heldTimers = 0; let closed = 0;
    const realSetTimeout = globalThis.setTimeout; const realClearTimeout = globalThis.clearTimeout; const heldTimer = Symbol('delayed verification timer');
    t.mock.method(Date, 'now', () => now);
    t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
      if (delay === 15000) { heldTimers++; return heldTimer; }
      return realSetTimeout(callback, delay, ...args);
    });
    t.mock.method(globalThis, 'clearTimeout', timer => { if (timer !== heldTimer) realClearTimeout(timer); });
    if (stage === 'fetch') win.fetch = () => new Promise(resolve => { finish = () => resolve(new Response(png)); });
    if (stage === 'stream') win.fetch = async () => new Response(new ReadableStream({ start(controller) { finish = () => { controller.enqueue(png); controller.close(); }; } }));
    if (stage === 'decoder') {
      win.fetch = async () => new Response(Buffer.from([...png, 99]));
      win.Blob = Blob; let decodes = 0;
      win.createImageBitmap = async () => {
        const bitmap = { width: 64, height: 64, close() { closed++; } };
        if (++decodes === 2) return new Promise(resolve => { finish = () => resolve(bitmap); });
        return bitmap;
      };
      // A deterministic successful comparison isolates deadline enforcement;
      // codec correctness is covered by the image-equivalence tests.
      win.OffscreenCanvas = class {
        constructor(width, height) { this.width = width; this.height = height; }
        getContext() { return { fillRect() {}, drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(this.width * this.height * 4) }) }; }
      };
    }
    const upload = clipboardUpload(doc);
    try {
      assert.equal(dom.inputAttachmentState(upload.input, [upload.name]).reason, 'verifying');
      await settleClipboardRead(); await settleClipboardRead();
      assert.equal(typeof finish, 'function'); assert.equal(heldTimers, 1);
      now = 31000; finish();
      await settleClipboardRead(); await settleClipboardRead();
      assert.throws(() => dom.inputAttachmentState(upload.input, [upload.name]), /核对 Gemini 粘贴图片内容超时/);
      if (stage === 'decoder') assert.equal(closed, 2);
    } finally { dom.releaseInputImages(upload.input); win.close(); t.mock.restoreAll(); }
  });
});

test('Gemini preview verification enforces both declared and streamed ten-megabyte limits', async () => {
  const responses = [
    () => new Response(png, { headers: { 'content-length': String(dom.MAX_IMAGE_BYTES + 1) } }),
    () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(dom.MAX_IMAGE_BYTES)); controller.enqueue(new Uint8Array([1])); controller.close();
    } }), { headers: { 'content-length': '1' } }),
  ];
  for (const response of responses) {
    const doc = page(); doc.defaultView.fetch = async () => response(); const upload = clipboardUpload(doc);
    try {
      assert.equal(dom.inputAttachmentState(upload.input, [upload.name]).reason, 'verifying');
      await settleClipboardRead();
      assert.throws(() => dom.inputAttachmentState(upload.input, [upload.name]), /图片预览超过 10 MB/);
    } finally { dom.releaseInputImages(upload.input); doc.defaultView.close(); }
  }
});

test('Gemini clipboard simulation uses a validated File and refuses a replaced editor', () => {
  const doc = page(); const input = dom.composer(doc); let pasted;
  input.addEventListener('paste', event => { pasted = event.clipboardData.files[0]; });
  const upload = clipboardUpload(doc);
  assert.equal(pasted.name, upload.name); assert.equal(pasted.type, 'image/png'); assert.equal(pasted.size, png.length);
  assert.throws(() => dom.pasteInputImage(doc, input, { mimeType: 'image/png', base64: png.toString('base64') }, upload.name), /名称重复/);
  input.replaceWith(input.cloneNode(true));
  assert.throws(() => dom.pasteInputImage(doc, input, { mimeType: 'image/png', base64: png.toString('base64') }, 'new.png'), /输入目标/);
  dom.releaseInputImages(input);
});

test('Gemini actual image-only response completes without a toolbar text-copy action', () => {
  const doc = page(); const state = submitted(doc); const message = addAnswer(doc, answer(generatedImage));
  message.querySelector('message-actions copy-button').remove();
  const image = message.querySelector('img'); loaded(image, { complete: false });
  assert.equal(candidate(doc, state), null);
  loaded(image, { naturalWidth: 1024, naturalHeight: 559 });
  const result = candidate(doc, state);
  assert.equal(result.text, ''); assert.deepEqual(result.images, [{ src: image.src, width: 1024, height: 559 }]);
  assert.equal(dom.assertReady(doc), dom.composer(doc));
});

test('Gemini generated image completion is independent of hover-only download and reply actions', () => {
  const doc = page(); const state = submitted(doc); const message = addAnswer(doc, answer(generatedImage));
  message.querySelector('message-actions copy-button').remove();
  message.querySelector('message-actions').style.visibility = 'hidden';
  message.querySelector('.generated-image-controls').style.visibility = 'hidden';
  const image = message.querySelector('img'); loaded(image);
  assert.equal(candidate(doc, state)?.images.length, 1);
  message.querySelector('download-generated-image-button button').disabled = true;
  assert.equal(candidate(doc, state), null);
});

test('Gemini image-only history with a loaded class but unready pixels cannot lease another task', () => {
  const doc = page(); const state = submitted(doc); const message = addAnswer(doc, answer(generatedImage));
  message.querySelector('message-actions copy-button').remove();
  const image = message.querySelector('img');
  for (const pixels of [{ complete: false }, { naturalWidth: 0 }, { naturalHeight: 0 }]) {
    loaded(image, pixels);
    assert.equal(candidate(doc, state), null);
    assert.throws(() => dom.assertReady(doc), /尚未明确完成/);
  }
  loaded(image);
  assert.equal(dom.assertReady(doc), dom.composer(doc));
});

test('Gemini unknown nonimage attachment cards remain protected as existing drafts', () => {
  const doc = page(); const input = dom.composer(doc);
  dom.composerScope(input).insertAdjacentHTML('beforeend', '<gem-media-attachment><span>Private document.pdf</span></gem-media-attachment>');
  const attachment = dom.composerScope(input).querySelector('gem-media-attachment');
  assert.equal(dom.hasAttachments(input), true);
  assert.equal(dom.inputAttachmentState(input, []).ready, false);
  assert.throws(() => dom.assertReady(doc), /附件/);
  attachment.hidden = true;
  assert.equal(dom.hasAttachments(input), false);
  assert.equal(dom.inputAttachmentState(input, []).ready, true);
  assert.equal(dom.assertReady(doc), input);
});

test('Gemini one through four generated image previews are read in DOM order, excluding historical output', () => {
  for (let count = 1; count <= 4; count++) {
    const doc = page(); const state = submitted(doc);
    const gallery = Array.from({ length: count }, (_, index) => generatedImage.replaceAll('000000000002', `00000000000${index + 2}`).replace('data-image-attachment-index="0"', `data-image-attachment-index="${index}"`)).join('');
    const message = addAnswer(doc, answer(gallery)); message.querySelector('message-actions copy-button').remove();
    const images = [...message.querySelectorAll('img')]; images.forEach(image => loaded(image));
    const result = candidate(doc, state); assert.equal(result.images.length, count);
    assert.deepEqual(result.images.map(image => image.src), images.map(image => image.src));
  }
});

test('Gemini image-only completion needs its response footer, toolbar retry and every native image download control', () => {
  for (const change of [
    message => message.querySelector('.response-footer').classList.remove('complete'),
    message => message.querySelector('message-actions regenerate-button').remove(),
    message => message.querySelector('download-generated-image-button').remove(),
    message => message.querySelector('download-generated-image-button button').disabled = true,
    message => message.querySelector('img').classList.remove('loaded'),
    message => message.querySelector('message-actions').hidden = true,
  ]) {
    const doc = page(); const state = submitted(doc); const message = addAnswer(doc, answer(generatedImage));
    message.querySelector('message-actions copy-button').remove(); loaded(message.querySelector('img')); change(message);
    assert.equal(candidate(doc, state), null);
  }
});

test('Gemini generated image controls cannot authorize an unrelated image or an unsupported generated source', () => {
  const doc = page(); const state = submitted(doc); const message = addAnswer(doc, answer(generatedImage));
  const image = message.querySelector('img'); loaded(image); image.src = 'https://external.example/generated.png';
  assert.throws(() => candidate(doc, state), /来源不受支持/);
  image.src = 'blob:https://gemini.google.com/test';
  image.parentElement.classList.remove('image-button');
  assert.throws(() => candidate(doc, state), /结构已变化/);
});

test('Gemini external illustration failures preserve body and code without fetching arbitrary origins', () => {
  const doc = page(); const state = submitted(doc);
  const message = addAnswer(doc, answer('<p>Public answer</p><pre><code class="language-js">const x = 1;\n</code></pre><img src="https://external.example/image.png"><img src="https://external.example/image.png"><img src="https://other.example/image.png">'));
  for (const image of message.querySelectorAll('img')) loaded(image, { complete: false, naturalWidth: 0, naturalHeight: 0 });
  const result = candidate(doc, state);
  assert.equal(result.text, 'Public answer\n\n```js\nconst x = 1;\n```\n\n提示：本次回复有 2 张外部来源图片未转发，请在 Gemini 网页查看。');
  assert.deepEqual(result.images, []);
});

test('Gemini output image source policy rejects unsafe schemes, other accounts and origin lookalikes', () => {
  for (const source of ['blob:https://claude.ai/file', 'https://gemini.google.com.evil.test/image', 'https://user:password@gemini.google.com/image', 'https://gemini.google.com:8443/image', 'http://gemini.google.com/image', 'data:image/png;base64,AA==', 'file:///private/image.png', 'https://lh3.googleusercontent.com/unobserved.png']) assert.throws(() => dom.answerImageSource(source), /来源不受支持/);
  assert.equal(dom.answerImageSource('blob:https://gemini.google.com/test'), 'blob:https://gemini.google.com/test');
  assert.equal(dom.answerImageSource('https://gemini.google.com/image.png'), 'https://gemini.google.com/image.png');
});

test('Gemini output reader validates actual bytes with credential-free no-redirect bounded reads', async () => {
  const image = { src: 'blob:https://gemini.google.com/test' };
  const payload = await dom.readAnswerImage(image, { fetchImpl: async (source, options) => {
    assert.equal(source, image.src); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    assert.equal(options.referrerPolicy, 'no-referrer'); return new Response(png, { headers: { 'content-type': 'image/png' } });
  } });
  assert.equal(payload.base64, png.toString('base64')); assert.equal(payload.byteLength, png.length);
  await assert.rejects(dom.readAnswerImage(image, { fetchImpl: async () => new Response('not an image', { headers: { 'content-type': 'image/png' } }) }), /格式不一致/);
  await assert.rejects(dom.readAnswerImage(image, { fetchImpl: async () => new Response('gif', { headers: { 'content-type': 'image/gif' } }) }), /格式不支持/);
  await assert.rejects(dom.readAnswerImage(image, { fetchImpl: async () => { throw new Error('redirect'); } }), /无法读取/);
  await assert.rejects(dom.readAnswerImage(image, { fetchImpl: async () => new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(dom.MAX_IMAGE_BYTES + 1) } }) }), /超过 10 MB/);
  await assert.rejects(dom.readAnswerImage(image, { fetchImpl: async () => new Promise(() => {}), timeoutMs: 2 }), /超时/);
});

test('Gemini loaded but broken images, canvas output and excessive image counts fail closed', () => {
  const doc = page(); const state = submitted(doc); const message = addAnswer(doc, answer(generatedImage));
  loaded(message.querySelector('img'), { naturalWidth: 0 }); assert.throws(() => candidate(doc, state), /尚未正常加载/);
  loaded(message.querySelector('img'));
  message.querySelector('.markdown').insertAdjacentHTML('beforeend', '<canvas></canvas>');
  assert.throws(() => candidate(doc, state), /画布/); message.querySelector('canvas').remove();
  for (let index = 3; index <= 6; index++) message.querySelector('.markdown').insertAdjacentHTML('beforeend', generatedImage.replaceAll('000000000002', `00000000000${index}`));
  for (const image of message.querySelectorAll('img')) loaded(image);
  assert.throws(() => candidate(doc, state), /超过 4 张/);
});
