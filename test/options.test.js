import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { observationLines } from '../extension/background-observation.js';

const html = await readFile(new URL('../extension/options.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../extension/options.js', import.meta.url), 'utf8');
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
const conversationUrl = 'https://chatgpt.com/c/platform-fixture';
const assistantNames = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', qwen: 'Qwen' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function setup(initialPlatform = 'qq', initial = {}) {
  const dom = new JSDOM(html, { url: 'https://extension.invalid/options.html', runScripts: 'outside-only' });
  const { window } = dom, calls = [], intervals = [];
  const opened = {
    chatgpt: [{ tabId: 7, title: 'ChatGPT 专用对话', conversationUrl }],
    claude: [{ tabId: 8, title: 'Claude 专用对话', conversationUrl: 'https://claude.ai/chat/claude-fixture' }],
    qwen: [{tabId:10,title:'Qwen 专用对话',conversationUrl:'https://chat.qwen.ai/c/qwen-fixture'}],
    gemini: [{ tabId: 9, title: 'Gemini 专用对话', conversationUrl: 'https://gemini.google.com/app/gemini-fixture' }]
  };
  const defaults = {
    qq: { configured: true, appId: '102345678', connection: { state: 'connected' }, replyStyle: 'separate', words: ['QQ词条', 'QQ短语'], groups: [{ chatId: 'qq_group', name: 'QQ 测试群' }], jobs: [], delivery: [], localNotices: [] },
    feishu: { configured: true, appId: 'cli_fixture', connection: { state: 'connected' }, replyStyle: 'card', words: ['飞书词条'], groups: [{ chatId: 'oc_group', name: '飞书测试群' }], jobs: [], delivery: [], localNotices: [] }
  };
  const profiles = Object.fromEntries(Object.keys(assistantNames).map((assistant, index) => {
    const changes = assistant === 'chatgpt' ? initial : initial[assistant] || {};
    return [assistant, { enabled: changes.enabled ?? assistant === 'chatgpt', platform: changes.platform || (assistant === 'chatgpt' ? initialPlatform : 'qq'),
      states: Object.fromEntries(Object.entries(defaults).map(([platform, state]) => [platform, { ...structuredClone(state), ...(assistant !== 'chatgpt' ? { appId: platform === 'qq' ? String(102345678 + index * 10) : `cli_${assistant}`, words: [`${assistantNames[assistant]} ${platform} 词条`] } : {}), ...changes[platform] }])) }];
  }));
  for (const entry of Object.values(profiles)) entry.channels = { qq: entry.platform === 'qq', feishu: entry.platform === 'feishu' };
  const states = profiles.chatgpt.states, hooks = {};
  window.setInterval = fn => { intervals.push(fn); return intervals.length; };
  window.chrome = { runtime: { async sendMessage(message) {
    calls.push(message);
    assert.ok(Object.hasOwn(assistantNames, message.assistant), 'Every request must identify its assistant');
    const hook = hooks[message.type];
    if (hook) await hook(message);
    const profile = profiles[message.assistant];
    const state = profile.states[message.platform || profile.platform];
    if (message.type === 'options:status') return { ok: true, data: structuredClone({
      ...state, clearableHistoryCount: state.jobs.filter(job => ['completed', 'failed', 'cancelled'].includes(job.state)).length, assistant: message.assistant, platform: message.platform || profile.platform, enabled: profile.enabled, channelEnabled: profile.channels[message.platform || profile.platform],
      assistants: Object.fromEntries(Object.entries(profiles).map(([assistant, entry]) => {
        const current = entry.states[entry.platform];
        return [assistant, { enabled: entry.enabled, platform: entry.platform, configured: current.configured, appId: current.appId, connection: current.connection }];
      })),
      platforms: Object.fromEntries(Object.entries(profile.states).map(([platform, state]) => [platform, { configured: state.configured, appId: state.appId, enabled: profile.channels[platform], connection: state.connection }])),
      moderation: { valid: true, count: state.words.length }
    }) };
    if (message.type === 'options:assistant') { profile.enabled = message.enabled; return { ok: true, data: { assistant: message.assistant, enabled: profile.enabled } }; }
    if (message.type === 'options:platform') {
      profile.platform = message.platform; return { ok: true, data: { ok: true, platform: profile.platform } };
    }
    if (message.type === 'options:channel') {
      if (!message.enabled && (state.jobs.some(job => ['queued', 'running'].includes(job.state)) || state.delivery.length)) return { ok: false, error: '此通道还有待完成任务' };
      profile.channels[message.platform] = message.enabled; return { ok: true, data: { platform: message.platform, enabled: message.enabled } };
    }
    let data = { ok: true };
    switch (message.type) {
      case 'options:tabs': data = { tabs: opened[message.assistant] }; break;
      case 'options:moderation': data = { valid: true, words: [...state.words] }; break;
      case 'options:config': state.appId = message.appId; state.configured = true; break;
      case 'options:save-words': state.words = Array.from(message.words); data = { count: state.words.length }; break;
      case 'options:reply-style':
        assert.equal(message.platform, 'feishu'); state.replyStyle = message.replyStyle; break;
      case 'options:clear-notices': state.localNotices = []; delete state.backgroundObservation; break;
      case 'options:clear-history': { const before = state.jobs.length; state.jobs = state.jobs.filter(job => !['completed', 'failed', 'cancelled'].includes(job.state)); data = { ok: true, count: before - state.jobs.length }; break; }
      case 'options:cancel-job': {
        const job = state.jobs.find(job => job.id === message.jobId);
        if (!job) return { ok: false, error: '任务不存在' };
        if (job.state !== 'queued') return { ok: false, error: '任务已开始，无法取消排队任务' };
        job.state = 'cancelled'; break;
      }
      case 'options:bind': {
        let group = state.groups.find(group => group.chatId === message.chatId);
        if (!group) { group = { chatId: message.chatId }; state.groups.push(group); }
        group.binding = { tabId: message.tabId, conversationUrl: message.conversationUrl }; break;
      }
      case 'options:unbind': state.groups.find(group => group.chatId === message.chatId).binding = null; break;
      default: throw new Error('Unexpected settings request: ' + message.type);
    }
    return { ok: true, data };
  } } };
  window.__observations = { observationLines };
  window.eval(source.replace("import { observationLines } from './background-observation.js';", 'const { observationLines } = globalThis.__observations;')); await settle();
  const $ = id => window.document.getElementById(id);
  return {
    $, window, calls, states, profiles, hooks, close: () => window.close(),
    get active() { return profiles.chatgpt.platform; }, setActive(platform, assistant = 'chatgpt') { profiles[assistant].platform = platform; }, setTabs(tabs, assistant = 'chatgpt') { opened[assistant] = tabs; },
    async change(id, value) { $(id).value = value; $(id).dispatchEvent(new window.Event('change')); await settle(); },
    async submit(id) { $(id).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle(); },
    async click(id) { $(id).click(); await settle(); },
    async poll() { intervals[0](); await settle(); },
    async view(assistant) { $('view-' + assistant).click(); await settle(); },
    async toggle(assistant) { $('enabled-' + assistant).click(); await settle(); },
    async switchTo(platform) { $('view-platform-' + platform).click(); await settle(); }
  };
}

