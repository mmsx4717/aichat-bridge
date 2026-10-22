// Bounded, local-only metadata. Never retain prompts, answers, URLs or DOM IDs.
const counts = ['elapsedMs', 'gapMs', 'wakeAgeMs', 'bodyChars', 'bodyCount', 'footerCount'];
const phases = { prepare: '准备输入', submit: '确认提问', answer: '读取回复', delivery: '提交扩展' };
const flags = ['hidden', 'generating', 'complete', 'candidate'];
export function sanitizeObservation(value) {
  if (!Array.isArray(value) || !value.length || value.length > 16) return null;
  const samples = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const clean = {};
    for (const key of counts) {
      if (!Number.isSafeInteger(item[key]) || item[key] < 0 || item[key] > 3600000) return null;
      clean[key] = item[key];
    }
    for (const key of flags) { if (typeof item[key] !== 'boolean') return null; clean[key] = item[key]; }
    for (const key of ['framePending', 'frameResumed']) {
      if (item[key] === undefined) continue;
      if (!Number.isSafeInteger(item[key]) || item[key] < 0 || item[key] > 3600000) return null;
      clean[key] = item[key];
    }
    if (item.focused !== undefined) { if (typeof item.focused !== 'boolean') return null; clean.focused = item.focused; }
    if (item.phase !== undefined) { if (typeof item.phase !== 'string' || !Object.hasOwn(phases, item.phase)) return null; clean.phase = item.phase; }
    if (samples.length && clean.elapsedMs < samples.at(-1).elapsedMs) return null;
    samples.push(clean);
  }
  return samples;
}
export function createObservationRecorder(startedAt) {
  const samples = [];
  let lastSampleAt = null, lastCheckAt = startedAt, maxGap = 0;
  return {
    capture(now, state) {
      maxGap = Math.max(maxGap, now - lastCheckAt); lastCheckAt = now;
      const previous = samples.at(-1);
      const changed = previous && ['hidden', 'focused', 'phase', 'generating', 'complete', 'candidate'].some(key => previous[key] !== state[key]);
      if (previous && !changed && now - lastSampleAt < 5000) return null;
      const clean = sanitizeObservation([{ ...state, elapsedMs: Math.min(3600000, Math.max(0, now - startedAt)), gapMs: Math.min(3600000, Math.max(0, maxGap)) }]);
      if (!clean) return null;
      samples.push(clean[0]);
      // Keep the first sample plus the most recent fifteen transitions/checks.
      if (samples.length > 16) samples.splice(1, samples.length - 16);
      lastSampleAt = now; maxGap = 0;
      return samples.map(sample => ({ ...sample }));
    },
  };
}
export function observationLines(value) {
  return (sanitizeObservation(value) || []).map(s =>
    `${(s.elapsedMs / 1000).toFixed(1)}秒 · ${s.hidden ? '页签隐藏（后台）' : '页签可见'}${s.focused === undefined ? '' : s.focused ? ' · 页面有焦点' : ' · 页面无焦点'}${s.phase ? ' · ' + phases[s.phase] : ''} · 正文 ${s.bodyChars} 字 / ${s.bodyCount} 块 · 操作栏 ${s.footerCount} · ${s.generating ? '页面仍显示生成中' : '未见生成中标记'} · ${s.complete ? '完成校验通过' : '完成校验未通过'} · ${s.candidate ? '可回传' : '尚不可回传'}${s.frameResumed === undefined ? '' : ` · 动画帧待执行 ${s.framePending} / 已补执行 ${s.frameResumed}`} · 采样间隔峰值 ${s.gapMs}ms · 距后台唤醒 ${s.wakeAgeMs}ms`);
}
