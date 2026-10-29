const $ = id => document.getElementById(id);
let hooks = [], origin = location.origin, editing = null, selected = null, refreshBusy = false;
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date = value => value ? new Date(value).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : 'No events yet';
function toast(message) { $('toast').textContent=message; $('toast').hidden=false; clearTimeout(toast.timer); toast.timer=setTimeout(()=>$('toast').hidden=true,4000); }
async function api(url, options={}) {
  const response = await fetch(url,{...options,headers:{'Content-Type':'application/json',...options.headers}});
  const data = await response.json();
  if (!response.ok) { if (response.status===401 && url!=='/api/login') showLogin(); throw new Error(data.error || 'Request failed'); } return data;
}
function showLogin() { $('workspace').hidden=true; $('login').hidden=false; for(const d of document.querySelectorAll('dialog[open]'))d.close(); }
async function refresh() {
  if(refreshBusy)return;refreshBusy=true;
  try {const data=await api('/api/hooks');hooks=data.hooks;origin=data.baseUrl||location.origin;$('login').hidden=true;$('workspace').hidden=false;
    $('stat-hooks').textContent=hooks.length;$('stat-active').textContent=`${hooks.filter(h=>h.active).length} active endpoints`;
    $('stat-events').textContent=data.stats.total||0;$('stat-forwarded').textContent=data.stats.forwarded||0;$('stat-failed').textContent=data.stats.failed||0;
    $('hook-count').textContent=hooks.length;renderHooks();
    if(selected && $('details').open)await refreshEvents();
  } finally{refreshBusy=false;}
}
function renderHooks(){
  const query=$('search').value.toLowerCase(), filter=$('filter').value;
  const shown=hooks.filter(h=>(h.name+' '+h.description).toLowerCase().includes(query)&&(filter==='all'||h.active===(filter==='active')));
  $('hook-list').innerHTML=shown.length?shown.map(h=>`<article class="hook-card"><div class="hook-icon" aria-hidden="true">↳</div><div><h3>${esc(h.name)}</h3><p>${esc(h.description||'Ready to receive events.')}</p><div class="hook-meta"><span>${h.destination?'STORE + FORWARD':'RECEIVE + STORE'}</span><span>${h.event_count} events</span><span>Last received: ${esc(date(h.last_received))}</span></div></div><div class="hook-actions"><span class="status ${h.active?'':'paused'}">● &nbsp;${h.active?'Active':'Paused'}</span><button class="secondary" data-open="${h.id}">Manage ↗</button></div></article>`).join(''):
  `<div class="empty"><div class="hook-icon">↗</div><h2>${hooks.length?'No matching connections.':'Your next connection starts here.'}</h2><p>${hooks.length?'Try a different search or status.':'Give your systems a secure place to send events. Create your first webhook to get moving.'}</p>${hooks.length?'':'<button class="primary" id="empty-create">＋ Create your first webhook</button>'}</div>`;
  document.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openDetails(b.dataset.open).catch(e=>toast(e.message)));
  if($('empty-create'))$('empty-create').onclick=()=>openEditor();
}
$('login-form').onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;$('login-error').textContent='';try{await api('/api/login',{method:'POST',body:JSON.stringify({password:$('password').value})});$('password').value='';await refresh();}catch(error){$('login-error').textContent=error.message;}finally{b.disabled=false;}};
$('logout').onclick=async()=>{try{await api('/api/logout',{method:'POST'});showLogin();}catch(e){toast(e.message);}};
$('search').oninput=renderHooks;$('filter').onchange=renderHooks;$('new-hook').onclick=()=>openEditor();
function openEditor(h=null){editing=h?.id||null;$('editor-title').textContent=h?'Edit webhook':'Create a webhook';$('hook-name').value=h?.name||'';$('hook-description').value=h?.description||'';$('hook-destination').value=h?.destination||'';$('save-hook').textContent=h?'Save changes ↗':'Create connection ↗';$('form-error').textContent='';$('editor').showModal();}
$('hook-form').onsubmit=async e=>{e.preventDefault();e.submitter.disabled=true;$('form-error').textContent='';try{const data=await api(editing?`/api/hooks/${editing}`:'/api/hooks',{method:editing?'PATCH':'POST',body:JSON.stringify({name:$('hook-name').value,description:$('hook-description').value,destination:$('hook-destination').value})});$('editor').close();await refresh();if(data.key)showCredentials(data.hook.id,data.key);else{toast('Connection updated.');if(selected)await openDetails(selected);}}catch(error){$('form-error').textContent=error.message;}finally{e.submitter.disabled=false;}};
function showCredentials(id,key){const url=`${origin}/hooks/${id}`;$('created-url').value=url;$('created-key').value=key;$('curl-example').textContent=`curl -X POST '${url}' \\\n  -H 'Content-Type: application/json' \\\n  -H 'X-Webhook-Key: ${key}' \\\n  -d '{"event":"order.created","order_id":"1234"}'`;$('credentials').showModal();}
$('credentials').addEventListener('close',()=>{$('created-key').value='';$('curl-example').textContent='';});
document.querySelectorAll('.close-dialog').forEach(b=>b.onclick=()=>b.closest('dialog').close());
async function copy(value){try{await navigator.clipboard.writeText(value);toast('Copied to clipboard.');}catch{toast('Clipboard unavailable. Select and copy the text manually.');}}
document.querySelectorAll('[data-copy]').forEach(b=>b.onclick=()=>copy($(b.dataset.copy).value));
function confirmAction(title,message){$('confirm-title').textContent=title;$('confirm-message').textContent=message;$('confirm-dialog').showModal();return new Promise(resolve=>{const finish=value=>{$('confirm-dialog').close();resolve(value);};$('confirm-cancel').onclick=()=>finish(false);$('confirm-ok').onclick=()=>finish(true);$('confirm-dialog').oncancel=e=>{e.preventDefault();finish(false);};});}
async function openDetails(id){selected=id;const h=hooks.find(h=>h.id===id);if(!h){$('details').close();return;}
$('detail-content').innerHTML=`<div class="dialog-heading"><div><div class="eyebrow">CONNECTION DETAILS</div><h2>${esc(h.name)}</h2></div><button class="icon-button" id="close-details" aria-label="Close">×</button></div><p>${esc(h.description||'No description added.')}</p><label>Webhook URL<div class="copy-field"><input id="detail-url" readonly value="${esc(origin+'/hooks/'+h.id)}"><button class="secondary" id="copy-url">Copy</button></div></label><small>Passkey: ••••••••${esc(h.key_hint)} · ${h.active?'Active':'Paused'}<br>Destination: ${esc(h.destination||'Store events only')}</small><div class="detail-top"><button class="secondary" id="test-hook">Send test event</button><button class="secondary" id="edit-hook">Edit</button><button class="secondary" id="toggle-hook">${h.active?'Pause':'Resume'}</button><button class="secondary" id="rotate-key">Rotate passkey</button><button class="secondary" id="delete-hook">Delete</button></div><div class="section-title"><h2>Incoming events</h2><span class="muted">Latest 100 · 1,000 retained</span></div><div id="event-list">Loading events…</div>`;
$('close-details').onclick=()=>$('details').close();$('copy-url').onclick=()=>copy($('detail-url').value);
$('edit-hook').onclick=()=>openEditor(h);
$('test-hook').onclick=e=>runButton(e.currentTarget,async()=>{await api(`/api/hooks/${id}/test`,{method:'POST'});toast('Test event received.');await refreshEvents();});
$('toggle-hook').onclick=e=>runButton(e.currentTarget,async()=>{await api(`/api/hooks/${id}`,{method:'PATCH',body:JSON.stringify({active:!h.active})});await refresh();await openDetails(id);});
$('rotate-key').onclick=e=>runButton(e.currentTarget,async()=>{if(!await confirmAction('Rotate this passkey?','The current passkey will stop working immediately. Update every sender with the new key.'))return;const data=await api(`/api/hooks/${id}/rotate`,{method:'POST'});await refresh();showCredentials(id,data.key);});
$('delete-hook').onclick=e=>runButton(e.currentTarget,async()=>{if(!await confirmAction('Delete this webhook?','This permanently deletes the endpoint and its stored events. Senders will lose access.'))return;await api(`/api/hooks/${id}`,{method:'DELETE'});$('details').close();selected=null;await refresh();toast('Webhook deleted.');});
if(!$('details').open)$('details').showModal();await refreshEvents();}
async function runButton(button,fn){button.disabled=true;try{await fn();}catch(e){toast(e.message);}finally{button.disabled=false;}}
async function refreshEvents(){const id=selected;if(!id)return;const data=await api(`/api/hooks/${id}/events`);if(selected!==id||!$('event-list'))return;
const expanded=new Set([...document.querySelectorAll('.event[open]')].map(e=>e.dataset.event));
$('event-list').innerHTML=data.events.length?data.events.map(event=>{let body=event.body;try{body=JSON.stringify(JSON.parse(body),null,2);}catch{}return `<details class="event" data-event="${event.id}" ${expanded.has(event.id)?'open':''}><summary><span class="${esc(event.status)}">● ${esc(event.status)}</span><span>${esc(event.content_type)} ${event.response_code?'· HTTP '+event.response_code:''}</span><time>${esc(date(event.created_at))}</time></summary>${event.error?`<p class="failed">${esc(event.error)}</p>`:''}<small>Event ID: ${esc(event.id)}</small><pre>${esc(body||'(empty body)')}</pre><small>Request metadata</small><pre>${esc(JSON.stringify(JSON.parse(event.headers),null,2))}</pre></details>`;}).join(''):'<p>No events yet. Send a test event or connect your app using the URL and passkey.</p>';}
refresh().catch(e=>{if(e.message!=='Please sign in.')toast(e.message);});
setInterval(()=>{if(!$('workspace').hidden&&!document.hidden)refresh().catch(e=>toast(e.message));},5000);