test('initial QQ settings use authoritative platform, Markdown, group_openid and no import', async () => {
  const x = await setup();
  try {
    assert.equal(x.window.document.body.dataset.platform, 'qq');
    assert.equal(x.$('view-platform-qq').disabled, true);
    assert.equal(x.$('connection').textContent, 'ChatGPT · QQ 已连接');
    assert.equal(x.$('app-id').value, '102345678');
    assert.equal(x.$('app-id').pattern, '[0-9]+');
    assert.equal(x.$('app-id').inputMode, 'numeric');
    assert.equal(x.$('reply-style-section').hidden, true);
    assert.equal(x.$('reply-style').disabled, true);
    assert.equal(x.$('qq-guide').hidden, false); assert.equal(x.$('feishu-guide').hidden, true);
    assert.match(x.$('bind-hint').textContent, /group_openid（不是 QQ 群号）/);
    assert.equal(x.$('blocked-words').value, 'QQ词条\nQQ短语');
    assert.equal(x.$('group').options[1].value, 'qq_group');
    assert.equal(x.$('migration-file'), null); assert.equal(x.$('import-config'), null);
    assert.match(x.window.document.body.textContent, /已有的 ChatGPT、Claude 配置会保留/);
    assert.match(x.window.document.body.textContent, /不同的专用对话.*不同标签页/);
    assert.doesNotMatch(source, /options:import/);
    assert.ok(x.calls.filter(call => call.type !== 'options:status').every(call => call.platform === 'qq'));
    assert.match(x.$('platform-status-qq').textContent, /已连接 · 已配置 102345678/);
    assert.match(x.$('platform-status-feishu').textContent, /已停用 · 已配置 cli_fixture/);
  } finally { x.close(); }
});

test('opening an already-active Feishu platform never loads or sends QQ configuration', async () => {
  const x = await setup('feishu');
  try {
    assert.equal(x.window.document.body.dataset.platform, 'feishu');
    assert.equal(x.$('connection').textContent, 'ChatGPT · 飞书 已连接');
    assert.equal(x.$('app-id').value, 'cli_fixture');
    assert.equal(x.$('app-id').hasAttribute('pattern'), false);
    assert.equal(x.$('app-id').inputMode, 'text');
    assert.equal(x.$('reply-style-section').hidden, false);
    assert.equal(x.$('reply-style').value, 'card');
    assert.equal(x.$('blocked-words').value, '飞书词条');
    assert.equal(x.$('group').options[1].value, 'oc_group');
    assert.match(x.$('bind-hint').textContent, /chat_id/);
    assert.ok(x.calls.filter(call => call.type !== 'options:status').every(call => call.platform === 'feishu'));
  } finally { x.close(); }
});

test('selecting a platform only changes the target; confirmed switch reloads isolated saved settings', async () => {
  const x = await setup();
  try {
    x.$('app-secret').value = 'unsaved-secret'; x.$('manual-group').value = 'old_manual';
    x.$('blocked-words').value = 'unsaved QQ words';
    await x.poll();
    assert.equal(x.$('blocked-words').value, 'unsaved QQ words');
    await x.switchTo('feishu');
    assert.equal(x.active, 'feishu');
    assert.equal(x.$('app-id').value, 'cli_fixture'); assert.equal(x.$('app-secret').value, '');
    assert.equal(x.$('manual-group').value, ''); assert.equal(x.$('blocked-words').value, '飞书词条');
    assert.equal(x.$('reply-style-section').hidden, false);
    assert.equal(x.calls.find(call => call.type === 'options:platform').platform, 'feishu');
    await x.switchTo('qq');
    assert.equal(x.$('app-id').value, '102345678'); assert.equal(x.$('blocked-words').value, 'unsaved QQ words');
    assert.equal(x.$('reply-style-section').hidden, true);
    assert.equal(x.calls.some(call => call.type === 'options:config'), false);
  } finally { x.close(); }
});

test('configuration selection leaves active jobs running; disabling their channel rolls back', async () => {
  const x = await setup('qq', { qq: { jobs: [{ id: 'job', chatId: 'qq_group', state: 'running', createdAt: 1800000000000 }] } });
  try {
    x.$('app-secret').value = 'unsaved'; await x.switchTo('feishu');
    assert.equal(x.active, 'feishu'); assert.equal(x.$('app-secret').value, '');
    assert.equal(x.profiles.chatgpt.channels.qq, true); assert.equal(x.profiles.chatgpt.channels.feishu, false);
    await x.click('enabled-platform-qq');
    assert.equal(x.$('enabled-platform-qq').checked, true); assert.match(x.$('feedback').textContent, /待完成任务/);
    assert.equal(x.states.qq.jobs[0].state, 'running');
  } finally { x.close(); }
});

test('configuration validates QQ digits and clears secrets; Feishu accepts its own App ID', async () => {
  const x = await setup();
  try {
    x.$('app-id').value = 'cli_wrong'; x.$('app-secret').value = 'test-secret';
    await x.submit('app-form');
    assert.equal(x.calls.some(call => call.type === 'options:config'), false);
    assert.match(x.$('feedback').textContent, /QQ AppID 只能包含数字/);
    x.$('app-id').value = ' 102345679 '; await x.submit('app-form');
    const qq = x.calls.find(call => call.type === 'options:config');
    assert.equal(qq.platform, 'qq'); assert.equal(qq.appId, '102345679'); assert.equal(qq.appSecret, 'test-secret');
    assert.equal(x.$('app-secret').value, ''); assert.doesNotMatch(x.window.document.body.textContent, /test-secret/);
    await x.switchTo('feishu'); x.$('app-id').value = ' cli_updated '; await x.submit('app-form');
    const feishu = x.calls.filter(call => call.type === 'options:config').at(-1);
    assert.equal(feishu.platform, 'feishu'); assert.equal(feishu.appId, 'cli_updated'); assert.equal(feishu.appSecret, '');
    assert.equal(x.states.qq.appId, '102345679');
  } finally { x.close(); }
});

