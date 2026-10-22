// Qwen-only MAIN-world adapter. No network, text extraction, credentials,
// visibility spoofing or synthesized input. A bounded task pulse can run only
// animation callbacks which the page itself has already requested.
(() => {
  if (location.origin !== 'https://chat.qwen.ai' || window !== window.top || window.__aichatQwenFrameScheduler) return;
  window.__aichatQwenFrameScheduler = true;
  const nativeRequest = window.requestAnimationFrame.bind(window);
  const nativeCancel = window.cancelAnimationFrame.bind(window);
  const now = performance.now.bind(performance);
  const pending = new Map();
  const MAX_PENDING = 512, STALLED_MS = 1000, MAX_PER_PULSE = 64;
  let lease = null;
  window.requestAnimationFrame = function (callback) {
    if (typeof callback !== 'function' || pending.size >= MAX_PENDING) return nativeRequest(callback);
    const id = nativeRequest(timestamp => {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      entry.callback.call(window, timestamp);
    });
    pending.set(id, { callback, at: now() });
    return id;
  };
  window.cancelAnimationFrame = function (id) {
    nativeCancel(id);
    // Native handles are unsigned 32-bit values (Web IDL conversion).
    pending.delete(Number(id) >>> 0);
  };
  document.addEventListener('aichat:qwen:frame-control', event => {
    const detail = event.detail;
    if (!detail || typeof detail.token !== 'string' || !/^[a-f0-9-]{36}$/.test(detail.token)) return;
    const time = now();
    if (lease && (time >= lease.until || lease.path !== location.pathname)) lease = null;
    if (detail.action === 'start') {
      if (lease || !/^\/c\/[A-Za-z0-9_-]+\/?$/.test(location.pathname) || !Number.isFinite(detail.timeoutMs) || detail.timeoutMs <= 0) return;
      lease = { token: detail.token, path: location.pathname, until: time + Math.min(600000, detail.timeoutMs), resumed: 0, lastPulse: -Infinity };
      return;
    }
    if (!lease || detail.token !== lease.token) return;
    if (detail.action === 'stop') { lease = null; return; }
    if (detail.action !== 'pulse' || time - lease.lastPulse < 500) return;
    lease.lastPulse = time;
    const current = lease;
    if (document.visibilityState !== 'visible' || !document.hasFocus()) {
      // Snapshot once: callbacks scheduled by callbacks wait for a later pulse.
      // Recent/native-running frames and cancelled callbacks are untouched.
      const stalled = [...pending].filter(([, entry]) => time - entry.at >= STALLED_MS).slice(0, MAX_PER_PULSE);
      for (const [id, entry] of stalled) {
        if (lease !== current || location.pathname !== current.path || now() >= current.until ||
            (document.visibilityState === 'visible' && document.hasFocus())) break;
        if (pending.get(id) !== entry) continue;
        pending.delete(id); nativeCancel(id); current.resumed++;
        try { entry.callback.call(window, time); }
        catch (error) { window.reportError?.(error); }
      }
    }
    document.dispatchEvent(new CustomEvent('aichat:qwen:frame-state', { detail: {
      token: current.token, pending: pending.size, resumed: Math.min(3600000, current.resumed),
    } }));
  });
})();
