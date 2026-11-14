'use strict';
const $=id=>document.getElementById(id);
const icon=name=>{const s=document.createElementNS('http://www.w3.org/2000/svg','svg'),u=document.createElementNS(s.namespaceURI,'use');u.setAttribute('href','#i-'+name);s.setAttribute('aria-hidden','true');s.append(u);return s;};
const storageKey='bdarija-chats-v1',input=$('prompt'),composer=$('composer'),scroll=$('main-scroll');
const uid=()=>globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+Math.random().toString(36).slice(2,8);
let chats=[],current=null,pending=null,recording=null,transcribing=null,permissionPending=false,voiceEpoch=0,confirmAction=null,toastTimer,serviceConnected=null;
let mode='chat',mediaDbPromise=null;
const mediaCache=new Map();
function mediaDb(){
  if(!mediaDbPromise)mediaDbPromise=new Promise((resolve,reject)=>{
    if(!globalThis.indexedDB){reject(new Error('storage unavailable'));return;}
    const request=indexedDB.open('bdarija-media-v1',1);
    request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains('images'))request.result.createObjectStore('images');};
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('storage blocked'));
  });
  return mediaDbPromise;
}
function cacheMedia(id,blob){mediaCache.set(id,blob);while(mediaCache.size>8)mediaCache.delete(mediaCache.keys().next().value);}
async function saveMedia(blob){
  const id=uid();cacheMedia(id,blob);
  try{const db=await mediaDb();await new Promise((resolve,reject)=>{const tx=db.transaction('images','readwrite');tx.objectStore('images').put(blob,id);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});return{id,persisted:true};}
  catch{return{id,persisted:false};}
}
async function loadMedia(id){
  if(mediaCache.has(id))return mediaCache.get(id);
  try{const db=await mediaDb();return await new Promise((resolve,reject)=>{const r=db.transaction('images').objectStore('images').get(id);r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>reject(r.error);});}catch{return null;}
}
async function pruneMedia(){
  const kept=new Set(chats.flatMap(c=>c.messages.map(m=>m.imageId).filter(Boolean)));
  for(const id of mediaCache.keys())if(!kept.has(id))mediaCache.delete(id);
  try{const db=await mediaDb();await new Promise((resolve,reject)=>{const tx=db.transaction('images','readwrite'),store=tx.objectStore('images'),r=store.getAllKeys();r.onsuccess=()=>{for(const id of r.result)if(!kept.has(id))store.delete(id);};tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}catch{}
}
const blobDataURL=blob=>new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result));r.onerror=()=>reject(r.error);r.readAsDataURL(blob);});
function imageBlob(image,mimeType){
  if(!['image/jpeg','image/png'].includes(mimeType)||typeof image!=='string'||image.length>12000000||!/^[A-Za-z0-9+/]+={0,2}$/.test(image))throw new Error('الصورة ما وصلاتش مزيان. عاود جرّب.');
  const raw=atob(image),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));return new Blob([bytes],{type:mimeType});
}
function showImage(body,dataURL,prompt){
  const panel=document.createElement('div');panel.className='generated-image';
  const img=document.createElement('img');img.src=dataURL;img.alt=prompt||'صورة مولّدة بواسطة Bdarija';img.width=512;img.height=512;img.decoding='async';
  const download=document.createElement('a');download.className='image-download';download.href=dataURL;download.download='bdarija-image.'+(dataURL.startsWith('data:image/png')?'png':'jpg');download.append(icon('download'),document.createTextNode('حمّل الصورة'));
  panel.append(img,download);body.append(panel);const follow=scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<120;img.onload=()=>{if(follow)bottom();};
}
function renderSavedMessage(item){
  const box=addMessage(item.role,item.text,item.kind==='image');
  if(item.role==='model'&&item.kind==='image'&&item.imageId){
    const state=document.createElement('span');state.className='image-storage-note';state.textContent='كنحمّلو الصورة المحفوظة…';box.body.append(state);
    loadMedia(item.imageId).then(async blob=>{if(!box.body.isConnected)return;if(!blob){state.textContent='الصورة ما بقاتش محفوظة فهاد المتصفح. الوصف ديالها باقي فالمحادثة.';return;}const url=await blobDataURL(blob);if(!box.body.isConnected)return;state.remove();showImage(box.body,url,item.prompt);}).catch(()=>{if(state.isConnected)state.textContent='ما قدرناش نفتحو الصورة المحفوظة.';});
  }
}
function setMode(next){
  if(pending||recording||transcribing||permissionPending)return;
  mode=next==='image'?'image':'chat';
  $('mode-chat').setAttribute('aria-pressed',String(mode==='chat'));$('mode-image').setAttribute('aria-pressed',String(mode==='image'));
  input.maxLength=mode==='image'?2000:6000;input.placeholder=mode==='image'?'وصف الصورة اللي بغيتي نوجد ليك…':'شنو فبالك اليوم؟';
  $('send').setAttribute('aria-label',mode==='image'?'أنشئ الصورة':'صيفط السؤال');$('stop').setAttribute('aria-label',mode==='image'?'وقف انتظار الصورة':'وقف الجواب');
  document.querySelector('.hero-description').textContent=mode==='image'?'وصف خيالك بالتفاصيل، وخليه يولي صورة.':'كتب، فهم، وخطّط. البداية غير سؤال.';
  updateBusy();resizeInput();
}