test('every group bind, unbind, word save and notice clear is scoped to the active platform', async () => {
  const x = await setup('qq', { qq: { localNotices: [{ tabId: 7, at: 1800000000000, error: 'QQ旧提示' }] }, feishu: { localNotices: [{ tabId: 7, at: 1800000000000, error: '飞书旧提示' }] } });
  try {
    for (const platform of ['qq', 'feishu']) {
      if (platform !== x.active) await x.switchTo(platform);
      x.$('group').value = platform === 'qq' ? 'qq_group' : 'oc_group'; x.$('tab').value = '7';
      await x.submit('bind-form');
      const binding = x.calls.filter(call => call.type === 'options:bind').at(-1);
      assert.equal(binding.platform, platform); assert.equal(binding.tabId, 7); assert.equal(binding.conversationUrl, conversationUrl);
      x.$('bindings').querySelector('button').click(); await settle();
      assert.equal(x.calls.filter(call => call.type === 'options:unbind').at(-1).platform, platform);
      x.$('blocked-words').value = ' 新词 \n\n新短语'; await x.submit('words-form');
      const words = x.calls.filter(call => call.type === 'options:save-words').at(-1);
      assert.equal(words.platform, platform); assert.deepEqual(Array.from(words.words), ['新词', '新短语']);
      await x.click('clear-notices');
      assert.equal(x.calls.filter(call => call.type === 'options:clear-notices').at(-1).platform, platform);
      assert.match(x.$('notices').textContent, /暂无历史故障/);
      if (platform === 'qq') assert.equal(x.states.feishu.localNotices.length, 1);
    }
  } finally { x.close(); }
});

test('Feishu-only reply style persists and does not overwrite unsaved selection during polling', async () => {
  const x = await setup('feishu');
  try {
    await x.change('reply-style', 'separate'); await x.poll();
    assert.equal(x.$('reply-style').value, 'separate');
    await x.submit('reply-style-form');
    const save = x.calls.find(call => call.type === 'options:reply-style');
    assert.equal(save.platform, 'feishu'); assert.equal(save.replyStyle, 'separate');
    assert.equal('appSecret' in save, false);
    await x.switchTo('qq'); await x.submit('reply-style-form');
    assert.equal(x.calls.filter(call => call.type === 'options:reply-style').length, 1);
    assert.match(x.$('feedback').textContent, /QQ 使用 Markdown/);
  } finally { x.close(); }
});

test('writes and switching are single-flight while a configuration save is in progress', async () => {
  const x = await setup(); const hold = deferred();
  try {
    x.hooks['options:config'] = () => hold.promise;
    x.$('app-secret').value = 'in-flight-secret'; await x.submit('app-form');
    assert.equal(x.$('view-platform-feishu').disabled, true); assert.equal(x.$('save-app').disabled, true);
    await x.switchTo('feishu'); await x.submit('words-form');
    assert.equal(x.calls.some(call => call.type === 'options:platform'), false);
    assert.equal(x.calls.some(call => call.type === 'options:save-words'), false);
    hold.resolve(); await settle();
    assert.equal(x.active, 'qq'); assert.equal(x.$('view-platform-feishu').disabled, false);
    assert.equal(x.calls.find(call => call.type === 'options:config').platform, 'qq');
  } finally { hold.resolve(); x.close(); }
});

test('a save keeps its original platform even when another settings page selects a different view', async () => {
  const x = await setup(); const hold = deferred();
  try {
    x.hooks['options:config'] = () => hold.promise;
    x.$('app-id').value = '102345699'; await x.submit('app-form');
    x.setActive('feishu'); hold.resolve(); await settle();
    assert.equal(x.calls.find(call => call.type === 'options:config').platform, 'qq');
    assert.equal(x.states.qq.appId, '102345699'); assert.equal(x.states.feishu.appId, 'cli_fixture');
    await x.poll();
    assert.equal(x.window.document.body.dataset.platform, 'feishu'); assert.equal(x.$('app-id').value, 'cli_fixture');
    assert.equal(x.$('blocked-words').value, '飞书词条');
  } finally { hold.resolve(); x.close(); }
});

test('platform switch in progress blocks old form submissions until target data has loaded', async () => {
  const x = await setup(); const hold = deferred();
  try {
    x.hooks['options:moderation'] = message => message.platform === 'feishu' ? hold.promise : undefined;
    await x.switchTo('feishu');
    assert.equal(x.active, 'feishu'); assert.equal(x.$('save-app').disabled, true);
    await x.submit('app-form'); await x.submit('bind-form');
    assert.equal(x.calls.some(call => call.type === 'options:config'), false);
    assert.equal(x.calls.some(call => call.type === 'options:bind'), false);
    hold.resolve(); await settle();
    assert.equal(x.$('app-id').value, 'cli_fixture'); assert.equal(x.$('save-app').disabled, false);
  } finally { hold.resolve(); x.close(); }
});

test('connection polling preserves word edits and action feedback but updates the real state', async () => {
  const x = await setup();
  try {
    x.$('blocked-words').value = '未保存词条'; await x.poll();
    assert.equal(x.$('blocked-words').value, '未保存词条');
    await x.submit('words-form'); const feedback = x.$('feedback').textContent;
    x.states.qq.connection = { state: 'error', error: 'QQ连接中断' }; await x.poll();
    assert.equal(x.$('feedback').textContent, feedback);
    assert.equal(x.$('connection').className, 'pill error');
    assert.equal(x.$('platform-state').textContent, 'QQ连接中断');
  } finally { x.close(); }
});

test('group and notice strings are text-safe and invalid binding does not issue a request', async () => {
  const unsafe = '<img src=x onerror="window.injected=true">';
  const x = await setup('feishu', { feishu: { groups: [{ chatId: 'oc_group', name: unsafe, binding: { tabId: 7, conversationUrl } }], localNotices: [{ tabId: 7, error: unsafe, at: 1800000000000 }] } });
  try {
    assert.equal(x.window.document.querySelector('#bindings img, #notices img, img[onerror]'), null);
    assert.deepEqual([...x.window.document.querySelectorAll('img')].map(image => image.getAttribute('src')), ['assets/chatgpt.svg', 'assets/chatgpt.svg', 'assets/claude.svg', 'assets/gemini.svg', 'assets/qwen.svg', 'assets/chatgpt.svg', 'assets/qq.svg', 'assets/feishu.png']);
    assert.equal(x.window.injected, undefined);
    assert.match(x.$('bindings').textContent, /<img/); assert.match(x.$('notices').textContent, /<img/);
    x.$('manual-group').value = 'oc_manual'; x.setTabs([]); await x.poll(); await x.submit('bind-form');
    assert.equal(x.calls.some(call => call.type === 'options:bind'), false);
    assert.match(x.$('feedback').textContent, /chat_id.*已有对话/);
  } finally { x.close(); }
});

test('both platform views distinguish inbound handoff and editor preparation from reply delivery', async () => {
  for (const platform of ['qq', 'feishu']) {
    const x = await setup(platform, { [platform]: { jobs: [{ id: 'timed-job', chatId: 'group-timing', createdAt: 1800000000000, state: 'completed',
      timing: { handoffMs: 2250, inputPreparationMs: 700, confirmationMs: 800, imagePreparationMs: 150, queueMs: 250, deliveryMs: 600 } }] } });
    try {
      const text = x.$('jobs').textContent;
      assert.match(text, /收到→网页接手 2.3 秒/); assert.match(text, /网页输入准备 0.7 秒/);
      assert.match(text, /回复图片准备 0.1 秒/); assert.match(text, /平台回传 0.6 秒/);
    } finally { x.close(); }
  }
});

