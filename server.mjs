import http from 'node:http';
import https from 'node:https';
import { openDatabase } from './database.mjs';
import { randomBytes, randomUUID, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const secret = () => `stk_${randomBytes(32).toString('base64url')}`;
const fail = (status, message) => Object.assign(new Error(message), { status });
const same = (a, b) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));

// Only globally routable IPv4 destinations; resolve once and pin the socket to
// that address to prevent redirects and DNS rebinding into the private network.
export function publicIPv4(address) {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some(x => !/^\d+$/.test(x) || +x > 255)) return false;
  const [a,b] = parts.map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0,2,168].includes(b)) ||
    (a === 198 && [18,19,51].includes(b)) || (a === 203 && b === 0));
}
export function validateDestination(value) {
  if (!value) return '';
  let u; try { u = new URL(value); } catch { throw fail(400, 'Enter a valid HTTPS destination.'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.hash || (u.port && u.port !== '443'))
    throw fail(400, 'Use an HTTPS URL on port 443, without credentials or a fragment.');
  if (u.hostname === 'localhost' || u.hostname.endsWith('.localhost') || u.hostname.includes(':') ||
      (/^[\d.]+$/.test(u.hostname) && !publicIPv4(u.hostname))) throw fail(400, 'Destination must be a public HTTPS service.');
  return u.href;
}
export async function deliver(destination, body, contentType, eventId) {
  const u = new URL(validateDestination(destination));
  const records = await Promise.race([lookup(u.hostname, { all: true, family: 4 }), new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('DNS lookup timed out')), 5000); timer.unref();
  })]);
  if (!records.length || records.some(r => !publicIPv4(r.address))) throw new Error('Destination resolves to a restricted address');
  return new Promise((resolve, reject) => {
    const request = https.request(u, { method: 'POST', agent: false,
      lookup: (_hostname, options, callback) => callback(null, options.all ? [records[0]] : records[0].address, 4),
      headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'Sportstech-Webhooks/1.0', 'X-Webhook-Event-Id': eventId }
    }, response => { response.destroy(); resolve({ status: response.statusCode }); });
    const deadline = setTimeout(() => request.destroy(new Error('Destination timed out after 10 seconds')), 10000);
    request.once('close', () => clearTimeout(deadline)); request.once('error', reject); request.end(body);
  });
}
async function readBody(req) {
  const parts = []; let bytes = 0;
  for await (const part of req) { bytes += part.length; if (bytes > 1024 * 1024) throw fail(413, 'Payload exceeds 1 MB.'); parts.push(part); }
  return Buffer.concat(parts).toString('utf8');
}
async function jsonBody(req) { try { return JSON.parse(await readBody(req)); } catch (e) { if (e.status) throw e; throw fail(400, 'Invalid JSON body.'); } }

