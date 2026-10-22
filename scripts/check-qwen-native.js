// Run the offline frame regression in a disposable browser, without
// Playwright's default focus emulation. Never use a user's browser profile.
// Usage: node scripts/check-qwen-native.js <Chrome executable> <Playwright module>
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import './prepare-qwen-frame-browser-check.js';
const [chromePath, playwrightModule] = process.argv.slice(2);
if (!chromePath || !playwrightModule) throw new Error('Provide a Chrome executable and installed Playwright module path');
const { chromium } = await import(pathToFileURL(path.resolve(playwrightModule)).href);
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'aichat-offline-frames-'));
const processHandle = spawn(chromePath, ['--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
const exited = new Promise(resolve => processHandle.once('exit', resolve));
let browser;
try {
  let endpoint;
  for (let n = 0; n < 100; n++) {
    const portFile = await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
    if (portFile) { const [port, pathname] = portFile.trim().split('\n'); endpoint = 'http://127.0.0.1:' + port; break; }
    await delay(100);
  }
  if (!endpoint) throw new Error('Temporary browser did not start');
  browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
  const context = browser.contexts()[0], page = context.pages()[0];
  const run = (0, eval)('(' + await fs.readFile(path.join(os.tmpdir(), 'aichat-qwen-frame-browser-check.js'), 'utf8') + ')');
  console.log(JSON.stringify(await run(page), null, 2));
} finally {
  await browser?.close().catch(() => {});
  processHandle.kill('SIGTERM');
  await Promise.race([exited, delay(3000)]);
  if (processHandle.exitCode === null) processHandle.kill('SIGKILL');
  await fs.rm(profile, { recursive: true, force: true });
}
