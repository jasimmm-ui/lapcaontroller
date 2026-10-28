import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

test('mock receiver pairs, rejects invalid commands, recovers after restart, and shuts down cleanly', { timeout: 15000 }, async t => {
  const port = 18787; const base = `http://127.0.0.1:${port}`;
  let child; let output = '';
  async function start() {
    child = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, REMOTE_HOST:'127.0.0.1', REMOTE_PORT:String(port), ALLOWED_CIDR:'', ALLOWED_ORIGINS:'https://lapcontroller.vercel.app', MOCK_MODE:'true' }, stdio:['ignore','pipe','pipe'] });
    output = ''; child.stdout.on('data',d=>output+=d); child.stderr.on('data',d=>output+=d);
    const end=Date.now()+6000;
    while(Date.now()<end&&!output.includes('Pairing code')) { if(child.exitCode!==null) throw new Error(output); await new Promise(r=>setTimeout(r,50)); }
    const code=output.match(/Pairing code \(valid 10 minutes\): (\d{10})/)?.[1]; assert.ok(code,output); return code;
  }
  async function stop() { if(!child||child.exitCode!==null)return; child.kill('SIGTERM'); await new Promise(resolve=>{const timer=setTimeout(resolve,1500); child.once('exit',()=>{clearTimeout(timer);resolve();});}); }
  t.after(stop);
  const code=await start();
  const badOrigin=await fetch(`${base}/api/pair`,{method:'POST',headers:{'content-type':'application/json',origin:'https://attacker.example'},body:JSON.stringify({code})}); assert.equal(badOrigin.status,403);
  const cors=await fetch(`${base}/api/pair`,{method:'OPTIONS',headers:{origin:'https://lapcontroller.vercel.app','access-control-request-method':'POST','access-control-request-headers':'content-type'}}); assert.equal(cors.status,204); assert.equal(cors.headers.get('access-control-allow-origin'),'https://lapcontroller.vercel.app');
  const denied=await fetch(`${base}/api/pair`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:'00000000'})}); assert.equal(denied.status,401);
  const paired=await fetch(`${base}/api/pair`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code})}); assert.equal(paired.status,200); const {token,mock}=await paired.json(); assert.equal(mock,true);
  const call=async body=>fetch(`${base}/api/command`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(body)});
  assert.equal((await call({command:'mouse.move',dx:3,dy:2})).status,200);
  assert.equal((await call({command:'mouse.move',dx:99999,dy:0})).status,400);
  assert.equal((await call({command:'system.exec',cmd:'calc'})).status,400);
  assert.equal((await call({command:'app.launch',app:'powershell'})).status,400);
  await stop();
  const restartCode=await start(); const alive=await fetch(`${base}/api/pair`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:restartCode})}); assert.equal(alive.status,200);
  await stop();
  await assert.rejects(fetch(`${base}/api/status`));
});
