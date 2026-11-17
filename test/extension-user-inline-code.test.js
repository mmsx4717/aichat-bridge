import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { snapshot, findSubmittedUser, finalCandidate, restoreChallengeContext } from '../extension/dom.js';

// Synthetic fixtures: no live account, browser profile or chat is accessed.
const prompt = 'How many outputs update the `state` field?';
const rendered = 'How many outputs update the <code>state</code> field?';
const layouts = {
  legacy: (id, html) => `<article data-testid="conversation-turn-${id}"><div data-message-author-role="user" data-message-id="${id}"><div class="whitespace-pre-wrap">${html}</div></div><div data-message-author-role="assistant" data-message-id="${id}-answer"><div class="markdown">Owned answer</div></div><button data-testid="copy-turn-action-button">Copy</button></article>`,
  modern: (id, html) => `<div data-turn-key="turn-${id}" data-talvt-turn-state="complete"><div data-chatgpt-search-unit-key="${id}:0:user" data-chatgpt-search-message-ids="${id}"><div data-user-message-bubble="true">${html}</div><button>Not prompt text</button></div><div data-chatgpt-search-unit-key="${id}:0:assistant" data-chatgpt-search-message-ids="${id}-answer"><div data-markdown-text-style="assistant-message">Owned answer</div></div><div class="turn-action-controls"><button aria-label="Copy">Copy</button></div></div>`,
};
const body = doc => doc.querySelector('[data-user-message-bubble], .whitespace-pre-wrap');
const add = (doc, html) => doc.querySelector('main').insertAdjacentHTML('beforeend', html);