try{const saved=JSON.parse(localStorage.getItem(storageKey));if(Array.isArray(saved))chats=saved.slice(0,24).filter(c=>c&&Array.isArray(c.messages)).map(c=>({id:typeof c.id==='string'?c.id:uid(),messages:c.messages.filter(m=>m&&['user','model'].includes(m.role)&&typeof m.text==='string'&&m.text.trim()).map(m=>({role:m.role,text:m.text.slice(0,16000),...(m.kind==='image'?{kind:'image'}:{}),...(typeof m.imageId==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(m.imageId)?{imageId:m.imageId}:{}),...(typeof m.prompt==='string'?{prompt:m.prompt.slice(0,2000)}:{})})),updatedAt:Number(c.updatedAt)||Date.now()}));if(localStorage.getItem('bdarija-large-type')==='true'){$('large-type').checked=true;document.body.classList.add('large-type');}}catch{}
const titleFor=c=>c.messages.find(m=>m.role==='user')?.text.replace(/\s+/g,' ').slice(0,64)||'محادثة جديدة';
function save(){try{localStorage.setItem(storageKey,JSON.stringify(chats.slice(0,24)));}catch{toast('المساحة فالمتصفح عامرة. حمّل المحادثة باش تحتافظ بيها.');}}
function toast(text){clearTimeout(toastTimer);$('toast').textContent=text;$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,3500);}
function feedback(text='',error=false){$('feedback').textContent=text;$('feedback').hidden=!text;$('feedback').classList.toggle('error',error);}
function resizeInput(){input.style.height='auto';input.style.height=Math.min(160,input.scrollHeight)+'px';}
function updateBusy(){const occupied=!!(pending||recording||transcribing||permissionPending);$('send').disabled=occupied||!input.value.trim();$('send').hidden=!!pending;$('stop').hidden=!pending;$('mic').disabled=!!(pending||transcribing||permissionPending);input.disabled=!!(recording||transcribing);$('mode-chat').disabled=occupied;$('mode-image').disabled=occupied;}
function bottom(){scroll.scrollTop=scroll.scrollHeight;}
function renderHistory(){const h=$('history');h.replaceChildren();$('history-empty').hidden=chats.length>0;$('chat-count').textContent=String(chats.length).padStart(2,'0');for(const c of chats){const b=document.createElement('button');b.type='button';b.className='thread';b.setAttribute('aria-current',String(c===current));const t=document.createElement('span');t.textContent=titleFor(c);b.title=titleFor(c);b.append(icon('chat'),t);b.onclick=()=>switchChat(c);h.append(b);}}
function closeMenu(){const was=$('sidebar').classList.contains('open');$('sidebar').classList.remove('open');$('overlay').hidden=true;$('menu').setAttribute('aria-expanded','false');document.querySelector('.workspace').inert=false;if(was)$('menu').focus();}
function openMenu(){$('sidebar').classList.add('open');$('overlay').hidden=false;$('menu').setAttribute('aria-expanded','true');document.querySelector('.workspace').inert=true;$('new-chat').focus();}
function cancelWork(){voiceEpoch++;pending?.abort();pending=null;transcribing?.abort();transcribing=null;if(recording){recording.discard=true;recording.stop();}permissionPending=false;updateBusy();}
function placeDock(){const active=!!current;$('welcome').hidden=active;$('chat-view').hidden=!active;$('chat-composer').hidden=!active;(active?$('chat-composer'):$('welcome-composer')).append($('dock'));if(active)$('conversation-title').textContent=titleFor(current);}
function switchChat(chat){cancelWork();current=chat;setMode(chat?.messages.at(-1)?.kind==='image'?'image':'chat');input.value='';resizeInput();feedback();$('messages').replaceChildren();$('messages').removeAttribute('aria-busy');placeDock();for(const m of chat?.messages||[])renderSavedMessage(m);renderHistory();closeMenu();updateBusy();bottom();}
function addMessage(role,text,noCopy=false){const article=document.createElement('article');article.className='message '+role;const avatar=document.createElement('span');avatar.className='message-avatar';avatar.setAttribute('aria-hidden','true');if(role==='model'){const logo=document.createElement('img');logo.src='/assets/bdarija-logo.webp';logo.alt='';logo.width=29;logo.height=29;avatar.append(logo);}else avatar.textContent='ب';const content=document.createElement('div');content.className='message-content';const author=document.createElement('span');author.className='message-author';author.textContent=role==='model'?'Bdarija':'نتا';const body=document.createElement('div');body.className='message-body';body.dir='auto';body.textContent=text;content.append(author,body);article.append(avatar,content);$('messages').append(article);if(role==='model'&&text&&!noCopy)addCopy(body);return{article,body,content};}
function addCopy(body){const actions=document.createElement('div');actions.className='message-actions';const b=document.createElement('button');b.type='button';b.className='copy-button';b.append(icon('copy'),document.createTextNode('نسخ الجواب'));b.onclick=async()=>{try{await navigator.clipboard.writeText(body.textContent);b.replaceChildren(icon('check'),document.createTextNode('تنسخ'));setTimeout(()=>{if(b.isConnected)b.replaceChildren(icon('copy'),document.createTextNode('نسخ الجواب'));},2000);}catch{toast('النسخ ما خدمش. تقدر تحدّد النص وتنسخو.');}};actions.append(b);body.after(actions);}
async function api(path,payload,signal){const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal});if(!response.headers.get('content-type')?.includes('application/json'))throw new Error('خدمة الأجوبة ما متوفّراش دابا. عاود جرّب من بعد.');const d=await response.json();if(!response.ok)throw new Error(d.error||'وقع مشكل فالخدمة. عاود جرّب.');return d;}
async function sendMessage({retry=false}={}){
  const text=input.value.trim();
  if(pending||recording||transcribing||permissionPending||(!retry&&!text))return;
  const requestMode=retry?(current?.messages.at(-1)?.kind==='image'?'image':'chat'):mode;
  if(!retry&&requestMode==='image'&&text.length>2000){feedback('الوصف طويل بزاف. خليه أقل من 2000 حرف.',true);return;}
  setMode(requestMode);feedback();
  if(!current){current={id:uid(),messages:[],updatedAt:Date.now()};chats.unshift(current);chats=chats.slice(0,24);placeDock();}
  const chat=current;
  if(!retry){const item={role:'user',text};if(requestMode==='image')item.kind='image';chat.messages.push(item);addMessage('user',text);input.value='';resizeInput();}
  else if(chat.messages.at(-1)?.role!=='user')return;
  chat.updatedAt=Date.now();save();renderHistory();$('conversation-title').textContent=titleFor(chat);
  const requestUser=chat.messages.at(-1),controller=new AbortController();pending=controller;updateBusy();
  const responseBox=addMessage('model',''),dots=document.createElement('span');dots.className='dots';dots.setAttribute('aria-label',requestMode==='image'?'كنوجد الصورة':'كنوجد الجواب');for(let i=0;i<3;i++)dots.append(document.createElement('i'));responseBox.body.append(dots);
  if(requestMode==='image'){const label=document.createElement('span');label.className='image-storage-note';label.textContent='كنوجدو الصورة ديالك…';responseBox.body.append(label);}
  $('messages').setAttribute('aria-busy','true');bottom();
  try{
    if(requestMode==='image'){
      const result=await api('/api/image',{prompt:requestUser.text},controller.signal);if(pending!==controller)return;
      const blob=imageBlob(result.image,result.mimeType),saved=await saveMedia(blob);
      if(pending!==controller){pruneMedia();return;}
      const item={role:'model',text:'الصورة ديالك واجدة.',kind:'image',imageId:saved.id,prompt:requestUser.text};chat.messages.push(item);save();pruneMedia();
      responseBox.body.textContent=item.text;showImage(responseBox.body,`data:${result.mimeType};base64,${result.image}`,requestUser.text);
      if(!saved.persisted)feedback('الصورة واجدة، ولكن ما قدرناش نحفظوها فالمتصفح. حمّلها باش تحتافظ بيها.');
    }else{
      const context=chat.messages.filter(m=>m.kind!=='image').slice(-21).map(m=>({role:m.role,text:m.text.slice(0,12000)}));
      let total=context.reduce((n,m)=>n+m.text.length,0);while(total>55000&&context.length>1)total-=context.shift().text.length;while(context[0]?.role==='model')context.shift();
      const result=await api('/api/chat',{messages:context},controller.signal);if(pending!==controller)return;
      if(typeof result.reply!=='string'||!result.reply.trim())throw new Error('الجواب جا خاوي. عاود جرّب.');
      chat.messages.push({role:'model',text:result.reply});save();responseBox.body.textContent=result.reply;addCopy(responseBox.body);
    }
    bottom();
  }catch(error){
    if(pending!==controller)return;
    responseBox.body.replaceChildren();responseBox.body.classList.add('message-error');
    responseBox.body.textContent=error.name==='AbortError'?(requestMode==='image'?'وقفنا انتظار الصورة. الطلب يقدر يكمل فالخدمة.':'توقّف الطلب. ملي تكون واجد تقدر تعاود تصيفط.'):error.message;
    const retryButton=document.createElement('button');retryButton.type='button';retryButton.className='retry-button';retryButton.textContent='عاود المحاولة';
    retryButton.onclick=()=>{if(pending||recording||transcribing||permissionPending)return;if(current!==chat||chat.messages.at(-1)!==requestUser){toast('هاد السؤال تبعاتو رسائل أخرى. صيفطو من جديد إلا بغيتي ترجع ليه.');return;}responseBox.article.remove();sendMessage({retry:true});};responseBox.content.append(retryButton);bottom();
  }finally{if(pending===controller){pending=null;$('messages').removeAttribute('aria-busy');updateBusy();input.focus();}}
}
composer.addEventListener('submit',e=>{e.preventDefault();sendMessage();});
input.addEventListener('input',()=>{resizeInput();updateBusy();});input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();composer.requestSubmit();}});
$('mode-chat').onclick=()=>{setMode('chat');input.focus();};$('mode-image').onclick=()=>{setMode('image');input.focus();};
$('stop').onclick=()=>pending?.abort();$('new-chat').onclick=()=>{switchChat(null);input.focus();};$('menu').onclick=openMenu;$('overlay').onclick=closeMenu;
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('sidebar').classList.contains('open')){e.preventDefault();closeMenu();}if(e.key==='Tab'&&$('sidebar').classList.contains('open')){const list=[...$('sidebar').querySelectorAll('a[href],button:not(:disabled)')];const first=list[0],last=list.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}});
window.matchMedia('(min-width:761px)').addEventListener('change',e=>{if(e.matches)closeMenu();});
function openDialog(id){closeMenu();$(id).showModal();}
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
document.querySelectorAll('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target!==d)return;const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}));
function renderSearch(){const query=$('search-input').value.trim().toLocaleLowerCase();const list=$('search-results');list.replaceChildren();const found=chats.filter(c=>c.messages.some(m=>m.text.toLocaleLowerCase().includes(query)));if(!found.length){const p=document.createElement('p');p.className='empty-results';p.textContent=query?'ما لقينا حتى محادثة بهاد الكلمة.':'المحادثات اللي غادي تبدا كتلقاها هنا.';list.append(p);return;}found.forEach(c=>{const b=document.createElement('button');b.className='search-result';const t=document.createElement('span');t.textContent=titleFor(c);b.append(icon('chat'),t);b.onclick=()=>{$('search-dialog').close();switchChat(c);};list.append(b);});}
$('open-search').onclick=()=>{$('search-input').value='';renderSearch();openDialog('search-dialog');$('search-input').focus();};$('search-input').addEventListener('input',renderSearch);
$('open-settings').onclick=()=>openDialog('settings-dialog');$('about-button').onclick=()=>openDialog('settings-dialog');
$('large-type').onchange=()=>{const enabled=$('large-type').checked;document.body.classList.toggle('large-type',enabled);try{localStorage.setItem('bdarija-large-type',String(enabled));}catch{}};
function confirmDelete(all=false){if(!all&&!current)return;$('confirm-title').textContent=all?'تمسح جميع المحادثات؟':'تمسح هاد المحادثة؟';$('confirm-description').textContent=all?'المحادثات اللي محفوظة فهاد المتصفح غادي تتمسح. هاد العملية ما يمكنش ترجعها.':'حمّل نسخة من المحادثة إلا بغيتي تحتافظ بيها. هاد العملية ما يمكنش ترجعها.';confirmAction=()=>{if(all)chats=[];else chats=chats.filter(c=>c!==current);save();pruneMedia();switchChat(null);toast(all?'تمسحو جميع المحادثات.':'تمسحات المحادثة.');};$('confirm-dialog').showModal();$('confirm-cancel').focus();}
$('delete-chat').onclick=()=>confirmDelete();$('clear-all').onclick=()=>{$('settings-dialog').close();confirmDelete(true);};$('confirm-cancel').onclick=()=>{$('confirm-dialog').close();confirmAction=null;};$('confirm-yes').onclick=()=>{const action=confirmAction;confirmAction=null;$('confirm-dialog').close();action?.();};
$('export-chat').onclick=()=>{if(!current)return;const content='Bdarija — '+titleFor(current)+'\n\n'+current.messages.map(m=>(m.role==='user'?'نتا':'Bdarija')+'\n'+m.text+(m.kind==='image'&&m.role==='model'?'\n[حمّل الصورة من داخل المحادثة]':'')).join('\n\n──────────\n\n');const url=URL.createObjectURL(new Blob(['\uFEFF'+content],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='bdarija-conversation.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('المحادثة واجدة للتحميل.');};
$('mic').onclick=async()=>{if(recording){recording.stop();return;}if(pending||transcribing||permissionPending)return;if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){feedback('التسجيل الصوتي ما مدعومش فهاد المتصفح. تقدر تكتب سؤالك.',true);return;}const epoch=voiceEpoch;permissionPending=true;updateBusy();feedback('عطي الإذن للميكروفون باش تسجّل سؤالك.');let stream;try{stream=await navigator.mediaDevices.getUserMedia({audio:true});if(epoch!==voiceEpoch){stream.getTracks().forEach(t=>t.stop());return;}permissionPending=false;const recorder=new MediaRecorder(stream),chunks=[];let timer;const session={discard:false,stop(){if(recorder.state!=='inactive')recorder.stop();}};recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};recorder.onerror=()=>{session.discard=true;session.stop();feedback('وقع مشكل فالتسجيل. عاود جرّب.',true);};recorder.onstop=async()=>{clearTimeout(timer);stream.getTracks().forEach(t=>t.stop());if(recording===session)recording=null;$('mic').classList.remove('recording');$('mic').setAttribute('aria-pressed','false');$('mic').setAttribute('aria-label','بدا التسجيل الصوتي');$('mic-label').textContent='قولها بصوتك';if(session.discard||epoch!==voiceEpoch){if(!recording)setMode(current?.messages.at(-1)?.kind==='image'?'image':'chat');updateBusy();return;}const ctl=new AbortController();transcribing=ctl;updateBusy();feedback('كنحوّلو كلامك لنص…');try{const blob=new Blob(chunks,{type:recorder.mimeType});if(!blob.size||blob.size>4000000)throw new Error('التسجيل خاوي ولا طويل بزاف. جرّب تسجيل أقصر.');const audio=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('ما قدرناش نقراو التسجيل.'));reader.readAsDataURL(blob);});if(transcribing!==ctl)return;const result=await api('/api/transcribe',{audio,mimeType:blob.type.split(';')[0]},ctl.signal);if(transcribing!==ctl)return;if(typeof result.transcript!=='string')throw new Error('ما قدرناش نفهمو التسجيل. عاود جرّب.');input.value=[input.value.trim(),result.transcript.trim()].filter(Boolean).join(' ').slice(0,6000);resizeInput();feedback('راجع النص على خاطرك، وصيفطو ملي تكون واجد.');}catch(e){if(transcribing===ctl)feedback(e.message||'ما قدرناش نحوّلو التسجيل لنص.',true);}finally{if(transcribing===ctl){transcribing=null;updateBusy();input.focus();}}};recorder.start();recording=session;timer=setTimeout(()=>session.stop(),45000);$('mic').classList.add('recording');$('mic').setAttribute('aria-pressed','true');$('mic').setAttribute('aria-label','وقف التسجيل');$('mic-label').textContent='وقف التسجيل';feedback('كنسجّلو… ضغط مرة أخرى باش توقف. أقصى مدة 45 ثانية.');updateBusy();}catch{stream?.getTracks().forEach(t=>t.stop());if(epoch===voiceEpoch){permissionPending=false;feedback('ما قدرناش نفتحو الميكروفون. شوف الإذن فإعدادات المتصفح.',true);updateBusy();}}};
window.addEventListener('pagehide',()=>{if(recording){recording.discard=true;recording.stop();}});
async function checkConnection(){try{const response=await fetch('/api/status',{signal:AbortSignal.timeout(6000)});const status=await response.json();serviceConnected=!!status.connected;$('connection-state').textContent=serviceConnected?'المساعد متصل بخدمة Gemini وواجد للمحادثة.':'الواجهة واجدة. خدمة الأجوبة والتفريغ الصوتي كتحتاج ربط مفتاح Gemini فإعدادات الخادم.';}catch{serviceConnected=false;$('connection-state').textContent='ما قدرناش نتحقّقو من اتصال المساعد. عاود جرّب من بعد.';}}
renderHistory();placeDock();updateBusy();checkConnection();pruneMedia();
