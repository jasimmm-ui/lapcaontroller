import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createRelay } from './index.js';

const pepper = 'test-only-relay-pepper-0123456789-abcdefghijklmnopqrstuvwxyz';
const opaque = () => crypto.randomBytes(32).toString('base64url');
const uuid = () => crypto.randomUUID();

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'liquid-glass-relay-'));
  const dbPath = path.join(root, 'relay.sqlite');
  let clock = Date.now();
  const now = options.now || (() => clock);
  const relay = createRelay({ dbPath, pepper, frontendOrigins: 'https://lapcontroller.vercel.app,http://localhost:5173', now });
  const address = await relay.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const cleanup = async () => {
    try { await relay.close(); } finally {
      const resolvedRoot = path.resolve(root);
      const tempRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
      if (resolvedRoot.startsWith(tempRoot)) fs.rmSync(resolvedRoot, { recursive: true, force: true });
    }
  };
  if (!options.deferCleanup) t.after(cleanup);
  return { relay, base, dbPath, now, advance: amount => { clock += amount; }, cleanup };
}

async function post(base, pathName, body, headers = {}) {
  return fetch(`${base}${pathName}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

async function register(base, deviceId, credential, name = 'Laptop') {
  const response = await post(base, '/v1/receiver/register', { deviceId, credential, name, mock: true });
  assert.equal(response.status, 200, await response.text());
}

async function pairAndApprove(base, deviceId, receiverCredential, options = {}) {
  const auth = { 'x-device-id': deviceId, authorization: `Bearer ${receiverCredential}` };
  const codeResponse = await post(base, '/v1/receiver/pair-code', {}, auth);
  assert.equal(codeResponse.status, 200);
  const { code } = await codeResponse.json();
  const phoneId = uuid(); const phoneToken = opaque(); const nonce = opaque();
  const requestResponse = await post(base, '/v1/pair', { code, phoneId, phoneToken, nonce, phoneName: options.phoneName || 'Test phone' });
  assert.equal(requestResponse.status, 202);
  const { requestId } = await requestResponse.json();
  const poll = await fetch(`${base}/v1/receiver/poll`, { headers: auth });
  assert.equal(poll.status, 200);
  const pending = await poll.json();
  assert.equal(pending.pairs.length, 1);
  assert.equal(pending.pairs[0].id, requestId);
  const decision = await post(base, '/v1/receiver/decision', { requestId, approve: options.approve !== false }, auth);
  assert.equal(decision.status, 200);
  const status = await fetch(`${base}/v1/pair/${requestId}`, { headers: { authorization: `Bearer ${nonce}` } });
  assert.equal(status.status, 200);
  return { phoneId, phoneToken, nonce, requestId, status: await status.json(), auth };
}

function nextWsMessage(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for a relay heartbeat message.')), 3000);
    socket.once('message', data => { clearTimeout(timer); resolve(JSON.parse(data.toString())); });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

test('receiver and phone WebSockets authenticate and exchange heartbeat messages', async t => {
  const { base } = await fixture(t); const id = uuid(); const credential = opaque();
  await register(base, id, credential);
  const address = base.replace(/^http/, 'ws');
  const receiver = new WebSocket(`${address}/v1/ws/receiver`, { origin: 'http://localhost:5173' });
  t.after(() => receiver.close());
  await new Promise((resolve, reject) => { receiver.once('open', resolve); receiver.once('error', reject); });
  let response = nextWsMessage(receiver);
  receiver.send(JSON.stringify({ type: 'auth', deviceId: id, credential }));
  assert.equal((await response).type, 'authenticated');
  response = nextWsMessage(receiver);
  receiver.send(JSON.stringify({ type: 'heartbeat' }));
  assert.equal((await response).type, 'heartbeat_ack');

  const paired = await pairAndApprove(base, id, credential);
  const phone = new WebSocket(`${address}/v1/ws/phone`, { origin: 'https://lapcontroller.vercel.app' });
  t.after(() => phone.close());
  await new Promise((resolve, reject) => { phone.once('open', resolve); phone.once('error', reject); });
  response = nextWsMessage(phone);
  phone.send(JSON.stringify({ type: 'auth', receiverId: id, token: paired.phoneToken }));
  assert.equal((await response).type, 'authenticated');
  response = nextWsMessage(phone);
  phone.send(JSON.stringify({ type: 'heartbeat' }));
  assert.equal((await response).type, 'heartbeat_ack');
});

test('pairing uses a single-use three-digit code and requires laptop approval', async t => {
  const { base } = await fixture(t); const id=uuid(); const credential=opaque();
  await register(base,id,credential);
  const paired=await pairAndApprove(base,id,credential);
  assert.equal(paired.status.status,'approved');
  assert.equal(paired.status.receiverId,id);
  const replay=await post(base,'/v1/pair',{code:'000',phoneId:uuid(),phoneToken:opaque(),nonce:opaque()});
  assert.equal(replay.status,401);
});

test('incorrect, expired, and reused pairing codes are rejected', async t => {
  const { base, advance } = await fixture(t); const id=uuid(); const credential=opaque(); await register(base,id,credential);
  const auth={'x-device-id':id,authorization:`Bearer ${credential}`};
  const issued=await post(base,'/v1/receiver/pair-code',{},auth);const {code}=await issued.json();
  const invalid=await post(base,'/v1/pair',{code:'999',phoneId:uuid(),phoneToken:opaque(),nonce:opaque()});
  assert.equal(invalid.status,401);
  const good=await post(base,'/v1/pair',{code,phoneId:uuid(),phoneToken:opaque(),nonce:opaque()});assert.equal(good.status,202);
  const reused=await post(base,'/v1/pair',{code,phoneId:uuid(),phoneToken:opaque(),nonce:opaque()});assert.equal(reused.status,401);
  const code2=(await (await post(base,'/v1/receiver/pair-code',{},auth)).json()).code;
  advance(120_001);
  const expired=await post(base,'/v1/pair',{code:code2,phoneId:uuid(),phoneToken:opaque(),nonce:opaque()});assert.equal(expired.status,401);
});

test('pairing attempts are persistently rate limited', async t => {
  const { base }=await fixture(t);
  for(let i=0;i<5;i++)assert.equal((await post(base,'/v1/pair',{code:'999',phoneId:uuid(),phoneToken:opaque(),nonce:opaque()})).status,401);
  assert.equal((await post(base,'/v1/pair',{code:'999',phoneId:uuid(),phoneToken:opaque(),nonce:opaque()})).status,429);
});

test('unpaired phones cannot send commands and malformed commands are rejected', async t => {
  const { base }=await fixture(t);const id=uuid();const credential=opaque();await register(base,id,credential);
  let response=await post(base,`/v1/phones/${id}/commands`,{command:'mouse.click'},{authorization:`Bearer ${opaque()}`});
  assert.equal(response.status,401);
  const paired=await pairAndApprove(base,id,credential);
  response=await post(base,`/v1/phones/${id}/commands`,{command:'system.exec',cmd:'calc'},{authorization:`Bearer ${paired.phoneToken}`});
  assert.equal(response.status,400);
  response=await post(base,`/v1/phones/${id}/commands`,{command:'mouse.move',dx:1,dy:1,arbitrary:'extra'},{authorization:`Bearer ${paired.phoneToken}`});
  assert.equal(response.status,400);
});

test('authorized command travels to receiver poll and returns its result', async t => {
  const { base }=await fixture(t);const id=uuid();const credential=opaque();await register(base,id,credential);const paired=await pairAndApprove(base,id,credential);
  const commandPromise=post(base,`/v1/phones/${id}/commands`,{command:'mouse.move',dx:4,dy:-2},{authorization:`Bearer ${paired.phoneToken}`});
  const poll=await fetch(`${base}/v1/receiver/poll`,{headers:paired.auth});const data=await poll.json();
  assert.equal(data.commands.length,1);assert.equal(data.commands[0].command,'mouse.move');
  const result=await post(base,'/v1/receiver/result',{id:data.commands[0].id,ok:true},paired.auth);assert.equal(result.status,200);
  const command=await commandPromise;assert.equal(command.status,200);
});

test('phone credentials and associations survive relay and receiver reconnects, and can be revoked', async t => {
  const first=await fixture(t,{deferCleanup:true});const id=uuid();const credential=opaque();await register(first.base,id,credential);const paired=await pairAndApprove(first.base,id,credential);
  await register(first.base,id,credential,'Laptop after receiver restart');
  await first.relay.close();
  const next=createRelay({dbPath:first.dbPath,pepper,frontendOrigins:'https://lapcontroller.vercel.app'});const address=await next.listen();
  t.after(async()=>{await next.close();await first.cleanup();});
  const base=`http://127.0.0.1:${address.port}`;
  await register(base,id,credential,'Laptop after restart');
  let response=await fetch(`${base}/v1/phones/${id}/status`,{headers:{authorization:`Bearer ${paired.phoneToken}`}});assert.equal(response.status,200);
  assert.equal((await response.json()).online,true);
  const revoke=await fetch(`${base}/v1/receiver/phones/${paired.phoneId}`,{method:'DELETE',headers:paired.auth});assert.equal(revoke.status,200);
  response=await fetch(`${base}/v1/phones/${id}/status`,{headers:{authorization:`Bearer ${paired.phoneToken}`}});assert.equal(response.status,401);
});

