// Sanitized structures observed on chat.qwen.ai on 2026-10-17.
// No account identifiers, image signatures or remote requests are retained.
import { JSDOM } from 'jsdom';
export const url = 'https://chat.qwen.ai/c/fixture-conversation';
export const png = Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
export const payload = { mimeType: 'image/png', base64: png.toString('base64') };
export const composerHTML = `<div class="message-input-container"><div class="message-input-column-file"><div class="file-card-list"></div></div><div class="message-input-container-area"><textarea class="message-input-textarea"></textarea></div><div class="message-input-column-footer"><input id="filesUpload" multiple aria-label="上传文件" type="file" style="display:none"><div class="message-input-right-button-send"><button class="send-button" aria-label="发送"><svg><use xlink:href="#qwpcicon-sendChat"></use></svg></button></div></div></div>`;
export function page(options={}) { return new JSDOM(`<main><div id="chat-message-container"></div>${composerHTML}</main>`, { url, ...options }); }
export function user(doc, prompt='Question', id='user-1') {
  doc.querySelector('#chat-message-container').insertAdjacentHTML('beforeend', `<div class="qwen-chat-message-select-turn"><div class="qwen-chat-message-user"><div class="chat-user-message-container" data-msg-id="${id}" data-chat-id="${doc.location.pathname.split('/').at(-1)}"><div class="chat-user-message"><div class="chunked-text-renderer-root"><p class="user-message-content"></p></div></div></div></div></div>`);
  const node=doc.querySelector('#chat-message-container').lastElementChild.querySelector('[data-msg-id]'); node.querySelector('p').textContent=prompt; return node;
}
export function answer(doc, body='<div class="qwen-markdown-paragraph">你好</div>', id='answer-1') {
  doc.querySelector('#chat-message-container').lastElementChild.insertAdjacentHTML('beforeend', `<div class="qwen-chat-message-assistant"><div class="chat-response-message" id="chat-response-message-${id}"><div class="response-message-content phase-thinking">PRIVATE THOUGHT</div><div class="response-message-content phase-answer"><div class="custom-qwen-markdown"><div class="qwen-markdown">${body}</div></div></div><div class="response-message-footer"><div class="qwen-chat-package-comp-new-action-control" data-msg-id="${id}" data-chat-id="${doc.location.pathname.split('/').at(-1)}"><button class="qwen-chat-package-comp-new-action-control-container-copy" aria-label="复制"></button><button class="qwen-chat-package-comp-new-action-control-container-regenerate" aria-label="重新生成"></button></div></div></div></div>`);
  return doc.querySelector('#chat-response-message-'+id);
}
export function monaco(lines=['print(1 + 1)']) {
  const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll(' ','&nbsp;');
  return `<pre class="qwen-markdown-code"><div class="qwen-markdown-code-header"><div>python</div><div><button aria-label="复制">复制</button><button aria-expanded="true">折叠代码</button></div></div><div class="qwen-markdown-code-body"><div class="monaco-editor" role="code"><div class="margin-view-overlays" aria-hidden="true">${lines.map((_,i)=>`<div class="line-numbers">${i+1}</div>`).join('')}</div><div class="view-lines" aria-hidden="true" style="height:${lines.length*20}px">${lines.map((l,i)=>`<div class="view-line" style="top:${i*20}px;height:20px"><span>${escape(l)}</span></div>`).join('')}</div><div class="invisible scrollbar vertical" style="height:${lines.length*20}px"><div class="slider" style="height:${lines.length*20}px"></div></div></div></div></pre>`;
}
export function loaded(image, values={}) { Object.defineProperties(image,Object.fromEntries(Object.entries({complete:true,naturalWidth:640,naturalHeight:480,...values}).map(([k,value])=>[k,{value,configurable:true}]))); }
export function attachment(doc,name,source=`https://qwen-webui-prod.oss-accelerate.aliyuncs.com/test/upload_${name}`) {
  const card=doc.createElement('div');card.className='vision-item-container';card.innerHTML='<div class="media"><div class="vision-item-content"><img class="vision-item-image"></div></div><button class="close-button" aria-label="删除文件" style="visibility:hidden"></button>';
  const img=card.querySelector('img');img.alt=name;img.src=source;loaded(img);doc.querySelector('.file-card-list').append(card);return card;
}
export function fileHarness(win, onChange=()=>{}, { requireUploadType = false } = {}) {
  let files=[];const field=win.document.querySelector('#filesUpload');
  Object.defineProperty(field,'files',{get:()=>files,set:value=>{files=[...value];},configurable:true});
  win.DataTransfer=class { constructor(){this.files=[];this.items={add:file=>this.files.push(file)};} };
  field.addEventListener('change',()=>{
    if (requireUploadType && field.dataset.type !== 'file') { files = []; return; }
    onChange(files);
  });
  return {field, get files(){return files;}, set files(value){files=value;}};
}
