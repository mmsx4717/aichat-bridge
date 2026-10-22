// Offline native-Chromium regression; never connects to the user's browser.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beginBackgroundRendering } from '../extension/qwen-dom.js';
const helper = fileURLToPath(new URL('../extension/qwen-frame-scheduler.js', import.meta.url));
const output = path.join(os.tmpdir(), 'aichat-qwen-frame-browser-check.js');
fs.writeFileSync(output, `async page => {
  const context = page.context();
  await context.route('**/*', route => {
    if (['https://chat.qwen.ai/c/frame-fixture', 'https://fixture.invalid/control'].includes(route.request().url()))
      return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Offline frame fixture</title><main>Offline</main>'});
    return route.abort();
  });
  await page.addInitScript({path:${JSON.stringify(helper)}});
  await page.goto('https://chat.qwen.ai/c/frame-fixture');
  const cdp = await context.newCDPSession(page);
  // Tool-driven focus emulation would invalidate a background test. Disable
  // it only in this disposable fixture, then read via CDP without activation.
  await cdp.send('Emulation.setFocusEmulationEnabled', {enabled:false});
  const mainEval = async fn => {
    const value = await cdp.send('Runtime.evaluate',{expression:'('+fn.toString()+')()',returnByValue:true});
    if(value.exceptionDetails) throw new Error(value.exceptionDetails.text);
    return value.result.value;
  };
  const {frameTree} = await cdp.send('Page.getFrameTree');
  const {executionContextId} = await cdp.send('Page.createIsolatedWorld', {frameId:frameTree.frame.id,worldName:'aichat-fixture'});
  const isolated = async expression => {
    const value = await cdp.send('Runtime.evaluate',{expression,contextId:executionContextId,returnByValue:true});
    if(value.exceptionDetails) throw new Error(value.exceptionDetails.text);
    return value.result.value;
  };
  await isolated('globalThis.fixtureClient = (' + ${JSON.stringify(beginBackgroundRendering.toString())} + ')(document, 60000)');
  const control = await context.newPage();
  await control.goto('https://fixture.invalid/control'); await control.bringToFront();
  const {windowId} = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', {windowId,bounds:{windowState:'minimized'}});
  await cdp.send('Runtime.evaluate',{expression:'new Promise(resolve => setTimeout(resolve,250))',awaitPromise:true});
  const visibility = await mainEval(() => ({visibility:document.visibilityState,focused:document.hasFocus()}));
  await mainEval(() => {window.fixtureCalls=0;requestAnimationFrame(() => window.fixtureCalls++);});
  await cdp.send('Runtime.evaluate',{expression:'new Promise(resolve => setTimeout(resolve,1300))',awaitPromise:true});
  const before = await mainEval(() => window.fixtureCalls);
  await isolated('fixtureClient.wake()');
  const after = await mainEval(() => window.fixtureCalls);
  const stats = await isolated('fixtureClient.stats()');
  await isolated('fixtureClient.stop()');
  await mainEval(() => requestAnimationFrame(() => window.fixtureCalls++));
  await cdp.send('Runtime.evaluate',{expression:'new Promise(resolve => setTimeout(resolve,1300))',awaitPromise:true}); await isolated('fixtureClient.wake()');
  const afterStop = await mainEval(() => window.fixtureCalls);
  await cdp.send('Browser.setWindowBounds', {windowId,bounds:{windowState:'normal'}});
  await page.bringToFront(); await page.waitForTimeout(100);
  const afterNative = await mainEval(() => window.fixtureCalls);
  await control.close(); await cdp.detach();
  const result = {visibility,before,after,stats,afterStop,afterNative};
  if(visibility.visibility !== 'hidden') throw new Error('This browser did not hide the fixture: '+JSON.stringify(result));
  if(before!==0 || after!==1 || stats.frameResumed!==1 || afterStop!==1 || afterNative!==2) throw new Error(JSON.stringify(result));
  return result;
}`);
console.log(output);