export async function createApp({ database = ':memory:', connectionString, password, baseUrl = '', secureCookie = false, forward = deliver, background = () => {} } = {}) {
  if (connectionString && !password) throw new Error('ADMIN_PASSWORD is required with PostgreSQL.');
  const db = await openDatabase(database, connectionString);
  await db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS hooks (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, destination TEXT NOT NULL,
      key_hash TEXT NOT NULL, key_hint TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, hook_id TEXT NOT NULL REFERENCES hooks(id) ON DELETE CASCADE,
      body TEXT NOT NULL, content_type TEXT NOT NULL, headers TEXT NOT NULL, status TEXT NOT NULL, response_code INTEGER,
      error TEXT, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS events_hook ON events(hook_id, created_at);
    CREATE TABLE IF NOT EXISTS sessions (key TEXT PRIMARY KEY, expires BIGINT NOT NULL);
    CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires BIGINT NOT NULL);`);
  await db.prepare("UPDATE events SET status='failed',error='Delivery did not complete before the worker stopped' WHERE status='pending' AND created_at<?").run(new Date(Date.now()-120000).toISOString());
  let admin = (await db.prepare("SELECT value FROM settings WHERE key='admin'").get())?.value;
  let passwordChanged = false;
  if (admin && password) { const [salt,digest] = admin.split(':'); passwordChanged = !same(scryptSync(password,salt,64).toString('hex'),digest); }
  if (passwordChanged || !admin) {
    password ||= randomBytes(18).toString('base64url');
    const salt = randomBytes(16).toString('hex');
    admin = `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
    await db.prepare("INSERT INTO settings (key,value) VALUES ('admin',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(admin);
    await db.prepare('DELETE FROM sessions').run();
    if (!arguments[0]?.password) console.log(`\nInitial admin password: ${password}\nSave it securely. It is shown only once.\n`);
  }
  const jobs = new Set();
  const allow = async (key,max) => {
    const now = Date.now();
    await db.prepare('DELETE FROM rate_limits WHERE expires<?').run(now);
    const row = await db.prepare(`INSERT INTO rate_limits (key,count,expires) VALUES (?,1,?)
      ON CONFLICT(key) DO UPDATE SET count=rate_limits.count+1 RETURNING count`).get(key,now+60000);
    return row.count <= max;
  };
  const hook = async id => { const row = await db.prepare('SELECT * FROM hooks WHERE id=?').get(id); if (!row) throw fail(404, 'Webhook not found.'); return row; };
  const visible = h => { const { key_hash, ...rest } = h; return { ...rest, active: !!h.active }; };
  const fields = body => {
    if (!body || typeof body !== 'object' || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100) throw fail(400,'A webhook name of 1–100 characters is required.');
    if (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 1000)) throw fail(400,'Description must be at most 1,000 characters.');
    if (body.destination !== undefined && typeof body.destination !== 'string') throw fail(400,'Destination must be a URL.');
    return { name: body.name.trim(), description: body.description || '', destination: validateDestination(body.destination || '') };
  };
  const record = async (h, body, contentType, headers) => {
    const id = randomUUID(), created = new Date().toISOString();
    const safeHeaders = Object.fromEntries(Object.entries(headers).filter(([k]) => ['content-type','user-agent','x-request-id'].includes(k)));
    await db.prepare('INSERT INTO events (id,hook_id,body,content_type,headers,status,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id,h.id,body,contentType,JSON.stringify(safeHeaders),h.destination ? 'pending' : 'stored',created);
    await db.prepare('DELETE FROM events WHERE hook_id=? AND id NOT IN (SELECT id FROM events WHERE hook_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1000)').run(h.id,h.id);
    if (h.destination) {
      const job = Promise.resolve().then(() => forward(h.destination,body,contentType,id)).then(async result => {
        await db.prepare('UPDATE events SET status=?,response_code=?,error=? WHERE id=?').run(result.status >= 200 && result.status < 300 ? 'forwarded' : 'failed',result.status,result.status >= 200 && result.status < 300 ? null : `Destination returned HTTP ${result.status}`,id);
      }).catch(error => db.prepare("UPDATE events SET status='failed',error=? WHERE id=?").run(String(error.message).slice(0,500),id)).finally(() => jobs.delete(job));
      jobs.add(job);
      background(job);
      // Observe failures even if the database becomes unavailable after delivery.
      job.catch(error => console.error('Could not record forwarding result:', error.message));
    }
    return { id, status: h.destination ? 'pending' : 'stored' };
  };
  const server = http.createServer(async (req,res) => {
    const send = (status, data) => { res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('X-Frame-Options','DENY'); res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
    try {
      const url = new URL(req.url,'http://localhost'), p = url.pathname, method = req.method;
      if (p.startsWith('/hooks/')) {
        if (method !== 'POST') throw fail(405,'Use POST to send a webhook event.');
        const h = await hook(p.slice(7));
        const token = req.headers['x-webhook-key'] || req.headers.authorization?.replace(/^Bearer /i,'') || '';
        if (typeof token !== 'string' || !same(hash(token),h.key_hash)) throw fail(401,'Invalid webhook passkey.');
        if (!h.active) throw fail(403,'This webhook is paused.');
        if (!(await allow(`hook:${h.id}`,120))) throw fail(429,'Webhook limit reached. Retry in one minute.');
        if (jobs.size >= 50 && h.destination) throw fail(503,'Forwarding capacity reached. Retry shortly.');
        return send(202,await record(h,await readBody(req),req.headers['content-type'] || 'application/octet-stream',req.headers));
      }
      if (p.startsWith('/api/')) {
        if (method !== 'GET' && req.headers.origin) {
          const expected = baseUrl ? new URL(baseUrl).origin : `http://${req.headers.host}`;
          if (req.headers.origin !== expected) throw fail(403,'Request origin rejected.');
        }
        if (p === '/api/login' && method === 'POST') {
          if (!(await allow(`login:${req.socket.remoteAddress}`,10))) throw fail(429,'Too many sign-in attempts. Retry in one minute.');
          const body = await jsonBody(req); const [salt,digest] = admin.split(':');
          if (typeof body?.password !== 'string' || body.password.length > 1024 || !same(scryptSync(body.password,salt,64).toString('hex'),digest)) throw fail(401,'Incorrect admin password.');
          const token = randomBytes(32).toString('base64url'); await db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now()); await db.prepare('INSERT INTO sessions (key,expires) VALUES (?,?)').run(hash(token),Date.now()+8*3600000);
          res.setHeader('Set-Cookie',`session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secureCookie ? '; Secure' : ''}`); return send(200,{ok:true});
        }
        const token = req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('session='))?.slice(8) || '';
        if (((await db.prepare('SELECT expires FROM sessions WHERE key=?').get(hash(token)))?.expires || 0) <= Date.now()) throw fail(401,'Please sign in.');
        if (p === '/api/logout' && method === 'POST') { await db.prepare('DELETE FROM sessions WHERE key=?').run(hash(token)); res.setHeader('Set-Cookie',`session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie ? '; Secure' : ''}`); return send(200,{ok:true}); }
        if (p === '/api/hooks' && method === 'GET') {
          const hooks = (await db.prepare(`SELECT h.*, (SELECT COUNT(*) FROM events e WHERE e.hook_id=h.id) AS event_count,
            (SELECT MAX(created_at) FROM events e WHERE e.hook_id=h.id) AS last_received FROM hooks h ORDER BY created_at DESC`).all()).map(visible);
          return send(200,{hooks,baseUrl,stats:await db.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,SUM(CASE WHEN status='forwarded' THEN 1 ELSE 0 END) AS forwarded FROM events").get()});
        }
        if (p === '/api/hooks' && method === 'POST') {
          const f = fields(await jsonBody(req)), key = secret(), id = randomUUID();
          await db.prepare('INSERT INTO hooks (id,name,description,destination,key_hash,key_hint,created_at) VALUES (?,?,?,?,?,?,?)').run(id,f.name,f.description,f.destination,hash(key),key.slice(-6),new Date().toISOString());
          return send(201,{hook:visible(await hook(id)),key});
        }
        const match = p.match(/^\/api\/hooks\/([^/]+)(?:\/(rotate|events|test))?$/);
        if (match) {
          const h = await hook(match[1]), action = match[2];
          if (!action && method === 'PATCH') { const b = await jsonBody(req), f = fields({...h,...b}); if (b.active !== undefined && typeof b.active !== 'boolean') throw fail(400,'Active must be true or false.'); await db.prepare('UPDATE hooks SET name=?,description=?,destination=?,active=? WHERE id=?').run(f.name,f.description,f.destination,b.active === undefined ? h.active : +b.active,h.id); return send(200,{hook:visible(await hook(h.id))}); }
          if (!action && method === 'DELETE') { await db.prepare('DELETE FROM hooks WHERE id=?').run(h.id); return send(200,{ok:true}); }
          if (action === 'rotate' && method === 'POST') { const key = secret(); await db.prepare('UPDATE hooks SET key_hash=?,key_hint=? WHERE id=?').run(hash(key),key.slice(-6),h.id); return send(200,{key}); }
          if (action === 'events' && method === 'GET') return send(200,{events:await db.prepare('SELECT * FROM events WHERE hook_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100').all(h.id)});
          if (action === 'test' && method === 'POST') { if (!h.active) throw fail(403,'Resume the webhook before testing.'); if (!(await allow(`hook:${h.id}`,120)) || jobs.size >= 50) throw fail(429,'Please retry shortly.'); return send(202,await record(h,JSON.stringify({event:'webhook.test',source:'Sportstech dashboard',timestamp:new Date().toISOString()}),'application/json',{'user-agent':'Sportstech dashboard'})); }
        }
        throw fail(404,'API route not found.');
      }
      const assets = {'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css']};
      if (method !== 'GET' || !assets[p]) throw fail(404,'Page not found.');
      res.writeHead(200,{'Content-Type':`${assets[p][1]}; charset=utf-8`}); res.end(readFileSync(path.join(root,'public',assets[p][0])));
    } catch(error) { if (!res.headersSent) send(error.status || 500,{error:error.status ? error.message : 'An internal error occurred.'}); else res.end(); if (!error.status) console.error(error); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  return { server, handler: server.listeners('request')[0], db, drain: async () => { await Promise.allSettled([...jobs]); }, close: async () => { await new Promise(resolve => server.close(resolve)); await Promise.allSettled([...jobs]); await db.close(); } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const data = path.join(root,'data'); mkdirSync(data,{recursive:true,mode:0o700}); chmodSync(data,0o700);
  const baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/,'');
  if (baseUrl && !['http:','https:'].includes(new URL(baseUrl).protocol)) throw new Error('PUBLIC_BASE_URL must be HTTP or HTTPS');
  const app = await createApp({database:path.join(data,'webhooks.sqlite'),connectionString:process.env.POSTGRES_URL || process.env.DATABASE_URL,password:process.env.ADMIN_PASSWORD,baseUrl,secureCookie:baseUrl.startsWith('https:')});
  app.server.listen(Number(process.env.PORT || 4310),process.env.HOST || '127.0.0.1',()=>console.log(`Sportstech Webhooks: http://${process.env.HOST || '127.0.0.1'}:${app.server.address().port}`));
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal,async()=>{await app.close();process.exit(0);});
}
