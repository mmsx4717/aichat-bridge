import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import * as dom from '../extension/dom.js';
import * as shared from '../extension/shared.js';
const source=(await readFile(new URL('../extension/content.js',import.meta.url),'utf8')).replace("await import(chrome.runtime.getURL('dom.js'))",'globalThis.__dom').replace("await import(chrome.runtime.getURL('shared.js'))",'globalThis.__shared').replaceAll('location.reload();','globalThis.__reload();');
const url='https://chatgpt.com/c/idle-fixture';const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture({resumed=false,mutation,initialDraft='',lateEditor=false}={}){
  const page=new JSDOM('<main></main><form><textarea id="prompt-textarea"></textarea><button type="button" data-testid="send-button">Send</button></form>',{url,runScripts:'outside-only',pretendToBeVisual:true});
  const w=page.window,d=w.document,timers=new Map(),messages=[];let now=1000,serial=0,queued=false,offered=false,reloads=0,sends=0;const input=d.querySelector('textarea');input.value=initialDraft;
  const schedule=(fn,ms,repeat=0)=>{const id=++serial;timers.set(id,{fn,at:now+ms,repeat});return id;};
  w.Date=class extends Date{static now(){return now;}};w.setTimeout=(fn,ms)=>schedule(fn,ms);w.clearTimeout=id=>timers.delete(id);w.setInterval=(fn,ms)=>schedule(fn,ms,ms);w.clearInterval=id=>timers.delete(id);
  w.__dom=dom;w.__shared=shared;w.__reload=()=>{reloads++;};
  if(lateEditor){input.remove();schedule(()=>d.querySelector('form').prepend(input),1000);}
  d.querySelector('button').addEventListener('click',()=>{sends++;input.value='';d.querySelector('main').innerHTML='<div data-turn-key="new-turn"><div data-talvt-turn-state="complete"><div data-message-author-role="user" data-message-id="new-user"><div class="whitespace-pre-wrap">Hello</div></div><div data-message-author-role="assistant" data-message-id="new-answer"><div data-markdown-text-style="assistant-message"><p>Success</p></div></div><div class="turn-action-controls"><button aria-label="Copy">Copy</button></div></div></div>';});
  const job={id:'idle-job',assistant:'chatgpt',platform:'qq',conversationUrl:url,prompt:'Hello',timeoutMs:60000,images:[]};
  w.chrome={runtime:{id:'idle-fixture',getURL:p=>'chrome-extension://idle-fixture/'+p,onMessage:{addListener(){}},async sendMessage(m){messages.push(m);let data={ok:true};
    if(m.type==='bridge:challenge-resume')data={job:resumed?{...job,idleRefresh:{idleMs:650000,lastUserKey:mutation==='changed-history'?'message:original':null}}:null};
    if(m.type==='bridge:poll'){data={job:queued&&!offered?job:null};if(data.job)offered=true;}
    if(m.type==='bridge:idle-prepare'){if(mutation==='draft')input.value='Human draft';if(mutation==='navigation')w.history.replaceState({},'','/c/another-conversation');if(mutation==='new-user')d.querySelector('main').innerHTML='<div data-message-author-role="user" data-message-id="other">Human message</div>';}
    return {ok:true,data};}}};
  w.eval(source);await tick();
  return {d,messages,get reloads(){return reloads;},get sends(){return sends;},enqueue(){queued=true;},async advance(ms){const end=now+ms;let steps=0;while(true){await tick();const [id,t]=[...timers].sort((a,b)=>a[1].at-b[1].at)[0]||[];if(!t||t.at>end)break;assert.ok(++steps<10000);now=t.at;timers.delete(id);if(t.repeat)timers.set(id,{...t,at:now+t.repeat});t.fn();}now=end;await tick();},close(){timers.clear();w.close();}};
}
test('idle alone never refreshes; first queued task after ten minutes refreshes before input or start',async()=>{const x=await fixture();try{await x.advance(610000);assert.equal(x.reloads,0);x.enqueue();await x.advance(6000);assert.equal(x.reloads,1);assert.equal(x.sends,0);assert.equal(x.d.querySelector('textarea').value,'');assert.equal(x.messages.filter(m=>m.type==='bridge:idle-prepare').length,1);assert.equal(x.messages.some(m=>m.type==='bridge:started'),false);await x.advance(10000);assert.equal(x.reloads,1);}finally{x.close();}});
test('recent task sends normally without refreshing',async()=>{const x=await fixture();try{x.enqueue();await x.advance(7000);assert.equal(x.reloads,0);assert.equal(x.sends,1);assert.ok(x.messages.some(m=>m.type==='bridge:result'));}finally{x.close();}});
for(const lateEditor of [false,true])test('resumed idle task waits for readiness then sends exactly once '+lateEditor,async()=>{const x=await fixture({resumed:true,lateEditor});try{await x.advance(5000);assert.equal(x.reloads,0);assert.equal(x.sends,1);assert.equal(x.messages.filter(m=>m.type==='bridge:started').length,1);assert.equal(x.messages.filter(m=>m.type==='bridge:result').length,1);}finally{x.close();}});
for(const mutation of ['draft','navigation','new-user'])test('idle preflight aborts when page changes during acknowledgement: '+mutation,async()=>{const x=await fixture({mutation});try{await x.advance(610000);x.enqueue();await x.advance(6000);assert.equal(x.reloads,0);assert.equal(x.sends,0);assert.ok(x.messages.some(m=>m.type==='bridge:error'));if(mutation==='draft')assert.equal(x.d.querySelector('textarea').value,'');}finally{x.close();}});
test('existing draft is cleared before the queued idle refresh',async()=>{const x=await fixture({initialDraft:'Human draft'});try{await x.advance(610000);x.enqueue();await x.advance(6000);assert.equal(x.reloads,1);assert.equal(x.sends,0);assert.equal(x.d.querySelector('textarea').value,'');assert.equal(x.messages.some(m=>m.type==='bridge:idle-prepare'),true);}finally{x.close();}});
test('restored page with different latest message never submits and records bounded diagnostics',async()=>{const x=await fixture({resumed:true,mutation:'changed-history'});try{await x.advance(31000);assert.equal(x.sends,0);assert.equal(x.reloads,0);const e=x.messages.find(m=>m.type==='bridge:error');assert.match(e.error,/原对话或输入区尚未恢复/);assert.equal(e.diagnostics.bridgeIdleMs,650000);assert.equal(e.diagnostics.phase,'prepare');assert.equal(Object.hasOwn(e.diagnostics,'prompt'),false);}finally{x.close();}});
