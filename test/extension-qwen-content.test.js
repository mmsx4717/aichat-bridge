import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as qwen from '../extension/qwen-dom.js';
import * as shared from '../extension/shared.js';
import {page,user,answer,monaco,attachment,loaded,fileHarness,png,url} from './helpers/qwen-fixture.js';
const source=(await readFile(new URL('../extension/content.js',import.meta.url),'utf8'))
  .replace("await import(chrome.runtime.getURL('qwen-dom.js'))",'globalThis.__qwen')
  .replace("await import(chrome.runtime.getURL('shared.js'))",'globalThis.__shared');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture({imageCount=0,remount=false,uploadMissing=false,mutation,assistant='qwen',delay=0,outputImages=0,hydratePrompt=false,incompletePrompt=false,hydrateDelay=400,partialPrompt=true}={}) {
  const {window:w}=page({runScripts:'outside-only',pretendToBeVisual:true});const d=w.document,messages=[],timers=new Map(),uploads=[];
  let now=1000,serial=0,clicks=0,released=0;const schedule=(fn,ms,repeat=0)=>{const id=++serial;timers.set(id,{fn,at:now+ms,repeat});return id;};
  w.Date=class extends Date{static now(){return now;}};w.setTimeout=(fn,ms)=>schedule(fn,ms);w.clearTimeout=id=>timers.delete(id);w.setInterval=(fn,ms)=>schedule(fn,ms,ms);w.clearInterval=id=>timers.delete(id);
  w.__shared=shared;w.__qwen={...qwen,releaseInputImages(input){released++;qwen.releaseInputImages(input);},readAnswerImage:image=>qwen.readAnswerImage(image,{fetchImpl:async()=>new Response(png,{headers:{'content-type':'image/png'}})})};
  const h=fileHarness(w,files=>{const f=files[0];uploads.push(f.name);h.files=[];if(!uploadMissing)attachment(d,f.name);if(remount){const i=qwen.composer(d),next=i.cloneNode(true);i.replaceWith(next);if(mutation==='remount-draft')next.value='Human draft';}}, {requireUploadType:true});
  d.addEventListener('input',()=>{
    if(mutation==='draft')schedule(()=>{qwen.composer(d).value='Human draft';},200);
    if(mutation==='navigation')schedule(()=>w.history.replaceState({},'', '/c/other-conversation'),200);
    if(mutation==='extra-user')schedule(()=>user(d,'Human','other-user'),200);
  });
  const send=d.querySelector('.send-button');send.addEventListener('click',()=>{
    clicks++;const text=qwen.composer(d).value;qwen.composer(d).value='';d.querySelector('.file-card-list').replaceChildren();const sent=user(d,hydratePrompt?'':text);
    if(hydratePrompt){if(partialPrompt)schedule(()=>{sent.querySelector('p').textContent=text.slice(0,3);},100);if(!incompletePrompt)schedule(()=>{sent.querySelector('p').textContent=text;},hydrateDelay);}
    send.querySelector('use').setAttribute('xlink:href','#stop');
    schedule(()=>{const node=answer(d,'<div class="qwen-markdown-paragraph">你好</div>'+monaco()+Array.from({length:outputImages},(_,n)=>`<img src="https://qwen-webui-prod.oss-accelerate.aliyuncs.com/output-${n}.png">`).join(''));node.querySelectorAll('img').forEach(i=>loaded(i));send.querySelector('use').setAttribute('xlink:href','#qwpcicon-sendChat');},delay);
  });
  const images=Array.from({length:imageCount},(_,n)=>({id:String(n+1).repeat(64),mimeType:'image/png',name:'source.png',bytes:png.length}));
  w.chrome={runtime:{id:'qwen-fixture',getURL:p=>'chrome-extension://qwen-fixture/'+p,onMessage:{addListener(){}},async sendMessage(m){messages.push(m);let data={};if(m.type==='bridge:poll')data={job:messages.filter(x=>x.type==='bridge:poll').length===1?{id:'qwen-job',assistant,conversationUrl:url,prompt:'Describe this',timeoutMs:90000,images}:null};if(m.type==='bridge:input-image')data={imageId:m.imageId,mimeType:'image/png',name:'source.png',base64:png.toString('base64')};if(m.type==='bridge:image')data={imageId:String(m.index+5).repeat(64)};return {ok:true,data};}}};
  w.eval(source);await flush();
  return {d,messages,uploads,get clicks(){return clicks;},get released(){return released;},get result(){return messages.find(m=>m.type==='bridge:result');},get error(){return messages.find(m=>m.type==='bridge:error');},async advance(ms){const target=now+ms;let steps=0;while(true){await flush();const [id,t]=[...timers].sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0]||[];if(!t||t.at>target)break;assert.ok(++steps<4000);now=t.at;timers.delete(id);if(t.repeat)timers.set(id,{...t,at:now+t.repeat});t.fn();}now=target;await flush();},close(){timers.clear();w.close();}};
}
for(const options of [{},{imageCount:1},{imageCount:4,remount:true,outputImages:4}])test('Qwen content sends once and returns scoped prose/code/images '+JSON.stringify(options),async()=>{const x=await fixture(options);try{await x.advance(3000);assert.equal(x.error,undefined);assert.equal(x.clicks,1);assert.equal(x.uploads.length,options.imageCount||0);assert.equal(x.result.text,'你好\n\n```python\nprint(1 + 1)\n```');assert.equal(x.result.images.length,options.outputImages||0);assert.equal(x.messages.filter(m=>m.type==='bridge:result').length,1);assert.equal(x.released,1);}finally{x.close();}});
test('Qwen generation can remain pending without prematurely reporting completion',async()=>{const x=await fixture({delay:20000});try{await x.advance(15000);assert.equal(x.error,undefined);assert.equal(x.result,undefined);await x.advance(8000);assert.ok(x.result);assert.equal(x.clicks,1);}finally{x.close();}});
test('Qwen failed uploads never submit text alone',async()=>{const x=await fixture({imageCount:1,uploadMissing:true});try{await x.advance(61000);assert.equal(x.clicks,0);assert.equal(x.result,undefined);assert.match(x.error.error,/未显示本次图片附件/);assert.equal(qwen.composer(x.d).value,'');assert.equal(x.uploads.length,1);}finally{x.close();}});
for(const mutation of ['draft','navigation','extra-user','remount-draft'])test('Qwen content preserves ownership when '+mutation,async()=>{const x=await fixture({mutation,imageCount:mutation==='remount-draft'?1:0,remount:mutation==='remount-draft'});try{await x.advance(3000);assert.equal(x.clicks,0);assert.ok(x.error);assert.equal(x.result,undefined);}finally{x.close();}});
for(const assistant of ['chatgpt','claude','gemini',null])test('Qwen rejects jobs assigned to '+assistant,async()=>{const x=await fixture({assistant});try{await x.advance(1000);assert.equal(x.clicks,0);assert.match(x.error.error,/助手与当前网页不一致/);}finally{x.close();}});