for (const [layout, turn] of Object.entries(layouts)) {
  const page = () => new JSDOM('<!doctype html><main></main>', { url: 'https://chatgpt.com/c/fixture-inline-code' }).window.document;

  test(`${layout}: single-backtick inline code retains exact prompt ownership through answer extraction`, () => {
    const doc = page(); const baseline = snapshot(doc);
    add(doc, turn('owned', rendered));
    const user = findSubmittedUser(doc, baseline, prompt);
    assert.ok(user);
    assert.deepEqual(baseline.submittedUser, { key: 'message:owned', prompt });
    assert.equal(finalCandidate(doc, baseline, user).text, 'Owned answer');
    body(doc).innerHTML = 'How many outputs update the <code><span>state</span></code> field?';
    assert.equal(finalCandidate(doc, baseline, user).text, 'Owned answer');
  });

  test(`${layout}: literal backticks and unformatted control prompts still match`, () => {
    for (const expected of [prompt, 'How many outputs update the state field?', 'a lone ` character']) {
      const doc = page(); const baseline = snapshot(doc);
      add(doc, turn('owned', '')); body(doc).textContent = expected;
      assert.ok(findSubmittedUser(doc, baseline, expected));
    }
  });

  test(`${layout}: changed prose, changed code and missing code semantics cannot match`, () => {
    for (const html of [rendered.replace('state', 'status'), rendered.replace('How many', 'Which'), rendered.replace('<code>state</code>', 'state'), rendered.replace('<code>state</code>', '<span>state</span>'), rendered + ' extra']) {
      const doc = page(); const baseline = snapshot(doc);
      add(doc, turn('other', html));
      assert.throws(() => findSubmittedUser(doc, baseline, prompt), /不同/);
      assert.equal(baseline.submittedUser, undefined);
    }
    const doc = page(); const baseline = snapshot(doc); add(doc, turn('other', rendered));
    assert.throws(() => findSubmittedUser(doc, baseline, prompt.replaceAll('`', '')), /不同/);
  });

  test(`${layout}: progressive strict prefixes never claim a turn or release an answer`, () => {
    const doc = page(); const baseline = snapshot(doc); add(doc, turn('owned', ''));
    for (const html of ['', 'How many outputs update the ', 'How many outputs update the `sta', 'How many outputs update the <code>state</code>', 'How many outputs update the <code>state</code> fie']) {
      body(doc).innerHTML = html;
      assert.equal(findSubmittedUser(doc, baseline, prompt), null);
      assert.equal(baseline.submittedUser, undefined);
      assert.throws(() => finalCandidate(doc, baseline, doc.querySelector('[data-message-author-role="user"], [data-chatgpt-search-unit-key$=":user"]')), /被替换/);
    }
    body(doc).innerHTML = rendered;
    const user = findSubmittedUser(doc, baseline, prompt);
    assert.equal(finalCandidate(doc, baseline, user).text, 'Owned answer');
    body(doc).innerHTML = 'How many outputs update the <code>state</code>';
    assert.throws(() => findSubmittedUser(doc, baseline, prompt), /不同/);
    assert.throws(() => finalCandidate(doc, baseline, user), /被替换/);
  });

  test(`${layout}: other new users are rejected even if their text is identical`, () => {
    const doc = page(); const baseline = snapshot(doc); add(doc, turn('owned', rendered));
    const user = findSubmittedUser(doc, baseline, prompt);
    add(doc, turn('manual', rendered));
    assert.throws(() => findSubmittedUser(doc, baseline, prompt), /其他新消息/);
    assert.throws(() => finalCandidate(doc, baseline, user), /其他消息/);
    const unclaimed = page(); const before = snapshot(unclaimed);
    add(unclaimed, turn('first', rendered) + turn('second', rendered));
    assert.throws(() => findSubmittedUser(unclaimed, before, prompt), /其他新消息/);
    assert.equal(before.submittedUser, undefined);
  });

  test(`${layout}: historical matching messages cannot authorize a different new message`, () => {
    const doc = page(); add(doc, turn('old', rendered)); const baseline = snapshot(doc);
    assert.equal(findSubmittedUser(doc, baseline, prompt), null);
    add(doc, turn('manual', rendered.replace('state', 'private')));
    assert.throws(() => findSubmittedUser(doc, baseline, prompt), /不同/);
  });

  test(`${layout}: same-ID replacements are revalidated against the original code-bearing prompt`, () => {
    const doc = page(); const baseline = snapshot(doc); add(doc, turn('owned', rendered));
    const user = findSubmittedUser(doc, baseline, prompt);
    doc.querySelector('main').innerHTML = turn('owned', rendered);
    assert.equal(finalCandidate(doc, baseline, user).text, 'Owned answer');
    body(doc).innerHTML = rendered.replace('state', 'private');
    assert.throws(() => finalCandidate(doc, baseline, user), /被替换/);
    assert.throws(() => findSubmittedUser(doc, baseline, prompt.replace('state', 'private')), /被替换/);
  });

  test(`${layout}: restore also requires the complete original inline-code prompt`, () => {
    const doc = page(); add(doc, turn('owned', 'How many outputs update the <code>state</code>'));
    const checkpoint = { userKey: 'message:owned', prompt, imageSources: [] };
    assert.equal(restoreChallengeContext(doc, checkpoint), null);
    body(doc).innerHTML = rendered;
    const restored = restoreChallengeContext(doc, checkpoint);
    assert.ok(restored);
    assert.equal(finalCandidate(doc, restored.baseline, restored.user).text, 'Owned answer');
    body(doc).innerHTML = rendered.replace('state', 'other');
    assert.throws(() => restoreChallengeContext(doc, checkpoint), /消息已变化/);
  });

  test(`${layout}: inline code cannot borrow hidden or control text`, () => {
    const doc = page(); const baseline = snapshot(doc);
    add(doc, turn('owned', rendered.replace('state', '<span>state</span><span hidden>private</span><button>Copy</button>')));
    assert.ok(findSubmittedUser(doc, baseline, prompt));
    body(doc).innerHTML = rendered.replace('state', '<span hidden>state</span>other');
    assert.throws(() => findSubmittedUser(doc, baseline, prompt), /不同/);
  });

  test(`${layout}: block code and ambiguous inline delimiters cannot masquerade as single-backtick code`, () => {
    for (const html of ['<pre><code>state</code></pre>', '<div data-code-block="true"><code>state</code></div>', '<div class="cm-content"><code>state</code></div>', '<code>`state`</code>', '<code></code>']) {
      const doc = page(); const baseline = snapshot(doc); add(doc, turn('other', html));
      assert.throws(() => findSubmittedUser(doc, baseline, '`state`'), /不同|行内代码/);
      assert.equal(baseline.submittedUser, undefined);
    }
    for (const expected of ['``state``', '```state```']) {
      const doc = page(); const baseline = snapshot(doc); add(doc, turn('other', '<code>state</code>'));
      assert.throws(() => findSubmittedUser(doc, baseline, expected), /不同/);
      assert.equal(baseline.submittedUser, undefined);
    }
  });
}