test('only queued tasks offer cancellation and cancelled tasks keep a terminal label', async () => {
  const jobStates = ['queued', 'leased', 'running', 'generating', 'sending', 'result_pending', 'completed', 'failed', 'cancelled'];
  const x = await setup('qq', { qq: { jobs: jobStates.map(state => ({ id: state, chatId: 'qq_group', state, createdAt: 1800000000000 })) } });
  try {
    const rows = [...x.$('jobs').children];
    assert.equal(x.$('jobs').querySelectorAll('button').length, 1);
    assert.equal(rows[0].querySelector('button').textContent, '取消任务');
    assert.equal(rows[0].querySelector('button').getAttribute('aria-label'), '取消任务 queued');
    assert.equal(rows.at(-1).querySelector('.state').textContent, '已取消');
  } finally { x.close(); }
});

test('queued tasks beyond recent history remain visible and cancellable', async () => {
  const recent = Array.from({ length: 14 }, (_, index) => ({ id: `completed-${index}`, chatId: 'qq_group', state: 'completed', createdAt: 1800000000000 - index }));
  const oldQueued = { id: 'old-queued', chatId: 'qq_group', state: 'queued', createdAt: 1799999999000 };
  const x = await setup('qq', { qq: { jobs: [...recent, oldQueued] } });
  try {
    assert.equal(x.$('jobs').children.length, 13);
    const descriptions = [...x.$('jobs').querySelectorAll('p')].map(node => node.textContent);
    assert.equal(descriptions.includes('任务 completed-12'), false);
    assert.equal(descriptions.includes('任务 completed-13'), false);
    const button = x.$('jobs').querySelector('button');
    assert.equal(button.getAttribute('aria-label'), '取消任务 old-queued');
    button.click(); await settle();
    assert.equal(x.calls.find(call => call.type === 'options:cancel-job').jobId, 'old-queued');
    assert.equal(x.states.qq.jobs.at(-1).state, 'cancelled');
    assert.equal(x.$('jobs').children.length, 12);
    assert.match(x.$('feedback').textContent, /已取消.*排队任务/);
  } finally { x.close(); }
});

test('queued cancellation identifies the rendered assistant, platform and job in all six profiles', async () => {
  for (const assistant of Object.keys(assistantNames)) for (const platform of ['qq', 'feishu']) {
    const job = { id: 'cancel-me', chatId: 'fixture_group', state: 'queued', createdAt: 1800000000000 };
    const initial = assistant === 'chatgpt' ? { [platform]: { jobs: [job] } } : { [assistant]: { platform, [platform]: { jobs: [job] } } };
    const x = await setup(platform, initial);
    try {
      if (assistant !== 'chatgpt') await x.view(assistant);
      x.$('jobs').querySelector('button').click(); await settle();
      const requests = x.calls.filter(call => call.type === 'options:cancel-job');
      assert.equal(requests.length, 1);
      assert.deepEqual({ ...requests[0] }, { type: 'options:cancel-job', assistant, platform, jobId: 'cancel-me' });
      assert.equal(x.profiles[assistant].states[platform].jobs[0].state, 'cancelled');
      assert.equal(x.$('jobs').querySelector('button'), null);
      assert.equal(x.$('jobs').querySelector('.state').textContent, '已取消');
      assert.match(x.$('feedback').textContent, /已取消.*排队任务/);
      assert.ok(x.calls.slice(x.calls.indexOf(requests[0]) + 1).some(call => call.type === 'options:status' && call.assistant === assistant));
    } finally { x.close(); }
  }
});

test('cancellation is single-flight and disables task buttons and profile changes until refreshed', async () => {
  const x = await setup('qq', { qq: { jobs: [{ id: 'cancel-me', chatId: 'qq_group', state: 'queued', createdAt: 1800000000000 }] } });
  const hold = deferred();
  try {
    x.hooks['options:cancel-job'] = () => hold.promise;
    const button = x.$('jobs').querySelector('button'); button.click(); await settle();
    assert.equal(button.disabled, true); assert.equal(button.textContent, '正在取消…');
    assert.equal(x.$('view-claude').disabled, true); assert.equal(x.$('view-platform-feishu').disabled, true);
    assert.equal(x.$('view-gemini').disabled, true); assert.equal(x.$('enabled-gemini').disabled, true);
    button.dispatchEvent(new x.window.Event('click')); await x.view('claude'); await x.switchTo('feishu'); await x.poll();
    assert.equal(x.calls.filter(call => call.type === 'options:cancel-job').length, 1);
    assert.equal(x.calls.some(call => call.type === 'options:platform'), false);
    assert.equal(x.window.document.body.dataset.platform, 'qq'); // Disabled view controls cannot change the active form.
    hold.resolve(); await settle();
    assert.equal(x.active, 'qq'); assert.equal(x.$('jobs').querySelector('.state').textContent, '已取消');
    assert.equal(x.$('view-claude').disabled, false);
  } finally { hold.resolve(); x.close(); }
});

test('a task starting during cancellation refreshes its running state and displays the rejection', async () => {
  const x = await setup('qq', { qq: { jobs: [{ id: 'race', chatId: 'qq_group', state: 'queued', createdAt: 1800000000000 }] } });
  const hold = deferred();
  try {
    x.hooks['options:cancel-job'] = () => hold.promise;
    x.$('jobs').querySelector('button').click(); await settle();
    x.states.qq.jobs[0].state = 'running'; hold.resolve(); await settle();
    assert.equal(x.$('jobs').querySelector('.state').textContent, '网页生成中');
    assert.equal(x.$('jobs').querySelector('button'), null);
    assert.match(x.$('feedback').textContent, /任务已开始/);
    assert.equal(x.$('feedback').className, 'error');
    assert.equal(x.$('view-claude').disabled, false);
  } finally { hold.resolve(); x.close(); }
});

test('stale task handlers cannot cancel a different assistant and platform changes are refreshed on rejection', async () => {
  const x = await setup('qq', { qq: { jobs: [{ id: 'stale', chatId: 'qq_group', state: 'queued', createdAt: 1800000000000 }] } });
  const hold = deferred();
  try {
    const stale = x.$('jobs').querySelector('button');
    await x.view('gemini'); stale.dispatchEvent(new x.window.Event('click')); await settle();
    assert.equal(x.calls.some(call => call.type === 'options:cancel-job'), false);
    assert.match(x.$('feedback').textContent, /助手或平台已变化/);
    await x.view('chatgpt');
    x.hooks['options:cancel-job'] = () => hold.promise;
    x.$('jobs').querySelector('button').click(); await settle();
    x.setActive('feishu'); hold.resolve(); await settle();
    const request = x.calls.find(call => call.type === 'options:cancel-job');
    assert.equal(request.assistant, 'chatgpt'); assert.equal(request.platform, 'qq');
    assert.equal(x.states.qq.jobs[0].state, 'cancelled');
    assert.equal(x.window.document.body.dataset.platform, 'feishu');
    assert.match(x.$('feedback').textContent, /已取消/);
  } finally { hold.resolve(); x.close(); }
});