test('Qwen content waits for chunked submitted text before forwarding exactly once',async()=>{const x=await fixture({hydratePrompt:true,delay:600});try{await x.advance(3000);assert.equal(x.error,undefined);assert.ok(x.result);assert.equal(x.clicks,1);assert.equal(x.messages.filter(m=>m.type==='bridge:result').length,1);}finally{x.close();}});
test('Qwen incomplete prompt chunks time out without accepting an already completed answer',async()=>{const x=await fixture({hydratePrompt:true,incompletePrompt:true,delay:600});try{await x.advance(22000);assert.equal(x.result,undefined);assert.equal(x.error,undefined);await x.advance(70000);assert.match(x.error.error,/超时/);assert.equal(x.clicks,1);x.d.querySelector('.user-message-content').textContent='Describe this';await x.advance(1000);assert.equal(x.result,undefined);assert.equal(x.messages.filter(m=>m.type==='bridge:error').length,1);}finally{x.close();}});

for (const partialPrompt of [false, true]) test('Qwen accepts a fully rendered prompt after 20 seconds, with an earlier completed answer: '+partialPrompt, async () => {
  const x = await fixture({ hydratePrompt: true, hydrateDelay: 30000, partialPrompt, delay: 600 });
  try {
    await x.advance(25000);
    assert.equal(x.clicks, 1); assert.equal(x.error, undefined); assert.equal(x.result, undefined);
    assert.ok(x.d.querySelector('.response-message-footer'));
    await x.advance(7000);
    assert.equal(x.error, undefined); assert.ok(x.result); assert.equal(x.clicks, 1);
    assert.equal(x.messages.filter(m => m.type === 'bridge:result').length, 1);
  } finally { x.close(); }
});
test('Qwen pending prompt accepts one server ID promotion in the same row and forwards the completed answer once', async () => {
  const x = await fixture({ hydratePrompt: true, incompletePrompt: true, partialPrompt: false, delay: 600 });
  try {
    await x.advance(25000);
    const message = x.d.querySelector('.chat-user-message-container');
    const row = message.closest('.qwen-chat-message-select-turn');
    message.dataset.msgId = 'server-user-id'; message.querySelector('p').textContent = 'Describe this';
    await x.advance(1500);
    assert.equal(message.closest('.qwen-chat-message-select-turn'), row);
    assert.equal(x.error, undefined); assert.ok(x.result); assert.equal(x.clicks, 1);
    assert.equal(x.messages.filter(m => m.type === 'bridge:result').length, 1);
  } finally { x.close(); }
});

