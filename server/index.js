import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { safeEqual, isPrivateIPv4, inCidr, makeLimiter } from './security.js';
import { validateCommand } from './validation.js';
import { executeWindows, shutdownWindows } from './windows.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const host = process.env.REMOTE_HOST || '127.0.0.1';
const port = Number(process.env.REMOTE_PORT || 8787);
const mock = process.env.MOCK_MODE !== 'false';
const lan = host !== '127.0.0.1' && host !== 'localhost';
const cidr = process.env.ALLOWED_CIDR || '';
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map(origin => origin.trim()).filter(Boolean));
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('REMOTE_PORT must be between 1024 and 65535.');
if (lan && (!isPrivateIPv4(host) || !(process.env.TLS_PFX || (process.env.TLS_CERT && process.env.TLS_KEY)) || !cidr)) throw new Error('LAN mode requires a private IPv4 REMOTE_HOST, ALLOWED_CIDR, and a TLS PFX or certificate/key pair. See README.md.');
if (cidr && !inCidr(host, cidr)) throw new Error('REMOTE_HOST must be inside ALLOWED_CIDR.');

const app = express(); app.disable('x-powered-by'); app.use(express.json({ limit: '4kb', strict: true }));
const code = BigInt(`0x${crypto.randomBytes(5).toString('hex')}`) % 10000000000n;
const pairingCode = String(code).padStart(10, '0');
const pairExpires = Date.now() + 10 * 60 * 1000;
let pairingUsed = false;
const pairLimiter = makeLimiter({ limit: 5, windowMs: 60_000 });
const commandLimiter = makeLimiter({ limit: 3000, windowMs: 60_000 });
const sessions = new Map();
const validToken = (req) => { const token = (req.headers.authorization || '').replace(/^Bearer /, ''); const created = sessions.get(token); return Boolean(token && created && Date.now()-created < 8*60*60*1000); };

app.use((req,res,next) => {
  if (lan && req.headers.host !== `${host}:${port}`) return res.status(403).json({ error: 'Host does not match the configured receiver address.' });
  if (!lan && req.headers.host !== `${host}:${port}` && !(host === '127.0.0.1' && req.headers.host === `localhost:${port}`)) return res.status(403).json({ error: 'Host does not match the loopback receiver address.' });
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const loopback = ip === '127.0.0.1' || ip === '::1';
  if (!loopback && (!isPrivateIPv4(ip) || !inCidr(ip, cidr))) return res.status(403).json({ error: 'Only the allowed private Wi-Fi network can connect.' });
  const origin = req.headers.origin;
  if (origin) {
    try {
      const u = new URL(origin); const hostHeader = req.headers.host;
      const isDevLoopback = !lan && u.port === '5173' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && (hostHeader?.startsWith('127.0.0.1:') || hostHeader?.startsWith('localhost:'));
      const isConfiguredOrigin = allowedOrigins.has(origin);
      if (lan && !isConfiguredOrigin && (u.hostname !== host || u.port !== String(port))) return res.status(403).json({ error: 'Origin does not match the configured receiver address.' });
      if (u.host !== hostHeader && !isDevLoopback && !isConfiguredOrigin) return res.status(403).json({ error: 'Origin does not match receiver host.' });
      if (lan && u.protocol !== 'https:') return res.status(403).json({ error: 'HTTPS is required.' });
      if (isDevLoopback || isConfiguredOrigin) {
        res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary','Origin');
        res.setHeader('Access-Control-Allow-Methods','GET, POST, DELETE, OPTIONS'); res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
      }
    } catch { return res.status(403).json({ error: 'Invalid request origin.' }); }
  }
  res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('X-Frame-Options','DENY');
  if (lan) res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.post('/api/pair', (req,res) => {
  const ip=(req.socket.remoteAddress||'unknown').replace(/^::ffff:/,'');
  if (!pairLimiter(ip)) return res.status(429).json({ error: 'Too many pairing attempts. Wait one minute and try again.' });
  if (pairingUsed || Date.now() > pairExpires || !req.body || typeof req.body.code !== 'string' || !safeEqual(req.body.code, pairingCode)) return res.status(401).json({ error: 'Pairing code is invalid, expired, or already used.' });
  pairingUsed = true;
  const token=crypto.randomBytes(32).toString('hex'); sessions.set(token, Date.now());
  res.json({ token, name: os.hostname(), mock });
});

app.delete('/api/session', (req,res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (token) sessions.delete(token);
  res.sendStatus(204);
});

app.get('/api/status', (req,res) => {
  if (!validToken(req)) return res.status(401).json({ error: 'Pair your phone first.' });
  res.json({ name: os.hostname(), mock, network: lan ? 'private Wi-Fi / HTTPS' : 'loopback', address: lan ? `${host}:${port}` : null, battery: null });
});

app.post('/api/command', async (req,res) => {
  if (!validToken(req)) return res.status(401).json({ error: 'Pair your phone first.' });
  const ip=(req.socket.remoteAddress||'unknown').replace(/^::ffff:/,'');
  if (!commandLimiter(ip)) return res.status(429).json({ error: 'Command rate limit reached.' });
  if (!validateCommand(req.body)) return res.status(400).json({ error: 'Invalid command or payload.' });
  const { command, ...payload }=req.body;
  try {
    if (!mock) await executeWindows(command,payload);
    res.json({ ok:true, mock, command });
  } catch(error) { res.status(500).json({ error:error.message || 'Windows action failed.' }); }
});

const dist=path.resolve(here,'../dist');
if (fs.existsSync(dist)) { app.use(express.static(dist,{ index:false, dotfiles:'deny' })); app.get('*path',(req,res)=>res.sendFile(path.join(dist,'index.html'))); }
const tlsOptions = lan ? (process.env.TLS_PFX
  ? { pfx:fs.readFileSync(process.env.TLS_PFX), passphrase:process.env.TLS_PFX_PASS }
  : { key:fs.readFileSync(process.env.TLS_KEY), cert:fs.readFileSync(process.env.TLS_CERT) }) : undefined;
const server = lan ? https.createServer(tlsOptions,app) : http.createServer(app);
server.listen(port,host,()=>{
  console.log(`Liquid Glass receiver listening at ${lan?'https':'http'}://${host}:${port}`);
  console.log(`Pairing code (valid 10 minutes): ${pairingCode}`);
  console.log(`Mock mode: ${mock?'ON (no system input)':'OFF'}`);
  if (lan && !cidr) console.warn('ALLOWED_CIDR is unset; any private IPv4 client can attempt pairing. Configure it to your Wi-Fi subnet.');
});
function shutdown(signal) { console.log(`\n${signal}: closing receiver...`); server.close(()=>{ sessions.clear(); shutdownWindows(); console.log('Receiver stopped.'); process.exit(0); }); setTimeout(()=>process.exit(1),5000).unref(); }
process.on('SIGINT',()=>shutdown('SIGINT')); process.on('SIGTERM',()=>shutdown('SIGTERM'));
