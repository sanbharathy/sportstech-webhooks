import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp, publicIPv4, validateDestination, deliver } from './server.mjs';
async function start(options={}) {
  const app=await createApp({password:'test-password-strong',...options});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;let cookie='';
  const call=async(p,method='GET',body,headers={})=>{const r=await fetch(base+p,{method,headers:{...(cookie?{Cookie:cookie}:{}),'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});if(r.headers.has('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,data:await r.json()};};
  return {...app,base,call};
}
test('management authorization, receiving, rotation, pause, deletion, and logout',async()=>{
 const app=await start();try{
  assert.equal((await app.call('/api/hooks')).status,401);
  assert.equal((await app.call('/api/login','POST',{password:'wrong'})).status,401);
  assert.equal((await app.call('/api/login','POST',{password:'test-password-strong'})).status,200);
  assert.equal((await app.call('/api/hooks','POST',{name:'blocked'}, {Origin:'https://evil.test'})).status,403);
  const created=await app.call('/api/hooks','POST',{name:'Orders',description:'Incoming orders'});assert.equal(created.status,201);
  const {hook,key}=created.data;const endpoint=`/hooks/${hook.id}`;
  assert.equal((await app.call(endpoint,'POST',{hello:true})).status,401);
  assert.equal((await app.call(endpoint,'POST',{order_id:42},{'X-Webhook-Key':key})).status,202);
  const events=await app.call(`/api/hooks/${hook.id}/events`);assert.equal(events.data.events[0].body,'{"order_id":42}');assert.equal(events.data.events[0].status,'stored');assert.ok(!events.data.events[0].headers.includes(key));
  const list=await app.call('/api/hooks');assert.equal(list.data.hooks[0].event_count,1);assert.ok(!JSON.stringify(list.data).includes(key));assert.ok(!JSON.stringify(list.data).includes('key_hash'));
  const rotated=await app.call(`/api/hooks/${hook.id}/rotate`,'POST');assert.equal((await app.call(endpoint,'POST',{}, {'X-Webhook-Key':key})).status,401);
  assert.equal((await app.call(endpoint,'POST',{}, {Authorization:`Bearer ${rotated.data.key}`})).status,202);
  await app.call(`/api/hooks/${hook.id}`,'PATCH',{active:false});assert.equal((await app.call(endpoint,'POST',{}, {'X-Webhook-Key':rotated.data.key})).status,403);
  await app.call(`/api/hooks/${hook.id}`,'PATCH',{active:true});assert.equal((await app.call(`/api/hooks/${hook.id}/test`,'POST')).status,202);
  const large=await fetch(app.base+endpoint,{method:'POST',headers:{'X-Webhook-Key':rotated.data.key},body:'x'.repeat(1024*1024+1)});assert.equal(large.status,413);
  await app.call(`/api/hooks/${hook.id}`,'DELETE');assert.equal((await app.call(endpoint,'POST',{}, {'X-Webhook-Key':rotated.data.key})).status,404);assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM events').get().n,0);
  await app.call('/api/logout','POST');assert.equal((await app.call('/api/hooks')).status,401);
 }finally{await app.close();}
});
test('forwarding records success, HTTP failure, and network failure without losing the event',async()=>{
 let result={status:204};const sent=[];const app=await start({forward:async(...args)=>{sent.push(args);if(result instanceof Error)throw result;return result;}});
 try{await app.call('/api/login','POST',{password:'test-password-strong'});const c=await app.call('/api/hooks','POST',{name:'Relay',destination:'https://example.com/events'});const id=c.data.hook.id;
 for(const outcome of [{status:204},{status:503},new Error('Network unavailable')]){result=outcome;assert.equal((await app.call(`/hooks/${id}`,'POST',{event:'test'},{'X-Webhook-Key':c.data.key,'Content-Type':'application/json'})).status,202);await app.drain();}
 const events=(await app.call(`/api/hooks/${id}/events`)).data.events;assert.equal(events.length,3);assert.deepEqual(events.map(e=>e.status),['failed','failed','forwarded']);assert.match(events[0].error,/Network unavailable/);assert.equal(events[1].response_code,503);assert.equal(sent[0][1],'{"event":"test"}');assert.equal(sent[0][2],'application/json');assert.equal(sent[0].length,4);
 }finally{await app.close();}
});
test('hooks, hashed keys, admin credentials, and events persist across restarts',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'sportstech-test-'));const database=path.join(dir,'test.sqlite');let app=await start({database});
 try{await app.call('/api/login','POST',{password:'test-password-strong'});const c=(await app.call('/api/hooks','POST',{name:'Persistent'})).data;await app.call(`/hooks/${c.hook.id}`,'POST',{saved:true},{'X-Webhook-Key':c.key});assert.notEqual(app.db.prepare('SELECT key_hash FROM hooks').get().key_hash,c.key);await app.close();app=await start({database,password:undefined});assert.equal((await app.call('/api/login','POST',{password:'test-password-strong'})).status,200);assert.equal((await app.call('/api/hooks')).data.hooks.length,1);assert.equal((await app.call(`/hooks/${c.hook.id}`,'POST',{}, {'X-Webhook-Key':c.key})).status,202);
 }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
test('public forwarding rejects local, reserved, credentialed, and insecure destinations',async()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','192.168.1.1','169.254.169.254','100.100.100.200','172.31.1.1','0.0.0.0','198.18.0.1','203.0.113.10','224.1.1.1','::1'])assert.equal(publicIPv4(ip),false,ip);
 assert.equal(publicIPv4('8.8.8.8'),true);
 for(const dest of ['http://example.com','https://localhost','https://127.0.0.1','https://[::1]','https://user:pass@example.com','https://example.com:8443'])assert.throws(()=>validateDestination(dest));
 await assert.rejects(()=>deliver('https://127.0.0.1','{}','application/json','id'));
 const app=await start();try{await app.call('/api/login','POST',{password:'test-password-strong'});for(const body of [{name:''},{name:'a',description:123},{name:'a',destination:'http://example.com'}])assert.equal((await app.call('/api/hooks','POST',body)).status,400);}finally{await app.close();}
});
test('bot inbox: admin queues messages, bot pulls with its passkey, then acknowledges',async()=>{
 const app=await start();try{
  await app.call('/api/login','POST',{password:'test-password-strong'});
  const {hook,key}=(await app.call('/api/hooks','POST',{name:'Hermes'})).data;
  const inbox=`/hooks/${hook.id}/inbox`;
  assert.equal((await app.call(inbox)).status,401);
  assert.equal((await app.call(`/api/hooks/${hook.id}/messages`,'POST',{body:'hello hermes'})).status,201);
  assert.equal((await app.call(`/api/hooks/${hook.id}/messages`,'POST',{body:''})).status,400);
  const got=await app.call(inbox,'GET',undefined,{'X-Webhook-Key':key});
  assert.equal(got.status,200);assert.equal(got.data.messages[0].body,'hello hermes');
  assert.equal((await app.call(`/hooks/${hook.id}/inbox/ack`,'POST',{ids:[got.data.messages[0].id]},{'X-Webhook-Key':key})).status,200);
  assert.equal((await app.call(inbox,'GET',undefined,{'X-Webhook-Key':key})).data.messages.length,0);
  assert.equal((await app.call(`/api/hooks/${hook.id}/messages`)).data.messages[0].status,'acked');
 }finally{await app.close();}
});