test('receiver status becomes offline when its heartbeat is stale', async t => {
  const { base, advance }=await fixture(t);const id=uuid();const credential=opaque();await register(base,id,credential);const paired=await pairAndApprove(base,id,credential);
  advance(46_000);
  const response=await fetch(`${base}/v1/phones/${id}/status`,{headers:{authorization:`Bearer ${paired.phoneToken}`}});
  assert.equal((await response.json()).online,false);
});

test('relay does not store receiver or phone credentials in plaintext', async t => {
  const { base, dbPath }=await fixture(t);const id=uuid();const credential=opaque();await register(base,id,credential);const paired=await pairAndApprove(base,id,credential);
  const files=[dbPath,`${dbPath}-wal`].filter(fs.existsSync);
  const contents=Buffer.concat(files.map(file=>fs.readFileSync(file))).toString('utf8');
  assert.equal(contents.includes(credential),false);assert.equal(contents.includes(paired.phoneToken),false);
});

test('relay enforces exact website origin and bounded JSON requests', async t => {
  const { base }=await fixture(t);
  const rejected=await post(base,'/v1/pair',{code:'000',phoneId:uuid(),phoneToken:opaque(),nonce:opaque()},{origin:'https://attacker.example'});
  assert.equal(rejected.status,403);
  const allowed=await fetch(`${base}/v1/pair`,{method:'OPTIONS',headers:{origin:'https://lapcontroller.vercel.app','access-control-request-method':'POST','access-control-request-headers':'content-type,authorization'}});
  assert.equal(allowed.status,204);assert.equal(allowed.headers.get('access-control-allow-origin'),'https://lapcontroller.vercel.app');
});
