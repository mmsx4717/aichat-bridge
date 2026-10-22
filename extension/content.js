(() => {
  if (globalThis.__chatGPTBotBridge) return;
  globalThis.__chatGPTBotBridge = true;
  const CONTENT_VERSION = '0.1.7';
  const pageOpenedAt = Date.now();
  let bridgeIdleSince = pageOpenedAt;
  const IDLE_REFRESH_MS = 10 * 60 * 1000;
  // A worker request can perform two bounded 25-second host operations
  // (status + lease, or an operation + failure cleanup). Let that response
  // arrive before declaring a disconnected worker; never resend the prompt.
  const RPC_TIMEOUT_MS = 60_000;
  const sessionId = crypto.randomUUID();
  let running = false; let wakePending = false; let platformLabel = '机器人';
  let reloading = false; let recoveryChecked = false;
  let lastWorkerWakeAt = Date.now();
  // Worker messages and browser lifecycle events can arrive while page timers
  // are throttled. Wake only existing waits; never start another submission.
  const activeWaits = new Set();
  const wakeWaits = () => { for (const wake of [...activeWaits]) wake(); };
  const sleep = ms => new Promise(resolve => {
    const until = Date.now() + ms; let timer;
    const wake = () => {
      clearTimeout(timer);
      const remaining = until - Date.now();
      if (remaining > 0) { timer = setTimeout(wake, remaining); return; }
      activeWaits.delete(wake); resolve();
    };
    activeWaits.add(wake); timer = setTimeout(wake, ms);
  });
  const badge = document.createElement('div');
  const shadow = badge.attachShadow({ mode: 'closed' });
  const label = document.createElement('span');
  const style = document.createElement('style');
  style.textContent = ':host{position:fixed;bottom:68px;left:12px;z-index:99999;pointer-events:none}span{display:block;max-width:350px;padding:7px 11px;border-radius:9px;background:#103753ed;color:#c7eaff;font:11px/1.5 system-ui;box-shadow:0 2px 12px #0002}';
  shadow.append(style, label);
  let lastPersistentStatus = ''; let transientStatus = false;
  const status = (text, transient = false) => {
    transientStatus = transient;
    if (!transient) lastPersistentStatus = text;
    label.textContent = 'AIChat桥接 v' + CONTENT_VERSION + ' · ' + platformLabel + ' · ' + text;
    if (!badge.isConnected) document.documentElement.append(badge);
  };
  function rpc(type, extra = {}) {
    let timer;
    return Promise.race([
      chrome.runtime.sendMessage({ type, sessionId, ...extra }).then(response => { if (!response?.ok) throw new Error(response?.error || '扩展后台未响应'); return response.data; }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('扩展后台响应超时')), RPC_TIMEOUT_MS); })
    ]).finally(() => clearTimeout(timer));
  }
  (async () => {
    const { ASSISTANT_NAMES, assistantForUrl, conversationUrl, normalizeText, interruptsComposer } = await import(chrome.runtime.getURL('shared.js'));
    // The page origin selects the adapter. A job can never select a different
    // provider's selectors or widen the worker's sender authorization.
    const assistant = assistantForUrl(location.href);
    if (!assistant) return;
    const assistantLabel = ASSISTANT_NAMES[assistant];
    const dom = assistant === 'qwen'
      ? await import(chrome.runtime.getURL('qwen-dom.js'))
      : assistant === 'gemini'
      ? await import(chrome.runtime.getURL('gemini-dom.js'))
      : assistant === 'claude'
        ? await import(chrome.runtime.getURL('claude-dom.js'))
        : await import(chrome.runtime.getURL('dom.js'));
    function confirmedUser({ baseline, prompt, check, deadline, observe }) {
      return new Promise((resolve, reject) => {
        const confirmDeadline = Math.min(deadline, Date.now() + 20000);
        let finished = false; let timer; let waitingForRender = false;
        const cleanup = () => {
          clearTimeout(timer); observer.disconnect(); activeWaits.delete(changed);
          document.removeEventListener('visibilitychange', changed);
          document.removeEventListener('resume', changed);
          window.removeEventListener('pageshow', changed);
          window.removeEventListener('focus', changed);
        };
        const finish = (error, user) => {
          if (finished) return; finished = true; cleanup();
          if (error) reject(error); else resolve(user);
        };
        const changed = () => {
          if (finished) return;
          clearTimeout(timer);
          try {
            // A hidden/frozen page can resume after the confirmation timer was
            // due. Enforce the overall job deadline and ownership safeguards,
            // then inspect the current DOM before declaring a missing message.
            // This never clicks Send again or extends the job's lease.
            check();
            if (Date.now() >= deadline) throw new Error(`等待 ${assistantLabel} 回复超时；不会重新提问`);
            const user = dom.findSubmittedUser(document, baseline, prompt);
            observe?.(null, user);
            if (user) { finish(null, user); return; }
            // Provider-verified pending state may outlast the missing-message
            // window: Gemini has an exact prompt in its temporary shell;
            // Qwen can mount a durable message ID before rendering its text.
            // Revalidate on every wake and keep the original job deadline.
            // Waiting alone never authorizes an answer; full text must match.
            const pending = dom.submittedUserPending?.(document, baseline, prompt) === true;
            if (pending && Date.now() >= confirmDeadline && !waitingForRender) {
              waitingForRender = true;
              status(`已发送，等待 ${assistantLabel} 加载并确认本次提问；不会重复发送`);
            }
            const remaining = (pending ? deadline : confirmDeadline) - Date.now();
            if (remaining <= 0) {
              const reason = dom.submissionWaitReason?.(document, baseline, prompt);
              throw new Error('未确认到本次网页消息' + (reason ? `：${reason}` : '') + '，已停止；不会重复点击发送');
            }
            timer = setTimeout(changed, Math.max(1, Math.min(250, remaining)));
          } catch (error) { finish(error); }
        };
        const observer = new MutationObserver(changed);
        observer.observe(document.body || document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
        document.addEventListener('visibilitychange', changed);
        document.addEventListener('resume', changed);
        window.addEventListener('pageshow', changed);
        window.addEventListener('focus', changed);
        activeWaits.add(changed);
        changed();
      });
    }
    function completedAnswer({ baseline, user, check, deadline, fingerprint, observe }) {
      return new Promise((resolve, reject) => {
        let finished = false; let timer; let previous = ''; let stableSince = 0; let firstCandidateAt = null;
        let background = document.visibilityState !== 'visible';
        const cleanup = () => {
          clearTimeout(timer); observer.disconnect(); activeWaits.delete(changed);
          document.removeEventListener('load', changed, true);
          document.removeEventListener('visibilitychange', changed);
          document.removeEventListener('resume', changed);
          window.removeEventListener('pageshow', changed);
          window.removeEventListener('focus', changed);
        };
        const finish = (error, result) => {
          if (finished) return; finished = true; cleanup();
          if (error) reject(error); else resolve(result);
        };
        const changed = () => {
          if (finished) return;
          clearTimeout(timer);
          try {
            background ||= document.visibilityState !== 'visible';
            check();
            // Keep every existing completion/ownership check on each wake. A
            // quiet DOM or an unchanged string alone never proves completion.
            const candidate = dom.finalCandidate(document, baseline, user);
            const now = Date.now();
            observe?.(candidate);
            if (now >= deadline) throw new Error('没有识别到明确完成的最终回复；已停止转发');
            const current = fingerprint(candidate);
            if (candidate && firstCandidateAt === null) firstCandidateAt = now;
            if (!candidate || current !== previous) { previous = current; stableSince = now; }
            const stableMs = candidate?.images?.length ? 1200 : 800;
            const remaining = stableMs - (now - stableSince);
            if (candidate && remaining <= 0) {
              finish(null, { finalAnswer: candidate, confirmationMs: now - firstCandidateAt, background });
              return;
            }
            timer = setTimeout(changed, Math.max(1, Math.min(250, deadline - now, candidate ? remaining : 250)));
          } catch (error) { finish(error); }
        };
        const observer = new MutationObserver(changed);
        // The bridge badge is attached outside body. Observing body also keeps
        // its own status updates from repeatedly waking completion detection.
        observer.observe(document.body || document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
        // Image completion and returning to a hidden tab need not mutate DOM.
        document.addEventListener('load', changed, true);
        document.addEventListener('visibilitychange', changed);
        document.addEventListener('resume', changed);
        window.addEventListener('pageshow', changed);
        window.addEventListener('focus', changed);
        activeWaits.add(changed);
        changed();
      });
    }
    async function resumeChallenge(job, check, deadline) {
      while (Date.now() < deadline) {
        check();
        if (dom.pageChallengeActive(document)) {
          status('已刷新一次：请手动完成网页验证，完成后会在任务时限内继续');
          await sleep(500); continue;
        }
        const context = dom.restoreChallengeContext(document, job.recovery);
        if (!context) { status('已刷新一次：等待原消息加载'); await sleep(500); continue; }
        let button;
        try { button = dom.challengeRetryButton(document, context.user); }
        catch (error) {
          if (error.message === '暂未找到 ChatGPT 输入框，等待网页加载') { await sleep(500); continue; }
          throw error;
        }
        try {
          // Reload can mount the owned user turn before its error card or
          // answer. An empty candidate is still loading, not evidence that
          // the original failure recovered. Keep the unused single retry
          // available until a complete answer or the error surface appears.
          if (dom.finalCandidate(document, context.baseline, context.user)) return context;
          await sleep(250); continue;
        }
        catch (error) {
          if (error.code !== 'CHATGPT_CLOUDFLARE_CHALLENGE') throw error;
          if (!button) { status('已刷新一次：等待原回复的重试按钮或手动处理验证'); await sleep(500); continue; }
        }
        // Persist before clicking: a lost acknowledgement or another reload
        // must never authorize a second retry of this failed response.
        await rpc('bridge:challenge-retry', { jobId: job.id, conversationUrl: job.conversationUrl });
        check();
        const current = dom.restoreChallengeContext(document, job.recovery);
        if (!current || dom.challengeRetryButton(document, current.user) !== button) throw new Error('重试前网页内容发生变化，已停止自动操作');
        button.click();
        status('已刷新并重试一次，等待原消息的回复');
        const settleUntil = Math.min(deadline, Date.now() + 5000);
        while (Date.now() < settleUntil) {
          check();
          try { dom.finalCandidate(document, current.baseline, current.user); return current; }
          catch (error) { if (error.code !== 'CHATGPT_CLOUDFLARE_CHALLENGE') throw error; }
          await sleep(250);
        }
        throw new Error('已刷新并重试一次，ChatGPT 仍返回 cloudflare_challenge；请在原网页手动处理验证');
      }
      throw new Error('等待网页验证恢复超时；已停止，不会再次刷新或重试');
    }
    async function run(job) {
      platformLabel = job.platform === 'feishu' ? '飞书' : job.platform === 'qq' ? 'QQ ' : '机器人';
      const url = job.conversationUrl;
      const deadline = Date.now() + job.timeoutMs;
      let human = false; let ownEditing = false; let submissionClicked = false;
      let input = null; let baseline = null; let user = null; let inputPreparationMs = 0;
      const bridgeIdleMs = Math.min(2592000000, Math.max(0, job.idleRefresh?.idleMs ?? job.recoveryBridgeIdleMs ?? Date.now() - bridgeIdleSince));
      let phase = 'prepare';
      let backgroundRendering = null;
      const recorder = assistant === 'qwen' ? dom.createObservationRecorder?.(Date.now()) : null;
      let observationPending = null, observationSending = false, latestObservation;
      let lastObservationCheck = -Infinity, lastObservationHidden, lastObservationCandidate, lastObservationFocused, lastObservationPhase;
      const sendObservation = async () => {
        if (observationSending) return;
        observationSending = true;
        try {
          while (observationPending) {
            const samples = observationPending; observationPending = null;
            await rpc('bridge:qwen-observation', { jobId: job.id, conversationUrl: url, samples });
          }
        } catch { /* Diagnostic delivery must never stop or retry an AI task. */ }
        finally { observationSending = false; }
      };
      const observe = recorder ? (candidate, currentUser = user) => {
        try {
          const now = Date.now();
          const hidden = document.visibilityState !== 'visible', focused = document.hasFocus();
          if (now - lastObservationCheck < 1000 && hidden === lastObservationHidden && Boolean(candidate) === lastObservationCandidate && focused === lastObservationFocused && phase === lastObservationPhase) return;
          lastObservationCheck = now; lastObservationHidden = hidden; lastObservationCandidate = Boolean(candidate); lastObservationFocused = focused; lastObservationPhase = phase;
          const samples = recorder.capture(now, { ...dom.backgroundObservation(document, baseline, currentUser), candidate: Boolean(candidate), phase, ...backgroundRendering?.stats(),
            wakeAgeMs: Math.min(3600000, Math.max(0, now - lastWorkerWakeAt)) });
          if (samples) {
            latestObservation = samples;
            // The final samples ride with the result, avoiding a diagnostic RPC
            // queued in front of delivery and proving when the worker receives it.
            if (phase !== 'delivery') { observationPending = samples; void sendObservation(); }
          }
        } catch { /* DOM diagnostics are optional and cannot alter completion. */ }
      } : undefined;
      const diagnostics = () => ({ pageAgeMs: Math.min(2592000000, Math.max(0, Date.now() - pageOpenedAt)), bridgeIdleMs,
        visibility: document.visibilityState === 'visible' ? 'visible' : 'hidden', phase });
      const guard = event => {
        if (!event.isTrusted || ownEditing) return;
        const target = event.target;
        const control = target instanceof Element ? target.closest('button, [role="button"]') : null;
        if (event.type === 'pointerdown' && control && /^(?:重试|retry|try again)$/i.test(normalizeText(control.getAttribute('aria-label') || control.textContent))) human = true;
        if (target instanceof Element && dom.composerInteraction(target, input) && interruptsComposer(event, submissionClicked)) human = true;
      };
      const check = () => {
        if (Date.now() > deadline) throw new Error(`等待 ${assistantLabel} 回复超时；不会重新提问`);
        if (conversationUrl(location.href, assistant) !== url) throw new Error('当前网页切换了对话，任务已停止');
        if (human) throw new Error('检测到人工操作输入框，任务已停止，未转发后续内容');
        // Before submission, the original composer owns this draft and its
        // verified attachments. After the one send click, layout changes may
        // remount that now-unused editor; the conversation and submitted-turn
        // checks below remain authoritative throughout confirmation/delivery.
        if (!submissionClicked && input && dom.refreshComposer) input = dom.refreshComposer(document, input);
        if (!submissionClicked && input && !input.isConnected) throw new Error('网页输入框被替换或页面已退出登录');
      };
      ['beforeinput', 'input', 'keydown', 'paste', 'pointerdown'].forEach(name => document.addEventListener(name, guard, true));
      try {
        // Legacy jobs without a provider remain ChatGPT-only. Other work must
        // be explicitly labeled by the trusted extension worker.
        if ((job.assistant || 'chatgpt') !== assistant) throw new Error('任务助手与当前网页不一致，已停止发送');
        if (job.recovery) {
          if (assistant !== 'chatgpt') throw new Error('当前助手不支持此恢复操作');
          submissionClicked = true;
          phase = 'challenge-recovery';
          ({ user, baseline } = await resumeChallenge(job, check, deadline));
        } else {
          const inputImages = dom.validateInputImages(job.images);
          if (job.idleRefresh) {
            const readyDeadline = Math.min(deadline, Date.now() + 30000);
            let restored = false;
            while (Date.now() < readyDeadline) {
              check();
              try {
                dom.assertReady(document);
                restored = dom.snapshot(document).lastUserKey === job.idleRefresh.lastUserKey;
                if (restored) break;
              } catch (error) {
                if (!/^(?:暂未找到 ChatGPT 输入框|ChatGPT 模型尚未加载|上一条网页提问尚未明确完成|网页正在验证)/.test(error.message)) throw error;
              }
              status('已刷新一次：等待原对话与输入区恢复');
              await sleep(250);
            }
            if (!restored) throw new Error('发送前刷新后，原对话或输入区尚未恢复；未提交提问，请检查网页');
          }
          check(); input = dom.assertReady(document); baseline = dom.snapshot(document);
          if (assistant === 'chatgpt' && !job.idleRefresh && bridgeIdleMs >= IDLE_REFRESH_MS) {
            phase = 'idle-refresh';
            status('桥接长时间闲置，发送前刷新原网页一次');
            await rpc('bridge:idle-prepare', { jobId: job.id, conversationUrl: url, lastUserKey: baseline.lastUserKey, diagnostics: diagnostics() });
            check(); dom.assertReady(document);
            if (dom.newUsers(document, baseline).length) throw new Error('刷新前出现了新消息，已停止刷新和发送');
            reloading = true;
            try { location.reload(); } catch (error) { reloading = false; throw error; }
            return;
          }
          status('正在确认本次任务');
          await rpc('bridge:started', { jobId: job.id, conversationUrl: url });
          if (assistant === 'qwen' && dom.beginBackgroundRendering) {
            backgroundRendering = dom.beginBackgroundRendering(document, Math.max(1, deadline - Date.now()));
            activeWaits.add(backgroundRendering.wake);
          }
          observe?.(null);
          const inputPreparationStartedAt = Date.now();
          check(); dom.assertReady(document);
          if (dom.newUsers(document, baseline).length) throw new Error('确认期间出现了新消息，已停止发送');
          const attachmentNames = [];
          const assertDraft = () => {
            check();
            if (normalizeText(dom.composerText(input)) || dom.newUsers(document, baseline).length || dom.generating(document)) throw new Error('准备图片期间页面内容已变化，已停止发送');
          };
          for (const [index, metadata] of inputImages.entries()) {
            assertDraft();
            if (!dom.inputAttachmentState(input, attachmentNames).ready) throw new Error('准备图片前发现不属于本次任务的附件，已停止发送');
            status(`正在读取群消息图片 ${index + 1}/${inputImages.length}`);
            const payload = await rpc('bridge:input-image', { jobId: job.id, conversationUrl: url, imageId: metadata.id });
            assertDraft();
            if (!dom.inputAttachmentState(input, attachmentNames).ready) throw new Error('读取图片期间附件发生变化，已停止发送');
            if (payload.imageId !== metadata.id || payload.mimeType !== metadata.mimeType || payload.name !== metadata.name) throw new Error('群消息图片校验不一致，已停止发送');
            const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[metadata.mimeType];
            const name = `bridge-${crypto.randomUUID()}-${index + 1}.${extension}`;
            attachmentNames.push(name);
            status(`正在向 ${assistantLabel} 添加图片 ${index + 1}/${inputImages.length}`);
            ownEditing = true;
            try { (dom.attachInputImage || dom.pasteInputImage)(document, input, payload, name); } finally { ownEditing = false; }
            const uploadDeadline = Math.min(deadline, Date.now() + 60000);
            let ready = false; let attachmentState; let previousReason;
            while (Date.now() < uploadDeadline) {
              assertDraft();
              attachmentState = dom.inputAttachmentState(input, attachmentNames);
              if (attachmentState.ready) { ready = true; break; }
              const reason = attachmentState.reason || 'name-mismatch';
              if (reason !== previousReason) {
                const detail = { 'no-attachment': '等待附件出现', uploading: '等待上传完成', verifying: '核对图片内容', 'name-mismatch': '确认附件身份' }[reason] || '确认附件身份';
                status(`等待 ${assistantLabel} 确认图片 ${index + 1}/${inputImages.length}：${detail}`);
                previousReason = reason;
              }
              await sleep(200);
            }
            if (!ready) {
              const detail = assistant !== 'chatgpt' ? ({
                'no-attachment': dom.attachInputImage ? `${assistantLabel} 未显示本次图片附件，文件添加尚未获得网页确认` : `${assistantLabel} 未显示本次图片附件，模拟粘贴尚未获得网页确认`,
                'name-mismatch': `${assistantLabel} 附件名称或数量与本次图片不一致，尚未完成内容校验`,
                verifying: `${assistantLabel} 图片内容校验未完成`, uploading: `${assistantLabel} 图片仍在上传或处理`,
              }[attachmentState?.reason] || `${assistantLabel} 附件数量、内容或上传状态未能确认`) : '';
              throw new Error('未确认本次图片附件已上传完成，已停止发送；' + (detail || '请在网页检查附件'));
            }
          }
          assertDraft();
          ownEditing = true;
          try { dom.insertPrompt(document, input, job.prompt); } finally { ownEditing = false; }
          const assertPrepared = () => {
            check();
            if (dom.composer(document) !== input) throw new Error('网页输入框发生变化，已停止发送');
            if (!dom.inputAttachmentState(input, attachmentNames).ready) throw new Error('发送前附件与本次群消息不一致或仍在上传，已阻止发送');
            if (normalizeText(dom.composerText(input)) !== normalizeText(job.prompt) || dom.newUsers(document, baseline).length || dom.generating(document)) throw new Error('发送前页面内容已变化，已阻止发送');
          };
          status('正在确认图文输入');
          // Attachments can enable Send before the controlled editor has committed
          // the inserted text. Always yield real tasks and require a stable composer
          // and button; a synchronous DOM text check alone is not an acknowledgement.
          const settleDeadline = Math.min(deadline, Date.now() + 5000);
          let stableButton = null; let inputStableSince = 0; let button = null;
          while (Date.now() < settleDeadline) {
            await sleep(100);
            assertPrepared();
            const current = dom.sendButton(document, input);
            if (!current) { stableButton = null; inputStableSince = 0; }
            else if (current !== stableButton) { stableButton = current; inputStableSince = Date.now(); }
            else if (Date.now() - inputStableSince >= 600) { button = current; break; }
          }
          if (!button) throw new Error('图文输入或发送按钮尚未稳定，已停止发送；请在网页检查草稿');
          assertPrepared();
          if (dom.sendButton(document, input) !== button) throw new Error('发送按钮发生变化，已停止发送');
          inputPreparationMs = Date.now() - inputPreparationStartedAt;
          submissionClicked = true;
          phase = 'submit';
          button.click(); // Exactly one click. Never retry submission.
          status('已发送，等待本次完整回复');
          user = await confirmedUser({ baseline, prompt: job.prompt, check, deadline, observe });
        }
        const fingerprint = candidate => candidate ? JSON.stringify({ text: candidate.text, images: candidate.images || [] }) : '';
        phase = job.recovery ? 'challenge-recovery' : 'answer';
        const { finalAnswer, confirmationMs, background } = await completedAnswer({ baseline, user, check, deadline, fingerprint, observe });
        if (finalAnswer.text.length > 120000) throw new Error('最终回复超过 120000 字符，已停止回传；请在网页查看');
        check();
        // One last DOM check prevents a late stream update or manual new turn from slipping through.
        const assertFinal = () => { check(); if (fingerprint(dom.finalCandidate(document, baseline, user)) !== fingerprint(finalAnswer)) throw new Error('最终回复仍在变化，已停止转发'); };
        assertFinal();
        const preparationStartedAt = Date.now();
        const payloads = new Array(finalAnswer.images.length);
        let nextImage = 0; let readFailed = false;
        const readImages = async () => {
          try {
            while (!readFailed && nextImage < finalAnswer.images.length) {
              const index = nextImage++;
              assertFinal();
              status(`正在读取回复图片 ${index + 1}/${finalAnswer.images.length}`);
              const payload = await dom.readAnswerImage(finalAnswer.images[index]);
              assertFinal(); payloads[index] = payload;
            }
          } catch (error) { readFailed = true; throw error; }
        };
        // Only reads overlap. Settle every reader before rejecting, then persist
        // images in their original order and submit one complete final result.
        const reads = await Promise.allSettled(Array.from({ length: Math.min(2, payloads.length) }, readImages));
        const failedRead = reads.find(result => result.status === 'rejected');
        if (failedRead) throw failedRead.reason;
        if (payloads.reduce((sum, payload) => sum + payload.byteLength, 0) > dom.MAX_TOTAL_IMAGE_BYTES) throw new Error('本次回复图片合计超过 30 MB，请在网页查看完整结果');
        const images = [];
        for (const [index, payload] of payloads.entries()) {
          assertFinal();
          status(`正在回传图片 ${index + 1}/${payloads.length}`);
          const uploaded = await rpc('bridge:image', { jobId: job.id, conversationUrl: url, index, mimeType: payload.mimeType, base64: payload.base64 });
          if (!/^[a-f0-9]{64}$/.test(uploaded.imageId || '')) throw new Error('图片上传未获得有效确认，已停止回传');
          images.push(uploaded.imageId);
        }
        assertFinal();
        const timing = { confirmationMs, inputPreparationMs, imagePreparationMs: Date.now() - preparationStartedAt, background };
        phase = 'delivery';
        observe?.(finalAnswer);
        const result = await rpc('bridge:result', { jobId: job.id, conversationUrl: url, text: finalAnswer.text, images, timing, ...(latestObservation ? { observation: latestObservation } : {}) });
        if (result.failed) throw new Error(result.error || '最终回复未回传');
        status(result.pending ? '回复已暂存，将在有效回复时间内重试' : '本次回复已交给' + platformLabel + '扩展处理');
      } catch (error) {
        if (assistant === 'chatgpt' && !job.recovery && user && error.code === 'CHATGPT_CLOUDFLARE_CHALLENGE') {
          try {
            check();
            const checkpoint = dom.challengeCheckpoint(document, baseline, user, job.prompt);
            status('检测到 cloudflare_challenge，准备刷新一次并恢复原任务');
            await rpc('bridge:challenge-prepare', { jobId: job.id, conversationUrl: url, checkpoint, diagnostics: diagnostics() });
            check();
            if (JSON.stringify(dom.challengeCheckpoint(document, baseline, user, job.prompt)) !== JSON.stringify(checkpoint)) throw new Error('刷新前网页消息发生变化，已停止自动恢复');
            reloading = true;
            location.reload();
            return;
          } catch (recoveryError) { reloading = false; error = recoveryError; }
        }
        status(error.message || '本次任务已停止');
        await rpc('bridge:error', { jobId: job.id, conversationUrl: url, error: String(error.message || '网页任务失败').slice(0, 240),
          ...(assistant === 'chatgpt' ? { diagnostics: diagnostics() } : {}) }).catch(() => {});
        // Preserve any draft on failure. Never clear text that a human may have touched.
      } finally {
        if (backgroundRendering) { activeWaits.delete(backgroundRendering.wake); backgroundRendering.stop(); }
        bridgeIdleSince = Date.now();
        if (input) dom.releaseInputImages?.(input);
        ['beforeinput', 'input', 'keydown', 'paste', 'pointerdown'].forEach(name => document.removeEventListener(name, guard, true));
      }
    }
    async function poll(wake = false) {
      if (reloading) return;
      if (running) { if (wake) wakePending = true; return; }
      // Cover readiness and the lease RPC as well as the whole page job. A
      // notification arriving before the RPC resolves must never lease twice.
      running = true;
      let ready = false; let handledJob = false;
      try {
        const url = conversationUrl(location.href, assistant);
        if (!url) { if (badge.isConnected) badge.remove(); return; }
        if (assistant === 'chatgpt' && !recoveryChecked) {
          const recovery = await rpc('bridge:challenge-resume', { conversationUrl: url });
          recoveryChecked = true;
          if (recovery?.job) { handledJob = true; await run(recovery.job); return; }
        }
        // Do not lease queued work while the user has a draft or another answer is generating.
        dom.assertReady(document);
        ready = true;
        const response = await rpc('bridge:poll', { conversationUrl: url, capabilities: ['image-input-v1'] });
        if (!response.job) {
          if (response.notice) status(response.notice);
          else if (response.busy) status('网页已就绪，后台任务仍在处理中', true);
          else if (transientStatus || !lastPersistentStatus || !badge.isConnected) status(lastPersistentStatus || '网页已就绪，暂无可执行任务');
          return;
        }
        handledJob = true;
        await run(response.job);
      } catch (error) {
        status(error.name === 'PageSafetyError' ? '等待网页就绪：' + error.message : (error.message || '扩展后台未连接'), true);
      } finally {
        running = false;
        const again = wakePending;
        wakePending = false;
        // Coalesce notifications during a job into one ordinary safe poll,
        // and drain work that was queued before the listener was registered.
        // A blocked composer waits for a later external wake or fallback.
        if ((again || handledJob) && ready && !reloading) void poll();
      }
    }
    chrome.runtime.onMessage.addListener((message, sender) => {
      if (message?.type !== 'bridge:wake' || !chrome.runtime.id || sender?.id !== chrome.runtime.id || sender.tab !== undefined) return;
      if (sender.url !== undefined && sender.url !== chrome.runtime.getURL('worker.js')) return;
      lastWorkerWakeAt = Date.now();
      wakeWaits(); void poll(true);
    });
    const wakePage = () => { wakeWaits(); void poll(true); };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wakePage(); });
    // Restoring a frozen/BFCache document or focusing its window need not
    // produce a visibility change. Reuse the single-flight/readiness checks;
    // these events never reload a page, clear a draft or repeat a submission.
    window.addEventListener('pageshow', event => { if (event.persisted) wakePage(); });
    document.addEventListener('resume', wakePage);
    window.addEventListener('focus', wakePage);
    setInterval(() => { poll(); }, 4500);
    await poll();
  })().catch(() => { status('扩展已更新，请手动重新加载此网页'); });
})();
