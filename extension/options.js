import { observationLines } from './background-observation.js';
const $ = id => document.getElementById(id);
const PLATFORMS = {
  qq: { name: 'QQ', title: 'QQ 官方机器人', description: '使用 QQ 开放平台的 AppID / AppSecret', groupId: 'group_openid', appPlaceholder: '输入纯数字 AppID' },
  feishu: { name: '飞书', title: '飞书应用机器人', description: '使用飞书开放平台的 App ID / App Secret', groupId: 'chat_id', appPlaceholder: 'cli_…' }
};
const ASSISTANTS = {
  chatgpt: { name: 'ChatGPT', path: '/c/' },
  claude: { name: 'Claude', path: '/chat/' },
  qwen: { name: 'Qwen', path: '/c/<会话 ID>（海外版 chat.qwen.ai）' },
  gemini: { name: 'Gemini', path: '/app/<会话 ID>（多账号也支持 /u/<账号编号>/app/<会话 ID>）' }
};
const drafts = new Map();
let channelStatuses = {};
let activeAssistant = 'chatgpt', renderedAssistant = null, assistantStatuses = {}, viewReady = false;
let activePlatform = null, tabs = [], refreshing = false, busy = false, replyStyleDirty = false, hasNotices = false, hasHistory = false;
let feedbackOwner = 'connection';
async function rpc(type, data = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...data });
  if (!response?.ok) throw new Error(response?.error || '扩展后台没有响应');
  return response.data;
}
function platformRpc(type, data, scope) { return rpc(type, { ...data, assistant: scope.assistant, platform: scope.platform }); }
function scopeName(scope = { assistant: activeAssistant, platform: activePlatform }) { return `${ASSISTANTS[scope.assistant].name} · ${PLATFORMS[scope.platform].name}`; }
function saveDraft() {
  if (!renderedAssistant || !activePlatform) return;
  drafts.set(`${renderedAssistant}:${activePlatform}`, {
    appId: $('app-id').value, words: $('blocked-words').value, manualGroup: $('manual-group').value,
    group: $('group').value, tab: $('tab').value, replyStyle: $('reply-style').value, replyStyleDirty
  });
}
function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function feedback(text, error = false, owner = 'action', pending = false) {
  feedbackOwner = owner;
  const banner = $('feedback'); banner.hidden = false; banner.className = error ? 'error' : pending ? 'pending' : ''; banner.textContent = text;
}
function controls() {
  const disabled = busy || refreshing || !viewReady || !activePlatform || renderedAssistant !== activeAssistant;
  document.querySelectorAll('form button, #bindings button, #jobs button').forEach(button => { button.disabled = disabled; });
  for (const assistant of Object.keys(ASSISTANTS)) {
    $('view-' + assistant).disabled = busy || refreshing || assistant === activeAssistant;
    $('view-' + assistant).textContent = assistant === activeAssistant ? `正在配置 ${ASSISTANTS[assistant].name}` : `配置 ${ASSISTANTS[assistant].name}`;
    $('enabled-' + assistant).disabled = disabled || !assistantStatuses[assistant];
  }
  for (const [platform, meta] of Object.entries(PLATFORMS)) {
    $('view-platform-' + platform).disabled = disabled || platform === activePlatform;
    $('view-platform-' + platform).textContent = platform === activePlatform ? `正在配置 ${meta.name}` : `配置 ${meta.name}`;
    $('enabled-platform-' + platform).disabled = disabled || typeof channelStatuses[platform]?.enabled !== 'boolean';
  }
  $('refresh').disabled = busy || refreshing;
  $('clear-notices').disabled = disabled || !hasNotices;
  $('clear-history').disabled = disabled || !hasHistory;
  $('reply-style').disabled = disabled || activePlatform !== 'feishu';
  $('reply-style-form').querySelector('button').disabled = disabled || activePlatform !== 'feishu';
}
function platformView(assistant, platform, status, words) {
  saveDraft();
  const meta = PLATFORMS[platform], agent = ASSISTANTS[assistant], draft = drafts.get(`${assistant}:${platform}`);
  activePlatform = platform; renderedAssistant = assistant;
  document.body.dataset.platform = platform; document.body.dataset.assistant = assistant;
  $('platform-title').textContent = `${agent.name} 的机器人通道`;
  $('app-title').textContent = `${agent.name} · ${meta.title}`; $('app-description').textContent = meta.description;
  $('app-id-label').textContent = platform === 'qq' ? 'AppID' : 'App ID';
  $('app-secret-label').textContent = platform === 'qq' ? 'AppSecret' : 'App Secret';
  $('app-id').placeholder = meta.appPlaceholder; $('app-id').value = draft?.appId ?? status.appId ?? '';
  $('app-id').inputMode = platform === 'qq' ? 'numeric' : 'text';
  if (platform === 'qq') { $('app-id').pattern = '[0-9]+'; $('app-id').title = 'QQ AppID 只能包含数字'; }
  else { $('app-id').removeAttribute('pattern'); $('app-id').removeAttribute('title'); }
  $('app-secret').value = ''; $('manual-group').value = draft?.manualGroup || '';
  $('group').replaceChildren(new Option('', ''));
  if (draft?.group) $('group').add(new Option(draft.group, draft.group));
  $('group').value = draft?.group || '';
  $('tab').replaceChildren(new Option('', ''));
  if (draft?.tab) $('tab').add(new Option(draft.tab, draft.tab));
  $('tab').value = draft?.tab || '';
  $('blocked-words').value = draft?.words ?? (words?.words || []).join('\n');
  $('words-platform').textContent = `${agent.name} · ${meta.name} 的独立词表；通过后才送进 ${agent.name}`;
  $('save-words').textContent = `保存 ${agent.name} · ${meta.name} 词表`;
  $('save-app').textContent = `保存 ${agent.name} · ${meta.name} 凭据`;
  $('credential-hint').textContent = `凭据只用于连接${meta.name}，不传入 ${agent.name} 页面。首次配置需要填写密钥。停用时保存不会自动开启助手。`;
  $('bind-hint').textContent = `先在 ${agent.name} 新建专用对话并手动发送一句话，使地址包含 ${agent.path}。在${meta.name}群 @ 机器人一次，再刷新群列表；也可手动填写 ${meta.groupId}${platform === 'qq' ? '（不是 QQ 群号）' : ''}。QQ 与飞书请分别使用不同的专用对话和标签页。绑定后，群成员共用这段对话的上下文。`;
  $('bindings-title').textContent = `${agent.name} · ${meta.name} 群与网页绑定`;
  $('group-label').textContent = `选择 ${agent.name} · ${meta.name} 发现的群`;
  $('tab-label').textContent = `选择已打开的 ${agent.name} 对话`;
  $('manual-group').placeholder = `手动输入 ${meta.groupId}（可选）`;
  $('manual-group').setAttribute('aria-label', `手动输入群 ${meta.groupId}`);
  $('reply-style-section').hidden = platform !== 'feishu';
  $('reply-style-title').textContent = `${agent.name} 的飞书回复样式`;
  $('qq-guide').hidden = platform !== 'qq'; $('feishu-guide').hidden = platform !== 'feishu';
  $('state-title').textContent = `${agent.name} · ${meta.name} 运行状态`;
  $('notices-title').textContent = `${agent.name} · ${meta.name} 历史故障提示`;
  $('clear-notices').textContent = `清除 ${agent.name} · ${meta.name} 历史提示`;
  replyStyleDirty = Boolean(draft?.replyStyleDirty);
  if (replyStyleDirty) $('reply-style').value = draft.replyStyle;
  feedbackOwner = 'connection';
}
function renderAssistants(status) {
  assistantStatuses = status.assistants || { ...assistantStatuses, [activeAssistant]: status };
  for (const [assistant, meta] of Object.entries(ASSISTANTS)) {
    const summary = assistantStatuses[assistant];
    $('enabled-' + assistant).checked = Boolean(summary?.enabled);
    $('assistant-card-' + assistant).classList.toggle('selected', assistant === activeAssistant);
    const platform = PLATFORMS[summary?.platform]?.name || '未选择平台';
    const connection = { connected: '已连接', connecting: '连接中', reconnecting: '正在重连', error: '连接异常', stopped: '未连接' }[summary?.connection?.state] || '未连接';
    $('assistant-status-' + assistant).textContent = summary?.platforms ? Object.entries(PLATFORMS).map(([id, meta]) => `${meta.name} ${channelLabel(summary.platforms[id], summary.enabled)}`).join(' · ') : summary ? `${summary.enabled ? '已开启' : '已停用'} · ${platform} · ${summary.configured ? '已配置' : '未配置'}${summary.enabled ? ' · ' + connection : ''}` : `${meta.name} 状态尚未确认`;
  }
  const name = ASSISTANTS[activeAssistant].name;
  $('brand-logo').src = `assets/${activeAssistant}.svg`;
  $('brand-logo').alt = name; $('brand-logo').dataset.assistant = activeAssistant;
  $('active-assistant-logo').src = `assets/${activeAssistant}.svg`;
  $('active-assistant-logo').dataset.assistant = activeAssistant;
  $('active-assistant').textContent = `正在配置 ${name} · ${status.enabled ? '已开启' : '已停用，可编辑配置'}`;
  $('active-platform').textContent = `正在配置 ${PLATFORMS[activePlatform].name} · 两个通道可同时启用`;
}
function channelLabel(channel, masterEnabled) {
  if (!channel?.enabled) return '已停用';
  if (!masterEnabled) return '待助手开启';
  if (!channel.configured) return '待配置';
  return { connected: '已连接', connecting: '连接中', reconnecting: '重连中', error: '连接异常', stopped: '未连接' }[channel.connection?.state] || '未连接';
}
function connectionFeedback(status) {
  if (feedbackOwner !== 'connection') return;
  const name = scopeName(), agent = ASSISTANTS[activeAssistant].name, state = status.connection?.state || 'stopped', groups = status.groups || [];
  if (!status.enabled) {
    feedback(`${name} 已停用。可以保存凭据、词表和群绑定；准备好后打开上方 ${agent} 开关。`, false, 'connection');
  } else if (status.channelEnabled === false) {
    feedback(`${name} 通道已停用。可以编辑配置；打开该通道开关后接收群提问。`, false, 'connection');
  } else if (state === 'connected') {
    const bound = groups.filter(group => group.binding).length;
    const next = bound ? `已绑定 ${bound} 个群，可在对应群 @ 机器人提问。` : groups.length ? `已发现 ${groups.length} 个群；下一步请选择群和已打开的 ${agent} 对话完成绑定。` : `下一步：把机器人加入目标群，在群内 @ 它一次，然后刷新并绑定 ${agent} 对话。`;
    feedback(`${name} 已连接。${next}`, false, 'connection');
  } else if (['connecting', 'reconnecting'].includes(state)) feedback(`${name} 配置已保存，正在连接。状态会自动更新，无需重复保存。`, false, 'connection', true);
  else if (state === 'error') feedback(`${name} 连接失败：${status.connection?.error || '请检查应用配置和扩展后台状态。'}`, true, 'connection');
  else if (status.configured) feedback(`${name} 连接已停止或尚未确认。请稍后刷新，必要时重新保存配置。`, true, 'connection');
  else feedback(`尚未配置 ${name} 机器人。请填写对应平台的应用凭据。`, false, 'connection', true);
}
const states = { queued: '排队中', leased: '等待网页', started: '网页生成中', running: '网页生成中', generating: '网页生成中', sending: '发送中', delivering: '发送中', completed: '网页已完成', failed: '已停止', cancelled: '已取消', result_pending: '等待回传', 'result-pending': '等待回传', pending: '等待中' };
function renderGroups(groups) {
  const platform = activePlatform, assistant = activeAssistant, selected = $('group').value;
  $('group').replaceChildren(new Option(`选择群，或填写 ${PLATFORMS[platform].groupId}`, ''));
  for (const group of groups) $('group').add(new Option((group.name || group.chatId) + (group.binding ? ' · 已绑定' : ''), group.chatId));
  if (groups.some(group => group.chatId === selected)) $('group').value = selected;
  $('bindings').replaceChildren();
  for (const group of groups.filter(group => group.binding)) {
    const row = el('div', undefined, 'row'), detail = el('div'), button = el('button', '解除绑定', 'danger'); button.type = 'button';
    detail.append(el('strong', group.name || group.chatId), el('p', group.binding.conversationUrl), el('small', `标签页 ${group.binding.tabId} · ${group.chatId}`));
    button.addEventListener('click', () => action(async current => {
      if (current.platform !== platform || current.assistant !== assistant) throw new Error('助手或平台已变化，请刷新后再解除绑定。');
      await platformRpc('options:unbind', { chatId: group.chatId }, current); feedback(`已解除 ${scopeName(current)} 的群绑定。`); await refresh();
    }));
    row.append(detail, button); $('bindings').append(row);
  }
  if (!$('bindings').childElementCount) $('bindings').append(el('p', '尚未绑定会话。首次绑定后才会处理群提问。', 'empty'));
}
function renderJobs(jobs) {
  const scope = { assistant: activeAssistant, platform: activePlatform };
  $('jobs').replaceChildren();
  for (const job of jobs.filter((job, index) => index < 12 || job.state === 'queued')) {
    const row = el('div', undefined, 'row'), detail = el('div');
    detail.append(el('strong', job.chatId), el('p', job.error || `任务 ${job.id}`), el('small', new Date(job.createdAt).toLocaleString('zh-CN')));
    if (job.timing) {
      const stages = [['handoffMs', '收到→网页接手'], ['inputPreparationMs', '网页输入准备'], ['confirmationMs', '完成确认'], ['imagePreparationMs', '回复图片准备'], ['queueMs', '发送排队'], ['deliveryMs', '平台回传']]
        .filter(([key]) => Number.isFinite(job.timing[key])).map(([key, label]) => `${label} ${(job.timing[key] / 1000).toFixed(1)} 秒`);
      if (job.timing.background) stages.push('确认期间网页在后台');
      if (stages.length) detail.append(el('small', stages.join(' · '), 'timing'));
    }
    const actions = el('div', undefined, 'job-actions'), state = el('span', states[job.state] || job.state, 'state' + (job.state === 'failed' ? ' failed' : ''));
    actions.append(state);
    if (job.state === 'queued') {
      const button = el('button', '取消任务', 'danger'); button.type = 'button';
      button.setAttribute('aria-label', `取消任务 ${job.id}`);
      button.addEventListener('click', () => action(async current => {
        if (current.assistant !== scope.assistant || current.platform !== scope.platform) throw new Error('助手或平台已变化，请刷新后再取消任务。');
        button.textContent = '正在取消…';
        feedback(`正在取消 ${scopeName(scope)} 的排队任务…`, false, 'action', true);
        let cancelError;
        try {
          await platformRpc('options:cancel-job', { jobId: job.id }, scope);
          state.textContent = states.cancelled; button.remove();
        } catch (error) { cancelError = error; }
        // Refresh even after a conflict: the task may have started while this row was visible.
        viewReady = false;
        try { await refresh(); }
        catch (error) {
          throw new Error(`${cancelError ? cancelError.message : '任务已取消'}；状态刷新失败：${error.message}`);
        }
        if (cancelError) throw cancelError;
        feedback(`已取消 ${scopeName(scope)} 的排队任务。`);
      }));
      actions.append(button);
    }
    row.append(detail, actions); $('jobs').append(row);
  }
  if (!jobs.length) $('jobs').append(el('p', assistantStatuses[activeAssistant]?.enabled && channelStatuses[activePlatform]?.enabled ? `暂无任务。到已绑定的${PLATFORMS[activePlatform].name}群 @ 机器人即可开始。` : '当前助手或通道已停用。配置完成后，打开对应开关接收群提问。', 'empty'));
}
async function refresh() {
  if (refreshing) return;
  refreshing = true; controls();
  try {
    const assistant = activeAssistant;
    const status = await rpc('options:status', { assistant });
    if (status.assistant && status.assistant !== assistant) throw new Error('后台返回的助手不匹配，请刷新。');
    if (!PLATFORMS[status.platform]) throw new Error('后台返回的平台无效，请重新加载扩展。');
    const changed = assistant !== renderedAssistant || status.platform !== activePlatform;
    if (changed) viewReady = false;
    const scope = { assistant, platform: status.platform };
    const [opened, words] = await Promise.all([
      platformRpc('options:tabs', {}, scope),
      changed ? platformRpc('options:moderation', {}, scope) : Promise.resolve(null)
    ]);
    if (changed) platformView(assistant, status.platform, status, words);
    channelStatuses = status.platforms || {};
    renderAssistants(status);
    const selected = $('tab').value; tabs = opened.tabs || [];
    $('tab').replaceChildren(new Option(tabs.length ? '选择一个专用对话' : '没有已打开的固定对话，请先创建', ''));
    for (const tab of tabs) $('tab').add(new Option(`${tab.title} · 标签页 ${tab.tabId}`, String(tab.tabId)));
    if (tabs.some(tab => String(tab.tabId) === selected)) $('tab').value = selected;
    $('tab').dispatchEvent(new Event('change'));
    renderGroups(status.groups || []); renderJobs(status.jobs || []);
    if (!replyStyleDirty) $('reply-style').value = status.replyStyle === 'card' ? 'card' : 'separate';
    for (const [platform, meta] of Object.entries(PLATFORMS)) {
      const saved = channelStatuses[platform];
      $('platform-card-' + platform).classList.toggle('selected', platform === activePlatform);
      $('enabled-platform-' + platform).checked = Boolean(saved?.enabled);
      $('platform-status-' + platform).textContent = `${channelLabel(saved, status.enabled)} · ${saved?.configured ? '已配置 ' + (saved.appId || '') : '尚未配置'}`;
    }
    const name = scopeName(), state = status.enabled && status.channelEnabled !== false ? status.connection?.state || 'stopped' : 'disabled';
    const label = name + ' ' + ({ disabled: '已停用', connected: '已连接', connecting: '连接中', reconnecting: '正在重连', error: '连接异常', stopped: '未连接' }[state] || state);
    $('connection').textContent = label; $('connection').className = 'pill ' + (state === 'connected' ? 'connected' : state === 'error' ? 'error' : '');
    $('platform-state').textContent = (status.enabled && status.channelEnabled !== false && status.connection?.error) || (status.configured ? label + ' · 此助手的平台凭据已保存在扩展' : `尚未配置${name}应用`);
    connectionFeedback(status);
    $('notices').replaceChildren(...(status.localNotices || []).map(notice => {
      const entry = el('div', undefined, 'notice'), when = Number.isFinite(notice.at) ? new Date(notice.at).toLocaleString('zh-CN') : '旧记录，时间未知';
      entry.append(el('time', when), el('span', `标签页 ${notice.tabId}：${notice.error}`));
      const d = notice.diagnostics;
      if (d && Number.isFinite(d.bridgeIdleMs) && Number.isFinite(d.pageAgeMs)) {
        const phases = { prepare: '准备输入', 'idle-refresh': '闲置后刷新', submit: '确认发送', answer: '等待回复', 'challenge-recovery': '错误恢复', delivery: '回传' };
        entry.append(el('small', `本地诊断：桥接闲置 ${Math.round(d.bridgeIdleMs / 1000)} 秒 · 页面运行 ${Math.round(d.pageAgeMs / 1000)} 秒 · ${d.visibility === 'visible' ? '前台' : '后台'} · ${phases[d.phase] || '未知阶段'}${Number.isFinite(notice.idleRefreshMs) ? (notice.idleRefreshResumed === true ? ' · 发送前刷新已恢复' : ' · 发送前刷新已准备，尚未恢复') : ''}`, 'hint'));
      }
      return entry;
    }));
    const observation = status.backgroundObservation;
    const lines = observationLines(observation?.samples);
    if (lines.length) {
      const entry = el('div', undefined, 'notice');
      entry.append(el('strong', `Qwen 后台观察 · 标签页 ${observation.tabId}`), el('time', new Date(observation.at).toLocaleString('zh-CN')),
        el('small', '仅保留最近任务的状态数字，不含正文。可在保持 Qwen 隐藏时查看；记录不代表问题已修复。', 'hint'));
      entry.append(el('p', observation.receivedAt ? `扩展收到最终答案：${new Date(observation.receivedAt).toLocaleString('zh-CN')}（群内送达结果见任务记录）` : '此记录尚未确认最终答案到达扩展。', 'hint'));
      for (const line of lines) entry.append(el('p', line, 'hint'));
      $('notices').append(entry);
    }
    hasNotices = Boolean(status.localNotices?.length || lines.length);
    hasHistory = status.clearableHistoryCount > 0;
    if (!hasNotices) $('notices').append(el('p', '暂无历史故障提示。', 'empty'));
    if (status.moderation) $('words-summary').textContent = status.moderation.valid ? `${name} 已保存 ${status.moderation.count} 条词语；助手开启后用于新消息与未启动任务。` : '词表无效，提问已暂停；请修复并保存。';
    if (status.moderation?.presetUpdatePending) $('words-summary').textContent += ' 中英文预设尚未补充：词表已到数量或大小上限，请缩减后重新加载扩展。';
    $('delivery').replaceChildren();
    for (const item of status.delivery || []) {
      const attention = item.state === 'needs_attention', row = el('div', undefined, 'row'), detail = el('div');
      detail.append(el('strong', `回传 · ${item.chatId}`), el('p', item.error || (attention ? '超过自动重试窗口，请人工核对原群消息。' : `正在等待${name}确认送达。`)), el('small', `尝试 ${item.attempts || 0} 次`));
      row.append(detail, el('span', attention ? '需要人工核对' : `等待${name}送达`, 'state' + (attention ? ' failed' : ''))); $('delivery').append(row);
    }
    $('updated').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN');
    viewReady = true;
  } catch (error) {
    $('connection').textContent = '状态确认失败'; $('connection').className = 'pill error'; $('platform-state').textContent = error.message;
    if (feedbackOwner === 'connection') feedback(`无法确认 ${ASSISTANTS[activeAssistant].name} 状态：` + error.message, true, 'connection');
    throw error;
  } finally { refreshing = false; controls(); }
}
async function action(task) {
  if (busy || refreshing || !viewReady || !activePlatform || renderedAssistant !== activeAssistant) return;
  const scope = { assistant: activeAssistant, platform: activePlatform }; busy = true; controls();
  try { await task(scope); } catch (error) { feedback(error.message, true); } finally { busy = false; controls(); }
}
for (const assistant of Object.keys(ASSISTANTS)) {
  $('view-' + assistant).addEventListener('click', async () => {
    if (busy || refreshing || assistant === activeAssistant) return;
    saveDraft(); $('app-secret').value = '';
    activeAssistant = assistant; viewReady = false; feedbackOwner = 'connection';
    await refresh().catch(() => {});
  });
  $('enabled-' + assistant).addEventListener('change', () => {
    const enabled = $('enabled-' + assistant).checked;
    if (busy || refreshing || !viewReady || !assistantStatuses[assistant]) {
      $('enabled-' + assistant).checked = Boolean(assistantStatuses[assistant]?.enabled); return;
    }
    action(async () => {
      try {
        await rpc('options:assistant', { assistant, enabled });
        assistantStatuses[assistant] = { ...assistantStatuses[assistant], enabled };
        feedback(`${ASSISTANTS[assistant].name} ${enabled ? '已开启' : '已停用'}。其他助手的开关保持不变。`);
        await refresh();
      } catch (error) {
        $('enabled-' + assistant).checked = Boolean(assistantStatuses[assistant]?.enabled); throw error;
      }
    });
  });
}
for (const [platform, meta] of Object.entries(PLATFORMS)) {
  $('view-platform-' + platform).addEventListener('click', () => action(async scope => {
    if (platform === scope.platform) return;
    saveDraft(); $('app-secret').value = '';
    await rpc('options:platform', { assistant: scope.assistant, platform });
    viewReady = false; feedbackOwner = 'connection'; await refresh();
  }));
  $('enabled-platform-' + platform).addEventListener('change', () => {
    const checkbox = $('enabled-platform-' + platform), enabled = checkbox.checked;
    if (busy || refreshing || !viewReady) { checkbox.checked = Boolean(channelStatuses[platform]?.enabled); return; }
    action(async scope => {
      try {
        await rpc('options:channel', { assistant: scope.assistant, platform, enabled });
        channelStatuses[platform] = { ...channelStatuses[platform], enabled };
        feedback(`${ASSISTANTS[scope.assistant].name} · ${meta.name} 通道${enabled ? '已启用' : '已停用'}${enabled && !assistantStatuses[scope.assistant]?.enabled ? '，等待助手总开关开启' : ''}。`);
        await refresh();
      } catch (error) { checkbox.checked = Boolean(channelStatuses[platform]?.enabled); throw error; }
    });
  });
}
$('app-form').addEventListener('submit', event => { event.preventDefault(); action(async scope => {
  const appId = $('app-id').value.trim(), appSecret = $('app-secret').value;
  if (!appId || (scope.platform === 'qq' && !/^[0-9]+$/.test(appId))) throw new Error(scope.platform === 'qq' ? 'QQ AppID 只能包含数字，请填写 QQ 开放平台的 AppID。' : '请填写飞书应用 App ID。');
  $('app-secret').value = '';
  feedback(`正在保存 ${scopeName(scope)} 凭据…`, false, 'connection', true);
  await platformRpc('options:config', { appId, appSecret }, scope); await refresh();
}); });
$('bind-form').addEventListener('submit', event => { event.preventDefault(); action(async scope => {
  const tab = tabs.find(tab => String(tab.tabId) === $('tab').value), chatId = $('manual-group').value.trim() || $('group').value;
  if (!tab || !chatId) throw new Error(`请填写 ${PLATFORMS[scope.platform].groupId} 或选择群，并选择一个已有对话。`);
  await platformRpc('options:bind', { chatId, tabId: tab.tabId, conversationUrl: tab.conversationUrl }, scope);
  feedback(`${scopeName(scope)} 群绑定完成。今后的 @ 提问会进入选定的网页对话。`); await refresh();
}); });
$('tab').addEventListener('change', () => { $('tab-url').textContent = tabs.find(tab => String(tab.tabId) === $('tab').value)?.conversationUrl || ''; });
$('refresh').addEventListener('click', () => { if (!busy) refresh().catch(error => feedback(error.message, true)); });
$('words-form').addEventListener('submit', event => { event.preventDefault(); action(async scope => {
  const words = $('blocked-words').value.split(/\r?\n/).map(word => word.trim()).filter(Boolean);
  const result = await platformRpc('options:save-words', { words }, scope);
  feedback(`${scopeName(scope)} 词表已保存，共 ${result.count} 条。`); await refresh();
}); });
$('reply-style').addEventListener('change', () => { replyStyleDirty = true; });
$('reply-style-form').addEventListener('submit', event => { event.preventDefault(); action(async scope => {
  if (scope.platform !== 'feishu') throw new Error('QQ 使用 Markdown，无需设置飞书回复样式。');
  const replyStyle = $('reply-style').value;
  await platformRpc('options:reply-style', { replyStyle }, scope);
  replyStyleDirty = $('reply-style').value !== replyStyle;
  feedback(`${scopeName(scope)} 回复样式已保存：` + (replyStyle === 'card' ? '状态和最终答案均使用卡片。' : '状态卡片，正文和代码单独发送。')); await refresh();
}); });
$('clear-history').addEventListener('click', () => action(async scope => {
  const result = await platformRpc('options:clear-history', {}, scope);
  feedback(`已清除 ${scopeName(scope)} 的 ${result.count} 条已结束记录，进行中的任务保留。`);
  await refresh();
}));
$('clear-notices').addEventListener('click', () => action(async scope => {
  await platformRpc('options:clear-notices', {}, scope); feedback(`已清除 ${scopeName(scope)} 的历史提示。`); await refresh();
}));
const panels = ['connection', 'bindings', 'safety', 'activity'];
function showPanel(name, remember = false) {
  if (!panels.includes(name)) name = 'connection';
  for (const panel of panels) {
    const selected = panel === name;
    $('panel-' + panel).hidden = !selected;
    $('tab-' + panel).setAttribute('aria-selected', String(selected));
    $('tab-' + panel).tabIndex = selected ? 0 : -1;
  }
  if (remember) try { localStorage.setItem('aichat.settings.panel', name); } catch {}
}
let initialPanel = 'connection';
try { initialPanel = localStorage.getItem('aichat.settings.panel') || initialPanel; } catch {}
showPanel(initialPanel);
for (const [index, panel] of panels.entries()) {
  $('tab-' + panel).addEventListener('click', () => showPanel(panel, true));
  $('tab-' + panel).addEventListener('keydown', event => {
    const next = event.key === 'ArrowRight' ? (index + 1) % panels.length : event.key === 'ArrowLeft' ? (index + panels.length - 1) % panels.length : event.key === 'Home' ? 0 : event.key === 'End' ? panels.length - 1 : null;
    if (next === null) return;
    event.preventDefault(); showPanel(panels[next], true); $('tab-' + panels[next]).focus();
  });
}
refresh().catch(() => {});
setInterval(() => { if (!busy) refresh().catch(() => {}); }, 10000);
