import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';
import { RelayStore } from './store.js';
import { validateCommand } from '../server/validation.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const opaquePattern = /^[A-Za-z0-9_-]{40,64}$/;
const PAIR_TTL = 2 * 60 * 1000;
const ONLINE_TTL = 45 * 1000;
const POLL_TTL = 20 * 1000;
const COMMAND_TTL = 12 * 1000;

function bearer(req) {
  const value = req.get('authorization') || '';
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

function cleanName(value, fallback) {
  return (typeof value === 'string' ? value : '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 48) || fallback;
}

function safeId(value) { return typeof value === 'string' && uuidPattern.test(value); }
function opaque() { return crypto.randomBytes(32).toString('base64url'); }

export function createRelay({ dbPath, pepper, frontendOrigins, now = Date.now } = {}) {
  const store = new RelayStore(dbPath, pepper);
  const app = express();
  app.disable('x-powered-by');
  const configuredOrigins = new Set((frontendOrigins || '').split(',').map(value => value.trim()).filter(Boolean));
  if (process.env.NODE_ENV !== 'production') {
    configuredOrigins.add('http://localhost:5173');
    configuredOrigins.add('http://127.0.0.1:5173');
  }
  const trustHops = Number(process.env.TRUST_PROXY_HOPS || 0);
  if (!Number.isInteger(trustHops) || trustHops < 0 || trustHops > 3) throw new Error('TRUST_PROXY_HOPS must be between 0 and 3.');
  app.set('trust proxy', trustHops);
  app.use(express.json({ limit: '8kb', strict: true }));

  const commandQueues = new Map();
  const commandRequests = new Map();
  const receiverPollWaiters = new Map();
  const deliveredPairRequests = new Map();
  const activeReceiverPolls = new Set();
  const activePollIps = new Map();
  let relayClosed = false;

  function ipKey(req) { return req.ip || req.socket.remoteAddress || 'unknown'; }
  function rateLimit(req, res, scope, key, limit, windowMs) {
    if (store.allowAttempt(scope, key, { limit, windowMs, now: now() })) return false;
    res.status(429).json({ error: 'Too many attempts. Wait and try again.' });
    return true;
  }

  function wakeReceiver(receiverId) {
    const waiters = receiverPollWaiters.get(receiverId);
    if (!waiters) return;
    receiverPollWaiters.delete(receiverId);
    for (const wake of waiters) wake();
  }

  function waitForReceiverSignal(receiverId, res) {
    return new Promise(resolve => {
      let done = false;
      let timer;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        res.off('close', finish);
        const waiters = receiverPollWaiters.get(receiverId);
        if (waiters) {
          waiters.delete(finish);
          if (!waiters.size) receiverPollWaiters.delete(receiverId);
        }
        resolve();
      };
      if (!receiverPollWaiters.has(receiverId)) receiverPollWaiters.set(receiverId, new Set());
      receiverPollWaiters.get(receiverId).add(finish);
      timer = setTimeout(finish, POLL_TTL);
      res.on('close', finish);
    });
  }

  function receiverAuth(req, res, next) {
    const id = req.get('x-device-id');
    const credential = bearer(req);
    if (!safeId(id) || !opaquePattern.test(credential) || !store.receiverHasCredential(id, credential)) return res.status(401).json({ error: 'Receiver authentication failed.' });
    req.receiverId = id;
    next();
  }

  function phoneAuth(req, res, next) {
    const token = bearer(req);
    const receiverId = req.params.receiverId;
    if (!safeId(receiverId) || !opaquePattern.test(token)) return res.status(401).json({ error: 'Device authentication failed.' });
    const phone = store.phoneByToken(receiverId, token);
    if (!phone) return res.status(401).json({ error: 'Device authentication failed. Revoke and pair this phone again if needed.' });
    req.phone = phone;
    req.phoneToken = token;
    next();
  }

  app.use('/v1', (req, res, next) => {
    const origin = req.get('origin');
    if (origin && !configuredOrigins.has(origin)) return res.status(403).json({ error: 'This website is not allowed to use the relay.' });
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Device-Id');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.post('/v1/receiver/register', (req, res) => {
    if (rateLimit(req, res, 'register', ipKey(req), 10, 60_000)) return;
    const { deviceId, credential } = req.body || {};
    if (!safeId(deviceId) || !opaquePattern.test(credential || '')) return res.status(400).json({ error: 'Invalid receiver registration.' });
    const accepted = store.registerReceiver(deviceId, credential, cleanName(req.body.name, os.hostname()), now());
    if (!accepted) return res.status(401).json({ error: 'This receiver identity is already registered with different credentials.' });
    store.touchReceiver(deviceId, now(), Boolean(req.body.mock));
    for (const key of deliveredPairRequests.keys()) if (key.startsWith(`${deviceId}:`)) deliveredPairRequests.delete(key);
    res.json({ ok: true, deviceId });
  });

  app.post('/v1/receiver/pair-code', receiverAuth, (req, res) => {
    if (rateLimit(req, res, 'pair-code', req.receiverId, 6, 10 * 60_000)) return;
    let code;
    for (let i = 0; i < 10; i++) {
      const candidate = String(crypto.randomInt(0, 1000)).padStart(3, '0');
      const digest = store.hash(candidate, 'pair-code');
      const exists = store.db.prepare('SELECT 1 FROM pair_codes WHERE code_hash=? AND expires_at>?').get(digest, now());
      if (!exists) { code = candidate; break; }
    }
    if (!code) return res.status(503).json({ error: 'Could not create a pairing code. Try again shortly.' });
    const expiresAt = now() + PAIR_TTL;
    store.issuePairCode(req.receiverId, code, expiresAt);
    res.json({ code, expiresAt });
  });

  app.post('/v1/pair', (req, res) => {
    if (rateLimit(req, res, 'pair', ipKey(req), 5, 60_000)) return;
    const { code, phoneId, phoneToken, nonce } = req.body || {};
    if (typeof code !== 'string' || !/^\d{3}$/.test(code) || !safeId(phoneId) || !opaquePattern.test(phoneToken || '') || !opaquePattern.test(nonce || '')) return res.status(400).json({ error: 'Enter the three-digit code shown by the Windows receiver.' });
    const receiverId = store.consumePairCode(code, now());
    if (!receiverId) return res.status(401).json({ error: 'That code is incorrect, expired, or already used.' });
    const id = opaque();
    const expiresAt = now() + PAIR_TTL;
    store.createPairRequest({ id, receiverId, phoneId, phoneName: cleanName(req.body.phoneName, 'Android phone'), phoneToken, nonce, now: now(), expiresAt });
    wakeReceiver(receiverId);
    res.status(202).json({ requestId: id, expiresAt });
  });

  app.get('/v1/pair/:requestId', (req, res) => {
    const nonce = bearer(req);
    if (!opaquePattern.test(req.params.requestId) || !opaquePattern.test(nonce)) return res.status(401).json({ error: 'Pairing request authentication failed.' });
    const status = store.pairRequestStatus(req.params.requestId, nonce, now());
    if (!status) return res.status(404).json({ error: 'Pairing request was not found or has expired.' });
    res.json(status);
  });

  app.get('/v1/receiver/poll', receiverAuth, async (req, res) => {
    const receiverId = req.receiverId;
    const ip = ipKey(req);
    const ipCount = activePollIps.get(ip) || 0;
    if (activeReceiverPolls.has(receiverId)) return res.status(409).json({ error: 'Receiver already has an active poll.' });
    if (ipCount >= 20) return res.status(429).json({ error: 'Too many active receiver connections.' });
    activeReceiverPolls.add(receiverId);
    activePollIps.set(ip, ipCount + 1);
    try {
      const current = store.receiver(receiverId);
      store.touchReceiver(receiverId, now(), Boolean(current?.mock_mode));
      const read = () => {
        const pairs = store.pendingPairRequests(receiverId, now()).filter(item => !deliveredPairRequests.has(`${receiverId}:${item.id}`));
        for (const item of pairs) deliveredPairRequests.set(`${receiverId}:${item.id}`, item.expires_at);
        const queue = commandQueues.get(receiverId) || [];
        const commands = queue.filter(item => item.expiresAt > now());
        if (commands.length) {
          commandQueues.delete(receiverId);
          for (const item of commands) item.delivered = true;
        }
        return { pairs, commands };
      };
      let data = read();
      if (!data.pairs.length && !data.commands.length) {
        await waitForReceiverSignal(receiverId, res);
        if (res.destroyed) return;
        store.touchReceiver(receiverId, now(), Boolean(current?.mock_mode));
        data = read();
      }
      if (!res.destroyed) res.json({ pairs: data.pairs, commands: data.commands.map(({ id, command }) => ({ id, ...command })) });
    } finally {
      activeReceiverPolls.delete(receiverId);
      const remaining = (activePollIps.get(ip) || 1) - 1;
      if (remaining) activePollIps.set(ip, remaining); else activePollIps.delete(ip);
    }
  });

  app.post('/v1/receiver/decision', receiverAuth, (req, res) => {
    const { requestId, approve } = req.body || {};
    if (!opaquePattern.test(requestId || '') || typeof approve !== 'boolean') return res.status(400).json({ error: 'Invalid pairing decision.' });
    const changed = store.decidePairRequest(requestId, req.receiverId, approve, now());
    deliveredPairRequests.delete(`${req.receiverId}:${requestId}`);
    if (!changed) return res.status(409).json({ error: 'This pairing request has expired or was already handled.' });
    res.json({ ok: true });
  });

  app.get('/v1/receiver/phones', receiverAuth, (req, res) => res.json({ phones: store.phones(req.receiverId) }));

  app.delete('/v1/receiver/phones/:phoneId', receiverAuth, (req, res) => {
    if (!safeId(req.params.phoneId)) return res.status(400).json({ error: 'Invalid phone identity.' });
    const removed = store.revokePhone(req.receiverId, req.params.phoneId, now());
    res.status(removed ? 200 : 404).json(removed ? { ok: true } : { error: 'Paired phone was not found.' });
  });

  app.post('/v1/receiver/result', receiverAuth, (req, res) => {
    const { id, ok, error } = req.body || {};
    const entry = commandRequests.get(id);
    if (!opaquePattern.test(id || '') || typeof ok !== 'boolean' || !entry || entry.receiverId !== req.receiverId) return res.status(404).json({ error: 'Command request was not found.' });
    entry.finish(ok ? { ok: true } : { ok: false, error: 'The Windows action could not be completed.' });
    res.json({ ok: true });
  });

  app.get('/v1/phones/:receiverId/status', phoneAuth, (req, res) => {
    const receiver = store.receiver(req.params.receiverId);
    if (!receiver) return res.status(404).json({ error: 'Laptop is no longer registered.' });
    res.json({ receiverId: receiver.id, name: receiver.name, online: now() - receiver.last_seen < ONLINE_TTL, mock: Boolean(receiver.mock_mode), lastSeen: receiver.last_seen });
  });

  app.delete('/v1/phones/:receiverId/access', phoneAuth, (req, res) => {
    store.revokePhone(req.params.receiverId, req.phone.id, now());
    res.sendStatus(204);
  });

  app.post('/v1/phones/:receiverId/commands', phoneAuth, async (req, res) => {
    if (rateLimit(req, res, 'command', `${req.phone.id}:${req.params.receiverId}`, 6000, 60_000)) return;
    if (!validateCommand(req.body)) return res.status(400).json({ error: 'Invalid command or payload.' });
    const receiver = store.receiver(req.params.receiverId);
    if (!receiver || now() - receiver.last_seen >= ONLINE_TTL) return res.status(409).json({ error: 'Laptop is offline. Open the receiver on that laptop and try again.' });
    const id = opaque();
    const command = { ...req.body };
    const pending = { id, receiverId: req.params.receiverId, command, expiresAt: now() + COMMAND_TTL, delivered: false };
    const queue = commandQueues.get(pending.receiverId) || [];
    queue.push(pending);
    commandQueues.set(pending.receiverId, queue);
    wakeReceiver(pending.receiverId);
    const result = await new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        commandRequests.delete(id);
        resolve(value);
      };
      const timer = setTimeout(() => finish({ ok: false, error: 'The laptop did not respond in time. Try again.' }), COMMAND_TTL);
      commandRequests.set(id, { receiverId: pending.receiverId, finish });
    });
    if (!result.ok) return res.status(504).json({ error: result.error });
    res.json({ ok: true });
  });

  const interval = setInterval(() => {
    const current = now();
    store.cleanup(current);
    for (const [key, expiresAt] of deliveredPairRequests) if (expiresAt <= current) deliveredPairRequests.delete(key);
  }, 60_000);
  interval.unref();
  const server = http.createServer(app);
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
  const activeSockets = new Set();
  server.on('upgrade', (request, socket, head) => {
    let target;
    try { target = new URL(request.url, 'http://relay.local'); } catch { socket.destroy(); return; }
    const kind = target.pathname === '/v1/ws/receiver' ? 'receiver' : target.pathname === '/v1/ws/phone' ? 'phone' : '';
    const origin = request.headers.origin;
    if (!kind || (origin && !configuredOrigins.has(origin))) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    websocketServer.handleUpgrade(request, socket, head, ws => {
      ws.kind = kind;
      websocketServer.emit('connection', ws, request);
    });
  });
  websocketServer.on('connection', ws => {
    activeSockets.add(ws);
    let authenticated = false;
    let receiverId = '';
    let lastHeartbeatAt = 0;
    let authTimer = setTimeout(() => ws.close(4401, 'Authentication required'), 8000);
    ws.on('close', () => { clearTimeout(authTimer); activeSockets.delete(ws); });
    ws.on('error', () => {});
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { ws.close(4400, 'Invalid message'); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { ws.close(4400, 'Invalid message'); return; }
      if (!authenticated) {
        if (message.type !== 'auth') { ws.close(4400, 'Authentication message required'); return; }
        clearTimeout(authTimer);
        if (ws.kind === 'receiver') {
          if (Object.keys(message).length !== 3 || !Object.hasOwn(message, 'deviceId') || !Object.hasOwn(message, 'credential')) { ws.close(4400, 'Invalid authentication message'); return; }
          if (!safeId(message.deviceId) || !opaquePattern.test(message.credential || '') || !store.receiverHasCredential(message.deviceId, message.credential)) { ws.close(4401, 'Receiver authentication failed'); return; }
          receiverId = message.deviceId;
          const receiver = store.receiver(receiverId);
          store.touchReceiver(receiverId, now(), Boolean(receiver?.mock_mode));
        } else {
          if (Object.keys(message).length !== 3 || !Object.hasOwn(message, 'receiverId') || !Object.hasOwn(message, 'token')) { ws.close(4400, 'Invalid authentication message'); return; }
          if (!safeId(message.receiverId) || !opaquePattern.test(message.token || '') || !store.phoneByToken(message.receiverId, message.token)) { ws.close(4401, 'Phone authentication failed'); return; }
          receiverId = message.receiverId;
        }
        authenticated = true;
        ws.isAlive = true;
        ws.lastMessageAt = now();
        ws.send(JSON.stringify({ type: 'authenticated' }));
        return;
      }
      if (message.type !== 'heartbeat' || Object.keys(message).length !== 1) { ws.close(4400, 'Unsupported message'); return; }
      if (now() - lastHeartbeatAt < 10_000) { ws.close(4429, 'Heartbeat rate exceeded'); return; }
      lastHeartbeatAt = now();
      ws.isAlive = true;
      ws.lastMessageAt = now();
      if (ws.kind === 'receiver') {
        const current = store.receiver(receiverId);
        if (!current) { ws.close(4401, 'Receiver identity expired'); return; }
        store.touchReceiver(receiverId, now(), Boolean(current.mock_mode));
      }
      ws.send(JSON.stringify({ type: 'heartbeat_ack', at: now() }));
    });
  });
  const websocketHeartbeat = setInterval(() => {
    for (const ws of activeSockets) {
      if (ws.isAlive === false || now() - (ws.lastMessageAt || 0) > 60_000) { ws.terminate(); continue; }
      ws.isAlive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }
  }, 30_000);
  websocketHeartbeat.unref();
  server.requestTimeout = 35_000;
  server.maxConnections = 500;
  server.maxRequestsPerSocket = 500;
  return {
    app,
    server,
    store,
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolve(server.address()); });
      });
    },
    async close() {
      if (relayClosed) return;
      relayClosed = true;
      clearInterval(interval);
      clearInterval(websocketHeartbeat);
      for (const entry of commandRequests.values()) entry.finish({ ok: false, error: 'Relay is restarting. Try the command again.' });
      wakeAll();
      for (const ws of activeSockets) ws.close(1012, 'Relay restarting');
      websocketServer.close();
      await new Promise(resolve => {
        if (!server.listening) return resolve();
        server.close(resolve);
        server.closeAllConnections?.();
      });
      store.close();
    },
  };

  function wakeAll() { for (const id of receiverPollWaiters.keys()) wakeReceiver(id); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dbPath = process.env.RELAY_DB_PATH || path.resolve(here, 'data', 'relay.sqlite');
  const pepper = process.env.RELAY_PEPPER;
  if (!pepper || pepper.startsWith('replace-')) throw new Error('Set RELAY_PEPPER to a private random value before starting the relay.');
  const app = createRelay({ dbPath, pepper, frontendOrigins: process.env.FRONTEND_ORIGINS || 'https://lapcontroller.vercel.app' });
  const port = Number(process.env.PORT || process.env.RELAY_PORT || 8788);
  const host = process.env.RELAY_HOST || '0.0.0.0';
  app.listen(port, host).then(() => console.log(`Liquid Glass relay listening on ${host}:${port}; SQLite: ${dbPath}`)).catch(error => { console.error(`Relay failed to start: ${error.message}`); process.exitCode = 1; });
  const shutdown = () => app.close().finally(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
