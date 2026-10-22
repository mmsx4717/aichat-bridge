// Prepare a Playwright CLI run-code file for an isolated Chromium session.
// Every browser request is fulfilled from the explicit local allowlist or
// aborted: this check never contacts Qwen or uses a logged-in browser profile.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const paths = { '/c/fixture-conversation': path.join(root, 'test/browser/qwen-completion.html') };
for (const name of ['qwen-dom', 'dom', 'shared', 'background-observation']) paths[`/extension/${name}.js`] = path.join(root, `extension/${name}.js`);
paths['/test-source.png'] = path.join(root, 'test/fixtures/image-equivalence/source.png');
for (let index = 1; index <= 4; index++) paths[`/test/upload_bridge-audit-${index}.png`] = paths['/test-source.png'];
const output = path.join(os.tmpdir(), 'aichat-qwen-browser-check.js');
fs.writeFileSync(output, `async page => {
  const paths = ${JSON.stringify(paths)};
  await page.route('**/*', route => {
    const pathname = route.request().url().replace(/^https:\\/\\/[^/]+/, '').split('?')[0];
    return paths[pathname] ? route.fulfill({ path: paths[pathname], contentType: pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.png') ? 'image/png' : 'text/html', headers: { 'Access-Control-Allow-Origin': 'https://chat.qwen.ai' } }) : route.abort();
  });
  await page.goto('https://chat.qwen.ai/c/fixture-conversation');
  await page.waitForFunction(() => window.regressionResult);
  const result = await page.evaluate(() => window.regressionResult);
  if (result.error) throw new Error(result.error);
  return result;
}`);
console.log(output);