test('successful cancellation stays visible if status refresh fails and stale controls stay locked', async () => {
  const x = await setup('qq', { qq: { jobs: [{ id: 'refresh-fails', chatId: 'qq_group', state: 'queued', createdAt: 1800000000000 }] } });
  try {
    x.hooks['options:status'] = () => { throw new Error('status fixture failure'); };
    x.$('jobs').querySelector('button').click(); await settle();
    assert.equal(x.$('jobs').querySelector('.state').textContent, '已取消');
    assert.equal(x.$('jobs').querySelector('button'), null);
    assert.match(x.$('feedback').textContent, /任务已取消；状态刷新失败/);
    assert.equal(x.$('save-app').disabled, true);
    delete x.hooks['options:status']; await x.click('refresh');
    assert.equal(x.$('save-app').disabled, false);
    assert.equal(x.$('jobs').querySelector('.state').textContent, '已取消');
  } finally { x.close(); }
});

test('assistant view selection is read-only and shows only that assistant platform and tabs', async () => {
  const x = await setup('qq', { claude: { platform: 'feishu', enabled: true } });
  try {
    const before = x.calls.length;
    await x.view('claude');
    assert.equal(x.window.document.body.dataset.platform, 'feishu');
    assert.equal(x.$('app-id').value, 'cli_claude');
    assert.equal(x.$('blocked-words').value, 'Claude feishu 词条');
    assert.equal(x.$('connection').textContent, 'Claude · 飞书 已连接');
    assert.match(x.$('bind-hint').textContent, /Claude.*\/chat\//);
    assert.match(x.$('tab-label').textContent, /Claude/);
    assert.match(x.$('words-platform').textContent, /Claude · 飞书.*Claude/);
    assert.match(x.$('state-title').textContent, /Claude · 飞书/);
    assert.match(x.$('notices-title').textContent, /Claude · 飞书/);
    assert.equal(x.$('tab').options.length, 2);
    assert.equal(x.$('tab').options[1].value, '8');
    assert.ok(x.calls.slice(before).every(call => call.assistant === 'claude'));
    assert.equal(x.calls.some(call => ['options:assistant', 'options:platform', 'options:config'].includes(call.type)), false);
    assert.equal(x.profiles.chatgpt.enabled, true);
    assert.equal(x.profiles.chatgpt.platform, 'qq');
    await x.view('chatgpt');
    assert.equal(x.$('app-id').value, '102345678');
    assert.equal(x.$('tab').options[1].value, '7');
    assert.equal(x.$('connection').textContent, 'ChatGPT · QQ 已连接');
  } finally { x.close(); }
});

test('Gemini view uses its own platform, tabs and account-aware binding guidance without changing other assistants', async () => {
  const x = await setup('qq', { claude: { enabled: true }, gemini: { platform: 'feishu' } });
  try {
    const before = x.calls.length;
    await x.view('gemini');
    assert.equal(x.$('enabled-gemini').checked, false);
    assert.equal(x.window.document.body.dataset.platform, 'feishu');
    assert.equal(x.$('app-id').value, 'cli_gemini');
    assert.equal(x.$('blocked-words').value, 'Gemini feishu 词条');
    assert.equal(x.$('connection').textContent, 'Gemini · 飞书 已停用');
    assert.match(x.$('bind-hint').textContent, /Gemini.*\/app\/.*\/u\//);
    assert.match(x.$('tab-label').textContent, /Gemini/);
    assert.match(x.$('words-platform').textContent, /Gemini · 飞书.*Gemini/);
    assert.match(x.$('state-title').textContent, /Gemini · 飞书/);
    assert.equal(x.$('tab').options.length, 2);
    assert.equal(x.$('tab').options[1].value, '9');
    assert.ok(x.calls.slice(before).every(call => call.assistant === 'gemini'));
    assert.equal(x.calls.some(call => ['options:assistant', 'options:platform', 'options:config'].includes(call.type)), false);
    assert.equal(x.profiles.chatgpt.enabled, true); assert.equal(x.profiles.claude.enabled, true);
    await x.view('claude');
    assert.equal(x.$('app-id').value, '102345688');
    assert.equal(x.$('tab').options[1].value, '8');
  } finally { x.close(); }
});

test('all six assistant-platform drafts survive switching while secrets are discarded', async () => {
  const x = await setup();
  try {
    for (const assistant of Object.keys(assistantNames)) {
      await x.view(assistant);
      for (const platform of ['qq', 'feishu']) {
        await x.switchTo(platform);
        const scope = `${assistant}:${platform}`;
        x.$('app-id').value = scope; x.$('blocked-words').value = `词表 ${scope}`;
        x.$('manual-group').value = `群 ${scope}`; x.$('tab').value = String(Object.keys(assistantNames).indexOf(assistant) + 7);
        x.$('app-secret').value = `temporary-${scope}`;
        if (platform === 'feishu') await x.change('reply-style', assistant === 'gemini' ? 'card' : 'separate');
      }
    }
    await x.view('chatgpt');
    for (const assistant of Object.keys(assistantNames)) {
      await x.view(assistant);
      for (const platform of ['qq', 'feishu']) {
        await x.switchTo(platform); await x.poll();
        const scope = `${assistant}:${platform}`;
        assert.equal(x.$('app-id').value, scope);
        assert.equal(x.$('blocked-words').value, `词表 ${scope}`);
        assert.equal(x.$('manual-group').value, `群 ${scope}`);
        assert.equal(x.$('tab').value, String(Object.keys(assistantNames).indexOf(assistant) + 7));
        assert.equal(x.$('app-secret').value, '');
        if (platform === 'feishu') assert.equal(x.$('reply-style').value, assistant === 'gemini' ? 'card' : 'separate');
      }
    }
    assert.equal(x.calls.some(call => call.type === 'options:config' || call.type === 'options:save-words'), false);
  } finally { x.close(); }
});

test('disabled Gemini saves its own credentials, filters and multi-account binding without modifying other profiles', async () => {
  const x = await setup('qq', { claude: { enabled: true }, gemini: { platform: 'feishu', feishu: { localNotices: [{ tabId: 9, at: 1800000000000, error: 'Gemini fixture notice' }] } } });
  try {
    const originalChatgpt = structuredClone(x.profiles.chatgpt), originalClaude = structuredClone(x.profiles.claude);
    const multiAccountUrl = 'https://gemini.google.com/u/1/app/gemini-fixture';
    x.setTabs([{ tabId: 9, title: 'Gemini 多账号专用对话', conversationUrl: multiAccountUrl }], 'gemini');
    await x.view('gemini');
    assert.equal(x.$('save-app').disabled, false);
    x.$('app-id').value = 'cli_gemini_new'; x.$('app-secret').value = 'user-typed-fixture';
    await x.submit('app-form');
    assert.equal(x.$('app-secret').value, '');
    x.$('blocked-words').value = 'Gemini 独立过滤'; await x.submit('words-form');
    x.$('group').value = 'oc_group'; x.$('tab').value = '9'; await x.submit('bind-form');
    await x.change('reply-style', 'separate'); await x.submit('reply-style-form');
    await x.click('clear-notices');
    const gemini = x.profiles.gemini.states.feishu;
    assert.equal(gemini.appId, 'cli_gemini_new'); assert.deepEqual(gemini.words, ['Gemini 独立过滤']);
    assert.deepEqual(gemini.groups[0].binding, { tabId: 9, conversationUrl: multiAccountUrl });
    assert.equal(gemini.replyStyle, 'separate'); assert.equal(gemini.localNotices.length, 0);
    x.$('bindings').querySelector('button').click(); await settle();
    assert.equal(gemini.groups[0].binding, null); assert.equal(x.profiles.gemini.enabled, false);
    assert.deepEqual(x.profiles.chatgpt, originalChatgpt); assert.deepEqual(x.profiles.claude, originalClaude);
    const writes = x.calls.filter(call => ['options:config', 'options:save-words', 'options:bind', 'options:unbind', 'options:reply-style', 'options:clear-notices'].includes(call.type));
    assert.equal(writes.length, 6); assert.ok(writes.every(call => call.assistant === 'gemini' && call.platform === 'feishu'));
    assert.equal(x.calls.some(call => call.type === 'options:assistant'), false);
  } finally { x.close(); }
});

test('non-secret drafts are isolated across assistants and platforms, with secret input cleared on leaving', async () => {
  const x = await setup('feishu', { claude: { platform: 'feishu' } });
  try {
    x.$('app-id').value = 'cli_gpt_draft'; x.$('blocked-words').value = 'GPT 草稿';
    x.$('manual-group').value = 'oc_gpt_draft'; x.$('group').value = 'oc_group'; x.$('tab').value = '7';
    x.$('app-secret').value = 'unsaved-gpt-secret'; await x.change('reply-style', 'separate');
    await x.view('claude');
    assert.equal(x.$('app-secret').value, ''); assert.equal(x.$('manual-group').value, '');
    assert.equal(x.$('app-id').value, 'cli_claude');
    x.$('app-id').value = 'cli_claude_draft'; x.$('blocked-words').value = 'Claude 草稿';
    x.$('manual-group').value = 'oc_claude_draft'; x.$('tab').value = '8';
    await x.switchTo('qq');
    assert.equal(x.$('app-id').value, '102345688');
    assert.equal(x.$('blocked-words').value, 'Claude qq 词条');
    await x.switchTo('feishu');
    assert.equal(x.$('app-id').value, 'cli_claude_draft');
    assert.equal(x.$('manual-group').value, 'oc_claude_draft');
    assert.equal(x.$('tab').value, '8');
    await x.view('chatgpt'); await x.poll();
    assert.equal(x.$('app-id').value, 'cli_gpt_draft'); assert.equal(x.$('blocked-words').value, 'GPT 草稿');
    assert.equal(x.$('manual-group').value, 'oc_gpt_draft'); assert.equal(x.$('group').value, 'oc_group');
    assert.equal(x.$('tab').value, '7'); assert.equal(x.$('reply-style').value, 'separate');
    assert.equal(x.$('app-secret').value, '');
    assert.equal(x.calls.some(call => call.type === 'options:config' || call.type === 'options:save-words'), false);
  } finally { x.close(); }
});

test('independent switches support all sixteen combinations of four assistants', async () => {
  const x = await setup();
  try {
    const state = () => Object.values(x.profiles).map(profile => Number(profile.enabled)).join('');
    assert.equal(state(), '1000');
    const combinations = new Set([state()]);
    for (const assistant of ['qwen','gemini','qwen','claude','qwen','gemini','qwen','chatgpt','qwen','gemini','qwen','claude','qwen','gemini','qwen']) {
      const before = Object.fromEntries(Object.entries(x.profiles).map(([key, profile]) => [key, profile.enabled]));
      await x.toggle(assistant);
      assert.equal(x.profiles[assistant].enabled, !before[assistant]);
      for (const key of Object.keys(assistantNames)) {
        if (key !== assistant) assert.equal(x.profiles[key].enabled, before[key]);
        assert.equal(x.$('enabled-' + key).checked, x.profiles[key].enabled);
        assert.match(x.$('assistant-status-' + key).textContent, x.profiles[key].enabled ? /已开启/ : /已停用/);
      }
      assert.match(x.$('active-assistant').textContent, /正在配置 ChatGPT/);
      combinations.add(state());
    }
    assert.equal(combinations.size, 16);
    assert.equal(state(), '0000');
    assert.equal(x.calls.filter(call => call.type === 'options:assistant').length, 15);
    assert.equal(x.calls.some(call => call.type === 'options:config' || call.type === 'options:platform'), false);
  } finally { x.close(); }
});

test('disabled Claude can save credentials, filters, bindings and reply style without enabling either assistant', async () => {
  const notices = [{ tabId: 8, at: 1800000000000, error: 'Claude fixture notice' }];
  const x = await setup('qq', { claude: { platform: 'feishu', feishu: { localNotices: notices } } });
  try {
    await x.view('claude');
    assert.equal(x.$('save-app').disabled, false);
    assert.equal(x.$('connection').textContent, 'Claude · 飞书 已停用');
    assert.match(x.$('feedback').textContent, /已停用.*保存凭据、词表和群绑定/);
    x.$('app-id').value = 'cli_claude_new'; x.$('app-secret').value = 'new-user-typed-secret';
    await x.submit('app-form');
    x.$('blocked-words').value = 'Claude 独立过滤'; await x.submit('words-form');
    x.$('group').value = 'oc_group'; x.$('tab').value = '8'; await x.submit('bind-form');
    await x.change('reply-style', 'separate'); await x.submit('reply-style-form');
    await x.click('clear-notices');
    const claude = x.profiles.claude.states.feishu;
    assert.equal(claude.appId, 'cli_claude_new'); assert.deepEqual(claude.words, ['Claude 独立过滤']);
    assert.equal(claude.groups[0].binding.conversationUrl, 'https://claude.ai/chat/claude-fixture');
    assert.equal(claude.replyStyle, 'separate'); assert.equal(claude.localNotices.length, 0);
    x.$('bindings').querySelector('button').click(); await settle();
    assert.equal(claude.groups[0].binding, null);
    assert.equal(x.profiles.claude.enabled, false); assert.equal(x.profiles.chatgpt.enabled, true);
    assert.equal(x.states.feishu.appId, 'cli_fixture'); assert.deepEqual(x.states.feishu.words, ['飞书词条']);
    assert.equal(x.states.feishu.groups[0].binding, undefined);
    const writes = x.calls.filter(call => ['options:config', 'options:save-words', 'options:bind', 'options:unbind', 'options:reply-style', 'options:clear-notices'].includes(call.type));
    assert.equal(writes.length, 6); assert.ok(writes.every(call => call.assistant === 'claude' && call.platform === 'feishu'));
    assert.equal(x.calls.some(call => call.type === 'options:assistant'), false);
    assert.equal(x.$('app-secret').value, '');
  } finally { x.close(); }
});

test('an in-flight save prevents assistant changes and retains its original scope', async () => {
  const x = await setup(); const hold = deferred();
  try {
    x.hooks['options:config'] = () => hold.promise;
    x.$('app-id').value = '102345699'; await x.submit('app-form');
    assert.equal(x.$('view-claude').disabled, true); assert.equal(x.$('enabled-claude').disabled, true);
    assert.equal(x.$('view-gemini').disabled, true); assert.equal(x.$('enabled-gemini').disabled, true);
    await x.view('claude'); await x.toggle('claude'); await x.submit('words-form');
    await x.view('gemini'); await x.toggle('gemini');
    assert.equal(x.calls.some(call => call.assistant === 'claude'), false);
    assert.equal(x.calls.some(call => call.assistant === 'gemini'), false);
    hold.resolve(); await settle();
    assert.equal(x.states.qq.appId, '102345699');
    assert.equal(x.profiles.claude.states.qq.appId, '102345688');
    assert.equal(x.$('view-claude').disabled, false);
    assert.equal(x.profiles.gemini.states.qq.appId, '102345698');
    assert.equal(x.$('view-gemini').disabled, false);
  } finally { hold.resolve(); x.close(); }
});

test('assistant change loading blocks all old form submissions and stale unbind handlers', async () => {
  const x = await setup('qq', { qq: { groups: [{ chatId: 'qq_group', binding: { tabId: 7, conversationUrl } }] } });
  const hold = deferred();
  try {
    const oldUnbind = x.$('bindings').querySelector('button');
    x.hooks['options:moderation'] = message => message.assistant === 'claude' ? hold.promise : undefined;
    await x.view('claude');
    assert.equal(x.$('save-app').disabled, true);
    await x.submit('app-form'); await x.submit('words-form'); await x.submit('bind-form');
    oldUnbind.dispatchEvent(new x.window.Event('click')); await settle();
    assert.equal(x.calls.some(call => ['options:config', 'options:bind', 'options:unbind', 'options:save-words'].includes(call.type)), false);
    hold.resolve(); await settle();
    oldUnbind.dispatchEvent(new x.window.Event('click')); await settle();
    assert.equal(x.calls.some(call => call.type === 'options:unbind'), false);
    assert.match(x.$('feedback').textContent, /助手或平台已变化/);
    assert.equal(x.$('app-id').value, '102345688');
  } finally { hold.resolve(); x.close(); }
});

test('failed assistant load leaves old forms disabled until the selected assistant can be confirmed', async () => {
  const x = await setup();
  try {
    x.hooks['options:status'] = message => { if (message.assistant === 'claude') throw new Error('status fixture failure'); };
    await x.view('claude');
    assert.equal(x.$('save-app').disabled, true); assert.equal(x.$('enabled-chatgpt').disabled, true);
    await x.submit('app-form'); await x.submit('bind-form');
    assert.equal(x.calls.some(call => call.type === 'options:config' || call.type === 'options:bind'), false);
    delete x.hooks['options:status']; await x.click('refresh');
    assert.equal(x.$('save-app').disabled, false); assert.equal(x.$('app-id').value, '102345688');
  } finally { x.close(); }
});

test('failed enable request rolls its switch back without changing the other assistant', async () => {
  const x = await setup();
  try {
    x.hooks['options:assistant'] = () => { throw new Error('toggle fixture failure'); };
    await x.toggle('claude');
    assert.equal(x.$('enabled-claude').checked, false); assert.equal(x.$('enabled-chatgpt').checked, true);
    assert.equal(x.profiles.claude.enabled, false); assert.equal(x.profiles.chatgpt.enabled, true);
    assert.match(x.$('feedback').textContent, /toggle fixture failure/);
  } finally { x.close(); }
});

test('polling and draft preservation never read the secret input', async () => {
  const x = await setup();
  try {
    const input = x.$('app-secret'), descriptor = Object.getOwnPropertyDescriptor(x.window.HTMLInputElement.prototype, 'value');
    let reads = 0;
    Object.defineProperty(input, 'value', { get() { reads++; return descriptor.get.call(this); }, set(value) { descriptor.set.call(this, value); } });
    input.value = 'only-read-on-save';
    await x.poll(); await x.view('claude'); await x.view('gemini'); await x.view('chatgpt');
    assert.equal(reads, 0);
    input.value = 'explicit-save-secret'; await x.submit('app-form');
    assert.equal(reads, 1);
    const save = x.calls.find(call => call.type === 'options:config');
    assert.equal(save.appSecret, 'explicit-save-secret');
    assert.doesNotMatch(x.window.document.body.textContent, /only-read-on-save|explicit-save-secret/);
  } finally { x.close(); }
});

test('successful platform mutation with a failed refresh keeps stale platform forms locked', async () => {
  const x = await setup();
  try {
    x.hooks['options:moderation'] = message => { if (message.platform === 'feishu') throw new Error('words fixture failure'); };
    await x.switchTo('feishu');
    assert.equal(x.active, 'feishu'); assert.equal(x.$('save-app').disabled, true);
    await x.submit('app-form'); await x.submit('bind-form');
    assert.equal(x.calls.some(call => call.type === 'options:config' || call.type === 'options:bind'), false);
    delete x.hooks['options:moderation']; await x.click('refresh');
    assert.equal(x.$('save-app').disabled, false); assert.equal(x.$('app-id').value, 'cli_fixture');
  } finally { x.close(); }
});

test('a successful toggle remains reflected when its follow-up refresh fails', async () => {
  const x = await setup();
  try {
    x.hooks['options:status'] = () => { throw new Error('refresh fixture failure'); };
    await x.toggle('claude');
    assert.equal(x.profiles.claude.enabled, true); assert.equal(x.$('enabled-claude').checked, true);
    assert.equal(x.$('enabled-chatgpt').checked, true);
    assert.match(x.$('feedback').textContent, /refresh fixture failure/);
  } finally { x.close(); }
});


test('compact panels preserve unsaved configuration, expose only one panel and support keyboard navigation', async () => {
  const x = await setup();
  try {
    assert.equal(x.$('panel-connection').hidden, false);
    x.$('app-secret').value = 'unsaved-local-fixture'; x.$('blocked-words').value = 'custom unsaved';
    await x.click('tab-safety');
    assert.equal(x.$('panel-safety').hidden, false); assert.equal(x.$('panel-connection').hidden, true);
    x.$('tab-safety').dispatchEvent(new x.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal(x.$('panel-activity').hidden, false); assert.equal(x.$('tab-activity').getAttribute('aria-selected'), 'true');
    assert.equal(x.window.document.querySelectorAll('.view-panel:not([hidden])').length, 1);
    await x.click('tab-connection');
    assert.equal(x.$('app-secret').value, 'unsaved-local-fixture'); assert.equal(x.$('blocked-words').value, 'custom unsaved');
    assert.equal(x.calls.some(call => ['options:config', 'options:save-words'].includes(call.type)), false);
    assert.equal(x.window.localStorage.getItem('aichat.settings.panel'), 'connection');
  } finally { x.close(); }
});

test('clear history targets only the active assistant and platform while preserving queued and delivering rows', async () => {
  const jobs = ['completed', 'failed', 'cancelled', 'queued', 'delivering'].map((state, index) => ({ id: 'history-' + index, state, chatId: 'group', createdAt: 1800000000000 }));
  const x = await setup('qq', { qq: { jobs }, claude: { qq: { jobs } } });
  try {
    await x.click('tab-activity'); assert.equal(x.$('clear-history').disabled, false);
    await x.click('clear-history');
    assert.deepEqual(x.calls.filter(call => call.type === 'options:clear-history').map(call => [call.assistant, call.platform]), [['chatgpt', 'qq']]);
    assert.deepEqual(x.states.qq.jobs.map(job => job.state), ['queued', 'delivering']);
    assert.equal(x.profiles.claude.states.qq.jobs.length, 5);
    assert.match(x.$('feedback').textContent, /3 条已结束记录/); assert.equal(x.$('clear-history').disabled, true);
    await x.view('claude'); assert.equal(x.$('clear-history').disabled, false);
  } finally { x.close(); }
});

test('clear history failure leaves displayed records available', async () => {
  const x = await setup('qq', { qq: { jobs: [{ id: 'history', state: 'completed', chatId: 'group', createdAt: 1800000000000 }] } });
  try {
    x.hooks['options:clear-history'] = () => { throw new Error('history write failed'); };
    await x.click('clear-history');
    assert.match(x.$('feedback').textContent, /history write failed/); assert.equal(x.states.qq.jobs.length, 1);
    assert.equal(x.$('clear-history').disabled, false);
  } finally { x.close(); }
});

test('channel cards independently enable both transports and work under the assistant master switch', async () => {
  const x = await setup();
  try {
    await x.click('enabled-platform-feishu');
    assert.deepEqual(x.profiles.chatgpt.channels, { qq: true, feishu: true });
    assert.equal(x.active, 'qq');
    await x.switchTo('feishu'); assert.equal(x.$('connection').textContent, 'ChatGPT · 飞书 已连接');
    await x.click('enabled-platform-qq');
    assert.deepEqual(x.profiles.chatgpt.channels, { qq: false, feishu: true });
    await x.toggle('chatgpt');
    assert.equal(x.$('platform-status-feishu').textContent.startsWith('待助手开启'), true);
    await x.click('enabled-platform-qq');
    assert.equal(x.profiles.chatgpt.enabled, false); assert.deepEqual(x.profiles.chatgpt.channels, { qq: true, feishu: true });
    await x.toggle('chatgpt'); assert.equal(x.$('connection').textContent, 'ChatGPT · 飞书 已连接');
  } finally { x.close(); }
});
test('header logo follows the configured assistant and is bundled locally', async () => {
  const x = await setup();
  try {
    for (const assistant of ['chatgpt', 'claude', 'gemini', 'qwen', 'chatgpt']) {
      await x.view(assistant);
      assert.equal(x.$('brand-logo').getAttribute('src'), `assets/${assistant}.svg`);
      assert.equal(x.$('brand-logo').dataset.assistant, assistant);
      assert.equal(x.$('brand-logo').alt, assistantNames[assistant]);
    }
    for (const platform of ['qq', 'feishu']) assert.equal(x.$('platform-card-' + platform).querySelector('img').getAttribute('src'), `assets/${platform}.${platform === 'feishu' ? 'png' : 'svg'}`);
    assert.equal(x.$('platform'), null);
  } finally { x.close(); }
});

test('local failure diagnostics render as readable text and clear with the same notices', async()=>{
  const x=await setup('qq',{qq:{localNotices:[{tabId:7,at:1800000000000,error:'cloudflare_challenge',idleRefreshMs:650000,idleRefreshResumed:true,diagnostics:{pageAgeMs:20000,bridgeIdleMs:650000,visibility:'hidden',phase:'challenge-recovery'}}]}});
  try{assert.match(x.$('notices').textContent,/桥接闲置 650 秒.*页面运行 20 秒.*后台.*错误恢复.*发送前刷新已恢复/);await x.click('clear-notices');assert.doesNotMatch(x.$('notices').textContent,/本地诊断/);}finally{x.close();}
});

test('Qwen background observations display metadata, survive polling and clear only their channel', async () => {
  const sample = { elapsedMs: 5000, gapMs: 1000, wakeAgeMs: 0, bodyChars: 222, bodyCount: 1, footerCount: 1,
    hidden: true, generating: false, complete: true, candidate: true, text: 'PRIVATE ANSWER' };
  const x = await setup('qq', { qwen: { qq: { backgroundObservation: { at: 1800000000000, receivedAt: 1800000000000, tabId: 10, samples: [sample] } } } });
  try {
    assert.doesNotMatch(x.$('notices').textContent, /Qwen 后台观察/);
    await x.view('qwen');
    assert.match(x.$('notices').textContent, /Qwen 后台观察.*后台.*正文 222 字.*完成校验通过/);
    assert.doesNotMatch(x.$('notices').textContent, /PRIVATE ANSWER/);
    assert.match(x.$('notices').textContent, /扩展收到最终答案.*群内送达结果见任务记录/);
    assert.equal(x.$('clear-notices').disabled, false);
    await x.switchTo('feishu'); assert.doesNotMatch(x.$('notices').textContent, /Qwen 后台观察/);
    await x.switchTo('qq'); await x.poll(); assert.match(x.$('notices').textContent, /正文 222 字/);
    await x.click('clear-notices'); assert.doesNotMatch(x.$('notices').textContent, /Qwen 后台观察/);
    assert.equal(x.$('clear-notices').disabled, true);
  } finally { x.close(); }
});