test('Qwen already confirmed prompt retains ownership when its ID is promoted during generation', async () => {
  const x = await fixture({ delay: 30000 });
  try {
    await x.advance(25000);
    assert.equal(x.result, undefined); assert.equal(x.error, undefined); assert.equal(x.clicks, 1);
    x.d.querySelector('.chat-user-message-container').dataset.msgId = 'server-confirmed-id';
    await x.advance(7000);
    assert.equal(x.error, undefined); assert.ok(x.result); assert.equal(x.clicks, 1);
    assert.equal(x.messages.filter(m => m.type === 'bridge:result').length, 1);
  } finally { x.close(); }
});

for (const action of ['different-text', 'replaced-row', 'navigation', 'missing-user']) test('Qwen delayed prompt cannot bypass '+action, async () => {
  const x = await fixture({ hydratePrompt: true, incompletePrompt: true, partialPrompt: false, delay: 600 });
  try {
    await x.advance(action === 'missing-user' ? 1000 : 25000);
    const message = x.d.querySelector('.chat-user-message-container');
    if (action === 'different-text') { message.dataset.msgId = 'server-user-id'; message.querySelector('p').textContent = 'Other question'; }
    if (action === 'replaced-row') {
      const row = message.closest('.qwen-chat-message-select-turn'), replacement = row.cloneNode(true);
      replacement.querySelector('.chat-user-message-container').dataset.msgId = 'replacement';
      replacement.querySelector('.chat-user-message-container p').textContent = 'Describe this';
      row.replaceWith(replacement);
    }
    if (action === 'navigation') x.d.defaultView.history.replaceState({}, '', '/c/other-conversation');
    if (action === 'missing-user') message.remove();
    await x.advance(action === 'missing-user' ? 22000 : 1000);
    assert.equal(x.result, undefined); assert.ok(x.error); assert.equal(x.clicks, 1);
    assert.match(x.error.error, action === 'different-text' ? /消息不同/ : action === 'replaced-row' ? /替换/ : action === 'navigation' ? /切换了对话/ : /未确认到本次网页消息/);
  } finally { x.close(); }
});
