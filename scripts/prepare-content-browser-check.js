import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composerHTML } from '../test/helpers/qwen-fixture.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtures = {
  qwen: '<main><div id="chat-message-container"></div>' + composerHTML + '</main>',
  chatgpt: '<main></main><div data-composer-body><div data-composer-markdown contenteditable="true" role="textbox"></div><button data-testid="send-button">Send</button></div>',
};
for (const provider of ['claude', 'gemini']) fixtures[provider] = fs.readFileSync(path.join(root, `test/fixtures/${provider}-conversation.html`), 'utf8');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-content-audit-'));
const fixturePath = path.join(temporary, 'fixtures.js');
fs.writeFileSync(fixturePath, 'export default ' + JSON.stringify(fixtures));
const paths = { '/fixtures.js': fixturePath, '/test/browser/content-audit.js': path.join(root, 'test/browser/content-audit.js') };
for (const name of ['content', 'shared', 'dom', 'claude-dom', 'gemini-dom', 'qwen-dom', 'image-equivalence', 'background-observation']) paths[`/extension/${name}.js`] = path.join(root, `extension/${name}.js`);
const urls = ['https://chatgpt.com/c/fixture-conversation', 'https://claude.ai/chat/fixture-conversation', 'https://gemini.google.com/app/fixture-conversation', 'https://chat.qwen.ai/c/fixture-conversation'];
for (const url of urls) paths[new URL(url).pathname] = path.join(root, 'test/browser/content-audit.html');
const output = path.join(temporary, 'run.js');
const modes = process.argv.includes('--cleanup-only') ? ['cleanup-start', 'cleanup-failure'] : ['multiline', 'hydrate', 'remount', 'mismatch', 'incomplete', 'cleanup-start', 'cleanup-failure'];
fs.writeFileSync(output, `async page => {
  const paths = ${JSON.stringify(paths)}, urls = ${JSON.stringify(urls)}, results = [];
  await page.route('**/*', route => {
    const pathname = route.request().url().replace(/^https:\\/\\/[^/]+/, '').split('?')[0];
    return paths[pathname] ? route.fulfill({ path: paths[pathname], contentType: pathname.endsWith('.js') ? 'text/javascript' : 'text/html' }) : route.abort();
  });
  for (const url of urls) for (const mode of [...${JSON.stringify(modes)}, ...(${!process.argv.includes('--cleanup-only')} && url.startsWith('https://chat.qwen.ai/') ? ['late-hydrate', 'late-mismatch', 'late-id-change', 'late-row-replacement', 'confirmed-id-change'] : [])]) {
    await page.goto(url + '?mode=' + mode);
    await page.waitForFunction(() => window.regressionResult, undefined, { timeout: mode.startsWith('late-') ? 50000 : 20000 });
    const result = await page.evaluate(() => window.regressionResult);
    if(result.error) throw new Error(JSON.stringify(result));
    results.push(result);
  }
  return { passed: results.length, cases: results };
}`);
console.log(output);
