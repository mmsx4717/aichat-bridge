import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeObservation, createObservationRecorder, observationLines } from '../extension/background-observation.js';
import * as qwen from '../extension/qwen-dom.js';
import { page, user, answer } from './helpers/qwen-fixture.js';

const sample = { elapsedMs: 0, gapMs: 0, wakeAgeMs: 0, bodyChars: 0, bodyCount: 0, footerCount: 0,
  hidden: true, generating: false, complete: false, candidate: false };

test('observations accept only bounded metadata and discard text, credentials and URLs', () => {
  const input = { ...sample, text: 'private answer', secret: 'private credential', url: 'https://private.invalid', domId: 'private-id' };
  assert.deepEqual(sanitizeObservation([input]), [sample]);
  assert.doesNotMatch(observationLines([input]).join('\n'), /private/);
  for (const value of [null, [], Array(17).fill(sample), [null], [{ ...sample, hidden: 'true' }],
    [{ ...sample, bodyChars: -1 }], [{ ...sample, gapMs: 1.5 }], [{ ...sample, wakeAgeMs: Infinity }],
    [{ ...sample, elapsedMs: 3600001 }], [{ ...sample, elapsedMs: 2 }, { ...sample, elapsedMs: 1 }]]) {
    assert.equal(sanitizeObservation(value), null);
  }
});

test('recorder throttles steady state, preserves visibility transitions and reports stalled sampling', () => {
  const recorder = createObservationRecorder(1000);
  assert.equal(recorder.capture(1000, sample).length, 1);
  assert.equal(recorder.capture(2000, sample), null);
  const changed = recorder.capture(2500, { ...sample, hidden: false });
  assert.equal(changed.length, 2); assert.equal(changed[1].elapsedMs, 1500); assert.equal(changed[1].gapMs, 1000);
  assert.equal(recorder.capture(3000, { ...sample, hidden: false }), null);
  const stalled = recorder.capture(63000, { ...sample, hidden: false });
  assert.equal(stalled.at(-1).gapMs, 60000);
  changed[0].bodyChars = 999;
  assert.equal(stalled[0].bodyChars, 0, 'returned samples cannot mutate recorder state');
});

test('recorder retains the first sample and the latest fifteen snapshots', () => {
  const recorder = createObservationRecorder(0);
  let samples;
  for (let n = 0; n < 40; n++) samples = recorder.capture(n * 5000, sample);
  assert.equal(samples.length, 16); assert.equal(samples[0].elapsedMs, 0);
  assert.equal(samples[1].elapsedMs, 125000); assert.equal(samples.at(-1).elapsedMs, 195000);
});

test('Qwen observations count only this turn answer DOM, excluding old replies and thought text', () => {
  const { window } = page(); const doc = window.document;
  try {
    user(doc, 'old', 'old-user'); answer(doc, '<p>OLD ANSWER</p>', 'old-answer');
    const baseline = qwen.snapshot(doc); const current = user(doc, 'Question');
    assert.equal(qwen.backgroundObservation(doc, baseline, current).bodyChars, 0);
    const response = answer(doc, '<p>Hello</p>');
    const observed = qwen.backgroundObservation(doc, baseline, current);
    assert.equal(observed.bodyChars, 5); assert.equal(observed.bodyCount, 1);
    assert.equal(observed.footerCount, 1); assert.equal(observed.complete, true);
    assert.doesNotMatch(JSON.stringify(observed), /Hello|PRIVATE|OLD/);
    response.querySelector('.response-message-footer').remove();
    assert.equal(qwen.backgroundObservation(doc, baseline, current).complete, false);
    doc.querySelector('.send-button use').setAttribute('xlink:href', '#stop');
    assert.equal(qwen.backgroundObservation(doc, baseline, current).generating, true);
    current.remove();
    assert.equal(qwen.backgroundObservation(doc, baseline, current).bodyChars, 0);
  } finally { window.close(); }
});

test('diagnostics distinguish a visible unfocused window and retain rapid phase changes', () => {
  const recorder = createObservationRecorder(0);
  recorder.capture(0, { ...sample, hidden: false, focused: false, phase: 'prepare' });
  const submitted = recorder.capture(100, { ...sample, hidden: false, focused: false, phase: 'submit' });
  assert.equal(submitted.length, 2);
  assert.match(observationLines(submitted).at(-1), /页签可见.*页面无焦点.*确认提问/);
  const focused = recorder.capture(200, { ...sample, hidden: false, focused: true, phase: 'submit' });
  assert.equal(focused.length, 3);
  assert.equal(sanitizeObservation([{ ...sample, phase: 'private answer' }]), null);
  assert.equal(sanitizeObservation([{ ...sample, focused: 'secret' }]), null);
});
